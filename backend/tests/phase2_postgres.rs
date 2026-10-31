//! Phase 2: Postgres persistence.
//!
//! Needs a running Postgres: `docker compose up -d --wait postgres` from the repo root.
//! Uses TEST_DATABASE_URL (defaults to the local compose `lild_test` database).
//! Tests share one database and isolate themselves with unique client IDs.

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use chrono::Utc;
use http_body_util::BodyExt;
use lild_backend::{
    AppState,
    auth::{ApiKeyRecord, Scope, generate_api_key},
    build_app,
    pg_store::PgStore,
    store::Store,
};
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

const Q: &str = "Which in-stock shirts have a body length under 30 inches?";

fn test_db_url() -> String {
    std::env::var("TEST_DATABASE_URL").unwrap_or_else(|_| {
        "postgres://lild:lild_dev_password@127.0.0.1:54329/lild_test".into()
    })
}

async fn pg() -> Arc<PgStore> {
    let store = PgStore::connect(&test_db_url()).await.unwrap_or_else(|e| {
        panic!("Postgres not reachable ({e}). Start it: docker compose up -d --wait postgres")
    });
    store.migrate().await.expect("migrations");
    Arc::new(store)
}

fn unique_client() -> String {
    format!("t-{}", Uuid::new_v4().simple())
}

async fn provision(store: &PgStore, client_id: &str) -> (String, String) {
    let k = generate_api_key();
    let inserted = store
        .provision_api_key(ApiKeyRecord {
            client_id: client_id.into(),
            key_hash: k.hash.clone(),
            scopes: Scope::ALL.to_vec(),
            expires_at: None,
            revoked: false,
        })
        .await
        .unwrap();
    assert!(inserted);
    (k.plaintext, k.hash)
}

fn app(store: Arc<PgStore>) -> Router {
    build_app(AppState { store })
}

async fn send(app: Router, req: Request<Body>) -> (StatusCode, Value) {
    let resp = app.oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn post_q(key: &str, idem: Option<&str>, q: &str) -> Request<Body> {
    let mut b = Request::post("/v1/requests")
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {key}"));
    if let Some(i) = idem {
        b = b.header("idempotency-key", i);
    }
    b.body(Body::from(json!({ "question": q }).to_string())).unwrap()
}

fn get(key: &str, path: &str) -> Request<Body> {
    Request::get(path)
        .header("authorization", format!("Bearer {key}"))
        .body(Body::empty())
        .unwrap()
}

// ---------- schema ----------

#[tokio::test]
async fn migrations_are_idempotent() {
    let store = pg().await;
    store.migrate().await.expect("second run is a no-op");

    // Regression: with an unpinned search_path, the `lild` role + `lild` schema made
    // sqlx create a second, empty `_sqlx_migrations` and re-run migration 1.
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM information_schema.tables WHERE table_name = '_sqlx_migrations'",
    )
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(n, 1, "exactly one migrations bookkeeping table");
}

#[tokio::test]
async fn relay_tables_are_not_in_public_schema() {
    // On Supabase, `public` is auto-exposed over REST. Relay tables must not be there.
    let store = pg().await;
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name IN ('api_keys', 'requests', 'idempotency_keys')",
    )
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn database_constraints_reject_bad_data_directly() {
    // Defense in depth: even SQL that bypasses the Rust validation is refused.
    let store = pg().await;
    let bad: [(&str, &str); 4] = [
        ("plaintext key as hash",
         "INSERT INTO lild.api_keys (key_hash, client_id, scopes) VALUES ('lild_live_abc', 'x', '{}')"),
        ("unknown scope",
         "INSERT INTO lild.api_keys (key_hash, client_id, scopes) VALUES (repeat('a', 64), 'x', '{admin}')"),
        ("unknown status",
         "INSERT INTO lild.requests (id, client_id, status, question) VALUES (gen_random_uuid(), 'x', 'hacked', 'q')"),
        ("empty question",
         "INSERT INTO lild.requests (id, client_id, status, question) VALUES (gen_random_uuid(), 'x', 'pending', '')"),
    ];
    for (name, sql) in bad {
        assert!(sqlx::query(sql).execute(store.pool()).await.is_err(), "{name} must be rejected");
    }
}

