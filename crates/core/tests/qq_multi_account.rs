use std::sync::Arc;

use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;
use web_bridge_core::{CoreConfig, CoreState, RuntimeRole, commands, state::PendingQqAction};
use web_bridge_protocol::{AccountRef, AccountStatus, Command, Network, RouteMode, ServerFrame};

#[tokio::test]
async fn removing_one_qq_account_keeps_the_other_online() {
    let root = std::env::temp_dir().join(format!("web-bridge-qq-lifecycle-{}", Uuid::new_v4()));
    let state = Arc::new(CoreState::new(
        RuntimeRole::Server,
        CoreConfig {
            data_dir: root.clone(),
            ..CoreConfig::default()
        },
    ));
    let account_a = qq("10001");
    let account_b = qq("10002");

    for account in [&account_a, &account_b] {
        state
            .accounts
            .upsert(account.clone(), None, RouteMode::Server)
            .unwrap();
        state
            .accounts
            .set_status(account, AccountStatus::Online, None)
            .unwrap();
    }

    let (writer_a, _reader_a) = mpsc::unbounded_channel();
    let (writer_b, _reader_b) = mpsc::unbounded_channel();
    state.qq.insert(account_a.clone(), writer_a);
    state.qq.insert(account_b.clone(), writer_b);

    let (pending_a_tx, pending_a_rx) = oneshot::channel();
    let (pending_b_tx, _pending_b_rx) = oneshot::channel();
    state.qq_pending.insert(
        "echo-a".into(),
        PendingQqAction {
            account: account_a.clone(),
            response: pending_a_tx,
        },
    );
    state.qq_pending.insert(
        "echo-b".into(),
        PendingQqAction {
            account: account_b.clone(),
            response: pending_b_tx,
        },
    );

    let frames = commands::execute(
        Uuid::new_v4(),
        Command::RemoveAccount {
            account: account_a.clone(),
        },
        &state,
    )
    .await;

    assert!(matches!(frames.as_slice(), [ServerFrame::Ack { .. }]));
    assert!(state.accounts.get(&account_a).is_none());
    assert!(!state.qq.contains_key(&account_a));
    assert!(!state.qq_pending.contains_key("echo-a"));
    assert!(pending_a_rx.await.unwrap().is_err());

    assert_eq!(
        state.accounts.get(&account_b).unwrap().status,
        AccountStatus::Online
    );
    assert!(state.qq.contains_key(&account_b));
    assert!(state.qq_pending.contains_key("echo-b"));

    let _ = tokio::fs::remove_dir_all(root).await;
}

fn qq(id: &str) -> AccountRef {
    AccountRef {
        network: Network::Qq,
        id: id.into(),
    }
}
