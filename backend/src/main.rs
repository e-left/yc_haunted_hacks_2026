use std::sync::Arc;

use lild_backend::{
    AppState,
    auth::{ApiKeyRecord, Scope, is_valid_client_id},
    build_app,
    pg_store::PgStore,
    pipeline::{Pipeline, StubPipeline},
    store::{MemoryStore, Store},
    worker::{WorkerConfig, run_worker},
};
use std::time::Duration;
use tokio::sync::watch;
use tracing_subscriber::EnvFilter;

/// Relay server.
///
/// - `DATABASE_URL` set: Postgres/Supabase store (migrations run at startup).
/// - `DATABASE_URL` unset: in-memory store (Phase 1 behavior, data lost on restart).
/// - `LILD_API_KEYS="client_id:sha256hex,..."` keys are provisioned at startup. Existing
///   keys are never modified, so a revoked key stays revoked across restarts.
/// - `LILD_WORKERS` background workers (default 2, `0` disables).
/// - `LILD_PIPELINE` which pipeline the workers run (default `stub`: results are marked
///   `simulated`). The real pipeline plugs in here; see docs/HANDOFF.md.
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

    let workers: usize = std::env::var("LILD_WORKERS")
        .ok()
        .map(|v| v.parse().unwrap_or_else(|_| fatal("LILD_WORKERS must be a number")))
        .unwrap_or(2);
    // Integration point for the real pipeline (plan -> validate -> review -> Terse actor):
    // add a variant here, e.g. "real" => Arc::new(RealPipeline::new(...)). See docs/HANDOFF.md.
    // The regression gates pin LILD_PIPELINE=stub so their checks stay deterministic.
    let pipeline_name = std::env::var("LILD_PIPELINE").unwrap_or_else(|_| "stub".into());
    let pipeline: Arc<dyn Pipeline> = match pipeline_name.as_str() {
        "stub" => Arc::new(StubPipeline),
        other => fatal(&format!("unknown LILD_PIPELINE '{other}' (available: stub)")),
    };
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let mut worker_handles = Vec::new();
    for n in 0..workers {
        let cfg = WorkerConfig::new(format!("worker-{}-{n}", std::process::id()));
        cfg.validate().unwrap_or_else(|e| fatal(&e));
        worker_handles.push(tokio::spawn(run_worker(
            store.clone(),
            pipeline.clone(),
            cfg,
            shutdown_rx.clone(),
        )));
    }
    tracing::info!(workers, pipeline = %pipeline_name, "workers started");

    axum::serve(listener, build_app(AppState { store }))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap_or_else(|e| fatal(&format!("server error: {e}")));

    // Stop workers. A job mid-flight keeps its lease and is retried after restart.
    let _ = shutdown_tx.send(true);
    let drain = async {
        for h in worker_handles {
            let _ = h.await;
        }
    };
    if tokio::time::timeout(Duration::from_secs(10), drain).await.is_err() {
        tracing::warn!("workers did not stop within 10s; exiting anyway");
    }
    tracing::info!("shutdown complete");
}

/// Resolves on Ctrl+C (SIGINT) or SIGTERM (what `kill`, Docker, and hosts send).
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
    tracing::info!("shutdown signal received");
}

fn fatal(msg: &str) -> ! {
    tracing::error!("{msg}");
    eprintln!("fatal: {msg}");
    std::process::exit(1);
}