#[tokio::test]
async fn only_key_hashes_are_stored() {
    let store = pg().await;
    let client = unique_client();
    let (plaintext, hash) = provision(&store, &client).await;
    let stored: String = sqlx::query_scalar("SELECT key_hash FROM lild.api_keys WHERE client_id = $1")
        .bind(&client)
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!(stored, hash);
    assert_ne!(stored, plaintext);
    let leaked: i64 = sqlx::query_scalar("SELECT count(*) FROM lild.api_keys WHERE key_hash LIKE 'lild_live_%'")
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!(leaked, 0);
}

// ---------- HTTP contract on Postgres (same behavior as Phase 1) ----------

#[tokio::test]
async fn create_and_read_on_postgres() {
    let store = pg().await;
    let (key, _) = provision(&store, &unique_client()).await;

    let (s, created) = send(app(store.clone()), post_q(&key, None, Q)).await;
    assert_eq!(s, StatusCode::ACCEPTED);
    assert_eq!(created["status"], "pending");

    let path = format!("/v1/requests/{}", created["request_id"].as_str().unwrap());
    let (s, got) = send(app(store), get(&key, &path)).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(got, created);
}

#[tokio::test]
async fn other_clients_cannot_see_a_request_on_postgres() {
    let store = pg().await;
    let (a, _) = provision(&store, &unique_client()).await;
    let (b, _) = provision(&store, &unique_client()).await;
    let (_, created) = send(app(store.clone()), post_q(&a, None, Q)).await;
    let path = format!("/v1/requests/{}", created["request_id"].as_str().unwrap());
    let (s, body) = send(app(store), get(&b, &path)).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["code"], "not_found");
}

#[tokio::test]
async fn requests_survive_a_restart() {
    let (key, path) = {
        let store = pg().await;
        let (key, _) = provision(&store, &unique_client()).await;
        let (_, created) = send(app(store.clone()), post_q(&key, None, Q)).await;
        store.pool().close().await; // "shut down"
        (key, format!("/v1/requests/{}", created["request_id"].as_str().unwrap()))
    };
    let fresh = pg().await; // "restart": new process, new pool
    let (s, got) = send(app(fresh), get(&key, &path)).await;
    assert_eq!(s, StatusCode::OK, "request and key both persisted");
    assert_eq!(got["question"], Q);
}

// ---------- idempotency on Postgres ----------

#[tokio::test]
async fn idempotency_replay_conflict_and_scoping_on_postgres() {
    let store = pg().await;
    let (a, _) = provision(&store, &unique_client()).await;
    let (b, _) = provision(&store, &unique_client()).await;

    let (_, r1) = send(app(store.clone()), post_q(&a, Some("k1"), Q)).await;
    let (s, r2) = send(app(store.clone()), post_q(&a, Some("k1"), Q)).await;
    assert_eq!(s, StatusCode::ACCEPTED);
    assert_eq!(r1["request_id"], r2["request_id"], "replay returns the original");

    let (s, body) = send(app(store.clone()), post_q(&a, Some("k1"), "different")).await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(body["error"]["code"], "idempotency_conflict");

    let (_, rb) = send(app(store), post_q(&b, Some("k1"), Q)).await;
    assert_ne!(r1["request_id"], rb["request_id"], "keys are per client");
}

