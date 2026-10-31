# LI/LD build phases

Each phase ends with a passing test suite and a git tag, so any stage can be
checked out, run, and tested on its own (`git checkout v0.1.0`).

| Phase | Tag | What it adds | Spec |
| --- | --- | --- | --- |
| 1 | `v0.1.0` | **Relay API core.** API-key auth (hashed, scoped, revocable, expiring), `POST/GET /v1/requests`, idempotency, ownership isolation, input limits. In-memory store. | FR-3 intake, FR-9 |
| 2 | `v0.2.0` | **Postgres persistence.** Same `Store` trait backed by Supabase/Postgres + migrations. The Phase 1 tests also run against Postgres. | FR-7, FR-8 durability |
| 3 | `v0.3.0` | **Worker + state machine.** Job claiming (`FOR UPDATE SKIP LOCKED`), leases, timeouts, bounded retries, explicit `failed` state. Stub pipeline. | FR-7, FR-9 |
| 4 | `v0.4.0` | **Exposed schema, classification, structured plan + deterministic validator.** Planner LLM behind a trait (mocked in tests). Private fields are never exposed. | FR-1, FR-3, FR-5 |
| 5 | `v0.5.0` | **Security review agent.** Approve/deny; timeout, malformed output, or unavailable reviewer means no activation. Approval scoped to the plan hash. | FR-4 |
| 6 | `v0.6.0` | **Temporary API.** Invocation tokens, gateway, expiry check on every call, fixed and bounded inputs, Terse actor adapter. | FR-6 |
| 7 | `v0.7.0` | **Database boundary.** Restricted execution role, grants, RLS, and customer JWT binding. Direct-DB denial tests. | FR-2, FR-5 |
| 8 | `v0.8.0` | **Catalog, audit, and merchant admin.** | FR-7, FR-8 |
| 9 | `v0.9.0` | **Demo script** covering acceptance criteria 1–9. | Demo |

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
