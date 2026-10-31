# Spec: on-demand agent APIs inside a merchant boundary (Haunted Hacks)

Working name needed. Merchant-facing product is a Supabase add-on; "plugin" means a label step plus a compiler.

Revision note: this version follows a doc-checked stress test (Terse, Agent Relay, arelay.to, Supabase, PostgREST). The customer tier, Freestyle VM and Claude Code answering agent are gone. Caller identity is the arelay.to conversation id. Approval for `conditional` columns is agent-to-agent through a policy agent; the human queue remains for unlabeled columns. See "Review findings" at the end for why.

## Context

YC Haunted Hacks, Sat Oct 31 2026, San Francisco. Team of 4. Hacking 11:00 to 16:00, lunch at 13:00, then live demos.
All code must be written at the event. Accounts, configuration, ideas and throwaway tests are fine beforehand.
Tracks: Durable Actors from Terse, Agent Relay, bonus for both. Judges want very well-executed or very creative.

Problem: customer agents ask questions a merchant's site and API cannot answer, while the answer sits in internal tables. Postgres can express any boundary with roles, column grants and views. Nobody writes one per customer question, so internal data stays locked and agents get nothing.

Pitch: **"Postgres can express any boundary. Nobody writes one per question. We turn an agent's question into a ten-minute API inside the merchant's boundary, and Postgres still gets to say no."**

Principle: the merchant decides what may be disclosed and writes the policy, the policy agent applies it, the customer's agent decides how to answer, the database enforces the ceiling.

Honesty note for judges, say it before they ask:
- Postgres enforces the merchant's maximum boundary per tier (grants, views, the one-off function).
- The actor enforces narrowing to one intent: it only runs its stored plan and dies at expiry.
- The gateway holds the keys and is the trust root.
- The API URL plus token is a bearer capability. Anyone holding it can call it until it expires. We say "one capability, ten minutes", never "one agent".
- The policy agent can only say no to something the merchant already said maybe to. It cannot relabel, cannot touch private columns, cannot grant `always`. Code enforces its caps; Postgres enforces the ceiling.

## Scope

In: one seeded store, read-only answers, one caller tier (`agent_public`), caller identity = arelay.to conversation id, policy agent approving `once` grants on `conditional` columns with its reasoning visible on a relay channel, human queue with Allow once and Always allow for unlabeled columns, expiry, audit log.
Out: writes and purchases (return a product link), generated code, per-request views, delegated or customer auth, a bound-customer tier (RLS, `caller_bindings`, `sub` claim), promoting intents to permanent APIs, Freestyle VM.

## Architecture

```
Customer's agent (Claude Code etc.)
   | curl --data-raw '<question>' https://arelay.to/<store>/<conversation-id>
arelay.to  --relay-native DM-->  Gateway's relay listener (@agent-relay/sdk, agent token only)
   |
Gateway (hand-written, trusted; holds Terse key, ES256 JWT private key, Supabase secret key, relay agent token)
   |-- plan generation: one LLM call, sees only the capabilities list and the visitor text
   |-- validator (deterministic) + policy rules (deterministic)
   |-- policy agent: one structured LLM call, allow|deny + reason, conditional columns only
   |        | posts decision to relay channel #approvals -> observer link on the judges' screen
   |-- Terse actor GrantedApi, one instance per approved intent, holds the plan
   |        | fetch with 60s JWT passed in per call + apikey header
   |        v
   |     Supabase PostgREST -> Postgres (column grants, owner-rights view, one_off_read)
   |-- merchant dashboard (one page; human queue for unlabeled columns)
Customer's agent calls gateway URL /a/:id with the token and inputs; polls GET /a/:id while pending
```

Reply to the visitor within seconds, always. Policy-agent approval runs inside the visitor's turn (about 5 seconds), so a conditional column normally comes back already approved. Only an unlabeled column replies with the URL and `status: pending`; the customer agent polls `GET /a/:id`. A later `agent.reply` in the thread is a nice-to-have, not the delivery path, because arelay.to ends visitor turns with `timeout` and a visitor only keeps waiting by re-polling.