#[tokio::test]
async fn concurrent_retries_create_exactly_one_row() {
    let store = pg().await;
    let client = unique_client();
    let (key, _) = provision(&store, &client).await;

    let tasks: Vec<_> = (0..25)
        .map(|_| {
            let app = app(store.clone());
            let req = post_q(&key, Some("burst"), Q);
            tokio::spawn(async move { send(app, req).await })
        })
        .collect();
    let mut ids = vec![];
    for t in tasks {
        let (s, body) = t.await.unwrap();
        assert_eq!(s, StatusCode::ACCEPTED);
        ids.push(body["request_id"].clone());
    }
    assert!(ids.windows(2).all(|w| w[0] == w[1]), "all retries got the same request");

    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM lild.requests WHERE client_id = $1")
        .bind(&client)
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!(rows, 1, "losing transactions were rolled back, no orphan rows");
}

// ---------- key lifecycle ----------

#[tokio::test]
async fn revoked_and_expired_keys_in_db_are_401() {
    let store = pg().await;
    let (revoked, revoked_hash) = provision(&store, &unique_client()).await;
    let (expired, expired_hash) = provision(&store, &unique_client()).await;
    sqlx::query("UPDATE lild.api_keys SET revoked_at = now() WHERE key_hash = $1")
        .bind(&revoked_hash)
        .execute(store.pool())
        .await
        .unwrap();
    sqlx::query("UPDATE lild.api_keys SET expires_at = now() - interval '1 second' WHERE key_hash = $1")
        .bind(&expired_hash)
        .execute(store.pool())
        .await
        .unwrap();
    for key in [revoked, expired] {
        let (s, body) = send(app(store.clone()), post_q(&key, None, Q)).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"]["code"], "unauthorized");
    }
}

#[tokio::test]
async fn reprovisioning_never_unrevokes_or_rescopes_a_key() {
    // Simulates restarting the server with the same LILD_API_KEYS after an operator revoked a key.
    let store = pg().await;
    let client = unique_client();
    let (key, hash) = provision(&store, &client).await;
    sqlx::query("UPDATE lild.api_keys SET revoked_at = now() WHERE key_hash = $1")
        .bind(&hash)
        .execute(store.pool())
        .await
        .unwrap();

    let inserted = store
        .provision_api_key(ApiKeyRecord {
            client_id: "someone-else".into(),
            key_hash: hash.clone(),
            scopes: Scope::ALL.to_vec(),
            expires_at: Some(Utc::now() + chrono::Duration::days(365)),
            revoked: false,
        })
        .await
        .unwrap();
    assert!(!inserted, "existing key is left alone");

    let rec = store.find_api_key(&hash).await.unwrap().unwrap();
    assert!(rec.revoked, "still revoked");
    assert_eq!(rec.client_id, client, "owner unchanged");
    let (s, _) = send(app(store), post_q(&key, None, Q)).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

// ---------- failures are visible (FR-9) ----------

#[tokio::test]
async fn database_down_is_503_on_ready_and_500_on_writes_never_a_fake_success() {
    let store = pg().await;
    let (key, _) = provision(&store, &unique_client()).await;

    let (s, _) = send(app(store.clone()), Request::get("/v1/ready").body(Body::empty()).unwrap()).await;
    assert_eq!(s, StatusCode::OK);

    store.pool().close().await; // database becomes unreachable

    let (s, body) = send(app(store.clone()), Request::get("/v1/ready").body(Body::empty()).unwrap()).await;
    assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], "unavailable");

    let (s, body) = send(app(store.clone()), post_q(&key, None, Q)).await;
    assert_eq!(s, StatusCode::INTERNAL_SERVER_ERROR, "never 202 when nothing was stored");
    assert_eq!(body["error"]["message"], "internal error", "no DB details leak to the client");

    let (s, _) = send(app(store), Request::get("/v1/health").body(Body::empty()).unwrap()).await;
    assert_eq!(s, StatusCode::OK, "liveness stays up; readiness reports the problem");
}

#[tokio::test]
async fn unreachable_database_fails_fast_instead_of_hanging() {
    let start = Instant::now();
    let result = PgStore::connect("postgres://lild:x@127.0.0.1:1/lild").await;
    assert!(result.is_err());
    assert!(start.elapsed() < Duration::from_secs(7), "bounded by connect timeout");
}
