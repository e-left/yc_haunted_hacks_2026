-- Phase 3: the requests table doubles as a durable job queue.
--
-- A worker "claims" a pending row by setting locked_by and locked_until (a lease).
-- If the worker crashes, the lease expires and another worker can claim the row.
-- attempts is incremented at claim time, so a job that crashes every worker
-- (a "poison pill") still runs out of attempts instead of looping forever.

ALTER TABLE lild.requests
    ADD COLUMN attempts        int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    ADD COLUMN max_attempts    int NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
    ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN locked_by       text,
    ADD COLUMN locked_until    timestamptz,
    ADD COLUMN last_error      text CHECK (char_length(last_error) <= 1000),   -- internal only
    ADD COLUMN status_reason   text CHECK (char_length(status_reason) <= 500), -- shown to client
    ADD COLUMN result          jsonb,
    ADD CONSTRAINT requests_lock_consistent CHECK ((locked_by IS NULL) = (locked_until IS NULL)),
    ADD CONSTRAINT requests_terminal_unlocked CHECK (status = 'pending' OR locked_by IS NULL),
    ADD CONSTRAINT requests_active_has_result CHECK (status <> 'active' OR result IS NOT NULL);

-- Fast lookup of claimable work. Partial index: only pending rows are indexed.
CREATE INDEX requests_claimable_idx ON lild.requests (next_attempt_at, created_at)
    WHERE status = 'pending';

-- State machine enforced by the database, independent of Rust code:
--   pending -> active | rejected | failed
--   active  -> expired          (Phase 6)
-- Terminal states never go back. Owner and question are immutable.
CREATE FUNCTION lild.enforce_request_transition() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF NEW.client_id IS DISTINCT FROM OLD.client_id OR NEW.question IS DISTINCT FROM OLD.question THEN
        RAISE EXCEPTION 'request owner and question are immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
           (OLD.status = 'pending' AND NEW.status IN ('active', 'rejected', 'failed'))
        OR (OLD.status = 'active'  AND NEW.status = 'expired')
    ) THEN
        RAISE EXCEPTION 'illegal request status transition % -> %', OLD.status, NEW.status
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER requests_enforce_transition
    BEFORE UPDATE ON lild.requests
    FOR EACH ROW EXECUTE FUNCTION lild.enforce_request_transition();