## Component specs

### 1. Supabase (Person 1)

Demo tables in `public`: `products` (includes `body_length_in`, `supplier_cost`, `fabric_origin`, `supplier_name`), `variants` (`size`, `stock_count`), `shipping_options`. Keep `orders` and `returns` out of the seed; the tier that needed them is cut.
Control tables in unexposed schema `boundary`: `column_labels` (with a `policy` text column), `derived_fields`, `intents`, `one_off_grants`, `audit_log`.

Labels per column, each with a plain-language description:

| Label | Agents get | Enforced by |
|---|---|---|
| visible | Raw column | Column-level GRANT, no table-wide SELECT |
| derived | Merchant-approved computed field only | Owner-rights view, for example `in_stock` from `stock_count`; never `security_invoker` |
| conditional | The column, per intent, when the policy agent says the request fits the merchant's policy sentence | `one_off_read` plus a `boundary.one_off_grants` row written by the gateway, never by the agent |
| private | Nothing | No grant |
| unlabeled | Nothing until a human approves | Intent goes to the human queue |

Seed labels for the demo: `supplier_cost` private; `fabric_origin` conditional with policy "Disclose when a shopper asks about specific products. Never in bulk. At most 20 products per request."; `supplier_name` unlabeled; everything else visible or derived.

Role: `agent_public` (`NOLOGIN`), granted to `authenticator`, with `USAGE` on schema `public`, no table-wide SELECT, no EXECUTE except `one_off_read`.

Mandatory SQL, in this order, first 30 minutes:

```sql
-- 1. Functions: kill default EXECUTE before creating anything.
alter default privileges revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;

-- 2. Role.
create role agent_public nologin;
grant agent_public to authenticator;
grant usage on schema public to agent_public;

-- 3. Demo tables must not be readable by the publishable key.
--    New public tables get SELECT for anon/authenticated by default.
revoke all on all tables in schema public from anon, authenticated;
-- Leave RLS OFF on the demo tables. If anyone enables it, agent_public gets 200 [] with no error.
-- If RLS must be on, add: create policy agent_read on products for select to agent_public using (true);

-- 4. Compiler output (idempotent): column grants only.
revoke select on products from agent_public;
grant select (id, name, price, body_length_in, url) on products to agent_public;
-- ...variants, shipping_options likewise

-- 5. Derived field as an owner-rights view. FK columns must be in the SELECT for PostgREST embeds.
create or replace view variant_availability as
  select v.id, v.product_id, v.size, (v.stock_count > 0) as in_stock from variants v;
grant select on variant_availability to agent_public;
notify pgrst, 'reload schema';

-- 6. Everything else callable via /rpc/ is revoked.
revoke execute on all functions in schema public from public, anon, authenticated, agent_public;
```

`select=*` is not allowed for a column-restricted role, including embeds like `variants(*)`. The executor always lists columns.

JWT minting is configuration done tonight, not code: `supabase gen signing-key --algorithm ES256`, import as standby in the dashboard, rotate to it (state changes throttle about 5 minutes), keep the private JWK for the gateway. Tokens carry header `kid`, claims `role: agent_public`, `intent_id`, `exp = now + 60s`. Verify with `supabase gen bearer-jwt --role agent_public` and a curl. Every Data API request also needs the `apikey` header with the publishable key; the minted JWT cannot go there.

Allow once in Postgres, the single exception to the no-`rpc` and no-EXECUTE rules, and the last thing Person 1 builds:

