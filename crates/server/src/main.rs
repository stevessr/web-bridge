mod napcat;
mod state;
mod web;

use std::{env, net::SocketAddr, sync::Arc};

use anyhow::{Context, Result};
use state::{AppConfig, AppState};
use tokio::net::TcpListener;
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing::info;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let bind: SocketAddr = env::var("WEB_BRIDGE_BIND")
        .unwrap_or_else(|_| "0.0.0.0:8787".into())
        .parse()
        .context("invalid WEB_BRIDGE_BIND")?;

    let config = AppConfig {
        client_token: env::var("WEB_BRIDGE_CLIENT_TOKEN").unwrap_or_else(|_| "dev-client-token".into()),
        napcat_token: env::var("WEB_BRIDGE_NAPCAT_TOKEN").unwrap_or_else(|_| "dev-napcat-token".into()),
    };

    let state = Arc::new(AppState::new(config));
    let app = web::router(state)
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive());

    let listener = TcpListener::bind(bind).await?;
    info!(%bind, "web-bridge server listening");
    axum::serve(listener, app).await?;
    Ok(())
}
