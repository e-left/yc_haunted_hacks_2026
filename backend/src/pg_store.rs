//! Postgres implementation of [`Store`] (Phase 2). Works with local Postgres or Supabase.
//!
//! Reliability choices:
//! - Every wait is bounded: 5s to connect or get a pooled connection, 5s per SQL statement.
//!   A slow or dead database becomes a visible error, never a hang (spec FR-9).
//! - Idempotent creation is one transaction guarded by the `idempotency_keys` primary
//!   key, so concurrent retries can't create duplicates.

use std::{str::FromStr, time::Duration};

use sqlx::types::Json;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::{
    PgPool, Row,
    postgres::{PgConnectOptions, PgPoolOptions, PgRow},
};
use uuid::Uuid;

use crate::{
    auth::{ApiKeyRecord, Scope},
    model::{RelayRequest, RequestStatus},
    store::{
        CreateOutcome, Finish, Idempotency, JobSnapshot, Store, StoreError, exhausted_reason,
        plan_finish,
    },
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const STATEMENT_TIMEOUT_MS: &str = "5000";

pub struct PgStore {
    pool: PgPool,
}

fn db_err(e: impl std::fmt::Display) -> StoreError {
    StoreError(e.to_string())
}

impl PgStore {
    /// Connect (bounded by [`CONNECT_TIMEOUT`]). Doesn't run migrations; call [`Self::migrate`].
    pub async fn connect(database_url: &str) -> Result<Self, StoreError> {
        let options = PgConnectOptions::from_str(database_url)
            .map_err(|e| StoreError(format!("invalid DATABASE_URL: {e}")))?
            // Pin search_path: Postgres defaults to `"$user", public`, and our role and
            // schema can share a name (`lild`), which would silently move unqualified
            // tables (like sqlx's `_sqlx_migrations`) between schemas. All app SQL is
            // schema-qualified anyway.
            .options([("statement_timeout", STATEMENT_TIMEOUT_MS), ("search_path", "public")])
            .application_name("lild-backend");
        let pool = tokio::time::timeout(
            CONNECT_TIMEOUT,
            PgPoolOptions::new()
                .max_connections(10)
                .acquire_timeout(CONNECT_TIMEOUT)
                .connect_with(options),
        )
        .await
        .map_err(|_| StoreError("timed out connecting to database".into()))?
        .map_err(db_err)?;
        Ok(Self { pool })
    }

    /// Apply `migrations/*.sql`. Safe to run on every startup and from several processes at once.
    pub async fn migrate(&self) -> Result<(), StoreError> {
        sqlx::migrate!("./migrations")
            .run(&self.pool)
            .await
            .map_err(db_err)
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }
}

fn row_to_request(row: &PgRow) -> Result<RelayRequest, StoreError> {
    let status: String = row.try_get("status").map_err(db_err)?;
    Ok(RelayRequest {
        id: row.try_get("id").map_err(db_err)?,
        client_id: row.try_get("client_id").map_err(db_err)?,
        status: parse_status(&status)?,
        question: row.try_get("question").map_err(db_err)?,
        attempts: row.try_get("attempts").map_err(db_err)?,
        status_reason: row.try_get("status_reason").map_err(db_err)?,
        result: row
            .try_get::<Option<Json<serde_json::Value>>, _>("result")
            .map_err(db_err)?
            .map(|j| j.0),
        created_at: row.try_get("created_at").map_err(db_err)?,
        updated_at: row.try_get("updated_at").map_err(db_err)?,
    })
}

const REQUEST_COLS: &str = "r.id, r.client_id, r.status, r.question, r.attempts, \
    r.status_reason, r.result, r.created_at, r.updated_at";

fn parse_status(s: &str) -> Result<RequestStatus, StoreError> {
    RequestStatus::parse(s).ok_or_else(|| StoreError(format!("unknown status in DB: {s}")))
}

fn millis(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

#[async_trait]
impl Store for PgStore {
    async fn ping(&self) -> Result<(), StoreError> {
        sqlx::query("SELECT 1").execute(&self.pool).await.map_err(db_err)?;
        Ok(())
    }

    async fn provision_api_key(&self, record: ApiKeyRecord) -> Result<bool, StoreError> {
        let scopes: Vec<&str> = record.scopes.iter().map(|s| s.as_str()).collect();
        let result = sqlx::query(
            "INSERT INTO lild.api_keys (key_hash, client_id, scopes, expires_at, revoked_at)
             VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() END)
             ON CONFLICT (key_hash) DO NOTHING",
        )
        .bind(&record.key_hash)
        .bind(&record.client_id)
        .bind(&scopes)
        .bind(record.expires_at)
        .bind(record.revoked)
        .execute(&self.pool)
        .await
        .map_err(db_err)?;
        Ok(result.rows_affected() == 1)
    }

    async fn find_api_key(&self, key_hash: &str) -> Result<Option<ApiKeyRecord>, StoreError> {
        let row = sqlx::query(
            "SELECT client_id, key_hash, scopes, expires_at, revoked_at IS NOT NULL AS revoked
             FROM lild.api_keys WHERE key_hash = $1",
        )
        .bind(key_hash)
        .fetch_optional(&self.pool)
        .await
        .map_err(db_err)?;

        row.map(|row| {
            let scopes: Vec<String> = row.try_get("scopes").map_err(db_err)?;
            Ok(ApiKeyRecord {
                client_id: row.try_get("client_id").map_err(db_err)?,
                key_hash: row.try_get("key_hash").map_err(db_err)?,
                scopes: scopes.iter().filter_map(|s| Scope::parse(s)).collect(),
                expires_at: row.try_get::<Option<DateTime<Utc>>, _>("expires_at").map_err(db_err)?,
                revoked: row.try_get("revoked").map_err(db_err)?,
            })
        })
        .transpose()
    }

    async fn create_request(
        &self,
        client_id: &str,
        question: &str,
        idempotency: Option<Idempotency>,
    ) -> Result<CreateOutcome, StoreError> {
        let mut tx = self.pool.begin().await.map_err(db_err)?;

        let row = sqlx::query(&format!(
            "INSERT INTO lild.requests AS r (id, client_id, status, question)
             VALUES ($1, $2, 'pending', $3)
             RETURNING {REQUEST_COLS}"
        ))
        .bind(Uuid::new_v4())
        .bind(client_id)
        .bind(question)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_err)?;
        let created = row_to_request(&row)?;

        if let Some(idem) = &idempotency {
            // If another transaction holds this (client, key), Postgres makes us wait
            // until it commits, then DO NOTHING applies. Exactly one request wins.
            let inserted = sqlx::query(
                "INSERT INTO lild.idempotency_keys (client_id, key, body_hash, request_id)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (client_id, key) DO NOTHING",
            )
            .bind(client_id)
            .bind(&idem.key)
            .bind(&idem.body_hash)
            .bind(created.id)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?
            .rows_affected();

            if inserted == 0 {
                // Lost the race, or this is a retry: discard our request, return the original.
                tx.rollback().await.map_err(db_err)?;
                let row = sqlx::query(&format!(
                    "SELECT k.body_hash, {REQUEST_COLS}
                     FROM lild.idempotency_keys k JOIN lild.requests r ON r.id = k.request_id
                     WHERE k.client_id = $1 AND k.key = $2"
                ))
                .bind(client_id)
                .bind(&idem.key)
                .fetch_one(&self.pool)
                .await
                .map_err(db_err)?;
                let body_hash: String = row.try_get("body_hash").map_err(db_err)?;
                return Ok(if body_hash == idem.body_hash {
                    CreateOutcome::Replayed(row_to_request(&row)?)
                } else {
                    CreateOutcome::Conflict
                });
            }
        }

        tx.commit().await.map_err(db_err)?;
        Ok(CreateOutcome::Created(created))
    }

    async fn get_request(
        &self,
        client_id: &str,
        id: Uuid,
    ) -> Result<Option<RelayRequest>, StoreError> {
        // Ownership is part of the WHERE clause, so other clients' rows are never loaded.
        sqlx::query(&format!(
            "SELECT {REQUEST_COLS} FROM lild.requests r WHERE r.id = $1 AND r.client_id = $2"
        ))
        .bind(id)
        .bind(client_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(db_err)?
        .as_ref()
        .map(row_to_request)
        .transpose()
    }

    async fn claim_next(
        &self,
        worker_id: &str,
        lease: Duration,
    ) -> Result<Option<RelayRequest>, StoreError> {
        // Sweep: jobs out of attempts whose lease is gone (worker crashed) -> failed.
        // The exhausted reason is built in Rust so both stores word it identically.
        // The UPDATE re-checks every condition, so a race with another worker is harmless.
        let exhausted = sqlx::query(
            "SELECT id, attempts FROM lild.requests
             WHERE status = 'pending' AND attempts >= max_attempts
               AND (locked_until IS NULL OR locked_until < now())",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(db_err)?;
        for row in exhausted {
            let id: Uuid = row.try_get("id").map_err(db_err)?;
            let attempts: i32 = row.try_get("attempts").map_err(db_err)?;
            sqlx::query(
                "UPDATE lild.requests SET status = 'failed', status_reason = $2,
                     locked_by = NULL, locked_until = NULL, updated_at = now()
                 WHERE id = $1 AND status = 'pending'
                   AND (locked_until IS NULL OR locked_until < now())",
            )
            .bind(id)
            .bind(exhausted_reason(attempts))
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        }

        // SKIP LOCKED: concurrent workers skip rows another worker is claiming right
        // now instead of waiting, so each claim picks a different job.
        let row = sqlx::query(&format!(
            "WITH next AS (
                 SELECT id FROM lild.requests
                 WHERE status = 'pending' AND attempts < max_attempts
                   AND next_attempt_at <= now()
                   AND (locked_until IS NULL OR locked_until < now())
                 ORDER BY next_attempt_at, created_at
                 FOR UPDATE SKIP LOCKED
                 LIMIT 1
             )
             UPDATE lild.requests AS r
             SET locked_by = $1,
                 locked_until = now() + ($2::float8 * interval '1 millisecond'),
                 attempts = r.attempts + 1,
                 updated_at = now()
             FROM next WHERE r.id = next.id
             RETURNING {REQUEST_COLS}"
        ))
        .bind(worker_id)
        .bind(millis(lease))
        .fetch_optional(&self.pool)
        .await
        .map_err(db_err)?;
        row.as_ref().map(row_to_request).transpose()
    }

    async fn finish_job(
        &self,
        id: Uuid,
        worker_id: &str,
        finish: Finish,
    ) -> Result<Option<RequestStatus>, StoreError> {
        let mut tx = self.pool.begin().await.map_err(db_err)?;
        // Fencing: only the worker that holds the job may finish it.
        let Some(row) = sqlx::query(
            "SELECT attempts, max_attempts FROM lild.requests
             WHERE id = $1 AND locked_by = $2 AND status = 'pending'
             FOR UPDATE",
        )
        .bind(id)
        .bind(worker_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_err)?
        else {
            return Ok(None);
        };
        let attempts: i32 = row.try_get("attempts").map_err(db_err)?;
        let max_attempts: i32 = row.try_get("max_attempts").map_err(db_err)?;
        let plan = plan_finish(attempts, max_attempts, finish);

        sqlx::query(
            "UPDATE lild.requests SET
                 status = $2, status_reason = $3, result = $4,
                 last_error = COALESCE($5, last_error),
                 next_attempt_at = CASE WHEN $6::float8 IS NULL THEN next_attempt_at
                                        ELSE now() + ($6::float8 * interval '1 millisecond') END,
                 locked_by = NULL, locked_until = NULL, updated_at = now()
             WHERE id = $1",
        )
        .bind(id)
        .bind(plan.status.as_str())
        .bind(&plan.status_reason)
        .bind(plan.result.clone().map(Json))
        .bind(&plan.last_error)
        .bind(plan.retry_after.map(millis))
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
        tx.commit().await.map_err(db_err)?;
        Ok(Some(plan.status))
    }

    async fn inspect_job(&self, id: Uuid) -> Result<Option<JobSnapshot>, StoreError> {
        let row = sqlx::query(
            "SELECT status, attempts, max_attempts, locked_by, last_error, status_reason, next_attempt_at
             FROM lild.requests WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(db_err)?;
        row.map(|row| {
            let status: String = row.try_get("status").map_err(db_err)?;
            Ok(JobSnapshot {
                status: parse_status(&status)?,
                attempts: row.try_get("attempts").map_err(db_err)?,
                max_attempts: row.try_get("max_attempts").map_err(db_err)?,
                locked_by: row.try_get("locked_by").map_err(db_err)?,
                last_error: row.try_get("last_error").map_err(db_err)?,
                status_reason: row.try_get("status_reason").map_err(db_err)?,
                next_attempt_at: row.try_get("next_attempt_at").map_err(db_err)?,
            })
        })
        .transpose()
    }
}
