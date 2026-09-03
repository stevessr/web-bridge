use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
};

use grammers_session::{
    BoxFuture, Session, SessionData,
    types::{ChannelState, DcOption, PeerId, PeerInfo, UpdateState, UpdatesState},
};
use rusqlite::{Connection, OptionalExtension, params};

use crate::private_fs::restrict_file;

pub struct RusqliteSession {
    inner: Mutex<SessionInner>,
}

struct SessionInner {
    connection: Connection,
    data: SessionData,
}

#[derive(Debug, thiserror::Error)]
pub enum RusqliteSessionError {
    #[error("Telegram session SQLite error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("Telegram session filesystem error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Telegram session serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Telegram session lock poisoned")]
    Poisoned,
}

impl RusqliteSession {
    pub fn open(path: &Path) -> Result<Self, RusqliteSessionError> {
        let connection = Connection::open(path)?;
        restrict_file(path)?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS telegram_session_state (
                 singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                 home_dc INTEGER NOT NULL,
                 updates_json TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS telegram_dc_options (
                 dc_id INTEGER PRIMARY KEY,
                 option_json TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS telegram_peers (
                 peer_key TEXT PRIMARY KEY,
                 peer_json TEXT NOT NULL
             );",
        )?;

        let mut data = SessionData::default();
        if let Some((home_dc, updates_json)) = connection
            .query_row(
                "SELECT home_dc, updates_json FROM telegram_session_state WHERE singleton = 1",
                [],
                |row| Ok((row.get::<_, i32>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
        {
            data.home_dc = home_dc;
            data.updates_state = serde_json::from_str(&updates_json)?;
        }

        {
            let mut statement =
                connection.prepare("SELECT option_json FROM telegram_dc_options")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            for row in rows {
                let option: DcOption = serde_json::from_str(&row?)?;
                data.dc_options.insert(option.id, option);
            }
        }

        {
            let mut statement = connection.prepare("SELECT peer_json FROM telegram_peers")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            for row in rows {
                let peer: PeerInfo = serde_json::from_str(&row?)?;
                data.peer_infos.insert(peer.id(), peer);
            }
        }

        Ok(Self {
            inner: Mutex::new(SessionInner { connection, data }),
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, SessionInner>, RusqliteSessionError> {
        self.inner
            .lock()
            .map_err(|_| RusqliteSessionError::Poisoned)
    }
}

impl Session for RusqliteSession {
    type Error = RusqliteSessionError;

    fn home_dc_id(&self) -> Result<i32, Self::Error> {
        Ok(self.lock()?.data.home_dc)
    }

    fn set_home_dc_id(&self, dc_id: i32) -> BoxFuture<'_, Result<(), Self::Error>> {
        Box::pin(async move {
            let mut inner = self.lock()?;
            let updates_json = serde_json::to_string(&inner.data.updates_state)?;
            inner.connection.execute(
                "INSERT INTO telegram_session_state (singleton, home_dc, updates_json)
                 VALUES (1, ?1, ?2)
                 ON CONFLICT(singleton) DO UPDATE SET home_dc = excluded.home_dc",
                params![dc_id, updates_json],
            )?;
            inner.data.home_dc = dc_id;
            Ok(())
        })
    }

    fn dc_option(&self, dc_id: i32) -> Result<Option<DcOption>, Self::Error> {
        Ok(self.lock()?.data.dc_options.get(&dc_id).cloned())
    }

    fn set_dc_option(&self, dc_option: &DcOption) -> BoxFuture<'_, Result<(), Self::Error>> {
        let dc_option = dc_option.clone();
        Box::pin(async move {
            let option_json = serde_json::to_string(&dc_option)?;
            let mut inner = self.lock()?;
            inner.connection.execute(
                "INSERT INTO telegram_dc_options (dc_id, option_json)
                 VALUES (?1, ?2)
                 ON CONFLICT(dc_id) DO UPDATE SET option_json = excluded.option_json",
                params![dc_option.id, option_json],
            )?;
            inner.data.dc_options.insert(dc_option.id, dc_option);
            Ok(())
        })
    }

    fn peer(&self, peer: PeerId) -> BoxFuture<'_, Result<Option<PeerInfo>, Self::Error>> {
        Box::pin(async move { Ok(self.lock()?.data.peer_infos.get(&peer).cloned()) })
    }

    fn cache_peer(&self, peer: &PeerInfo) -> BoxFuture<'_, Result<(), Self::Error>> {
        let peer = peer.clone();
        Box::pin(async move {
            let mut inner = self.lock()?;
            let peer_id = peer.id();
            let mut canonical = inner
                .data
                .peer_infos
                .get(&peer_id)
                .cloned()
                .unwrap_or_else(|| peer.clone());
            canonical.extend_info(&peer);
            let peer_key = serde_json::to_string(&peer_id)?;
            let peer_json = serde_json::to_string(&canonical)?;
            inner.connection.execute(
                "INSERT INTO telegram_peers (peer_key, peer_json)
                 VALUES (?1, ?2)
                 ON CONFLICT(peer_key) DO UPDATE SET peer_json = excluded.peer_json",
                params![peer_key, peer_json],
            )?;
            inner.data.peer_infos.insert(peer_id, canonical);
            Ok(())
        })
    }

    fn updates_state(&self) -> BoxFuture<'_, Result<UpdatesState, Self::Error>> {
        Box::pin(async move { Ok(self.lock()?.data.updates_state.clone()) })
    }

    fn set_update_state(&self, update: UpdateState) -> BoxFuture<'_, Result<(), Self::Error>> {
        Box::pin(async move {
            let mut inner = self.lock()?;
            let mut next = inner.data.updates_state.clone();
            apply_update(&mut next, update);
            let updates_json = serde_json::to_string(&next)?;
            let home_dc = inner.data.home_dc;
            inner.connection.execute(
                "INSERT INTO telegram_session_state (singleton, home_dc, updates_json)
                 VALUES (1, ?1, ?2)
                 ON CONFLICT(singleton) DO UPDATE SET updates_json = excluded.updates_json",
                params![home_dc, updates_json],
            )?;
            inner.data.updates_state = next;
            Ok(())
        })
    }
}

fn apply_update(state: &mut UpdatesState, update: UpdateState) {
    match update {
        UpdateState::All(next) => *state = next,
        UpdateState::Primary { pts, date, seq } => {
            state.pts = pts;
            state.date = date;
            state.seq = seq;
        }
        UpdateState::Secondary { qts } => state.qts = qts,
        UpdateState::Channel { id, pts } => {
            state.channels.retain(|channel| channel.id != id);
            state.channels.push(ChannelState { id, pts });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use grammers_session::types::{PeerAuth, PeerInfo};
    use uuid::Uuid;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn session_backend_is_sender_pool_safe() {
        fn assert_traits<T: Session + Send + Sync>() {}
        assert_traits::<RusqliteSession>();
    }

    #[tokio::test]
    async fn session_survives_reopen_without_libsql() {
        let path = std::env::temp_dir().join(format!(
            "web-bridge-telegram-rusqlite-{}.session",
            Uuid::new_v4()
        ));
        let peer = PeerInfo::User {
            id: 123,
            auth: Some(PeerAuth::from_hash(456)),
            bot: Some(false),
            is_self: Some(true),
        };

        {
            let session = RusqliteSession::open(&path).unwrap();
            #[cfg(unix)]
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            session.set_home_dc_id(4).await.unwrap();
            let mut dc = session.dc_option(4).unwrap().unwrap();
            dc.auth_key = Some([7; 256]);
            session.set_dc_option(&dc).await.unwrap();
            session.cache_peer(&peer).await.unwrap();
            session
                .set_update_state(UpdateState::Primary {
                    pts: 10,
                    date: 20,
                    seq: 30,
                })
                .await
                .unwrap();
            session
                .set_update_state(UpdateState::Channel { id: 99, pts: 40 })
                .await
                .unwrap();
        }

        let restored = RusqliteSession::open(&path).unwrap();
        assert_eq!(restored.home_dc_id().unwrap(), 4);
        assert_eq!(
            restored.dc_option(4).unwrap().unwrap().auth_key,
            Some([7; 256])
        );
        assert_eq!(
            restored.peer(PeerId::user(123).unwrap()).await.unwrap(),
            Some(peer)
        );
        let updates = restored.updates_state().await.unwrap();
        assert_eq!((updates.pts, updates.date, updates.seq), (10, 20, 30));
        assert_eq!(updates.channels, vec![ChannelState { id: 99, pts: 40 }]);

        let _ = std::fs::remove_file(path);
    }
}
