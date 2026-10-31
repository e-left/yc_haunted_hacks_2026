//! Storage behind a trait, so the HTTP layer, worker, and tests don't care whether
//! data lives in memory (Phase 1) or Postgres (Phase 2+).

use std::{collections::HashMap, time::Duration};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::Value;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    auth::ApiKeyRecord,
    model::{
        DEFAULT_MAX_ATTEMPTS, MAX_ERROR_CHARS, MAX_REASON_CHARS, RelayRequest, RequestStatus,
        truncate_chars,
    },
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

/// How a worker finished a claimed job.
#[derive(Debug, Clone)]
pub enum Finish {
    Active { result: Value },
    Rejected { reason: String },
    /// Try again after `delay`, unless attempts are exhausted (then `failed`).
    Retry { error: String, delay: Duration },
    /// Give up now. `error` is internal and never shown to the client.
    Fail { error: String },
}

/// The row update a [`Finish`] turns into. One function decides this for every
/// store, so in-memory and Postgres can't drift apart.
#[derive(Debug, Clone, PartialEq)]
pub struct FinishPlan {
    pub status: RequestStatus,
    pub status_reason: Option<String>,
    pub result: Option<Value>,
    pub last_error: Option<String>,
    pub retry_after: Option<Duration>,
}

pub fn plan_finish(attempts: i32, max_attempts: i32, finish: Finish) -> FinishPlan {
    let err = |e: &str| Some(truncate_chars(e, MAX_ERROR_CHARS));
    match finish {
        Finish::Active { result } => FinishPlan {
            status: RequestStatus::Active,
            status_reason: None,
            result: Some(result),
            last_error: None,
            retry_after: None,
        },
        Finish::Rejected { reason } => FinishPlan {
            status: RequestStatus::Rejected,
            status_reason: Some(truncate_chars(&reason, MAX_REASON_CHARS)),
            result: None,
            last_error: None,
            retry_after: None,
        },
        Finish::Retry { error, delay } if attempts < max_attempts => FinishPlan {
            status: RequestStatus::Pending,
            status_reason: None,
            result: None,
            last_error: err(&error),
            retry_after: Some(delay),
        },
        Finish::Retry { error, .. } => FinishPlan {
            status: RequestStatus::Failed,
            status_reason: Some(exhausted_reason(attempts)),
            result: None,
            last_error: err(&error),
            retry_after: None,
        },
        Finish::Fail { error } => FinishPlan {
            status: RequestStatus::Failed,
            status_reason: Some("processing failed".into()),
            result: None,
            last_error: err(&error),
            retry_after: None,
        },
    }
}

pub fn exhausted_reason(attempts: i32) -> String {
    format!("processing failed after {attempts} attempt(s)")
}

/// Internal view of a job, for operators and tests. Not exposed over the API.
#[derive(Debug, Clone)]
pub struct JobSnapshot {
    pub status: RequestStatus,
    pub attempts: i32,
    pub max_attempts: i32,
    pub locked_by: Option<String>,
    pub last_error: Option<String>,
    pub status_reason: Option<String>,
    pub next_attempt_at: DateTime<Utc>,
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

    // ----- job queue (Phase 3) -----

    /// Atomically claim the oldest due pending request for `worker_id` with a lease,
    /// incrementing its attempts. Two workers never get the same job while a lease is live.
    /// Also fails pending jobs whose attempts ran out while a crashed worker held them.
    async fn claim_next(
        &self,
        worker_id: &str,
        lease: Duration,
    ) -> Result<Option<RelayRequest>, StoreError>;

    /// Record the outcome, but only if `worker_id` still holds the job.
    /// Returns the new status, or `None` if the worker lost its lease (result discarded).
    async fn finish_job(
        &self,
        id: Uuid,
        worker_id: &str,
        finish: Finish,
    ) -> Result<Option<RequestStatus>, StoreError>;

    async fn inspect_job(&self, id: Uuid) -> Result<Option<JobSnapshot>, StoreError>;
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
    jobs: HashMap<Uuid, JobMeta>,
    idempotency: HashMap<(String, String), (Uuid, String)>, // (client, key) -> (request, body_hash)
}

#[derive(Debug, Clone)]
struct JobMeta {
    max_attempts: i32,
    next_attempt_at: DateTime<Utc>,
    locked_by: Option<String>,
    locked_until: Option<DateTime<Utc>>,
    last_error: Option<String>,
}

impl JobMeta {
    fn lease_free(&self, now: DateTime<Utc>) -> bool {
        self.locked_until.is_none_or(|t| t < now)
    }
}

