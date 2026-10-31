# LI/LD: request-specific merchant APIs

**Status:** Draft baseline for spec-driven development. LI/LD means “living integration/living deployment.”

## Product

A customer’s agent asks a merchant a question that the merchant’s existing API cannot answer, such as “Which in-stock shirts have a body length under 30 inches?” LI/LD creates a temporary API tailored to that request using data the merchant permits the customer to access.

The customer’s agent sends the request through Agent Relay. The merchant’s internal agent proposes a read-only query plan. After access checks and security review, the system creates a Terse Durable Actor holding the approved plan. The internal agent replies through Agent Relay with the temporary API’s URL, invocation contract, and expiry. The customer’s agent calls the API to get results. A gateway may route the call to the actor; direct public HTTP access to Terse actors remains to be verified. Purchasing uses the merchant’s existing checkout.

The API is generated as a structured plan and a request-specific actor instance, not arbitrary generated code. The merchant controls the data boundary; the internal agents work inside it.

## Access model

The merchant assigns data to these mandatory access control categories. Access is denied by default until a category and applicable policy are configured.

| Category   | Meaning                                                                         | Access rule                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private    | Merchant-only data, such as supplier costs.                                     | Unavailable to customer-facing plans and execution, even if the customer or an agent requests it. The reviewing agent cannot grant access.                            |
| Custodial  | A customer’s own data, such as their profile and cart.                          | Accessible only for the authenticated customer who owns it and only within the merchant’s permitted operations and fields. Security review cannot override ownership. |
| Reviewable | Other merchant data made eligible for customer use, such as product dimensions. | Available for the specific request only after the security review agent approves its use, subject to merchant-defined restrictions and deterministic enforcement.     |

These categories govern data used in output, filters, joins, sorting, and derived results: even filtering on a field can disclose information. The merchant decides which data is private or custodial and what reviewable data is eligible for disclosure. Unclassified data remains inaccessible. A merchant policy change is an authenticated administrative action, never an agent decision.

The database interface exposes to the planning agent only data available for the current request’s evaluation; private data and other customers’ custodial data are not exposed. Reviewable data is identifiable for proposing a plan, but its values are not available to execution until approval. The execution path uses restricted credentials and database-enforced grants and row policies; neither the planner nor reviewer can change the classifications, database permissions, or authenticated customer identity. The review agent is the approval decision-maker for reviewable data, not the enforcement boundary for private or custodial data.

## API and interaction catalog

The platform catalogs generated APIs and interactions, organized into categories, so it can identify opportunities to expand useful capabilities into stateful infrastructure. The catalog is a platform record, not an authorization grant: each future use remains subject to the current merchant policy, customer identity, security review, and database enforcement.

For each request-specific API, record its identifier, merchant, category, intended purpose, structured contract and approved plan, access categories, creation and expiry times, and lifecycle state. Link interactions to that API and record their type, time, and outcome, including review decisions and invocations. Capture only the information needed for the catalog and audit; do not store credentials, raw sensitive payloads, or unnecessary customer data. Custodial records remain subject to customer ownership and merchant access rules.

Categories group related APIs and interactions by their purpose, such as product discovery or cart access. The category is platform metadata and cannot change a data classification, confer permission, or merge data across merchants or customers. Categorization must be reviewable and correctable by an authorized merchant or platform operator.

**Expansion is an open product decision:** define what stateful infrastructure the platform should create from these categories, whether creation is automatic or requires approval, and which state and retention rules apply. Until then, the catalog records opportunities; it does not create persistent APIs or workflows, extend an expired API, or grant access.

## Scope

**In scope:** one seeded merchant; read-only product discovery; Agent Relay request and reply; request-specific structured plans; security-agent review of reviewable data; Terse actor-backed temporary APIs; Supabase/Postgres access controls; expiry, audit records, and the API and interaction catalog. Demonstrate customer-specific data only if verified customer authentication and row isolation are working.

**Out of scope:** purchases and writes, arbitrary generated code or SQL, a production-ready general-purpose platform, and access to unclassified or private data. An anonymous Relay conversation does not authenticate a customer. If customer identity cannot be verified, custodial requests are denied or require authentication; anonymous product discovery can still be demonstrated.

## Functional requirements

- **FR-1 — Classification:** The merchant can configure private, custodial, and reviewable data and associated field, row, operation, and disclosure restrictions. Unclassified data is inaccessible. A private field is unavailable for all customer-facing use.
- **FR-2 — Identity and ownership:** Custodial access requires a verified customer identity bound to the invocation. Database row policies enforce ownership independently of model output and request text. A customer cannot select a different owner by changing input or supplying an ID.
- **FR-3 — Request and plan:** The system receives untrusted natural language and generates a versioned, structured, read-only plan using the exposed interface. The plan specifies resources, fields, filters, limits, inputs, and outputs. Unsupported or ambiguous requests are rejected or clarified; they are not silently broadened.
- **FR-4 — Review:** Before execution, a security agent reviews each use of reviewable data for the specific request against merchant policy. Approval is scoped to the plan, permitted fields and rows, purpose, and expiry. A denial, timeout, malformed response, or unavailable reviewer prevents execution. The reviewer cannot override private classification, custodial ownership, or other merchant restrictions.
- **FR-5 — Deterministic enforcement:** Code validates plans and invocations against the exposed interface, classification, approved scope, and supported operations. Database permissions and row policies enforce the data ceiling even if a plan or review decision is wrong. No customer-facing execution credential can change its own permissions. Reject invalid or unverifiable plans.
- **FR-6 — Temporary API:** Each approved request gets an actor-backed interface with a defined contract and expiry. The actor executes only the approved plan. Inputs cannot broaden the request: if the approved request is for shirts under 30 inches, a caller cannot change the limit to 100 inches. Require an authorized invocation credential; a bearer token is transferable until it expires unless bound to an authenticated identity.
- **FR-7 — Lifecycle and audit:** Track pending, active, rejected, and expired requests. Check expiry at every invocation even if an alarm is late. Record the request ID, access category, decision and reason, approver type, expiry, and invocation outcome without logging credentials or unnecessary customer data.
- **FR-8 — Catalog:** Record every API and its interactions in the appropriate merchant-scoped categories, including lifecycle and outcomes, with access controls and data minimization. Catalog writes must be durable and failures visible; do not report a cataloged operation as recorded if its record was not persisted.
- **FR-9 — Failures:** Surface model, relay, actor, and database failures as errors or explicit pending states. Use bounded deadlines for remote calls. Never report a failed query as a successful empty result. Protect administrative actions with merchant authentication and authorization.

