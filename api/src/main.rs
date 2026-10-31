mod auth;
mod config;
mod error;
mod lists;
mod realtime;

use std::{net::SocketAddr, sync::Arc, time::Duration};

use axum::{
    Router,
    http::{HeaderValue, Method, header},
    routing::get,
};
use jsonwebtoken::{DecodingKey, EncodingKey};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tower_governor::{
    GovernorLayer, governor::GovernorConfigBuilder, key_extractor::SmartIpKeyExtractor,
};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use crate::{config::Config, realtime::Hub};

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    pub hub: Arc<Hub>,
    pub http: reqwest::Client,
    pub jwt: Arc<(EncodingKey, DecodingKey)>,
}

#[tokio::main]
async fn main() {
    // `api healthcheck` lets the distroless image (no curl) probe itself for Docker/Coolify.
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        std::process::exit(if healthcheck().await { 0 } else { 1 });
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "api=info,tower_http=warn".into()),
        )
        .init();

    let config = Config::from_env();
    let db = PgPoolOptions::new()
        .max_connections(10)
        .connect(&config.database_url)
        .await
        .expect("connect to database");
    sqlx::migrate!().run(&db).await.expect("run migrations");

    let state = AppState {
        db,
        hub: Arc::default(),
        http: reqwest::Client::builder()
            .user_agent("sharedlists")
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap(),
        jwt: Arc::new((
            EncodingKey::from_secret(config.jwt_secret.as_bytes()),
            DecodingKey::from_secret(config.jwt_secret.as_bytes()),
        )),
        config: Arc::new(config),
    };

    // Per-IP limit on the REST API: bursts of 60, refilling 10/s. SmartIp reads
    // X-Forwarded-For set by Coolify's proxy, falling back to the peer address.
    let governor = GovernorConfigBuilder::default()
        .per_millisecond(100)
        .burst_size(60)
        .key_extractor(SmartIpKeyExtractor)
        .finish()
        .unwrap();
    let limiter = governor.limiter().clone();

    let cleanup_state = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(3600));
        loop {
            tick.tick().await;
            limiter.retain_recent();
            auth::delete_expired_sessions(&cleanup_state).await;
        }
    });

    let cors = CorsLayer::new()
        .allow_origin(
            state
                .config
                .allowed_origins
                .iter()
                .map(|o| HeaderValue::from_str(o).expect("origin header"))
                .collect::<Vec<_>>(),
        )
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        .allow_credentials(true)
        .max_age(Duration::from_secs(86400));

    let app = Router::new()
        .merge(lists::router())
        .merge(auth::router())
        .layer(GovernorLayer::new(governor))
        .route("/ws", get(realtime::ws_handler))
        .route("/health", get(|| async { "ok" }))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state.clone());

    let addr = SocketAddr::from(([0, 0, 0, 0], state.config.port));
    let listener = TcpListener::bind(addr).await.expect("bind");
    tracing::info!("listening on {addr}");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await
    .unwrap();
}

async fn shutdown() {
    let ctrl_c = tokio::signal::ctrl_c();
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("install SIGTERM handler");
    tokio::select! {
        _ = ctrl_c => {},
        _ = term.recv() => {},
    }
}

async fn healthcheck() -> bool {
    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".into());
    let probe = async {
        let mut stream = TcpStream::connect(("127.0.0.1", port.parse::<u16>().ok()?))
            .await
            .ok()?;
        stream
            .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .ok()?;
        let mut buf = [0u8; 12];
        stream.read_exact(&mut buf).await.ok()?;
        Some(buf.ends_with(b"200"))
    };
    tokio::time::timeout(Duration::from_secs(3), probe)
        .await
        .ok()
        .flatten()
        .unwrap_or(false)
}
