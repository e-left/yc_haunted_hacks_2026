//! API-key authentication for customer agents.
//!
//! - Keys are 32 random bytes from the OS CSPRNG, hex-encoded, with a `lild_live_` prefix.
//! - Only the SHA-256 hash is stored. A fast hash is fine here because the key has
//!   256 bits of entropy, so it can't be brute-forced (unlike a password).
//! - Keys carry scopes, an optional expiry, and can be revoked.

use axum::{extract::FromRequestParts, http::request::Parts};
use chrono::{DateTime, Utc};
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::{AppState, error::ApiError};

pub const KEY_PREFIX: &str = "lild_live_";
const KEY_RANDOM_BYTES: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    RequestsCreate,
    RequestsRead,
}

impl Scope {
    pub const ALL: [Scope; 2] = [Scope::RequestsCreate, Scope::RequestsRead];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::RequestsCreate => "requests:create",
            Self::RequestsRead => "requests:read",
        }
    }

    /// Unknown scope strings return `None` and are dropped (least privilege).
    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|scope| scope.as_str() == s)
    }
}

/// Client IDs: 1-64 chars of `A-Z a-z 0-9 . _ -` (same rule as the DB constraint).
pub fn is_valid_client_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// What the store keeps about a key. It never holds the plaintext.
#[derive(Debug, Clone)]
pub struct ApiKeyRecord {
    pub client_id: String,
    pub key_hash: String,
    pub scopes: Vec<Scope>,
    pub expires_at: Option<DateTime<Utc>>,
    pub revoked: bool,
}

impl ApiKeyRecord {
    pub fn is_usable(&self, now: DateTime<Utc>) -> bool {
        !self.revoked && self.expires_at.is_none_or(|exp| now < exp)
    }
}

/// A freshly generated key. Show `plaintext` to the user once, then store only `hash`.
pub struct GeneratedKey {
    pub plaintext: String,
    pub hash: String,
}

pub fn generate_api_key() -> GeneratedKey {
    let mut bytes = [0u8; KEY_RANDOM_BYTES];
    rand::rng().fill_bytes(&mut bytes);
    let plaintext = format!("{KEY_PREFIX}{}", hex::encode(bytes));
    let hash = hash_key(&plaintext);
    GeneratedKey { plaintext, hash }
}

pub fn hash_key(plaintext: &str) -> String {
    hex::encode(Sha256::digest(plaintext.as_bytes()))
}

/// The authenticated caller, available to any handler that takes it as an argument.
#[derive(Debug, Clone)]
pub struct AuthClient {
    pub client_id: String,
    pub scopes: Vec<Scope>,
}

impl AuthClient {
    pub fn require(&self, scope: Scope) -> Result<(), ApiError> {
        if self.scopes.contains(&scope) {
            Ok(())
        } else {
            Err(ApiError::Forbidden)
        }
    }
}

/// Pull the token out of `Authorization: Bearer <token>`.
fn bearer_token(parts: &Parts) -> Option<&str> {
    let value = parts.headers.get(axum::http::header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    token.starts_with(KEY_PREFIX).then_some(token)
}

impl FromRequestParts<AppState> for AuthClient {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let token = bearer_token(parts).ok_or(ApiError::Unauthorized)?;
        // Look up by hash. The plaintext is never compared or stored.
        let record = state
            .store
            .find_api_key(&hash_key(token))
            .await
            .map_err(|e| ApiError::Internal(e.to_string()))?
            .ok_or(ApiError::Unauthorized)?;

        if !record.is_usable(Utc::now()) {
            return Err(ApiError::Unauthorized);
        }
        Ok(AuthClient {
            client_id: record.client_id,
            scopes: record.scopes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    #[test]
    fn generated_key_has_prefix_and_256_bits() {
        let k = generate_api_key();
        assert!(k.plaintext.starts_with(KEY_PREFIX));
        assert_eq!(k.plaintext.len(), KEY_PREFIX.len() + KEY_RANDOM_BYTES * 2);
    }

    #[test]
    fn keys_are_unique_and_hash_is_deterministic() {
        let a = generate_api_key();
        let b = generate_api_key();
        assert_ne!(a.plaintext, b.plaintext);
        assert_eq!(hash_key(&a.plaintext), a.hash);
        assert_ne!(a.hash, a.plaintext, "hash must not equal plaintext");
    }

    #[test]
    fn revoked_or_expired_keys_are_unusable() {
        let now = Utc::now();
        let mut r = ApiKeyRecord {
            client_id: "c".into(),
            key_hash: "h".into(),
            scopes: vec![],
            expires_at: None,
            revoked: false,
        };
        assert!(r.is_usable(now));
        r.expires_at = Some(now - Duration::seconds(1));
        assert!(!r.is_usable(now));
        r.expires_at = Some(now + Duration::hours(1));
        assert!(r.is_usable(now));
        r.revoked = true;
        assert!(!r.is_usable(now));
    }
}
