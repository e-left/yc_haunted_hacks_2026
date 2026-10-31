//! Postgres implementation of [`Store`] (Phase 2). Works with local Postgres or Supabase.
//!
//! Reliability choices:
//! - Every wait is bounded: 5s to connect or get a pooled connection, 5s per SQL statement.
//!   A slow or dead database becomes a visible error, never a hang (spec FR-9).
//! - Idempotent creation is one transaction guarded by the `idempotency_keys` primary
//!   key, so concurrent retries can't create duplicates.

use std::{str::FromStr, time::Duration};

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
    store::{CreateOutcome, Idempotency, Store, StoreError},
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
        status: RequestStatus::parse(&status)
            .ok_or_else(|| StoreError(format!("unknown status in DB: {status}")))?,
        question: row.try_get("question").map_err(db_err)?,
        created_at: row.try_get("created_at").map_err(db_err)?,
        updated_at: row.try_get("updated_at").map_err(db_err)?,
    })
}

const REQUEST_COLS: &str = "r.id, r.client_id, r.status, r.question, r.created_at, r.updated_at";

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
}
