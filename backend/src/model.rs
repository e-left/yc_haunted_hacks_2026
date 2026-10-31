//! Core data types shared by the API, store, and (later) the worker.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Max length of the natural-language question, in characters.
pub const MAX_QUESTION_CHARS: usize = 2_000;
/// Max HTTP request body size, in bytes.
pub const MAX_BODY_BYTES: usize = 16 * 1024;
/// Max length of an `Idempotency-Key` header value.
pub const MAX_IDEMPOTENCY_KEY_LEN: usize = 255;
/// How many times the worker tries a request before marking it `failed`.
pub const DEFAULT_MAX_ATTEMPTS: i32 = 3;
/// Max stored length of internal error text and client-visible reasons.
pub const MAX_ERROR_CHARS: usize = 1_000;
pub const MAX_REASON_CHARS: usize = 500;

/// Lifecycle of a relay request (spec FR-7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestStatus {
    Pending,
    Active,
    Rejected,
    Expired,
    Failed,
}

impl RequestStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Active => "active",
            Self::Rejected => "rejected",
            Self::Expired => "expired",
            Self::Failed => "failed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "pending" => Self::Pending,
            "active" => Self::Active,
            "rejected" => Self::Rejected,
            "expired" => Self::Expired,
            "failed" => Self::Failed,
            _ => return None,
        })
    }
}

/// A customer agent's request as stored by the relay.
#[derive(Debug, Clone)]
pub struct RelayRequest {
    pub id: Uuid,
    /// The API client that submitted it. Used for ownership checks; never echoed.
    pub client_id: String,
    pub status: RequestStatus,
    pub question: String,
    /// Worker attempts so far (incremented when a worker claims the request).
    pub attempts: i32,
    /// Client-visible explanation for `rejected` / `failed`.
    pub status_reason: Option<String>,
    /// Pipeline output for `active` requests.
    pub result: Option<serde_json::Value>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Body of `POST /v1/requests`. Unknown fields are rejected.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateRequestBody {
    pub question: String,
}

/// What the API returns for a request. Internal fields such as `client_id` stay out.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RequestView {
    pub request_id: Uuid,
    pub status: RequestStatus,
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub status_url: String,
}

impl From<&RelayRequest> for RequestView {
    fn from(r: &RelayRequest) -> Self {
        Self {
            request_id: r.id,
            status: r.status,
            question: r.question.clone(),
            status_reason: r.status_reason.clone(),
            result: r.result.clone(),
            created_at: r.created_at,
            updated_at: r.updated_at,
            status_url: format!("/v1/requests/{}", r.id),
        }
    }
}

/// Truncate to at most `max` characters (never splits a UTF-8 character).
pub fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}
