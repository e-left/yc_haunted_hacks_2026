//! Phase 3: worker + state machine.
//!
//! Every scenario runs twice: on MemoryStore and on a fresh, throwaway Postgres
//! database (a queue test must not pick up another test's jobs). Needs the local
//! Postgres: `docker compose up -d --wait postgres`.

use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use lild_backend::{
    AppState,
    auth::{ApiKeyRecord, Scope, generate_api_key},
    build_app,
    model::{RelayRequest, RequestStatus},
    pg_store::PgStore,
    pipeline::{Pipeline, PipelineError, PipelineOutcome, StubPipeline},
    store::{CreateOutcome, Finish, MemoryStore, Store},
    worker::{RunOnce, WorkerConfig, run_once, run_worker},
};
use serde_json::{Value, json};
use tokio::sync::watch;
use tower::ServiceExt;
use uuid::Uuid;

// ---------- harness ----------

fn test_db_url() -> String {
    std::env::var("TEST_DATABASE_URL").unwrap_or_else(|_| {
        "postgres://lild:lild_dev_password@127.0.0.1:54329/lild_test".into()
    })
}

/// A throwaway database, dropped when the scenario finishes.
struct TempDb {
    name: String,
    store: Arc<PgStore>,
}

impl TempDb {
    async fn create() -> Self {
        let admin = PgStore::connect(&test_db_url()).await.unwrap_or_else(|e| {
            panic!("Postgres not reachable ({e}). Start it: docker compose up -d --wait postgres")
        });
        let name = format!("lild_p3_{}", Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE DATABASE {name}"))
            .execute(admin.pool())
            .await
            .unwrap();
        admin.pool().close().await;
        let url = test_db_url();
        let (base, _) = url.rsplit_once('/').expect("TEST_DATABASE_URL must end in /<database>");
        let store = PgStore::connect(&format!("{base}/{name}")).await.unwrap();
        store.migrate().await.unwrap();
        Self { name, store: Arc::new(store) }
    }

    async fn drop_db(self) {
        self.store.pool().close().await;
        let admin = PgStore::connect(&test_db_url()).await.unwrap();
        sqlx::query(&format!("DROP DATABASE IF EXISTS {} WITH (FORCE)", self.name))
            .execute(admin.pool())
            .await
            .unwrap();
    }
}

/// Run a scenario on the in-memory store, then on a fresh Postgres database.
async fn on_both<F, Fut>(scenario: F)
where
    F: Fn(Arc<dyn Store>, Option<Arc<PgStore>>) -> Fut,
    Fut: Future<Output = ()>,
{
    scenario(Arc::new(MemoryStore::new()), None).await;
    let db = TempDb::create().await;
    scenario(db.store.clone(), Some(db.store.clone())).await;
    db.drop_db().await;
}

fn cfg(worker_id: &str) -> WorkerConfig {
    WorkerConfig {
        worker_id: worker_id.into(),
        lease: Duration::from_secs(2),
        pipeline_timeout: Duration::from_millis(300),
        poll_interval: Duration::from_millis(20),
        base_backoff: Duration::from_millis(50),
        max_backoff: Duration::from_millis(200),
    }
}

async fn new_request(store: &Arc<dyn Store>, q: &str) -> Uuid {
    match store.create_request("agent-a", q, None).await.unwrap() {
        CreateOutcome::Created(r) => r.id,
        other => panic!("unexpected {other:?}"),
    }
}

async fn status(store: &Arc<dyn Store>, id: Uuid) -> RequestStatus {
    store.inspect_job(id).await.unwrap().unwrap().status
}

/// What the scripted pipeline does on the Nth call for a given request (0-based).
#[derive(Clone)]
enum Step {
    Ok,
    Reject(&'static str),
    Transient,
    Permanent,
    Hang,
    Panic,
}

/// Pipeline whose behavior is scripted per call, and which records every call.
struct Scripted {
    script: Box<dyn Fn(usize) -> Step + Send + Sync>,
    calls: Mutex<HashMap<Uuid, usize>>,
}

impl Scripted {
    fn new(script: impl Fn(usize) -> Step + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self { script: Box::new(script), calls: Mutex::new(HashMap::new()) })
    }
    fn calls_for(&self, id: Uuid) -> usize {
        self.calls.lock().unwrap().get(&id).copied().unwrap_or(0)
    }
}

#[async_trait]
impl Pipeline for Scripted {
    async fn process(&self, r: &RelayRequest) -> Result<PipelineOutcome, PipelineError> {
        let n = {
            let mut calls = self.calls.lock().unwrap();
            let c = calls.entry(r.id).or_default();
            *c += 1;
            *c - 1
        };
        match (self.script)(n) {
            Step::Ok => Ok(PipelineOutcome::Active { result: json!({ "call": n }) }),
            Step::Reject(reason) => Ok(PipelineOutcome::Rejected { reason: reason.into() }),
            Step::Transient => Err(PipelineError::Transient("upstream 503 (secret-host:5432)".into())),
            Step::Permanent => Err(PipelineError::Permanent("model returned garbage".into())),
            Step::Hang => {
                tokio::time::sleep(Duration::from_secs(30)).await;
                Ok(PipelineOutcome::Active { result: json!({}) })
            }
            Step::Panic => panic!("pipeline bug"),
        }
    }
}

/// Keep running `run_once` until the job leaves `pending` (or give up).
async fn drive_until_done(store: &Arc<dyn Store>, p: &Arc<dyn Pipeline>, id: Uuid) -> RequestStatus {
    for _ in 0..200 {
        run_once(store, p, &cfg("w1")).await.unwrap();
        let s = status(store, id).await;
        if s != RequestStatus::Pending {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("job {id} never finished");
}

// ---------- happy paths ----------

#[tokio::test]
async fn empty_queue_is_idle() {
    on_both(|store, _| async move {
        let p: Arc<dyn Pipeline> = Arc::new(StubPipeline);
        assert_eq!(run_once(&store, &p, &cfg("w1")).await.unwrap(), RunOnce::Idle);
    })
    .await;
}

#[tokio::test]
async fn pending_becomes_active_and_api_shows_result() {
    on_both(|store, _| async move {
        // Provision a key so we can check the HTTP view too.
        let k = generate_api_key();
        store
            .provision_api_key(ApiKeyRecord {
                client_id: "agent-a".into(),
                key_hash: k.hash,
                scopes: Scope::ALL.to_vec(),
                expires_at: None,
                revoked: false,
            })
            .await
            .unwrap();
        let id = new_request(&store, "shirts under 30 inches").await;
        let p: Arc<dyn Pipeline> = Arc::new(StubPipeline);

        let r = run_once(&store, &p, &cfg("w1")).await.unwrap();
        assert_eq!(r, RunOnce::Processed { id, status: Some(RequestStatus::Active) });

        let resp = build_app(AppState { store: store.clone() })
            .oneshot(
                Request::get(format!("/v1/requests/{id}"))
                    .header("authorization", format!("Bearer {}", k.plaintext))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(body["status"], "active");
        assert_eq!(body["result"]["simulated"], true, "stub output is labeled simulated");
        assert!(body.get("last_error").is_none() && body.get("attempts").is_none());
    })
    .await;
}

#[tokio::test]
async fn rejection_is_terminal_with_client_visible_reason() {
    on_both(|store, _| async move {
        let id = new_request(&store, "supplier costs please").await;
        let p: Arc<dyn Pipeline> = Scripted::new(|_| Step::Reject("private data requested"));
        assert_eq!(drive_until_done(&store, &p, id).await, RequestStatus::Rejected);
        let job = store.inspect_job(id).await.unwrap().unwrap();
        assert_eq!(job.status_reason.as_deref(), Some("private data requested"));
        assert_eq!(job.attempts, 1, "rejection is not retried");
    })
    .await;
}

// ---------- retries and failures ----------

#[tokio::test]
async fn transient_errors_retry_with_backoff_then_fail() {
    on_both(|store, _| async move {
        let id = new_request(&store, "q").await;
        let scripted = Scripted::new(|_| Step::Transient);
        let p: Arc<dyn Pipeline> = scripted.clone();

        // Attempt 1 fails -> back to pending, not immediately claimable (backoff).
        run_once(&store, &p, &cfg("w1")).await.unwrap();
        let job = store.inspect_job(id).await.unwrap().unwrap();
        assert_eq!((job.status, job.attempts), (RequestStatus::Pending, 1));
        assert!(job.next_attempt_at > chrono::Utc::now(), "backoff scheduled in the future");
        assert!(job.last_error.unwrap().contains("transient"));
        assert_eq!(run_once(&store, &p, &cfg("w1")).await.unwrap(), RunOnce::Idle, "not due yet");

        assert_eq!(drive_until_done(&store, &p, id).await, RequestStatus::Failed);
        let job = store.inspect_job(id).await.unwrap().unwrap();
        assert_eq!(job.attempts, 3);
        assert_eq!(scripted.calls_for(id), 3, "exactly max_attempts pipeline calls");
        let reason = job.status_reason.unwrap();
        assert_eq!(reason, "processing failed after 3 attempt(s)");
        assert!(!reason.contains("secret-host"), "internal error text never reaches the client");
    })
    .await;
}

#[tokio::test]
async fn transient_then_success_recovers() {
    on_both(|store, _| async move {
        let id = new_request(&store, "q").await;
        let p: Arc<dyn Pipeline> = Scripted::new(|n| if n == 0 { Step::Transient } else { Step::Ok });
        assert_eq!(drive_until_done(&store, &p, id).await, RequestStatus::Active);
        assert_eq!(store.inspect_job(id).await.unwrap().unwrap().attempts, 2);
    })
    .await;
}

#[tokio::test]
async fn permanent_error_fails_immediately() {
    on_both(|store, _| async move {
        let id = new_request(&store, "q").await;
        let p: Arc<dyn Pipeline> = Scripted::new(|_| Step::Permanent);
        assert_eq!(drive_until_done(&store, &p, id).await, RequestStatus::Failed);
        let job = store.inspect_job(id).await.unwrap().unwrap();
        assert_eq!(job.attempts, 1, "no retry for permanent errors");
        assert_eq!(job.status_reason.as_deref(), Some("processing failed"));
    })
    .await;
}

#[tokio::test]
async fn hanging_pipeline_times_out_into_a_retry_not_a_success() {
    on_both(|store, _| async move {
        let id = new_request(&store, "q").await;
        let p: Arc<dyn Pipeline> = Scripted::new(|n| if n == 0 { Step::Hang } else { Step::Ok });
        let started = std::time::Instant::now();
        run_once(&store, &p, &cfg("w1")).await.unwrap();
        assert!(started.elapsed() < Duration::from_secs(2), "bounded by pipeline_timeout");
        let job = store.inspect_job(id).await.unwrap().unwrap();
        assert_eq!(job.status, RequestStatus::Pending);
        assert!(job.last_error.unwrap().contains("timed out"));
        assert_eq!(drive_until_done(&store, &p, id).await, RequestStatus::Active);
    })
    .await;
}

#[tokio::test]
async fn panicking_pipeline_is_a_retry_and_worker_survives() {
    on_both(|store, _| async move {
        let id = new_request(&store, "q").await;
        let p: Arc<dyn Pipeline> = Scripted::new(|n| if n == 0 { Step::Panic } else { Step::Ok });
        run_once(&store, &p, &cfg("w1")).await.unwrap();
        let job = store.inspect_job(id).await.unwrap().unwrap();
        assert_eq!(job.status, RequestStatus::Pending);
        assert!(job.last_error.unwrap().contains("panicked"));
        assert_eq!(drive_until_done(&store, &p, id).await, RequestStatus::Active);
    })
    .await;
}

// ---------- crash recovery and fencing ----------

#[tokio::test]
async fn crashed_worker_lease_expires_and_stale_result_is_refused() {
    on_both(|store, _| async move {
        let id = new_request(&store, "q").await;

        // w1 claims, then "crashes" (never finishes).
        let claimed = store.claim_next("w1", Duration::from_millis(150)).await.unwrap().unwrap();
        assert_eq!(claimed.id, id);
        assert!(store.claim_next("w2", Duration::from_secs(2)).await.unwrap().is_none(),
            "live lease: nobody else can take it");

        tokio::time::sleep(Duration::from_millis(250)).await; // lease expires

        let p: Arc<dyn Pipeline> = Arc::new(StubPipeline);
        let r = run_once(&store, &p, &cfg("w2")).await.unwrap();
        assert_eq!(r, RunOnce::Processed { id, status: Some(RequestStatus::Active) });
        assert_eq!(store.inspect_job(id).await.unwrap().unwrap().attempts, 2, "crash counted");

        // w1 wakes up and tries to write its result: refused.
        let stale = store
            .finish_job(id, "w1", Finish::Rejected { reason: "stale".into() })
            .await
            .unwrap();
        assert_eq!(stale, None);
        assert_eq!(status(&store, id).await, RequestStatus::Active, "w2's result stands");
    })
    .await;
}

#[tokio::test]
async fn stale_worker_cannot_overwrite_while_new_owner_is_still_working() {
    // The dangerous fencing case: the job is still `pending` (w2 mid-flight), so only
    // the locked_by check stops w1's late write from clobbering it.
    on_both(|store, _| async move {
        let id = new_request(&store, "q").await;
        store.claim_next("w1", Duration::from_millis(100)).await.unwrap().unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await; // w1's lease expires
        store.claim_next("w2", Duration::from_secs(5)).await.unwrap().unwrap(); // w2 working

        for late in [
            Finish::Active { result: json!({"from": "w1"}) },
            Finish::Rejected { reason: "w1".into() },
            Finish::Fail { error: "w1".into() },
            Finish::Retry { error: "w1".into(), delay: Duration::ZERO },
        ] {
            assert_eq!(store.finish_job(id, "w1", late).await.unwrap(), None, "stale write refused");
        }
        let job = store.inspect_job(id).await.unwrap().unwrap();
        assert_eq!(job.status, RequestStatus::Pending);
        assert_eq!(job.locked_by.as_deref(), Some("w2"), "w2 still owns it");

        let done = store
            .finish_job(id, "w2", Finish::Active { result: json!({"from": "w2"}) })
            .await
            .unwrap();
        assert_eq!(done, Some(RequestStatus::Active));
    })
    .await;
}

#[tokio::test]
async fn poison_pill_that_crashes_every_worker_ends_failed() {
    on_both(|store, _| async move {
        let id = new_request(&store, "q").await;
        for w in ["w1", "w2", "w3"] {
            assert!(store.claim_next(w, Duration::from_millis(50)).await.unwrap().is_some());
            tokio::time::sleep(Duration::from_millis(80)).await; // each one "crashes"
        }
        // 3 attempts used up without anyone finishing: the next claim sweeps it to failed.
        assert!(store.claim_next("w4", Duration::from_secs(1)).await.unwrap().is_none());
        let job = store.inspect_job(id).await.unwrap().unwrap();
        assert_eq!(job.status, RequestStatus::Failed);
        assert_eq!(job.status_reason.as_deref(), Some("processing failed after 3 attempt(s)"));
    })
    .await;
}

// ---------- concurrency and shutdown ----------

#[tokio::test]
async fn many_workers_process_each_job_exactly_once() {
    on_both(|store, _| async move {
        let mut ids = vec![];
        for i in 0..30 {
            ids.push(new_request(&store, &format!("q{i}")).await);
        }
        let scripted = Scripted::new(|_| Step::Ok);
        let p: Arc<dyn Pipeline> = scripted.clone();
        let (tx, rx) = watch::channel(false);
        let handles: Vec<_> = (0..6)
            .map(|n| tokio::spawn(run_worker(store.clone(), p.clone(), cfg(&format!("w{n}")), rx.clone())))
            .collect();

        for _ in 0..300 {
            let mut done = 0;
            for id in &ids {
                if status(&store, *id).await == RequestStatus::Active {
                    done += 1;
                }
            }
            if done == ids.len() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tx.send(true).unwrap();
        for h in handles {
            tokio::time::timeout(Duration::from_secs(2), h).await.expect("worker stops on shutdown").unwrap();
        }
        for id in &ids {
            assert_eq!(status(&store, *id).await, RequestStatus::Active);
            assert_eq!(scripted.calls_for(*id), 1, "job {id} processed exactly once");
        }
    })
    .await;
}

#[tokio::test]
async fn worker_loop_survives_panics_and_store_errors() {
    on_both(|store, pg| async move {
        let id = new_request(&store, "q").await;
        let p: Arc<dyn Pipeline> = Scripted::new(|n| if n == 0 { Step::Panic } else { Step::Ok });
        let (tx, rx) = watch::channel(false);
        let h = tokio::spawn(run_worker(store.clone(), p, cfg("w1"), rx));
        for _ in 0..200 {
            if status(&store, id).await == RequestStatus::Active {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(status(&store, id).await, RequestStatus::Active);

        if let Some(pg) = pg {
            pg.pool().close().await; // database goes away under a running worker
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert!(!h.is_finished(), "store errors are logged, the worker keeps going");
        }
        tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(2), h).await.unwrap().unwrap();
    })
    .await;
}

// ---------- database-enforced state machine (Postgres only) ----------

#[tokio::test]
async fn database_refuses_illegal_transitions_and_mutations() {
    let db = TempDb::create().await;
    let store: Arc<dyn Store> = db.store.clone();
    let id = new_request(&store, "q").await;
    let p: Arc<dyn Pipeline> = Arc::new(StubPipeline);
    run_once(&store, &p, &cfg("w1")).await.unwrap();
    assert_eq!(status(&store, id).await, RequestStatus::Active);

    let pool = db.store.pool();
    let illegal = [
        ("active -> pending", "UPDATE lild.requests SET status = 'pending' WHERE id = $1"),
        ("active -> failed", "UPDATE lild.requests SET status = 'failed' WHERE id = $1"),
        ("change owner", "UPDATE lild.requests SET client_id = 'attacker' WHERE id = $1"),
        ("change question", "UPDATE lild.requests SET question = 'other' WHERE id = $1"),
        ("lock a terminal row",
         "UPDATE lild.requests SET locked_by = 'w9', locked_until = now() WHERE id = $1"),
    ];
    for (name, sql) in illegal {
        assert!(sqlx::query(sql).bind(id).execute(pool).await.is_err(), "{name} must be refused");
    }
    assert!(
        sqlx::query("UPDATE lild.requests SET status = 'expired' WHERE id = $1")
            .bind(id).execute(pool).await.is_ok(),
        "active -> expired is allowed (Phase 6)"
    );

    let pending = new_request(&store, "q2").await;
    assert!(
        sqlx::query("UPDATE lild.requests SET status = 'active' WHERE id = $1")
            .bind(pending).execute(pool).await.is_err(),
        "active without a result is refused"
    );
    db.drop_db().await;
}
