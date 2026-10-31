//! LI/LD backend: the relay between customer agents and the merchant pipeline.
//! See `docs/PHASES.md` for the build plan.

pub mod auth;
pub mod error;
pub mod mcp;
pub mod model;
pub mod pg_store;
pub mod pipeline;
pub mod routes;
pub mod store;
pub mod worker;

use std::sync::Arc;

use axum::{
    Router,
    extract::DefaultBodyLimit,
    routing::{get, post},
};
use tower_http::trace::TraceLayer;

use crate::store::Store;

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<dyn Store>,
}

pub fn build_app(state: AppState) -> Router {
    Router::new()
        .route("/v1/health", get(routes::health))
        .route("/v1/ready", get(routes::ready))
        .route("/v1/requests", post(routes::create_request))
        .route("/v1/requests/{id}", get(routes::get_request))
        .layer(DefaultBodyLimit::max(model::MAX_BODY_BYTES))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
