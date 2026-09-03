use std::{
    ffi::OsString,
    net::{SocketAddrV4, SocketAddrV6},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use grammers_session::{
    BoxFuture, Session, SessionData,
    types::{
        ChannelKind, ChannelState, DcOption, PeerAuth, PeerId, PeerInfo, PeerKind, UpdateState,
        UpdatesState,
    },
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};

use crate::private_fs::restrict_file;

const LEGACY_BACKUP_SUFFIX: &str = ".legacy.bak";
const MIGRATION_TEMP_SUFFIX: &str = ".migrating";

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
    #[error("Telegram legacy session address is invalid: {0}")]
    Address(#[from] std::net::AddrParseError),
    #[error("Telegram legacy session auth key has invalid length {0}; expected 256 bytes")]
    InvalidLegacyAuthKeyLength(usize),
    #[error("Telegram legacy session contains invalid peer id {0}")]
    InvalidLegacyPeerId(i64),
    #[error("Telegram legacy session backup already exists at {0}")]
    LegacyBackupExists(PathBuf),
    #[error("Telegram legacy session replacement failed and rollback also failed: {0}")]
    MigrationRollback(String),
    #[error("Telegram session lock poisoned")]
    Poisoned,
}

impl RusqliteSession {
    pub fn open(path: &Path) -> Result<Self, RusqliteSessionError> {
        if legacy_schema_present(path)? {
            migrate_legacy_session(path)?;
        }
        open_current(path)
    }

    fn lock(&self) -> Result<MutexGuard<'_, SessionInner>, RusqliteSessionError> {
        self.inner
            .lock()
            .map_err(|_| RusqliteSessionError::Poisoned)
    }
}

fn open_current(path: &Path) -> Result<RusqliteSession, RusqliteSessionError> {
    let connection = Connection::open(path)?;
    restrict_file(path)?;
    initialize_current_schema(&connection)?;
    let data = load_current_data(&connection)?;
    Ok(RusqliteSession {
        inner: Mutex::new(SessionInner { connection, data }),
    })
}

fn initialize_current_schema(connection: &Connection) -> Result<(), RusqliteSessionError> {
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
    Ok(())
}

fn load_current_data(connection: &Connection) -> Result<SessionData, RusqliteSessionError> {
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
        let mut statement = connection.prepare("SELECT option_json FROM telegram_dc_options")?;
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
    Ok(data)
}

fn legacy_schema_present(path: &Path) -> Result<bool, RusqliteSessionError> {
    if !path.exists() {
        return Ok(false);
    }
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    if table_exists(&connection, "telegram_session_state")? {
        return Ok(false);
    }
    for table in [
        "dc_home",
        "dc_option",
        "peer_info",
        "update_state",
        "channel_state",
    ] {
        if !table_exists(&connection, table)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool, rusqlite::Error> {
    connection.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1
         )",
        [table],
        |row| row.get(0),
    )
}

