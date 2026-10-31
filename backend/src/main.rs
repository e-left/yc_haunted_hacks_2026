use std::sync::Arc;

use lild_backend::{
    AppState,
    auth::{ApiKeyRecord, Scope, is_valid_client_id},
    build_app,
    pg_store::PgStore,
    store::{MemoryStore, Store},
};
use tracing_subscriber::EnvFilter;

/// Relay server.
///
/// - `DATABASE_URL` set: Postgres/Supabase store (migrations run at startup).
/// - `DATABASE_URL` unset: in-memory store (Phase 1 behavior, data lost on restart).
/// - `LILD_API_KEYS="client_id:sha256hex,..."` keys are provisioned at startup. Existing
///   keys are never modified, so a revoked key stays revoked across restarts.
#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,tower_http=info".into()),
        )
        .init();

    let store: Arc<dyn Store> = match std::env::var("DATABASE_URL") {
        Ok(url) if !url.is_empty() => {
            let pg = PgStore::connect(&url)
                .await
                .unwrap_or_else(|e| fatal(&format!("database connection failed: {e}")));
            pg.migrate()
                .await
                .unwrap_or_else(|e| fatal(&format!("migrations failed: {e}")));
            tracing::info!("store: postgres (migrations applied)");
            Arc::new(pg)
        }
        _ => {
            tracing::warn!("store: in-memory (DATABASE_URL unset), data is lost on restart");
            Arc::new(MemoryStore::new())
        }
    };

    let mut provisioned = 0;
    let mut configured = 0;
    let keys = std::env::var("LILD_API_KEYS").unwrap_or_default();
    for entry in keys.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let Some((client_id, hash)) = entry.split_once(':') else {
            fatal("LILD_API_KEYS entry must be client_id:sha256hex");
        };
        if !is_valid_client_id(client_id) {
            fatal(&format!("LILD_API_KEYS: invalid client_id '{client_id}'"));
        }
        if !(hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())) {
            fatal(&format!(
                "LILD_API_KEYS: '{client_id}' needs a 64-char hex SHA-256 hash, not a plaintext key"
            ));
        }
        let inserted = store
            .provision_api_key(ApiKeyRecord {
                client_id: client_id.to_string(),
                key_hash: hash.to_lowercase(),
                scopes: Scope::ALL.to_vec(),
                expires_at: None,
                revoked: false,
            })
            .await
            .unwrap_or_else(|e| fatal(&format!("provisioning API key failed: {e}")));
        configured += 1;
        provisioned += inserted as usize;
    }
    if configured == 0 {
        tracing::warn!("no API keys in LILD_API_KEYS; only keys already in the store will work");
    }

    let bind = std::env::var("LILD_BIND").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .unwrap_or_else(|e| fatal(&format!("bind {bind}: {e}")));
    tracing::info!(%bind, configured, newly_provisioned = provisioned, "relay listening");

    axum::serve(listener, build_app(AppState { store }))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .unwrap_or_else(|e| fatal(&format!("server error: {e}")));
}

fn fatal(msg: &str) -> ! {
    tracing::error!("{msg}");
    eprintln!("fatal: {msg}");
    std::process::exit(1);
}
