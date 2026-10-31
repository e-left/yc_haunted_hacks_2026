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

## Phase 1: how to test it

```bash
cd backend
cargo test                                   # all tests
cargo test --test phase1_relay_api           # only Phase 1

# run the server manually
cargo run --bin keygen -- demo-agent         # prints a key + LILD_API_KEYS line
LILD_API_KEYS='demo-agent:<hash>' cargo run --bin lild-backend

curl -s localhost:8080/v1/health
curl -s -X POST localhost:8080/v1/requests \
  -H "Authorization: Bearer <key>" -H "Idempotency-Key: demo-1" \
  -H 'content-type: application/json' \
  -d '{"question":"Which in-stock shirts have a body length under 30 inches?"}'
curl -s localhost:8080/v1/requests/<request_id> -H "Authorization: Bearer <key>"
```

In Phase 1, requests stay `pending` because no worker exists yet (that's Phase 3).
