# Verified end-to-end runs

Real agents calling the relay through `lild-mcp`, with the backend log as proof.
Use these as the reference for "what success looks like" when you change anything.

**The rule for success:** the agent's request_id must show up in the relay log as
`request accepted … client_id=<that agent>`, followed by `job processed … outcome="active"`.
An agent that answers without that log line did **not** use the relay.

All runs below use the stub pipeline (`LILD_PIPELINE=stub`), so results are correctly
reported as **simulated**.

---

## Run 1: Codex CLI (user-run, 2026-10-31, tag `v0.4.1`)

Setup: `phases/phase-4/connect-codex.sh`, then `phases/phase-4/server.sh` (local Postgres, 2 workers).

**Agent side** (Codex v0.166.0, session `01a19395-e7c8-7ee3-b3c9-8a82f1b31536`):

```text
$ codex exec -c 'mcp_servers.lild-relay.default_tools_approval_mode="approve"' \
  "Use the lild-relay tool ask_merchant to ask: Which in-stock shirts have a body length under 30 inches? Report status, request_id and whether the result is simulated."

mcp: lild-relay/ask_merchant started
mcp: lild-relay/ask_merchant (completed)
codex
- **Status:** active
- **Request ID:** `781fa85a-6abf-48c4-968e-a8ed5c42e2bb`
- **Simulated:** Yes — the result is a placeholder, not real merchant data.
```

**Relay side** (`phases/phase-4/server.sh` output):

```text
20:07:45.260335Z INFO relay listening bind=127.0.0.1:8080 configured=4 newly_provisioned=2
20:07:45.260386Z INFO workers started workers=2 pipeline=stub
20:10:43.740828Z INFO request accepted request_id=781fa85a-6abf-48c4-968e-a8ed5c42e2bb client_id=codex-agent replayed=false
20:10:43.762610Z INFO job processed   request_id=781fa85a-6abf-48c4-968e-a8ed5c42e2bb attempt=1 outcome="active"
```

What this proves:

- Codex discovered and called the `ask_merchant` MCP tool.
- It authenticated with **its own key** (`client_id=codex-agent`, from `CODEX_KEY`).
- Same request_id on both sides: the answer came from this backend.
- The request was stored, claimed by a worker and finished in ~22 ms.
- `newly_provisioned=2`: the relay loaded the new `claude-agent` and `codex-agent` keys at startup.
- The simulated flag reached the agent, and Codex reported it honestly.

## Run 2: Claude Code (automated, 2026-10-31, tag `v0.4.0`)

Headless Claude Code 2.1.316 with a temporary `--mcp-config` (the user's config was not touched):

```text
The relay is reachable and the API key was accepted.
- Status: active
- request_id: 704001cb-f4ce-4c65-8656-0c617f7aaad4
- Simulated: Yes — placeholder pipeline, no actual shirt data returned.
```

Relay log:

```text
request accepted request_id=704001cb-f4ce-4c65-8656-0c617f7aaad4 client_id=demo-customer replayed=false
job processed   request_id=704001cb-f4ce-4c65-8656-0c617f7aaad4 attempt=1 outcome="active"
```

Claude called `check_relay_connection`, then `ask_merchant`. This run predates per-agent
keys, so it used `demo-customer`. With `connect-claude.sh` it logs as `claude-agent`.

---

## Known pitfall: the agent answers without calling the relay

When the prompt doesn't mention the tool (e.g. just *"which in-stock shirts have a body
length under 30 inches"*), Codex used its own browser/computer tool and asked which store to
check. **No `request accepted` line appeared in the relay log, so that is not a success.**
Name the tool in the prompt ("Use the lild-relay tools to …"), and check `/mcp` in Codex
or Claude to confirm `lild-relay` is loaded.

## Re-verify after changes

```bash
scripts/before-phase.sh 5           # automated: phases 1-4, including a scripted MCP session
phases/phase-4/server.sh            # then repeat Run 1 by hand and compare the log lines
```
