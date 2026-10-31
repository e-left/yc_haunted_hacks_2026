//! The work done for each request: plan, validate, review, create the API.
//! Phase 3 has only a stub. Phases 4-6 replace it with the real pipeline.

use async_trait::async_trait;
use serde_json::{Value, json};

use crate::model::RelayRequest;

#[derive(Debug, Clone)]
pub enum PipelineOutcome {
    /// The temporary API is ready. `result` is shown to the client.
    Active { result: Value },
    /// A deliberate "no" (e.g. private data requested). `reason` is shown to the client.
    Rejected { reason: String },
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum PipelineError {
    /// Worth retrying: timeouts, rate limits, a dependency briefly down.
    #[error("transient: {0}")]
    Transient(String),
    /// Retrying won't help: malformed model output, invalid configuration.
    #[error("permanent: {0}")]
    Permanent(String),
}

#[async_trait]
pub trait Pipeline: Send + Sync {
    async fn process(&self, request: &RelayRequest) -> Result<PipelineOutcome, PipelineError>;
}

/// Phase 3 placeholder: marks every request active with a result that is clearly
/// labeled as simulated (spec: simulated behavior must be identified).
pub struct StubPipeline;

#[async_trait]
impl Pipeline for StubPipeline {
    async fn process(&self, request: &RelayRequest) -> Result<PipelineOutcome, PipelineError> {
        Ok(PipelineOutcome::Active {
            result: json!({
                "simulated": true,
                "note": "Phase 3 stub pipeline: no plan, review, or temporary API yet",
                "request_id": request.id,
            }),
        })
    }
}
