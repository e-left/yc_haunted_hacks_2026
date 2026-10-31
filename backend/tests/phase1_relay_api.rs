//! Phase 1: relay API core. Auth, intake, idempotency, ownership, and limits.

use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use chrono::{Duration, Utc};
use http_body_util::BodyExt;
use lild_backend::{
    AppState,
    auth::{ApiKeyRecord, Scope, generate_api_key},
    build_app,
    model::{MAX_BODY_BYTES, MAX_QUESTION_CHARS},
    store::MemoryStore,
};
use serde_json::{Value, json};
use tower::ServiceExt;

const Q: &str = "Which in-stock shirts have a body length under 30 inches?";

struct Harness {
    store: Arc<MemoryStore>,
}

impl Harness {
    fn new() -> Self {
        Self { store: Arc::new(MemoryStore::new()) }
    }

    fn app(&self) -> Router {
        build_app(AppState { store: self.store.clone() })
    }

    /// Register a key for `client_id` and return the plaintext.
    async fn key(&self, client_id: &str, scopes: &[Scope], expires_in: Option<Duration>, revoked: bool) -> String {
        let k = generate_api_key();
        self.store
            .insert_api_key(ApiKeyRecord {
                client_id: client_id.into(),
                key_hash: k.hash,
                scopes: scopes.to_vec(),
                expires_at: expires_in.map(|d| Utc::now() + d),
                revoked,
            })
            .await;
        k.plaintext
    }

    async fn full_key(&self, client_id: &str) -> String {
        self.key(client_id, &Scope::ALL, None, false).await
    }

    async fn send(&self, req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, Value) {
        let resp = self.app().oneshot(req).await.unwrap();
        let status = resp.status();
        let headers = resp.headers().clone();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, headers, body)
    }
}

fn post(key: Option<&str>, idem: Option<&str>, body: impl Into<Body>) -> Request<Body> {
    let mut b = Request::post("/v1/requests").header("content-type", "application/json");
    if let Some(k) = key {
        b = b.header("authorization", format!("Bearer {k}"));
    }
    if let Some(i) = idem {
        b = b.header("idempotency-key", i);
    }
    b.body(body.into()).unwrap()
}

fn post_q(key: &str, idem: Option<&str>, q: &str) -> Request<Body> {
    post(Some(key), idem, json!({ "question": q }).to_string())
}

fn get(key: Option<&str>, path: &str) -> Request<Body> {
    let mut b = Request::get(path);
    if let Some(k) = key {
        b = b.header("authorization", format!("Bearer {k}"));
    }
    b.body(Body::empty()).unwrap()
}

fn assert_error(body: &Value, code: &str) {
    assert_eq!(body["error"]["code"], code, "body: {body}");
}

// ---------- health ----------

#[tokio::test]
async fn health_needs_no_auth() {
    let h = Harness::new();
    let (s, _, b) = h.send(get(None, "/v1/health")).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(b["status"], "ok");
}

// ---------- authentication ----------

#[tokio::test]
async fn missing_or_malformed_credentials_are_401() {
    let h = Harness::new();
    let real = h.full_key("agent-a").await;

    let cases: Vec<Request<Body>> = vec![
        post(None, None, json!({"question": Q}).to_string()),
        Request::post("/v1/requests").header("authorization", "Basic abc").body(Body::empty()).unwrap(),
        Request::post("/v1/requests").header("authorization", format!("Token {real}")).body(Body::empty()).unwrap(),
        post_q("not_a_lild_key", None, Q),
        post_q("lild_live_0000000000000000000000000000000000000000000000000000000000000000", None, Q),
    ];
    for req in cases {
        let (s, headers, b) = h.send(req).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        assert_error(&b, "unauthorized");
        assert_eq!(headers["www-authenticate"], "Bearer");
    }
}