## Architecture and trust boundaries

```text
Customer agent
  | request / API details
  v
Agent Relay <--> Merchant gateway and internal agents
                       |-- exposed schema and access policy
                       |-- plan generation and deterministic validation
                       |-- security review for reviewable data
                       |-- request-specific Terse actor: plan, scope, expiry
                       |-- API and interaction catalog, audit, merchant administration
Customer agent --> temporary API / gateway --> actor --> restricted DB interface
                                                        --> Supabase / Postgres
```

- **Agent Relay** carries the request and API details. A Relay conversation ID alone is not proof of customer identity.
- **Gateway** is trusted to authenticate callers, manage short-lived access, enforce policy, and route requests. Administrative and execution credentials must be separated and protected.
- **Terse actor** owns request-specific state and executes the approved plan. It is not assumed to be a sandbox for arbitrary hostile code.
- **Supabase/Postgres** enforces the data boundary through appropriately restricted roles, grants, views, and row policies. Private data and other customers’ custodial rows must remain inaccessible even through direct database calls using execution credentials. Views and privileged functions must be reviewed for their effective privileges and row-policy behavior.
- **Security review agent** decides whether eligible reviewable data may be used for a request. Its approval must be translated into a scoped, enforceable grant; approval text alone is not an access control.

## Acceptance criteria

1. An anonymous product request for shirts under 30 inches results in security review of the required reviewable data. On approval, the customer agent receives the API details through Agent Relay and can call the API to receive only matching, permitted product information.
2. A request for private supplier cost is denied or cannot be planned. The planning interface does not expose the private field, and direct database reads or filters using the execution credential are denied. The security agent cannot approve it.
3. An authenticated customer can retrieve their own permitted cart or profile data. Attempts to read another customer’s rows, including by changing an input or making a direct database request, are denied. Anonymous callers cannot access custodial data.
4. Reviewable data is unavailable to execution before approval. A denial, timeout, or malformed security-agent response does not create an active API or permit a database read. An approval cannot be reused for another plan or beyond its row, field, purpose, or expiry scope.
5. Prompt injection asking the planner or reviewer to expose private data, bypass ownership, or change policy cannot change the enforced access boundary.
6. The API rejects missing or invalid credentials, inputs that broaden the approved request, and calls after expiry, including before the actor’s alarm fires.
7. The audit record shows access and review decisions and invocation outcomes without exposing credentials. Dependency failures are visible.
8. Each generated API and its review and invocation interactions appear in the correct merchant-scoped catalog category with their lifecycle and outcomes. An authorized operator can correct a category; categorization never changes access permissions. A catalog persistence failure is surfaced.
9. The demo uses actual Agent Relay, Terse, and Supabase integrations where available; any fallback or simulated decision is identified.

## Implementation decisions to resolve

- **Stateful expansion:** Define the desired infrastructure, trigger, approval model, ownership, retention, and lifecycle for expansion from catalog categories. Establish how existing access controls are rechecked at creation and on each use.
- **Scoped reviewable access:** Design and verify how an approval becomes a database-enforced, request-specific grant. It must constrain eligible fields and records, operation, and expiry, including direct database calls. Do not use a privileged function that accepts arbitrary record IDs merely because an intent was approved. If this cannot be enforced, deny the request rather than broaden access.
- **Customer authentication:** Select and verify a supported identity mechanism and bind the authenticated principal to the API invocation and Postgres row policies. Until then, custodial access is unavailable.
- **Request constraints:** Specify which values are fixed and which inputs may vary within approved bounds. Defaults alone do not preserve the request’s scope.
- **API delivery:** Verify whether Terse provides a suitable public HTTP interface or requires a gateway. Define secure delivery and retrieval of invocation credentials, including after delayed approval.
- **View and function privileges:** Verify effective role, grants, and RLS behavior for every exposed view and function. An owner-rights view or elevated function can bypass intended restrictions if designed incorrectly.
- **Abuse and disclosure limits:** Anonymous conversation IDs can be replaced and are not reliable anti-scraping controls. Define production identity, rate, and cumulative disclosure controls before expanding beyond the demo.

## Demo

1. Show the merchant’s classifications: supplier cost is private, customer cart is custodial, and product dimensions and availability are reviewable.
2. Ask for in-stock shirts under 30 inches. Show the security review, receive the API details through Relay, invoke the API, and show matching products.
3. Ask for supplier costs and show denial. Demonstrate that the execution credential cannot access the private field directly.
4. If verified customer identity and row isolation are implemented, show a customer’s own cart and a denied attempt to access another customer’s cart. Otherwise, show custodial access denied without authentication and state that customer authentication is not implemented.
5. Show a prompt-injection attempt failing to expand access, then show the temporary API rejecting a call after expiry.

Use Agent Relay and Terse Durable Actors for the hackathon integrations, and Supabase as the database boundary. Product limits and any simulated or fallback behavior must be explicit in the demo.
