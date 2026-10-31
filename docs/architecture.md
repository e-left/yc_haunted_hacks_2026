# Product architecture

This is a scaffold, not a working integration. [SPEC.md](../SPEC.md) is the source of truth for product and security requirements.

```text
Merchant browser --> React web app --> API / gateway
Customer agent <--> Agent Relay <----> API / gateway
                                      |-- planning + deterministic validation
                                      |-- security review
                                      |-- Terse actor adapter
                                      |-- catalog + audit
                                      `--> restricted Supabase/Postgres interface
Customer agent --> gateway --> request-specific actor --> restricted data interface
```

- `apps/web`: merchant-facing interface for classifications, request review, and catalog. The browser must not receive privileged database credentials.
- `apps/api`: trusted gateway and orchestration. Add feature modules here for Relay, planning, policy validation, review, actor lifecycle, invocation, catalog, and administration as they are implemented. Keep vendor adapters at the edges and authorization at the actual entry points.
- `packages/contracts`: versioned types shared by the web app and API. Types alone do not validate untrusted input; validate it at runtime at each boundary.
- `supabase/migrations`: versioned schema, grants, and row policies. Keep merchant data separate from catalog/audit records and scope both by merchant. Add seed data only after the access boundary exists.

The API currently exposes only process liveness at `GET /health/live`; it does not check external dependencies. The web app is a placeholder. No Relay, Terse, model, Supabase, authentication, or catalog integration is implemented. There are no customer-facing execution routes or permissive fallback decisions.

## Build order and constraints

1. Establish merchant authentication and administration, classifications, database roles, grants, and row policies. Unclassified and private fields must be inaccessible to customer-facing execution, including direct database calls. Custodial data stays unavailable until verified identity and row isolation work.
2. Define and validate a bounded, versioned plan and its invocation contract. Planner and reviewer inputs are untrusted; neither may change policy or credentials.
3. Implement review and a database-enforced grant bound to the approved plan, fields, rows, purpose, and expiry. The spec leaves this mechanism unresolved; deny execution until it is designed and verified, including direct database access.
4. Integrate Relay and Terse behind the gateway. Verify actor delivery and credential handling; enforce authorization and expiry on every invocation. Use bounded deadlines and surface failures.
5. Persist merchant-scoped catalog and audit events, including decisions and invocation outcomes, without credentials or unnecessary customer data. Persistence failures must be visible. Categories never grant access.

Do not implement stateful expansion until its ownership, approval, and lifecycle are decided. No migration or integration in this scaffold should be treated as satisfying the spec's acceptance criteria.