#[tokio::test]
async fn revoked_and_expired_keys_are_401_with_same_generic_message() {
    let h = Harness::new();
    let revoked = h.key("agent-a", &Scope::ALL, None, true).await;
    let expired = h.key("agent-a", &Scope::ALL, Some(Duration::seconds(-1)), false).await;
    let unknown = generate_api_key().plaintext;

    let mut messages = vec![];
    for k in [&revoked, &expired, &unknown] {
        let (s, _, b) = h.send(post_q(k, None, Q)).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        messages.push(b["error"]["message"].clone());
    }
    // The client can't tell revoked, expired, and unknown keys apart.
    assert!(messages.windows(2).all(|w| w[0] == w[1]));
}

#[tokio::test]
async fn missing_scope_is_403() {
    let h = Harness::new();
    let read_only = h.key("agent-a", &[Scope::RequestsRead], None, false).await;
    let (s, _, b) = h.send(post_q(&read_only, None, Q)).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_error(&b, "forbidden");

    let write_only = h.key("agent-b", &[Scope::RequestsCreate], None, false).await;
    let (s, _, b) = h.send(post_q(&write_only, None, Q)).await;
    assert_eq!(s, StatusCode::ACCEPTED);
    let path = format!("/v1/requests/{}", b["request_id"].as_str().unwrap());
    let (s, _, _) = h.send(get(Some(&write_only), &path)).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
}

// ---------- intake ----------

#[tokio::test]
async fn create_returns_202_pending_and_is_readable() {
    let h = Harness::new();
    let key = h.full_key("agent-a").await;

    let (s, headers, b) = h.send(post_q(&key, None, &format!("  {Q}  "))).await;
    assert_eq!(s, StatusCode::ACCEPTED);
    assert_eq!(b["status"], "pending");
    assert_eq!(b["question"], Q, "question is trimmed");
    assert!(b.get("client_id").is_none(), "internal fields must not leak");
    let id = b["request_id"].as_str().unwrap();
    assert_eq!(headers["location"], format!("/v1/requests/{id}"));

    let (s, _, got) = h.send(get(Some(&key), &format!("/v1/requests/{id}"))).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(got, b);
}

#[tokio::test]
async fn other_clients_cannot_see_a_request() {
    let h = Harness::new();
    let a = h.full_key("agent-a").await;
    let b_key = h.full_key("agent-b").await;

    let (_, _, created) = h.send(post_q(&a, None, Q)).await;
    let path = format!("/v1/requests/{}", created["request_id"].as_str().unwrap());

    let (s, _, body) = h.send(get(Some(&b_key), &path)).await;
    assert_eq!(s, StatusCode::NOT_FOUND, "another client's request looks like it doesn't exist");
    assert_error(&body, "not_found");

    // Same response as an ID that truly doesn't exist, or a malformed one.
    for p in [format!("/v1/requests/{}", uuid::Uuid::new_v4()), "/v1/requests/not-a-uuid".into()] {
        let (s, _, body) = h.send(get(Some(&b_key), &p)).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
        assert_error(&body, "not_found");
    }
}

// ---------- validation and limits ----------

#[tokio::test]
async fn invalid_bodies_are_rejected() {
    let h = Harness::new();
    let key = h.full_key("agent-a").await;

    let too_long = "x".repeat(MAX_QUESTION_CHARS + 1);
    let cases: Vec<(String, StatusCode, &str)> = vec![
        ("not json".into(), StatusCode::BAD_REQUEST, "bad_request"),
        ("{}".into(), StatusCode::BAD_REQUEST, "bad_request"),
        (json!({"question": Q, "customer_id": "someone-else"}).to_string(), StatusCode::BAD_REQUEST, "bad_request"),
        (json!({"question": "   "}).to_string(), StatusCode::UNPROCESSABLE_ENTITY, "validation_failed"),
        (json!({"question": too_long}).to_string(), StatusCode::UNPROCESSABLE_ENTITY, "validation_failed"),
        (json!({"question": "hi\u{0000}there"}).to_string(), StatusCode::UNPROCESSABLE_ENTITY, "validation_failed"),
    ];
    for (body, status, code) in cases {
        let (s, _, b) = h.send(post(Some(&key), None, body.clone())).await;
        assert_eq!(s, status, "body: {body}");
        assert_error(&b, code);
    }
}

