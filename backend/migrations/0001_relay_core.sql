-- Phase 2: relay core tables.
--
-- Everything lives in a dedicated `lild` schema, not `public`. On Supabase, `public`
-- is exposed through the auto-generated REST API (PostgREST), so keeping relay tables
-- out of it means they can't be reached that way by accident.
--
-- CHECK constraints duplicate the app's validation on purpose: if a bug skips a check
-- in Rust, the database still refuses bad data.

CREATE SCHEMA IF NOT EXISTS lild;
REVOKE ALL ON SCHEMA lild FROM PUBLIC;

CREATE TABLE lild.api_keys (
    key_hash    text PRIMARY KEY CHECK (key_hash ~ '^[0-9a-f]{64}$'), -- SHA-256 hex only, never plaintext
    client_id   text NOT NULL CHECK (client_id ~ '^[A-Za-z0-9._-]{1,64}$'),
    scopes      text[] NOT NULL CHECK (scopes <@ ARRAY['requests:create', 'requests:read']::text[]),
    expires_at  timestamptz,
    revoked_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lild.requests (
    id          uuid PRIMARY KEY,
    client_id   text NOT NULL,
    status      text NOT NULL CHECK (status IN ('pending', 'active', 'rejected', 'expired', 'failed')),
    question    text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 2000),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX requests_client_created_idx ON lild.requests (client_id, created_at DESC);

-- One row per (client, Idempotency-Key). The primary key makes concurrent retries
-- race safely: only one insert wins, the others see the winner's request.
CREATE TABLE lild.idempotency_keys (
    client_id   text NOT NULL,
    key         text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 255),
    body_hash   text NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'),
    request_id  uuid NOT NULL REFERENCES lild.requests (id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (client_id, key)
);
