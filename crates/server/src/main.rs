use std::{env, net::SocketAddr};

use anyhow::{Context, Result};
use tokio::net::TcpListener;
use tower_http::{cors::CorsLayer, trace::TraceLayer};
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
        },
    );

    let app = web::router(runtime.state())
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive());

    let listener = TcpListener::bind(bind).await?;
    info!(%bind, "web-bridge shared core running in server mode");
    axum::serve(listener, app).await?;
    Ok(())
}