fn chrono_dur(d: Duration) -> chrono::Duration {
    chrono::Duration::from_std(d).unwrap_or(chrono::Duration::MAX)
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
                let existing = inner.requests.get(existing_id).cloned().ok_or_else(|| {
                    StoreError("idempotency record points to missing request".into())
                })?;
                return Ok(CreateOutcome::Replayed(existing));
            }
        }

        let now = Utc::now();
        let req = RelayRequest {
            id: Uuid::new_v4(),
            client_id: client_id.to_string(),
            status: RequestStatus::Pending,
            question: question.to_string(),
            attempts: 0,
            status_reason: None,
            result: None,
            created_at: now,
            updated_at: now,
        };
        inner.requests.insert(req.id, req.clone());
        inner.jobs.insert(
            req.id,
            JobMeta {
                max_attempts: DEFAULT_MAX_ATTEMPTS,
                next_attempt_at: now,
                locked_by: None,
                locked_until: None,
                last_error: None,
            },
        );
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

    async fn claim_next(
        &self,
        worker_id: &str,
        lease: Duration,
    ) -> Result<Option<RelayRequest>, StoreError> {
        let mut guard = self.inner.lock().await;
        let inner = &mut *guard;
        let now = Utc::now();

        // Sweep: out of attempts and nobody holds a live lease -> failed.
        for (id, job) in inner.jobs.iter_mut() {
            let req = inner.requests.get_mut(id).expect("job without request");
            if req.status == RequestStatus::Pending
                && req.attempts >= job.max_attempts
                && job.lease_free(now)
            {
                req.status = RequestStatus::Failed;
                req.status_reason = Some(exhausted_reason(req.attempts));
                req.updated_at = now;
                job.locked_by = None;
                job.locked_until = None;
            }
        }

        let next = inner
            .jobs
            .iter()
            .filter(|(id, job)| {
                let req = &inner.requests[*id];
                req.status == RequestStatus::Pending
                    && req.attempts < job.max_attempts
                    && job.next_attempt_at <= now
                    && job.lease_free(now)
            })
            .min_by_key(|(id, job)| (job.next_attempt_at, inner.requests[*id].created_at))
            .map(|(id, _)| *id);

        let Some(id) = next else { return Ok(None) };
        let job = inner.jobs.get_mut(&id).unwrap();
        job.locked_by = Some(worker_id.to_string());
        job.locked_until = Some(now + chrono_dur(lease));
        let req = inner.requests.get_mut(&id).unwrap();
        req.attempts += 1;
        req.updated_at = now;
        Ok(Some(req.clone()))
    }

    async fn finish_job(
        &self,
        id: Uuid,
        worker_id: &str,
        finish: Finish,
    ) -> Result<Option<RequestStatus>, StoreError> {
        let mut guard = self.inner.lock().await;
        let inner = &mut *guard;
        let (Some(req), Some(job)) = (inner.requests.get_mut(&id), inner.jobs.get_mut(&id)) else {
            return Ok(None);
        };
        if req.status != RequestStatus::Pending || job.locked_by.as_deref() != Some(worker_id) {
            return Ok(None); // lost the lease: someone else owns this job now
        }
        let plan = plan_finish(req.attempts, job.max_attempts, finish);
        let now = Utc::now();
        req.status = plan.status;
        req.status_reason = plan.status_reason;
        req.result = plan.result;
        req.updated_at = now;
        if plan.last_error.is_some() {
            job.last_error = plan.last_error;
        }
        if let Some(d) = plan.retry_after {
            job.next_attempt_at = now + chrono_dur(d);
        }
        job.locked_by = None;
        job.locked_until = None;
        Ok(Some(req.status))
    }

    async fn inspect_job(&self, id: Uuid) -> Result<Option<JobSnapshot>, StoreError> {
        let inner = self.inner.lock().await;
        Ok(inner.requests.get(&id).zip(inner.jobs.get(&id)).map(|(r, j)| JobSnapshot {
            status: r.status,
            attempts: r.attempts,
            max_attempts: j.max_attempts,
            locked_by: j.locked_by.clone(),
            last_error: j.last_error.clone(),
            status_reason: r.status_reason.clone(),
            next_attempt_at: j.next_attempt_at,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn retry_before_limit_stays_pending_with_backoff() {
        let p = plan_finish(1, 3, Finish::Retry { error: "boom".into(), delay: Duration::from_secs(2) });
        assert_eq!(p.status, RequestStatus::Pending);
        assert_eq!(p.retry_after, Some(Duration::from_secs(2)));
        assert_eq!(p.last_error.as_deref(), Some("boom"));
        assert_eq!(p.status_reason, None);
    }

    #[test]
    fn retry_at_limit_fails_with_generic_reason() {
        let p = plan_finish(3, 3, Finish::Retry { error: "db password wrong".into(), delay: Duration::ZERO });
        assert_eq!(p.status, RequestStatus::Failed);
        assert_eq!(p.status_reason.as_deref(), Some("processing failed after 3 attempt(s)"));
        assert!(!p.status_reason.unwrap().contains("password"), "internal error never in reason");
    }

    #[test]
    fn errors_and_reasons_are_truncated() {
        let p = plan_finish(1, 3, Finish::Fail { error: "x".repeat(5000) });
        assert_eq!(p.last_error.unwrap().chars().count(), MAX_ERROR_CHARS);
        let p = plan_finish(1, 3, Finish::Rejected { reason: "é".repeat(5000) });
        assert_eq!(p.status_reason.unwrap().chars().count(), MAX_REASON_CHARS);
    }

    #[test]
    fn active_carries_result() {
        let p = plan_finish(1, 3, Finish::Active { result: json!({"ok": true}) });
        assert_eq!(p.status, RequestStatus::Active);
        assert_eq!(p.result, Some(json!({"ok": true})));
    }
}
