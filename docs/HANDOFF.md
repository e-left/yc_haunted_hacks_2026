# Handoff: plugging the real pipeline into the relay

The relay is done (phases 1-4). An agent such as Claude can send a question to the
backend, the request is stored durably, a worker processes it, and the agent gets the
answer back. **The only missing piece is the pipeline**: what a worker actually does
with a question. Today it's a stub that returns `"simulated": true`.

```text
Claude ──MCP──▶ lild-mcp ──HTTPS + API key──▶ relay API ──▶ Postgres queue ──▶ worker ──▶ Pipeline  ◀── you are here
                (phase 4)                     (phase 1)      (phase 2)          (phase 3)   (stub today)
```

## Run it (3 terminals)

```bash
phases/phase-4/server.sh            # Postgres (Docker) + relay on :8080 + 2 workers
phases/phase-4/smoke.sh             # everything works end to end
phases/phase-4/connect-claude.sh    # Claude's key + register with Claude Code / print Desktop config
phases/phase-4/connect-codex.sh     # Codex's key + register with Codex CLI
```

Restart the relay after a connect script creates a new key. Then in Claude Code or Codex:
*"Use the lild-relay tools to ask the merchant which in-stock shirts have a body length under
30 inches."* Each agent has its own key and `client_id` (`claude-agent`, `codex-agent`);
the `.env` layout is in `docs/PHASES.md` (Phase 4).

**Verified:** real Codex and Claude Code sessions have completed this round trip. The
transcripts, matching relay logs, and the "what counts as success" rule are in
[`docs/VERIFICATION.md`](VERIFICATION.md).

## Your integration point: the `Pipeline` trait

`backend/src/pipeline.rs`:

```rust
#[async_trait]
pub trait Pipeline: Send + Sync {
    async fn process(&self, request: &RelayRequest) -> Result<PipelineOutcome, PipelineError>;
}
```

`request` gives you `id`, `question` (untrusted text from the agent), `client_id` (which
agent asked) and `attempts`. Return one of:

| Return | Meaning | What the agent sees |
| --- | --- | --- |
| `Ok(PipelineOutcome::Active { result })` | API created | `status: active`, and `result` **verbatim** |
| `Ok(PipelineOutcome::Rejected { reason })` | Policy "no" (private data, ambiguous, review denied) | `status: rejected` + `reason`. Not retried. |
| `Err(PipelineError::Transient(e))` | Timeout, rate limit, Terse/LLM briefly down | Retried with backoff. After 3 attempts: `failed`. |
| `Err(PipelineError::Permanent(e))` | Malformed model output, bad config | `failed` immediately |

Error text (`e`) is stored internally only (`last_error`) and **never shown to the agent**.

Suggested `result` shape for an active request (spec FR-6):

```json
{
  "api_url": "https://.../apis/<id>/invoke",
  "contract": { "method": "POST", "inputs": { "max_length": { "type": "number", "max": 30 } } },
  "expires_at": "2026-11-01T12:00:00Z",
  "invocation_token": "..."
}
```

Register it in `backend/src/main.rs` (search for `LILD_PIPELINE`):

```rust
"real" => Arc::new(RealPipeline::new(/* LLM client, Terse client, ... */)),
```

and run with `LILD_PIPELINE=real phases/phase-4/server.sh`.

## Rules the relay relies on

1. **Your pipeline may run more than once for the same request.** If a worker crashes
   after your code created the Terse actor but before the result was saved, another worker
   retries. Make side effects idempotent: key the actor on `request.id` and reuse it if it
   already exists.
2. **Time limit: 30s per attempt** (`pipeline_timeout`). A hang is cancelled and retried.
   If planner + review + actor creation need longer, raise `pipeline_timeout` **and** `lease`
   in `WorkerConfig` (`backend/src/worker.rs`). The lease must stay longer than the timeout.
3. **`result` is shown to the agent verbatim.** Never put private fields, internal errors,
   or credentials other than the intended invocation token in it.
4. **`client_id` identifies the agent, not a customer.** It doesn't prove who the human
   customer is (spec FR-2). Custodial data needs real customer auth, which doesn't exist yet.
5. **`question` is untrusted.** Prompt injection arrives here. LLM output is a proposal;
   deterministic validation and DB permissions are the boundary (spec FR-5).
6. **Expiry:** the state machine allows `active -> expired` (database trigger in
   `migrations/0002_worker_queue.sql`). Set it with
   `UPDATE lild.requests SET status = 'expired', updated_at = now() WHERE id = $1 AND status = 'active'`.
   The temporary API must still check expiry on every call itself.
7. **Schema changes go in a new migration** (`backend/migrations/0003_*.sql`). Never edit
   0001 or 0002, because they've already run on existing databases.

## Relay HTTP API (for anything that isn't Claude)

All endpoints except health and ready need `Authorization: Bearer lild_live_...`.

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/requests` `{"question": "..."}` + optional `Idempotency-Key` | 202, `{request_id, status: "pending", ...}` |
| `GET /v1/requests/{id}` | Status: `pending`, `active` (+`result`), `rejected`/`failed` (+`status_reason`), `expired`. 404 for other agents' requests. |
| `GET /v1/health` | Process is up |
| `GET /v1/ready` | Database reachable (503 if not) |

New agent keys: `cargo run --bin keygen -- <client_id>` then add the hash to `LILD_API_KEYS`.

## Testing workflow: keep the gates green

```bash
scripts/before-phase.sh 5     # must pass before you start: re-checks phases 1-4
```

Add `phases/phase-5/check.sh` (copy `phases/phase-4/check.sh` as a template) with tests for
your pipeline. The gates pin `LILD_PIPELINE=stub`, so the earlier phases' checks stay
deterministic after your pipeline lands. Test your pipeline in your own phase, with fake
LLM/Terse clients behind traits, the same way `tests/phase3_worker.rs` scripts its pipeline.

The remaining spec work (classification, plans, validator, security review, Terse actor,
RLS, catalog) is yours. The earlier draft roadmap is in `docs/PHASES.md`.
