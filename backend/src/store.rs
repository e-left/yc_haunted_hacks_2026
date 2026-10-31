//! Storage behind a trait, so Phase 2 can swap the in-memory version for Postgres
//! without touching the HTTP layer or the tests.

use std::collections::HashMap;

use async_trait::async_trait;
use chrono::Utc;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    auth::ApiKeyRecord,
    model::{RelayRequest, RequestStatus},
};

#[derive(Debug, thiserror::Error)]
#[error("store error: {0}")]
pub struct StoreError(pub String);

/// The caller's idempotency key plus a hash of the body it was sent with.
#[derive(Debug, Clone)]
pub struct Idempotency {
    pub key: String,
    pub body_hash: String,
}

#[derive(Debug)]
pub enum CreateOutcome {
    /// A new request was stored.
    Created(RelayRequest),
    /// Same client, key, and body as before: return the original request.
    Replayed(RelayRequest),
    /// Same client and key, but a different body.
    Conflict,
}

#[async_trait]
pub trait Store: Send + Sync {
    /// Is the backing storage reachable? Used by `/v1/ready`.
    async fn ping(&self) -> Result<(), StoreError> {
        Ok(())
    }

    /// Add a key if its hash is not already known. An existing key is never modified,
    /// so restarting with the same config can't un-revoke or re-scope a key.
    /// Returns true if the key was inserted.
    async fn provision_api_key(&self, record: ApiKeyRecord) -> Result<bool, StoreError>;

    async fn find_api_key(&self, key_hash: &str) -> Result<Option<ApiKeyRecord>, StoreError>;

    /// Store a new pending request. The idempotency check and the insert must be
    /// atomic, so two concurrent retries can't both create a request.
    async fn create_request(
        &self,
        client_id: &str,
        question: &str,
        idempotency: Option<Idempotency>,
    ) -> Result<CreateOutcome, StoreError>;

    /// Return the request only if `client_id` owns it.
    async fn get_request(
        &self,
        client_id: &str,
        id: Uuid,
    ) -> Result<Option<RelayRequest>, StoreError>;
}

/// In-memory store for Phase 1 and for tests. Data is lost on restart.
#[derive(Default)]
pub struct MemoryStore {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    api_keys: HashMap<String, ApiKeyRecord>, // key_hash -> record
    requests: HashMap<Uuid, RelayRequest>,
    idempotency: HashMap<(String, String), (Uuid, String)>, // (client, key) -> (request, body_hash)
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn insert_api_key(&self, record: ApiKeyRecord) {
        self.inner
            .lock()
            .await
            .api_keys
            .insert(record.key_hash.clone(), record);
    }
}

#[async_trait]
impl Store for MemoryStore {
    async fn provision_api_key(&self, record: ApiKeyRecord) -> Result<bool, StoreError> {
        let mut inner = self.inner.lock().await;
        if inner.api_keys.contains_key(&record.key_hash) {
            return Ok(false);
        }
        inner.api_keys.insert(record.key_hash.clone(), record);
        Ok(true)
    }

    async fn find_api_key(&self, key_hash: &str) -> Result<Option<ApiKeyRecord>, StoreError> {
        Ok(self.inner.lock().await.api_keys.get(key_hash).cloned())
    }

    async fn create_request(
        &self,
        client_id: &str,
        question: &str,
        idempotency: Option<Idempotency>,
    ) -> Result<CreateOutcome, StoreError> {
        // One lock for the whole operation makes the check-then-insert atomic.
        let mut inner = self.inner.lock().await;

        if let Some(idem) = &idempotency {
            let k = (client_id.to_string(), idem.key.clone());
            if let Some((existing_id, body_hash)) = inner.idempotency.get(&k) {
                if *body_hash != idem.body_hash {
                    return Ok(CreateOutcome::Conflict);
                }
                let existing = inner
                    .requests
                    .get(existing_id)
                    .cloned()
                    .ok_or_else(|| StoreError("idempotency record points to missing request".into()))?;
                return Ok(CreateOutcome::Replayed(existing));
            }
        }

        let now = Utc::now();
        let req = RelayRequest {
            id: Uuid::new_v4(),
            client_id: client_id.to_string(),
            status: RequestStatus::Pending,
            question: question.to_string(),
            created_at: now,
            updated_at: now,
        };
        inner.requests.insert(req.id, req.clone());
        if let Some(idem) = idempotency {
            inner
                .idempotency
                .insert((client_id.to_string(), idem.key), (req.id, idem.body_hash));
        }
        Ok(CreateOutcome::Created(req))
    }

    async fn get_request(
        &self,
        client_id: &str,
        id: Uuid,
    ) -> Result<Option<RelayRequest>, StoreError> {
        Ok(self
            .inner
            .lock()
            .await
            .requests
            .get(&id)
            .filter(|r| r.client_id == client_id)
            .cloned())
    }
}
