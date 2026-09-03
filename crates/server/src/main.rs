use std::{collections::HashMap, env, net::SocketAddr, path::PathBuf};

use anyhow::{Context, Result, bail};
use tokio::net::TcpListener;
use tower_http::trace::TraceLayer;
use tracing::info;
use web_bridge_core::{ClientCredential, CoreConfig, CoreRuntime, RuntimeRole, web};

const DEV_CLIENT_TOKEN: &str = "dev-client-token";
const DEV_NAPCAT_TOKEN: &str = "dev-napcat-token";

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let bind: SocketAddr = env::var("WEB_BRIDGE_BIND")
        .unwrap_or_else(|_| "0.0.0.0:8787".into())
        .parse()
        .context("invalid WEB_BRIDGE_BIND")?;
    let client_token =
        env::var("WEB_BRIDGE_CLIENT_TOKEN").unwrap_or_else(|_| DEV_CLIENT_TOKEN.into());
    let napcat_token =
        env::var("WEB_BRIDGE_NAPCAT_TOKEN").unwrap_or_else(|_| DEV_NAPCAT_TOKEN.into());
    let client_credentials: Vec<ClientCredential> =
        parse_json_env("WEB_BRIDGE_CLIENT_CREDENTIALS")?.unwrap_or_default();
    let napcat_tokens: HashMap<String, String> =
        parse_json_env("WEB_BRIDGE_NAPCAT_TOKENS")?.unwrap_or_default();

    validate_remote_credentials(
        bind,
        &client_token,
        &client_credentials,
        &napcat_token,
        &napcat_tokens,
    )?;

    let runtime = CoreRuntime::new(
        RuntimeRole::Server,
        CoreConfig {
            client_token,
            client_credentials,
            napcat_token,
            napcat_tokens,
            client_allowed_origins: parse_allowed_origins(
                env::var("WEB_BRIDGE_ALLOWED_ORIGINS").ok(),
            ),
            data_dir: PathBuf::from(
                env::var("WEB_BRIDGE_DATA_DIR").unwrap_or_else(|_| "data".into()),
            ),
        },
    );
    runtime.restore_local_sessions().await;

    let app = web::router(runtime.state()).layer(TraceLayer::new_for_http());

    let listener = TcpListener::bind(bind).await?;
    info!(%bind, "web-bridge shared core running in server mode");
    axum::serve(listener, app).await?;
    Ok(())
}

fn parse_json_env<T: serde::de::DeserializeOwned>(name: &str) -> Result<Option<T>> {
    let Some(raw) = env::var(name).ok().filter(|raw| !raw.trim().is_empty()) else {
        return Ok(None);
    };
    serde_json::from_str(&raw)
        .with_context(|| format!("invalid JSON in {name}"))
        .map(Some)
}

fn parse_allowed_origins(raw: Option<String>) -> Vec<String> {
    raw.into_iter()
        .flat_map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|origin| !origin.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .collect()
}

fn validate_remote_credentials(
    bind: SocketAddr,
    client_token: &str,
    client_credentials: &[ClientCredential],
    napcat_token: &str,
    napcat_tokens: &HashMap<String, String>,
) -> Result<()> {
    if bind.ip().is_loopback() {
        return Ok(());
    }

    if client_credentials.is_empty()
        && (client_token.is_empty() || client_token == DEV_CLIENT_TOKEN)
    {
        bail!(
            "refusing non-loopback bind with the default client credential; set WEB_BRIDGE_CLIENT_TOKEN or WEB_BRIDGE_CLIENT_CREDENTIALS"
        );
    }
    if !client_credentials.is_empty()
        && client_credentials
            .iter()
            .any(|credential| credential.token.is_empty())
    {
        bail!("WEB_BRIDGE_CLIENT_CREDENTIALS contains an empty token");
    }

    if napcat_tokens.is_empty() && (napcat_token.is_empty() || napcat_token == DEV_NAPCAT_TOKEN) {
        bail!(
            "refusing non-loopback bind with the default NapCat credential; set WEB_BRIDGE_NAPCAT_TOKEN or WEB_BRIDGE_NAPCAT_TOKENS"
        );
    }
    if !napcat_tokens.is_empty() && napcat_tokens.values().any(String::is_empty) {
        bail!("WEB_BRIDGE_NAPCAT_TOKENS contains an empty token");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use web_bridge_protocol::Network;

    #[test]
    fn parses_explicit_origin_allowlist() {
        assert_eq!(
            parse_allowed_origins(Some(
                "https://one.example, https://two.example,,".to_owned()
            )),
            vec!["https://one.example", "https://two.example"]
        );
        assert!(parse_allowed_origins(None).is_empty());
    }

    #[test]
    fn public_bind_rejects_default_tokens_but_accepts_structured_credentials() {
        let public: SocketAddr = "0.0.0.0:8787".parse().unwrap();
        assert!(
            validate_remote_credentials(
                public,
                DEV_CLIENT_TOKEN,
                &[],
                DEV_NAPCAT_TOKEN,
                &HashMap::new(),
            )
            .is_err()
        );

        let credentials = vec![ClientCredential {
            token: "client-secret".into(),
            principal: "desktop".into(),
            devices: vec!["device-a".into()],
            networks: vec![Network::Matrix],
            read_only: false,
        }];
        let napcat_tokens = HashMap::from([("10001".into(), "napcat-secret".into())]);
        assert!(
            validate_remote_credentials(
                public,
                DEV_CLIENT_TOKEN,
                &credentials,
                DEV_NAPCAT_TOKEN,
                &napcat_tokens,
            )
            .is_ok()
        );
    }

    #[test]
    fn loopback_bind_allows_development_defaults() {
        let loopback: SocketAddr = "127.0.0.1:8787".parse().unwrap();
        assert!(
            validate_remote_credentials(
                loopback,
                DEV_CLIENT_TOKEN,
                &[],
                DEV_NAPCAT_TOKEN,
                &HashMap::new(),
            )
            .is_ok()
        );
    }
}