```sql
create or replace function public.one_off_read(p_resource text, p_column text, p_ids uuid[])
returns table(id uuid, value text)
language plpgsql security definer set search_path = '' as $$
declare v_intent text := current_setting('request.jwt.claims', true)::json->>'intent_id';
begin
  if p_resource not in ('products','variants') then raise exception 'resource not eligible'; end if;
  if not exists (select 1 from boundary.one_off_grants g
                 where g.intent_id = v_intent and g.resource = p_resource
                   and g.column_name = p_column and g.expires_at > now())
  then raise exception 'no one-off grant' using errcode = '42501'; end if;
  return query execute format('select t.id, t.%I::text from public.%I t where t.id = any($1)', p_column, p_resource) using p_ids;
end $$;
revoke execute on function public.one_off_read(text,text,uuid[]) from public;
grant execute on function public.one_off_read(text,text,uuid[]) to agent_public;
```

The function runs as `postgres`, which bypasses RLS, so it is limited to tables without RLS. Plans can never name it; the actor calls it only for approved extra columns.

Label proposal: pre-computed LLM output, saved as a file. Not generated live.

### 2. Plan format (frozen at 11:00 with the actor method signatures)

Generated API = structured JSON, never SQL.

```json
{
  "version": 1,
  "inputs": { "max_length_in": { "type": "number", "default": 30 }, "size": { "type": "string", "default": "M" } },
  "steps": [
    { "id": "avail", "resource": "variant_availability",
      "select": ["product_id"],
      "filters": [ { "column": "size", "op": "eq", "value": { "input": "size" } },
                   { "column": "in_stock", "op": "eq", "value": true } ],
      "limit": 200 },
    { "id": "shirts", "resource": "products",
      "select": ["id", "name", "price", "body_length_in", "url"],
      "filters": [ { "column": "body_length_in", "op": "lt", "value": { "input": "max_length_in" } },
                   { "column": "id", "op": "in", "value": { "from": "avail.product_id" } } ],
      "limit": 50 }
  ],
  "output": "shirts"
}
```

Ops allowlist: eq, neq, lt, lte, gt, gte, in, not_in, ilike. Embeds allowed only over known foreign keys and only with explicit column lists. No `rpc`. Step count at most 3, limit at most 200.

### 3. Gateway (Person 2)