fn migrate_legacy_session(path: &Path) -> Result<(), RusqliteSessionError> {
    let data = export_legacy_data(path)?;
    let backup_path = append_suffix(path, LEGACY_BACKUP_SUFFIX);
    if backup_path.exists() {
        return Err(RusqliteSessionError::LegacyBackupExists(backup_path));
    }
    let temp_path = append_suffix(path, MIGRATION_TEMP_SUFFIX);
    match std::fs::remove_file(&temp_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

    let write_result = (|| -> Result<(), RusqliteSessionError> {
        let mut connection = Connection::open(&temp_path)?;
        restrict_file(&temp_path)?;
        initialize_current_schema(&connection)?;
        write_session_data(&mut connection, &data)?;
        drop(connection);
        let validation = open_current(&temp_path)?;
        drop(validation);
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&temp_path);
        return Err(error);
    }

    std::fs::rename(path, &backup_path)?;
    restrict_file(&backup_path)?;
    if let Err(replace_error) = std::fs::rename(&temp_path, path) {
        let rollback = std::fs::rename(&backup_path, path);
        if let Err(rollback_error) = rollback {
            return Err(RusqliteSessionError::MigrationRollback(format!(
                "replace error: {replace_error}; rollback error: {rollback_error}"
            )));
        }
        return Err(replace_error.into());
    }
    restrict_file(path)?;
    Ok(())
}

fn export_legacy_data(path: &Path) -> Result<SessionData, RusqliteSessionError> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut data = SessionData::default();

    if let Some(home_dc) = connection
        .query_row("SELECT dc_id FROM dc_home LIMIT 1", [], |row| row.get(0))
        .optional()?
    {
        data.home_dc = home_dc;
    }

    {
        let mut statement =
            connection.prepare("SELECT dc_id, ipv4, ipv6, auth_key FROM dc_option")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, i32>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<Vec<u8>>>(3)?,
            ))
        })?;
        for row in rows {
            let (id, ipv4, ipv6, auth_key) = row?;
            let auth_key = match auth_key {
                Some(bytes) => Some(bytes.try_into().map_err(|bytes: Vec<u8>| {
                    RusqliteSessionError::InvalidLegacyAuthKeyLength(bytes.len())
                })?),
                None => None,
            };
            let option = DcOption {
                id,
                ipv4: ipv4.parse::<SocketAddrV4>()?,
                ipv6: ipv6.parse::<SocketAddrV6>()?,
                auth_key,
            };
            data.dc_options.insert(id, option);
        }
    }

    {
        let mut statement = connection.prepare("SELECT peer_id, hash, subtype FROM peer_info")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<i64>>(2)?,
            ))
        })?;
        for row in rows {
            let (legacy_id, hash, subtype) = row?;
            let peer_id = PeerId::from_bot_api_dialog_id(legacy_id)
                .ok_or(RusqliteSessionError::InvalidLegacyPeerId(legacy_id))?;
            let bare_id = peer_id
                .bare_id()
                .ok_or(RusqliteSessionError::InvalidLegacyPeerId(legacy_id))?;
            let subtype = subtype.map(|value| value as u8);
            let peer = match peer_id.kind() {
                PeerKind::User => PeerInfo::User {
                    id: bare_id,
                    auth: hash.map(PeerAuth::from_hash),
                    bot: subtype.map(|value| value & 2 != 0),
                    is_self: subtype.map(|value| value & 1 != 0),
                },
                PeerKind::Chat => PeerInfo::Chat { id: bare_id },
                PeerKind::Channel => PeerInfo::Channel {
                    id: bare_id,
                    auth: hash.map(PeerAuth::from_hash),
                    kind: subtype.and_then(legacy_channel_kind),
                },
            };
            data.peer_infos.insert(peer.id(), peer);
        }
    }

    data.updates_state = connection
        .query_row(
            "SELECT pts, qts, date, seq FROM update_state LIMIT 1",
            [],
            |row| {
                Ok(UpdatesState {
                    pts: row.get(0)?,
                    qts: row.get(1)?,
                    date: row.get(2)?,
                    seq: row.get(3)?,
                    channels: Vec::new(),
                })
            },
        )
        .optional()?
        .unwrap_or_default();
    {
        let mut statement = connection.prepare("SELECT peer_id, pts FROM channel_state")?;
        let rows = statement.query_map([], |row| {
            Ok(ChannelState {
                id: row.get(0)?,
                pts: row.get(1)?,
            })
        })?;
        for row in rows {
            data.updates_state.channels.push(row?);
        }
    }
    Ok(data)
}

fn legacy_channel_kind(subtype: u8) -> Option<ChannelKind> {
    if subtype & 12 == 12 {
        Some(ChannelKind::Gigagroup)
    } else if subtype & 8 != 0 {
        Some(ChannelKind::Broadcast)
    } else if subtype & 4 != 0 {
        Some(ChannelKind::Megagroup)
    } else {
        None
    }
}

