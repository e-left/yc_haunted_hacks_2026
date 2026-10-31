//! HTTP handlers for the relay API.

use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{AuthClient, Scope},
    error::ApiError,
    model::{CreateRequestBody, MAX_IDEMPOTENCY_KEY_LEN, MAX_QUESTION_CHARS, RequestView},
    store::{CreateOutcome, Idempotency},
};

/// Liveness: the process is up. Doesn't touch the database.
pub async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok" }))
}

/// Readiness: dependencies are reachable. 503 if the store is down, so failures are
/// visible to load balancers and the demo instead of hiding behind a 200.
pub async fn ready(State(state): State<AppState>) -> Response {
    match state.store.ping().await {
        Ok(()) => Json(json!({ "status": "ready" })).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "readiness check failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": { "code": "unavailable", "message": "storage unavailable" } })),
            )
                .into_response()
        }
    }
}

/// `POST /v1/requests`: accept a question, store it as `pending`, return 202.
///
/// The body is read as raw bytes so it can be hashed for idempotency and parsed
/// with the same error envelope as everything else.
pub async fn create_request(
    State(state): State<AppState>,
    client: AuthClient,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    client.require(Scope::RequestsCreate)?;

    let idempotency = parse_idempotency_key(&headers)?.map(|key| Idempotency {
        key,
        body_hash: hex::encode(Sha256::digest(&body)),
    });

    let parsed: CreateRequestBody = serde_json::from_slice(&body)
        .map_err(|e| ApiError::BadRequest(format!("invalid JSON body: {e}")))?;
    let question = validate_question(&parsed.question)?;

    let outcome = state
        .store
        .create_request(&client.client_id, question, idempotency)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    let (req, replayed) = match outcome {
        CreateOutcome::Created(r) => (r, false),
        CreateOutcome::Replayed(r) => (r, true),
        CreateOutcome::Conflict => return Err(ApiError::IdempotencyConflict),
    };

    tracing::info!(request_id = %req.id, client_id = %client.client_id, replayed, "request accepted");

    let view = RequestView::from(&req);
    let mut resp = (StatusCode::ACCEPTED, Json(&view)).into_response();
    let h = resp.headers_mut();
    h.insert("location", view.status_url.parse().unwrap());
    if replayed {
        h.insert("idempotent-replayed", "true".parse().unwrap());
    }
    Ok(resp)
}

/// `GET /v1/requests/{id}`: status of a request the caller owns.
pub async fn get_request(
    State(state): State<AppState>,
    client: AuthClient,
    Path(id): Path<String>,
) -> Result<Json<RequestView>, ApiError> {
    client.require(Scope::RequestsRead)?;
    // A malformed ID is just "not found". It's the same answer as for a request owned by someone else.
    let id = Uuid::parse_str(&id).map_err(|_| ApiError::NotFound)?;
    let req = state
        .store
        .get_request(&client.client_id, id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(RequestView::from(&req)))
}

fn parse_idempotency_key(headers: &HeaderMap) -> Result<Option<String>, ApiError> {
    let Some(raw) = headers.get("idempotency-key") else {
        return Ok(None);
    };
    let key = raw
        .to_str()
        .map_err(|_| ApiError::BadRequest("Idempotency-Key must be visible ASCII".into()))?;
    let valid = !key.is_empty()
        && key.len() <= MAX_IDEMPOTENCY_KEY_LEN
        && key.bytes().all(|b| b.is_ascii_graphic());
    if !valid {
        return Err(ApiError::BadRequest(format!(
            "Idempotency-Key must be 1-{MAX_IDEMPOTENCY_KEY_LEN} visible ASCII characters"
        )));
    }
    Ok(Some(key.to_string()))
}

fn validate_question(q: &str) -> Result<&str, ApiError> {
    let q = q.trim();
    if q.is_empty() {
        return Err(ApiError::Validation("question must not be empty".into()));
    }
    if q.chars().count() > MAX_QUESTION_CHARS {
        return Err(ApiError::Validation(format!(
            "question must be at most {MAX_QUESTION_CHARS} characters"
        )));
    }
    if q.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
        return Err(ApiError::Validation(
            "question must not contain control characters".into(),
        ));
    }
    Ok(q)
}
