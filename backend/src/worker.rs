//! Background worker: claims pending requests, runs the pipeline, records the outcome.
//!
//! Reliability rules:
//! - **Lease:** a claimed job belongs to this worker until `lease` runs out. If the
//!   worker crashes, the lease expires and another worker picks the job up.
//! - **Fencing:** a worker that lost its lease can't overwrite the new owner's result.
//! - **Timeout:** the pipeline gets at most `pipeline_timeout`; a hang becomes a retry.
//! - **Isolation:** the pipeline runs in its own task, so a panic is a retry, not a dead worker.
//! - **Bounded retries:** exponential backoff with jitter, then `failed`. Never a silent success.

use std::{sync::Arc, time::Duration};

use rand::Rng;
use tokio::sync::watch;
use uuid::Uuid;

use crate::{
    model::{RelayRequest, RequestStatus},
    pipeline::{Pipeline, PipelineError, PipelineOutcome},
    store::{Finish, Store, StoreError},
};

#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub worker_id: String,
    /// How long a claim is valid. Must be longer than `pipeline_timeout`.
    pub lease: Duration,
    pub pipeline_timeout: Duration,
    /// Sleep between polls when the queue is empty.
    pub poll_interval: Duration,
    pub base_backoff: Duration,
    pub max_backoff: Duration,
}

impl WorkerConfig {
    pub fn new(worker_id: impl Into<String>) -> Self {
        Self {
            worker_id: worker_id.into(),
            lease: Duration::from_secs(60),
            pipeline_timeout: Duration::from_secs(30),
            poll_interval: Duration::from_millis(500),
            base_backoff: Duration::from_secs(1),
            max_backoff: Duration::from_secs(30),
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.lease <= self.pipeline_timeout {
            return Err("lease must be longer than pipeline_timeout, or a slow job could be claimed twice".into());
        }
        if self.worker_id.is_empty() {
            return Err("worker_id must not be empty".into());
        }
        Ok(())
    }

    /// Exponential backoff for the attempt that just failed (1-based), capped,
    /// plus up to 20% random jitter so retries from many jobs don't sync up.
    pub fn backoff(&self, attempt: i32) -> Duration {
        let exp = 2u32.saturating_pow(attempt.saturating_sub(1).clamp(0, 16) as u32);
        let base = self.base_backoff.saturating_mul(exp).min(self.max_backoff);
        let jitter = base.mul_f64(rand::rng().random_range(0.0..0.2));
        base + jitter
    }
}

#[derive(Debug, PartialEq)]
pub enum RunOnce {
    /// Nothing was due.
    Idle,
    /// A job was processed. `status` is `None` if this worker lost the lease.
    Processed { id: Uuid, status: Option<RequestStatus> },
}

/// Claim and process at most one job. Tests drive the worker step by step with this.
pub async fn run_once(
    store: &Arc<dyn Store>,
    pipeline: &Arc<dyn Pipeline>,
    cfg: &WorkerConfig,
) -> Result<RunOnce, StoreError> {
    let Some(job) = store.claim_next(&cfg.worker_id, cfg.lease).await? else {
        return Ok(RunOnce::Idle);
    };
    let finish = execute(pipeline, &job, cfg).await;
    tracing::info!(request_id = %job.id, attempt = job.attempts, outcome = finish_label(&finish), "job processed");

    // If this write fails (e.g. DB down), the job stays leased and is retried by
    // whichever worker claims it after the lease expires. Nothing is lost.
    let status = store.finish_job(job.id, &cfg.worker_id, finish).await?;
    if status.is_none() {
        tracing::warn!(request_id = %job.id, worker = %cfg.worker_id, "lease lost; result discarded");
    }
    Ok(RunOnce::Processed { id: job.id, status })
}

async fn execute(pipeline: &Arc<dyn Pipeline>, job: &RelayRequest, cfg: &WorkerConfig) -> Finish {
    let retry = |error: String| Finish::Retry { error, delay: cfg.backoff(job.attempts) };

    let (p, j) = (pipeline.clone(), job.clone());
    let mut handle = tokio::spawn(async move { p.process(&j).await });

    match tokio::time::timeout(cfg.pipeline_timeout, &mut handle).await {
        Err(_) => {
            handle.abort();
            retry(format!("pipeline timed out after {:?}", cfg.pipeline_timeout))
        }
        Ok(Err(join_err)) => retry(format!(
            "pipeline {}",
            if join_err.is_panic() { "panicked" } else { "was cancelled" }
        )),
        Ok(Ok(Ok(PipelineOutcome::Active { result }))) => Finish::Active { result },
        Ok(Ok(Ok(PipelineOutcome::Rejected { reason }))) => Finish::Rejected { reason },
        Ok(Ok(Err(PipelineError::Transient(e)))) => retry(format!("transient: {e}")),
        Ok(Ok(Err(PipelineError::Permanent(e)))) => Finish::Fail { error: format!("permanent: {e}") },
    }
}

fn finish_label(f: &Finish) -> &'static str {
    match f {
        Finish::Active { .. } => "active",
        Finish::Rejected { .. } => "rejected",
        Finish::Retry { .. } => "retry",
        Finish::Fail { .. } => "fail",
    }
}

/// Loop until `shutdown` becomes true. Store errors are logged and retried after
/// `poll_interval`; they never crash the worker.
pub async fn run_worker(
    store: Arc<dyn Store>,
    pipeline: Arc<dyn Pipeline>,
    cfg: WorkerConfig,
    mut shutdown: watch::Receiver<bool>,
) {
    tracing::info!(worker = %cfg.worker_id, "worker started");
    while !*shutdown.borrow() {
        let idle = match run_once(&store, &pipeline, &cfg).await {
            Ok(RunOnce::Processed { .. }) => false,
            Ok(RunOnce::Idle) => true,
            Err(e) => {
                tracing::error!(worker = %cfg.worker_id, error = %e, "worker store error");
                true
            }
        };
        if idle {
            tokio::select! {
                _ = tokio::time::sleep(cfg.poll_interval) => {}
                _ = shutdown.changed() => {}
            }
        }
    }
    tracing::info!(worker = %cfg.worker_id, "worker stopped");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_and_is_capped() {
        let mut cfg = WorkerConfig::new("w");
        cfg.base_backoff = Duration::from_millis(100);
        cfg.max_backoff = Duration::from_millis(1000);
        let within = |d: Duration, base_ms: u64| {
            d >= Duration::from_millis(base_ms) && d <= Duration::from_millis(base_ms * 12 / 10)
        };
        assert!(within(cfg.backoff(1), 100));
        assert!(within(cfg.backoff(2), 200));
        assert!(within(cfg.backoff(3), 400));
        assert!(within(cfg.backoff(10), 1000), "capped at max_backoff");
        assert!(within(cfg.backoff(i32::MAX), 1000), "no overflow");
    }

    #[test]
    fn lease_must_exceed_pipeline_timeout() {
        let mut cfg = WorkerConfig::new("w");
        assert!(cfg.validate().is_ok());
        cfg.lease = cfg.pipeline_timeout;
        assert!(cfg.validate().is_err());
    }
}