fn write_session_data(
    connection: &mut Connection,
    data: &SessionData,
) -> Result<(), RusqliteSessionError> {
    let transaction = connection.transaction()?;
    let updates_json = serde_json::to_string(&data.updates_state)?;
    transaction.execute(
        "INSERT INTO telegram_session_state (singleton, home_dc, updates_json)
         VALUES (1, ?1, ?2)",
        params![data.home_dc, updates_json],
    )?;
    for option in data.dc_options.values() {
        transaction.execute(
            "INSERT INTO telegram_dc_options (dc_id, option_json) VALUES (?1, ?2)",
            params![option.id, serde_json::to_string(option)?],
        )?;
    }
    for peer in data.peer_infos.values() {
        transaction.execute(
            "INSERT INTO telegram_peers (peer_key, peer_json) VALUES (?1, ?2)",
            params![
                serde_json::to_string(&peer.id())?,
                serde_json::to_string(peer)?
            ],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = OsString::from(path.as_os_str());
    value.push(suffix);
    PathBuf::from(value)
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

    #[tokio::test]
    async fn migrates_grammers_legacy_sqlite_session_and_keeps_backup() {
        let path = std::env::temp_dir().join(format!(
            "web-bridge-telegram-legacy-{}.session",
            Uuid::new_v4()
        ));
        create_legacy_fixture(&path, vec![7; 256]);

        let session = RusqliteSession::open(&path).unwrap();
        assert_eq!(session.home_dc_id().unwrap(), 4);
        let dc = session.dc_option(4).unwrap().unwrap();
        assert_eq!(dc.ipv4.to_string(), "127.0.0.1:443");
        assert_eq!(dc.ipv6.to_string(), "[::1]:443");
        assert_eq!(dc.auth_key, Some([7; 256]));
        let user = session
            .peer(PeerId::user(123).unwrap())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            user,
            PeerInfo::User {
                auth: Some(auth),
                bot: Some(false),
                is_self: Some(true),
                ..
            } if auth.hash() == 456
        ));
        let channel = session
            .peer(PeerId::channel(99).unwrap())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            channel,
            PeerInfo::Channel {
                auth: Some(auth),
                kind: Some(ChannelKind::Broadcast),
                ..
            } if auth.hash() == 789
        ));
        let updates = session.updates_state().await.unwrap();
        assert_eq!(
            (updates.pts, updates.qts, updates.date, updates.seq),
            (10, 11, 20, 30)
        );
        assert_eq!(updates.channels, vec![ChannelState { id: 99, pts: 40 }]);

        let backup = append_suffix(&path, LEGACY_BACKUP_SUFFIX);
        assert!(backup.exists());
        let legacy =
            Connection::open_with_flags(&backup, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert!(table_exists(&legacy, "dc_home").unwrap());
        assert!(!table_exists(&legacy, "telegram_session_state").unwrap());
        let current = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert!(table_exists(&current, "telegram_session_state").unwrap());

        drop(current);
        drop(legacy);
        drop(session);
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(backup);
    }

    #[test]
    fn failed_legacy_export_preserves_original_session() {
        let path = std::env::temp_dir().join(format!(
            "web-bridge-telegram-invalid-legacy-{}.session",
            Uuid::new_v4()
        ));
        create_legacy_fixture(&path, vec![1, 2, 3]);

        let error = RusqliteSession::open(&path).err().unwrap();
        assert!(matches!(
            error,
            RusqliteSessionError::InvalidLegacyAuthKeyLength(3)
        ));
        assert!(path.exists());
        assert!(!append_suffix(&path, LEGACY_BACKUP_SUFFIX).exists());
        let legacy = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert!(table_exists(&legacy, "dc_home").unwrap());
        assert!(!table_exists(&legacy, "telegram_session_state").unwrap());
        drop(legacy);
        let _ = std::fs::remove_file(path);
    }

    fn create_legacy_fixture(path: &Path, auth_key: Vec<u8>) {
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE dc_home (
                     dc_id INTEGER NOT NULL,
                     PRIMARY KEY(dc_id));
                 CREATE TABLE dc_option (
                     dc_id INTEGER NOT NULL,
                     ipv4 TEXT NOT NULL,
                     ipv6 TEXT NOT NULL,
                     auth_key BLOB,
                     PRIMARY KEY (dc_id));
                 CREATE TABLE peer_info (
                     peer_id INTEGER NOT NULL,
                     hash INTEGER,
                     subtype INTEGER,
                     PRIMARY KEY (peer_id));
                 CREATE TABLE update_state (
                     pts INTEGER NOT NULL,
                     qts INTEGER NOT NULL,
                     date INTEGER NOT NULL,
                     seq INTEGER NOT NULL);
                 CREATE TABLE channel_state (
                     peer_id INTEGER NOT NULL,
                     pts INTEGER NOT NULL,
                     PRIMARY KEY (peer_id));
                 PRAGMA user_version = 1;",
            )
            .unwrap();
        connection
            .execute("INSERT INTO dc_home VALUES (4)", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO dc_option VALUES (?1, ?2, ?3, ?4)",
                params![4, "127.0.0.1:443", "[::1]:443", auth_key],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO peer_info VALUES (?1, ?2, ?3)",
                params![123_i64, 456_i64, 1_i64],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO peer_info VALUES (?1, ?2, ?3)",
                params![-1_000_000_000_099_i64, 789_i64, 8_i64],
            )
            .unwrap();
        connection
            .execute("INSERT INTO update_state VALUES (10, 11, 20, 30)", [])
            .unwrap();
        connection
            .execute("INSERT INTO channel_state VALUES (99, 40)", [])
            .unwrap();
        drop(connection);
    }
}