#[tokio::test]
async fn max_length_question_is_accepted() {
    let h = Harness::new();
    let key = h.full_key("agent-a").await;
    let (s, _, _) = h.send(post_q(&key, None, &"é".repeat(MAX_QUESTION_CHARS))).await;
    assert_eq!(s, StatusCode::ACCEPTED, "limit counts characters, not bytes");
}

#[tokio::test]
async fn oversized_body_is_413() {
    let h = Harness::new();
    let key = h.full_key("agent-a").await;
    let big = json!({ "question": "x".repeat(MAX_BODY_BYTES) }).to_string();
    let (s, _, _) = h.send(post(Some(&key), None, big)).await;
    assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE);
}

// ---------- idempotency ----------

#[tokio::test]
async fn retry_with_same_idempotency_key_returns_same_request() {
    let h = Harness::new();
    let key = h.full_key("agent-a").await;

    let (s1, h1, b1) = h.send(post_q(&key, Some("retry-1"), Q)).await;
    let (s2, h2, b2) = h.send(post_q(&key, Some("retry-1"), Q)).await;
    assert_eq!((s1, s2), (StatusCode::ACCEPTED, StatusCode::ACCEPTED));
    assert_eq!(b1["request_id"], b2["request_id"]);
    assert!(h1.get("idempotent-replayed").is_none());
    assert_eq!(h2["idempotent-replayed"], "true");
}

#[tokio::test]
async fn reusing_idempotency_key_with_different_body_is_409() {
    let h = Harness::new();
    let key = h.full_key("agent-a").await;
    h.send(post_q(&key, Some("k"), Q)).await;
    let (s, _, b) = h.send(post_q(&key, Some("k"), "a different question")).await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_error(&b, "idempotency_conflict");
}

#[tokio::test]
async fn idempotency_keys_are_scoped_per_client() {
    let h = Harness::new();
    let a = h.full_key("agent-a").await;
    let b = h.full_key("agent-b").await;
    let (_, _, ra) = h.send(post_q(&a, Some("same"), Q)).await;
    let (s, _, rb) = h.send(post_q(&b, Some("same"), Q)).await;
    assert_eq!(s, StatusCode::ACCEPTED);
    assert_ne!(ra["request_id"], rb["request_id"], "client B must not get client A's request");
}

#[tokio::test]
async fn without_idempotency_key_each_post_creates_new_request() {
    let h = Harness::new();
    let key = h.full_key("agent-a").await;
    let (_, _, r1) = h.send(post_q(&key, None, Q)).await;
    let (_, _, r2) = h.send(post_q(&key, None, Q)).await;
    assert_ne!(r1["request_id"], r2["request_id"]);
}

#[tokio::test]
async fn invalid_idempotency_key_is_400() {
    let h = Harness::new();
    let key = h.full_key("agent-a").await;
    for bad in ["", &"k".repeat(256), "has space"] {
        let (s, _, b) = h.send(post_q(&key, Some(bad), Q)).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "key: {bad:?}");
        assert_error(&b, "bad_request");
    }
}

#[tokio::test]
async fn concurrent_retries_create_exactly_one_request() {
    let h = Harness::new();
    let key = h.full_key("agent-a").await;
    let app = h.app();
    let tasks: Vec<_> = (0..20)
        .map(|_| {
            let app = app.clone();
            let req = post_q(&key, Some("burst"), Q);
            tokio::spawn(async move {
                let resp = app.oneshot(req).await.unwrap();
                let bytes = resp.into_body().collect().await.unwrap().to_bytes();
                serde_json::from_slice::<Value>(&bytes).unwrap()["request_id"].clone()
            })
        })
        .collect();
    let mut ids = vec![];
    for t in tasks {
        ids.push(t.await.unwrap());
    }
    assert!(ids.windows(2).all(|w| w[0] == w[1]), "all retries map to one request");
}
