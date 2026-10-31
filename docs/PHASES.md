# LI/LD build phases

Each phase ends with a passing test suite and a git tag, so any stage can be
checked out, run, and tested on its own (`git checkout v0.1.0`).

| Phase | Tag | What it adds | Spec |
| --- | --- | --- | --- |
| 1 | `v0.1.0` | **Relay API core.** API-key auth (hashed, scoped, revocable, expiring), `POST/GET /v1/requests`, idempotency, ownership isolation, input limits. In-memory store. | FR-3 intake, FR-9 |
| 2 | `v0.2.0` | **Postgres persistence.** Same `Store` trait backed by Supabase/Postgres + migrations. The Phase 1 tests also run against Postgres. | FR-7, FR-8 durability |
| 3 | `v0.3.0` | **Worker + state machine.** Job claiming (`FOR UPDATE SKIP LOCKED`), leases, timeouts, bounded retries, explicit `failed` state. Stub pipeline. | FR-7, FR-9 |
| 4 | `v0.4.0` | **Agent access (final relay phase).** `lild-mcp` MCP server so Claude Code / Claude Desktop can call the relay as tools (`ask_merchant`, `get_request_status`, `check_relay_connection`). Key stays out of the model's context; https-only off localhost. | Spec: Customer agent ↔ relay |
| 5+ | colleague | **Real pipeline**: classification, plan + validator, security review, Terse actor, RLS, catalog. Plugs into the `Pipeline` trait. See **`docs/HANDOFF.md`**. | FR-1..FR-8 |

## Workflow: gate before every phase

Before starting phase N, run the regression gate. It must pass:

```bash
scripts/before-phase.sh N      # re-runs phases/phase-1 .. phase-(N-1)
```

It runs `cargo build` + `cargo clippy -D warnings`, then each earlier phase's
`phases/phase-X/check.sh`: that phase's cargo tests plus a live smoke test against a
throwaway server with fresh keys. A phase is done when its own `check.sh` passes and
the gate for the next phase is green. Then tag it.

Every new phase X adds `phases/phase-X/check.sh` (plus `smoke.sh` if it has live behavior).

## Phase 1: manual testing

```bash
phases/phase-1/server.sh    # terminal 1: creates backend/.env with demo keys on first run
phases/phase-1/smoke.sh     # terminal 2: 8 live checks, reads keys from backend/.env
phases/phase-1/check.sh     # or run everything automated (tests + own server + smoke)
```

`backend/.env` is gitignored. It holds `LILD_API_KEYS` (hashes, for the server) and
`CUSTOMER_KEY` / `OTHER_KEY` (plaintext, for the agents). In Phase 1, requests stay
`pending` because no worker exists yet (that comes in Phase 3).

## Phase 2: manual testing (Postgres)

```bash
phases/phase-2/server.sh    # terminal 1: starts local Postgres (Docker) + relay on :8080
phases/phase-2/smoke.sh     # terminal 2: /v1/ready + the full Phase 1 smoke test
# Persistence by hand: create a request, Ctrl+C the server, start it again, GET it back.
phases/phase-2/check.sh     # or everything automated (uses the lild_test database)
```

- Local Postgres: `compose.yaml`, `127.0.0.1:54329`, databases `lild` (dev) and `lild_test` (tests).
- **Supabase:** put `DATABASE_URL=<Supabase connection string>?sslmode=require` in
  `backend/.env` and `phases/phase-2/server.sh` uses it. Migrations run at startup.
- Tables live in the `lild` schema, not `public`, so Supabase's auto-generated REST API
  doesn't expose them.
- `GET /v1/health` = process is up. `GET /v1/ready` = database reachable (503 if not).
- Re-provisioning keys from `LILD_API_KEYS` on restart never un-revokes or changes an existing key.
- Inspect data: `docker compose exec postgres psql -U lild -d lild -c 'select * from lild.requests'`

## Phase 3: manual testing (worker + state machine)

```bash
phases/phase-3/server.sh    # terminal 1: Postgres + relay + 2 workers (LILD_WORKERS=N to change)
phases/phase-3/smoke.sh     # terminal 2: phases 1-2 smoke + request goes pending -> active
phases/phase-3/check.sh     # automated: tests + live smoke + kill -9 recovery + SIGTERM drain
```

State machine (enforced by a database trigger as well as Rust code):

```text
pending -> active | rejected | failed      active -> expired (Phase 6)
```

- **Lease:** a worker owns a claimed job until its lease expires (default 60s). A crashed
  worker's job is reclaimed by another worker. `attempts` counts crashes too, so a job
  that kills every worker still ends `failed` after 3 attempts.
- **Fencing:** a worker that lost its lease can't overwrite the new owner's result.
- **Timeout / panic / transient error:** retried with exponential backoff + jitter.
  A permanent error fails immediately. Internal error text (`last_error`) is never sent to clients.
- **Stub pipeline:** results carry `"simulated": true` until Phase 4-6 add the real pipeline.
- Inspect the queue: `docker compose exec postgres psql -U lild -d lild -c
  'select id, status, attempts, locked_by, last_error from lild.requests order by created_at desc limit 10'`

## Phase 4: connect Claude (final relay phase)

```bash
phases/phase-4/server.sh            # terminal 1: relay (same as phase 3)
phases/phase-4/connect-claude.sh    # once: builds lild-mcp, registers it with Claude Code,
                                    #       prints the Claude Desktop config
phases/phase-4/smoke.sh             # phases 1-3 smoke + a scripted MCP session via the real binary
phases/phase-4/check.sh             # automated: MCP tests + live relay + MCP session
```

Then open Claude Code in this folder and ask it to use the `lild-relay` tools.
`lild-mcp` reads the key from `backend/.env` (`CUSTOMER_KEY`) at startup. Claude's config
only stores the path, never the key. Next steps for the real pipeline: `docs/HANDOFF.md`.