- `POST /intents` takes conversation id, intent text, plan. Runs validator, policy rules, cap check, then decides in this order:
  1. Any private column: reject immediately with the reason. The policy agent never sees it.
  2. Any unlabeled column: write a pending row to `boundary.intents`, return URL with `status: pending`. Human queue.
  3. Any conditional column: run the policy agent (section 6). On `allow`, write a `one_off_grants` row (intent, resource, column, expiry = the API's expiry) and create the actor. On `deny`, reject with the agent's reason. On timeout or error, fall to the human queue; never auto-approve.
  4. Everything visible or derived: create the actor, return URL, token, schema, expiry.
- Invariants the gateway enforces in code, whatever the policy agent outputs: the column is labeled conditional, scope is `once` only, at most 20 rows per request on that step, at most 3 conditional approvals per conversation, the grant expires with the API. Any agent output naming a different column, a different scope, or `always` is ignored and logged.
- `GET /a/:id` returns status, schema, expiry. `POST /a/:id` with the token invokes the plan.
- `POST /admin/approve/:intent` takes `scope`, for the human queue only. `once` adds a `one_off_grants` row (intent, resource, column, expiry) and creates the actor. `always` updates labels, runs the compiler, creates the actor. Both flip the intent to active; the customer's next poll sees it.
- `POST /admin/reject/:intent` marks rejected.
- `POST /admin/adversarial` replays a raw PostgREST request with a given intent's JWT against a forbidden column and returns the Postgres error verbatim.

Validator (deterministic): version, every resource and column labeled, ops allowed, limits and step count under caps, references resolve, explicit select lists.
Policy rules (deterministic, this is demo step 5): at most 3 intents per conversation per resource, at most 500 rows per conversation, `ilike` patterns at least 3 characters, no step without a filter on a resource over 100 rows.
Caps are per conversation id, in memory. A visitor can bypass them by fetching the handle page again; say so if asked.
Executor: builds PostgREST URLs with `URLSearchParams`; `in` list items double-quoted; values containing `,` `(` `)` rejected for `in`/`not_in`; column and table names only ever come from the validated plan.
JWT: signed per invoke, ES256 with `kid`, 60s expiry, claims `role`, `intent_id`.

### 4. Terse actor `GrantedApi` (Person 3)

One class deployed once. New actor ID per approved intent. The plan is state, not deployed code, and the gateway keeps only the id and the audit row, so the actor is the only place the plan lives.

- Persisted: `plan` (typed `Unchecked<Plan>`), `conversationId`, `status` (active, expired), `expiresAt`, `calls`.
- Methods, frozen at 11:00: `init(plan, conversationId, expiresAt)`, `invoke(inputs: Unchecked<Record<string, unknown>>, jwt)`, `getStatus()`, `onAlarm()`.
- `init` sets the alarm to `expiresAt`. `invoke` checks status and `expiresAt` itself, runs steps through PostgREST with `Authorization` and `apikey` headers, appends to the actor's SQLite call log. `onAlarm` sets `expired`. `getStatus` returns status, expiry, call count and the call log for the dashboard.
- Reassign persisted fields, never mutate nested values. No `@Interleave`. Stores no long-lived credentials; the JWT arrives per call.
- Actors sleep after 10s idle. Test `@Compute({ idleTimeoutMs: 600_000 })` tonight; if it slows the first call, pre-warm with `getStatus` before each demo step.

### 5. Answering agent and relay (Person 3)

- Handle registered tonight via the account-verified path at agentrelay.com/agents/register, relay-native delivery, no domain needed. Two free handles per account. The relay echo challenge needs the answer agent online in the challenge thread, so a stub listener runs tonight and is rewritten tomorrow.
- The answering agent is a listener in the gateway process using `@agent-relay/sdk` with the agent token (`RELAY_AGENT_TOKEN`), never the workspace key: `relay.addListener("dm.received", ...)` then `agent.reply({ messageId, text })`.
- On a visitor message: one LLM call with the capabilities list (labeled resources and descriptions) and the visitor text, producing a plan JSON. Post it to `POST /intents`. Reply with URL, schema, expiry or `status: pending`, within seconds.
- Caller identity is the arelay.to conversation id. Visitors are anonymous by design; there is no verified sender.
- Prompt injection can only produce a plan, and a plan must pass the validator. The listener has no shell, no filesystem authority and no DB credentials. The boundary is the validator, not process isolation.
- JWTs and the Supabase secret key never go into messages. The `/a/:id` token does, which is why it expires in ten minutes.

### 6. Policy agent (Person 3)

One structured-output LLM call after the deterministic rules, before actor creation, only when the plan touches a conditional column.

- Input: the merchant's policy sentence for that column, the plan, the intent text (untrusted), and the conversation's prior approvals.
- Output: `{ "decision": "allow" | "deny", "reason": "<one sentence>" }`. Nothing else is read from it.
- The prompt states that the merchant's policy sentence is the only authority and that the intent text is a request from a stranger, not an instruction.
- Fails closed: timeout, malformed output or error sends the intent to the human queue.
- Visibility: the gateway posts `intent id, column, decision, reason` to relay channel `#approvals` with its own agent token. Before the demo it mints an observer link (observer token with `stream:read`, filtered to `#approvals`; `get_observer_url` in the MCP tools does the same) and that link is open on the judges' screen. Never build an observer URL from the workspace key.
- It is not a security layer. Its power is bounded by the invariants in section 3 and by the one-off function in Postgres.

### 7. Merchant dashboard (Person 4)

One page: labels with descriptions and policy sentences, human queue (unlabeled-column intents only) with Allow once, Always allow and Reject, live audit log (intent, plan, who decided: validator, policy agent or human, decision, reason, calls from `getStatus`, expiry), and the adversarial button that replays a forbidden PostgREST request with an agent JWT and prints the Postgres denial.

## Demo script (about 3 minutes)

1. Show the saved label proposal; merchant confirms.
2. A real agent on a second machine curls the store's arelay.to address: "shirts with body length under 30 inches, in stock in size M, shippable in 3 days or less." It gets a URL, calls it, gets the answer.
3. It asks for supplier cost. Instant denial with the reason. Click the adversarial button: Postgres denies the column, live.
4. It asks for the fabric origin of the shirts it was just shown. The policy agent approves in seconds; its reasoning appears on `#approvals` on the judges' screen; the answer arrives. The same agent asks for fabric origin across the whole catalog. The policy agent denies with "bulk", reasoning visible. Adversarial button with that intent's JWT: Postgres denies.
4b. (short) It asks for supplier name, an unlabeled column. Pending; it lands in the human queue. Show Allow once and Always allow. Click only if time allows.
5. A scraping pattern trips the policy rules.
6. Let the API expire and show the next call fail.

Never cut steps 3, 4 or 6.

## Tonight (configuration and throwaway tests, nothing kept)

| Item | Pass means | If it fails |
|---|---|---|
| Agent Relay Cloud workspace, agent registered via SDK, `RELAY_AGENT_TOKEN` stored | Agent shows online in roster | Fall back to Relay Connect room (60-minute invite link) |
| arelay.to handle claimed, echo challenge answered by stub listener | `curl --data-raw hi https://arelay.to/<store>/<id>` gets a reply | MCP tools fallback, or Relay Connect |
| Late-reply measurement: receive, wait 3 minutes, reply | Know whether late replies arrive and what "timeout" is | Polling `GET /a/:id` is already primary |
| ES256 signing key imported and rotated; `supabase gen bearer-jwt --role agent_public` + curl with `apikey` | Grants apply, private column denied with 42501 | Legacy HS256 secret if the project still has it |
| `select=*` with `agent_public` | Fails; confirms executor must list columns | None needed |
| Enable RLS on a test table without a policy | Returns `200 []`; confirms why RLS stays off | None needed |
| Owner-rights view exposing `in_stock`, embedded to products | Derived field works, `stock_count` denied | Materialize `in_stock` as a column |
| Terse hello-world deployed, new actor ID, fetch to Supabase from inside the actor | Instances on demand, outbound fetch works | `terse actor dev` locally for the demo |
| `@Compute({ idleTimeoutMs })` cold-start comparison | Know whether to use it or pre-warm | Pre-warm with `getStatus` |
| `one_off_read` with a JWT `intent_id` claim | Returns the column only for the granted intent | Cut Allow once, keep Always allow |
| Post to a relay channel with the agent token, mint an observer link, open it in a browser | Judges' view shows the post live | Show the dashboard audit log instead |
| Structured-output policy call with the seed policy sentence against the two demo requests | Allow for the specific request, deny for the bulk one | Hardcode the two decisions for the demo and say so |

## Team and timeline

| Person | Owns |
|---|---|
| 1 | Supabase SQL: seed, labels, compiler, role, revokes, grants, view, `one_off_read`, JWT-mint helper |
| 2 | Gateway: endpoints, validator, policy rules, executor, Terse client calls, approval queue |
| 3 | Terse actor, relay SDK listener, plan-generation prompt, policy agent and `#approvals` post, customer-agent demo script |
| 4 | Dashboard (smaller queue), observer link on the judges' screen, demo script, pitch, two rehearsals, backup video |

- 11:00 Freeze plan format, actor method signatures and gateway API contract.
- 11:15 to 13:00 Build each piece against mocks. Person 1's mandatory SQL block lands first.
- 13:00 Lunch, then connect the happy path end to end.
- 14:30 Denial, policy-agent approval, human queue and expiry working.
- 15:15 Feature freeze, rehearse twice, record a backup video.
- 16:00 Submit.

Cut order if late: observer link (show the audit log), policy agent (conditional columns fall back to the human queue; say so), dashboard labels view (show the file), Allow once (keep Always allow, soften the pitch), the adversarial button's second use in step 4.

## Accepted for the demo

- Plans cannot express every request, so some fail or queue.
- Visitors are anonymous; caller = conversation id; caps are bypassable by opening a new conversation.
- The database enforces the tier ceiling; narrowing to one intent is actor code.
- The gateway holds the most powerful keys.
- Anyone holding a URL plus token can use it until it expires.
- arelay.to retains conversation content for 7 days.
- The LLM can misread a column, so descriptions matter.
- The policy agent can misjudge live. Its errors are bounded: conditional columns only, `once` only, 20 rows per request, 3 approvals per conversation, expires with the API.
- Judges may ask why an LLM approves disclosure. Answer with the honesty bullet: it can only say no to something the merchant already said maybe to.

Product questions to be ready for: who buys this (B2B on Supabase may beat marketplaces), why merchants would not publish fixed agent tools themselves, who pays for LLM calls from unknown agents, how long a request waits, how identity would work for real (Relay workspace membership or A2A with a verified domain), name.

## Verification

1. Validator unit tests: unlabeled column (pending), private column (reject), disallowed op, over-limit, `select` missing.
2. Anon key: `GET /products?select=supplier_cost` with the publishable key alone returns 42501.
3. Adversarial: agent JWT requesting `supplier_cost`, including in a filter and an order, returns 42501. `select=*` returns 42501.
4. Derived: `in_stock` readable, `stock_count` denied.
5. Prompt injection: visitor message instructs the listener to expose private columns; the plan is rejected or pending, nothing else changes.
6. Expiry: call after `expiresAt` fails, including before the alarm fires.
7. Policy rules: fourth intent on the same resource from one conversation is blocked.
8. Allow once: the approved intent gets the column; a different intent is denied by `one_off_read`; the same intent after expiry is denied. Always allow: labels change and a new intent reads it.
9. Policy agent: a specific request for a conditional column is allowed and a `one_off_grants` row exists with the API's expiry; a bulk request for the same column is denied; a plan naming a private column never reaches the policy agent; a forced timeout puts the intent in the human queue; an agent output asking for `always` or a different column is ignored and logged.
10. Full demo run twice from a second machine, with the observer link open.

## Review findings (why this revision)

Doc-checked against docs.useterse.ai, agentrelay.com/llms-full.txt, arelay.to/register, Supabase (signing keys, column-level security, RLS, securing your API) and PostgREST (auth, db_authz, embedding).

Critical: arelay.to visitors have no identity (killed the customer tier). Agent Relay's own guide recommends an SDK listener, not a laptop session, and warns a laptop session hands prompt injection a shell. Visitor turns end with `timeout`, so late thread replies are unreliable. Handle registration needs the answer agent online for the echo challenge. Supabase default privileges let the anon key read new public tables; RLS without a policy returns `200 []`; column-restricted roles cannot `select=*`. Custom-role JWTs need an imported ES256 key, a throttled rotation, and an `apikey` header alongside.

High: the old pitch premise was false. "One agent" was unenforced. `one_off_read` bypasses RLS and needed `format('%I')`, `search_path = ''` and an EXECUTE revoke. "No EXECUTE" needed explicit default-privilege revokes. The review agent is not a security layer.

Medium: Terse actors sleep after 10s; method signatures are the deployed contract; persisted fields must be reassigned; the actor must visibly own the plan. The old timeline overloaded Person 2.

Added after review: agent-to-agent approval. An LLM that can widen the boundary on its own judgment is prompt-injectable through the intent text, so the safe shape is a `conditional` label with a merchant-written policy sentence. The policy agent decides only whether a request fits that sentence; code enforces the caps; Postgres enforces the ceiling; the human queue keeps unlabeled columns and every failure path.
