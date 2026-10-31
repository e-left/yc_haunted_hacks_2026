use std::sync::Arc;

use lild_backend::{
    AppState,
    auth::{ApiKeyRecord, Scope},
    build_app,
    store::MemoryStore,
};
use tracing_subscriber::EnvFilter;

/// Phase 1 server. Keys come from `LILD_API_KEYS="client_id:sha256hex,..."`
/// (make one with `cargo run --bin keygen -- <client_id>`).
#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,tower_http=info".into()),
        )
        .init();

    let store = MemoryStore::new();
    let keys = std::env::var("LILD_API_KEYS").unwrap_or_default();
    let mut loaded = 0;
    for entry in keys.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let Some((client_id, hash)) = entry.split_once(':') else {
            panic!("LILD_API_KEYS entry must be client_id:sha256hex");
        };
        assert!(
            hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()),
            "LILD_API_KEYS: '{client_id}' needs a 64-char hex SHA-256 hash, not a plaintext key"
        );
        store
            .insert_api_key(ApiKeyRecord {
                client_id: client_id.to_string(),
                key_hash: hash.to_lowercase(),
                scopes: Scope::ALL.to_vec(),
                expires_at: None,
                revoked: false,
            })
            .await;
        loaded += 1;
    }
    if loaded == 0 {
        tracing::warn!("no API keys loaded; every authenticated call will return 401");
    }
    tracing::warn!("Phase 1: in-memory store, data is lost on restart");

    let bind = std::env::var("LILD_BIND").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let listener = tokio::net::TcpListener::bind(&bind).await.expect("bind");
    tracing::info!(%bind, keys = loaded, "relay listening");

    let app = build_app(AppState { store: Arc::new(store) });
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("server error");
}
