//! One error type for the HTTP API, rendered as `{ "error": { "code", "message" } }`.

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    /// Missing, malformed, unknown, revoked, or expired credential.
    /// One generic message, so callers can't tell which check failed.
    #[error("missing or invalid credentials")]
    Unauthorized,
    #[error("credential lacks the required scope")]
    Forbidden,
    /// Also used for resources owned by another client, so they don't leak existence.
    #[error("not found")]
    NotFound,
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Validation(String),
    #[error("Idempotency-Key was already used with a different request body")]
    IdempotencyConflict,
    /// The detail is logged server-side and never sent to the client.
    #[error("internal error")]
    Internal(String),
}

impl ApiError {
    fn status_and_code(&self) -> (StatusCode, &'static str) {
        match self {
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Self::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            Self::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            Self::Validation(_) => (StatusCode::UNPROCESSABLE_ENTITY, "validation_failed"),
            Self::IdempotencyConflict => (StatusCode::CONFLICT, "idempotency_conflict"),
            Self::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        if let Self::Internal(detail) = &self {
            tracing::error!(%detail, "internal error");
        }
        let (status, code) = self.status_and_code();
        let mut resp = (
            status,
            Json(json!({ "error": { "code": code, "message": self.to_string() } })),
        )
            .into_response();
        if status == StatusCode::UNAUTHORIZED {
            resp.headers_mut()
                .insert("www-authenticate", "Bearer".parse().unwrap());
        }
        resp
    }
}
