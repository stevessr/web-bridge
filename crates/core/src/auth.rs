use serde::{Deserialize, Serialize};
use web_bridge_protocol::{Command, Network, ServerFrame};

#[derive(Clone, Serialize, Deserialize)]
pub struct ClientCredential {
    pub token: String,
    #[serde(default)]
    pub principal: String,
    #[serde(default)]
    pub devices: Vec<String>,
    #[serde(default)]
    pub networks: Vec<Network>,
    #[serde(default)]
    pub read_only: bool,
}

#[derive(Clone)]
pub struct ClientPolicy {
    principal: String,
    devices: Vec<String>,
    networks: Vec<Network>,
    read_only: bool,
}

impl ClientPolicy {
    fn admin() -> Self {
        Self {
            principal: "legacy-admin".into(),
            devices: Vec::new(),
            networks: Vec::new(),
            read_only: false,
        }
    }

    pub fn principal(&self) -> &str {
        &self.principal
    }

    pub fn allows_device(&self, device_id: &str) -> bool {
        !device_id.is_empty()
            && (self.devices.is_empty() || self.devices.iter().any(|allowed| allowed == device_id))
    }

    pub fn allows_network(&self, network: Network) -> bool {
        self.networks.is_empty() || self.networks.contains(&network)
    }

    pub fn allows_write(&self) -> bool {
        !self.read_only
    }

    pub fn allows_command(&self, command: &Command) -> bool {
        if self.read_only && !command_is_read_only(command) {
            return false;
        }
        command_network(command).is_none_or(|network| self.allows_network(network))
    }

    pub fn filter_frame(&self, mut frame: ServerFrame) -> Option<ServerFrame> {
        match &mut frame {
            ServerFrame::Accounts { accounts, .. } => {
                accounts.retain(|snapshot| self.allows_network(snapshot.account.network));
            }
            ServerFrame::AccountChanged { account } => {
                if !self.allows_network(account.account.network) {
                    return None;
                }
            }
            ServerFrame::AccountRemoved { account }
            | ServerFrame::AuthChallenge { account, .. }
            | ServerFrame::Cursor { account, .. } => {
                if !self.allows_network(account.network) {
                    return None;
                }
            }
            ServerFrame::Message { message } => {
                if !self.allows_network(message.account.network) {
                    return None;
                }
            }
            ServerFrame::Conversations { conversations, .. } => {
                conversations.retain(|snapshot| self.allows_network(snapshot.account.network));
            }
            ServerFrame::Messages { messages, .. } => {
                messages.retain(|message| self.allows_network(message.account.network));
            }
            ServerFrame::Ready { .. }
            | ServerFrame::Ack { .. }
            | ServerFrame::Error { .. }
            | ServerFrame::Pong { .. } => {}
        }
        Some(frame)
    }
}

pub fn resolve_client_policy(
    token: &str,
    legacy_token: &str,
    credentials: &[ClientCredential],
) -> Option<ClientPolicy> {
    if !credentials.is_empty() {
        let credential = credentials
            .iter()
            .find(|credential| !credential.token.is_empty() && credential.token == token)?;
        return Some(ClientPolicy {
            principal: if credential.principal.is_empty() {
                "client".into()
            } else {
                credential.principal.clone()
            },
            devices: credential.devices.clone(),
            networks: credential.networks.clone(),
            read_only: credential.read_only,
        });
    }

    (!legacy_token.is_empty() && token == legacy_token).then(ClientPolicy::admin)
}

fn command_is_read_only(command: &Command) -> bool {
    matches!(
        command,
        Command::ListAccounts
            | Command::ListConversations { .. }
            | Command::ListMessages { .. }
            | Command::GetCursor { .. }
    )
}

fn command_network(command: &Command) -> Option<Network> {
    match command {
        Command::ListAccounts => None,
        Command::RegisterAccount { account, .. }
        | Command::RemoveAccount { account }
        | Command::SetAccountRoute { account, .. }
        | Command::DisconnectAccount { account }
        | Command::SendMessage { account, .. }
        | Command::ListConversations { account, .. }
        | Command::ListMessages { account, .. }
        | Command::GetCursor { account, .. }
        | Command::SetCursor { account, .. } => Some(account.network),
        Command::MatrixLoginPassword { .. } => Some(Network::Matrix),
        Command::TelegramBeginLogin { .. }
        | Command::TelegramSubmitCode { .. }
        | Command::TelegramSubmitPassword { .. } => Some(Network::Telegram),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use web_bridge_protocol::{AccountRef, RouteMode};

    fn account(network: Network) -> AccountRef {
        AccountRef {
            network,
            id: "account".into(),
        }
    }

    #[test]
    fn structured_policy_binds_device_network_and_mutation_mode() {
        let credential = ClientCredential {
            token: "secret".into(),
            principal: "reader".into(),
            devices: vec!["phone".into()],
            networks: vec![Network::Matrix],
            read_only: true,
        };
        let policy = resolve_client_policy("secret", "legacy", &[credential]).unwrap();
        assert_eq!(policy.principal(), "reader");
        assert!(policy.allows_device("phone"));
        assert!(!policy.allows_device("laptop"));
        assert!(!policy.allows_write());
        assert!(policy.allows_command(&Command::ListMessages {
            account: account(Network::Matrix),
            conversation: web_bridge_protocol::ConversationRef {
                kind: web_bridge_protocol::ConversationKind::Room,
                id: "!room:example".into(),
            },
            before: None,
            limit: 20,
        }));
        assert!(!policy.allows_command(&Command::SendMessage {
            account: account(Network::Matrix),
            route: RouteMode::Server,
            conversation: web_bridge_protocol::ConversationRef {
                kind: web_bridge_protocol::ConversationKind::Room,
                id: "!room:example".into(),
            },
            parts: vec![],
        }));
        assert!(!policy.allows_command(&Command::ListMessages {
            account: account(Network::Telegram),
            conversation: web_bridge_protocol::ConversationRef {
                kind: web_bridge_protocol::ConversationKind::Private,
                id: "peer".into(),
            },
            before: None,
            limit: 20,
        }));
    }

    #[test]
    fn structured_mode_does_not_fall_back_to_legacy_admin() {
        let credential = ClientCredential {
            token: "structured".into(),
            principal: "client".into(),
            devices: vec![],
            networks: vec![],
            read_only: false,
        };
        assert!(resolve_client_policy("legacy", "legacy", &[credential]).is_none());
    }

    #[test]
    fn legacy_token_remains_full_admin_when_structured_mode_is_off() {
        let policy = resolve_client_policy("legacy", "legacy", &[]).unwrap();
        assert!(policy.allows_device("any-device"));
        assert!(policy.allows_write());
        assert!(policy.allows_command(&Command::RemoveAccount {
            account: account(Network::Qq),
        }));
    }
}
