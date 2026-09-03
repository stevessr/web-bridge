use std::{env, net::SocketAddr, path::PathBuf};

use anyhow::{Context, Result};
use tokio::net::TcpListener;
use tower_http::trace::TraceLayer;
use tracing::info;
use web_bridge_core::{CoreConfig, CoreRuntime, RuntimeRole, web};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let bind: SocketAddr = env::var("WEB_BRIDGE_BIND")
        .unwrap_or_else(|_| "0.0.0.0:8787".into())
        .parse()
        .context("invalid WEB_BRIDGE_BIND")?;

    let runtime = CoreRuntime::new(
        RuntimeRole::Server,
        CoreConfig {
            client_token: env::var("WEB_BRIDGE_CLIENT_TOKEN")
                .unwrap_or_else(|_| "dev-client-token".into()),
            napcat_token: env::var("WEB_BRIDGE_NAPCAT_TOKEN")
                .unwrap_or_else(|_| "dev-napcat-token".into()),
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
