import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeActors, FakeRelay } from "../src/adapters/fake.js";
import { PostgresStore } from "../src/adapters/postgres-store.js";
import { TerseActors, type TemporaryApiClient } from "../src/adapters/terse.js";
import { OpenAIPlanner, OpenAIReviewer } from "../src/agents/index.js";
import { createPool } from "../src/db.js";
import { Harness } from "../src/pipeline/index.js";
import type { GrantCredential, GrantSpec } from "../src/ports/index.js";
import { PostgresGrants } from "../src/provision/index.js";

if (process.env.LIVE_SUPABASE) process.loadEnvFile(".env");

const CA = "supabase-ca.crt";

describe.runIf(process.env.LIVE_SUPABASE)("Supabase boundary", { timeout: 30_000 }, () => {
  let pool: pg.Pool;
  let grants: PostgresGrants;
  let store: PostgresStore;
  const url = new URL(process.env.SUPABASE_DB_URL ?? "postgres://x");
  const merchantId = process.env.LILD_MERCHANT_ID ?? "";
  const created: string[] = [];
  const requests: string[] = [];

  const shirts = (overrides: Partial<GrantSpec> = {}): GrantSpec => ({
    apiId: randomBytes(16).toString("hex"),
    merchantId,
    resource: "products",
    fields: ["variant_id", "name", "size", "body_length_inches"],
    filters: [
      { field: "body_length_inches", op: "lt", value: 30 },
      { field: "quantity", op: "gt", value: 0 },
    ],
    limit: 100,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  });

  const provision = async (overrides: Partial<GrantSpec> = {}) => {
    const spec = shirts(overrides);
    created.push(spec.apiId);
    return { spec, credential: await grants.create(spec) };
  };

  let executor: pg.Client;

  /** One stable login, as the actor uses. Each read switches role in its own transaction. */
  async function login<T>(credential: GrantCredential, run: (client: pg.Client) => Promise<T>): Promise<T> {
    await executor.query("begin");
    try {
      await executor.query(`set local role ${pg.escapeIdentifier(credential.role)}`);
      return await run(executor);
    } finally {
      await executor.query("rollback");
    }
  }

  const denied = (credential: GrantCredential, sql: string) =>
    expect(login(credential, (client) => client.query(sql))).rejects.toThrow(/permission denied|must be|^role .* does not exist/);

  let terse: { TemporaryApi: TemporaryApiClient };

  beforeAll(async () => {
    if (process.env.LIVE_TERSE) {
      const path = "../generated/index.js";
      terse = (await import(/* @vite-ignore */ path)).actors;
    }
    pool = createPool(process.env.SUPABASE_DB_URL!, CA);
    const executorUrl = new URL(process.env.LILD_EXECUTOR_URL!);
    executor = new pg.Client({
      host: executorUrl.hostname,
      port: Number(executorUrl.port),
      database: executorUrl.pathname.slice(1),
      user: decodeURIComponent(executorUrl.username),
      password: decodeURIComponent(executorUrl.password),
      ssl: { rejectUnauthorized: true, ca: readFileSync(CA, "utf8"), servername: executorUrl.hostname },
      connectionTimeoutMillis: 10_000,
    });
    executor.on("error", () => undefined);
    await executor.connect();
    grants = new PostgresGrants(pool);
    store = new PostgresStore(pool);
  });

  afterAll(async () => {
    await executor.end();
    await Promise.all(created.map((id) => grants.revoke(id)));
    await pool.query("delete from lild.interactions where request_id = any($1)", [requests]);
    await pool.query("delete from lild.apis where request_id = any($1)", [requests]);
    await pool.query("delete from lild.requests where request_id = any($1)", [requests]);
    const left = await pool.query("select count(*)::int as n from pg_roles where rolname = any($1)", [created.map((id) => `lild_api_${id}`)]);
    await pool.end();
    expect(left.rows[0].n).toBe(0);
  });

  it("is on a non-superuser admin connection", async () => {
    const { rows } = await pool.query("select rolsuper from pg_roles where rolname = current_user");
    expect(rows[0].rolsuper).toBe(false);
  });

  it("logs in through the pooler and returns only approved rows and fields", async () => {
    const { credential } = await provision();
    const { rows } = await login(credential, (client) => client.query(`select * from ${credential.view}`));
    const expected = await pool.query(
      `select count(*)::int as n from public.product_variants v
       join public.product_measurements m on m.variant_id = v.id join public.inventory i on i.variant_id = v.id
       where m.body_length_inches < 30 and i.quantity > 0`,
    );
    expect(rows).toHaveLength(Math.min(expected.rows[0].n, 100));
    expect(Object.keys(rows[0]).sort()).toEqual(["body_length_inches", "name", "size", "variant_id"]);
    expect(rows.every((row) => Number(row.body_length_inches) < 30)).toBe(true);
  });

  it("enforces the row limit in the database", async () => {
    const { credential } = await provision({ limit: 3 });
    const { rows } = await login(credential, (client) => client.query(`select * from ${credential.view}`));
    expect(rows).toHaveLength(3);
  });

  it("denies private, custodial, base and internal tables", async () => {
    const { credential } = await provision();
    for (const table of [
      "public.supplier_costs",
      "public.carts",
      "public.cart_items",
      "public.customer_profiles",
      "public.products",
      "public.product_variants",
      "public.inventory",
      "public.product_measurements",
      "public.data_classifications",
      "lild.grants",
      "lild.requests",
      "lild.apis",
      "lild.interactions",
    ]) {
      await denied(credential, `select * from ${table}`);
    }
  });

  it("gives the executor no data access of its own", async () => {
    await expect(executor.query("select * from public.products")).rejects.toThrow("permission denied");
    await expect(executor.query("select * from public.supplier_costs")).rejects.toThrow("permission denied");
    const { credential } = await provision();
    await expect(executor.query(`select * from ${credential.view}`)).rejects.toThrow("permission denied");
  });

  it("denies per-API roles any login", async () => {
    const { credential } = await provision();
    const { rows } = await pool.query("select rolcanlogin from pg_roles where rolname = $1", [credential.role]);
    expect(rows[0].rolcanlogin).toBe(false);
  });

  it("denies filtering or joining against supplier cost", async () => {
    const { credential } = await provision();
    await denied(
      credential,
      `select v.variant_id from ${credential.view} v join public.supplier_costs c on c.variant_id = v.variant_id::uuid where c.unit_cost_usd < 4`,
    );
  });

  it("denies another API's view", async () => {
    const first = await provision();
    const second = await provision({ fields: ["variant_id"] });
    const own = await login(first.credential, (client) => client.query(`select * from ${first.credential.view}`));
    expect(own.rows.length).toBeGreaterThan(0);
    await denied(first.credential, `select * from ${second.credential.view}`);
  });

  it("denies changing role, privileges or objects", async () => {
    const { credential } = await provision();
    for (const role of ["lild_view_owner", "lild_provisioner", "lild_recorder", "postgres", "service_role", "authenticated", "anon"]) {
      await denied(credential, `set role ${role}`);
    }
    await denied(credential, "create table public.stolen (id text)");
    await denied(credential, "create table lild_api.stolen (id text)");
    await denied(credential, `grant select on public.products to ${credential.role}`);
    await denied(credential, "create role attacker");
    await denied(credential, `alter role ${credential.role} valid until 'infinity'`);
  });

  it("gives supporting roles no route to private or custodial data", async () => {
    const client = await pool.connect();
    try {
      for (const role of ["lild_view_owner", "lild_recorder", "lild_provisioner"]) {
        for (const table of ["public.supplier_costs", "public.carts", "public.customer_profiles"]) {
          await client.query("begin");
          await client.query(`set local role ${role}`);
          await expect(client.query(`select * from ${table}`)).rejects.toThrow("permission denied");
          await client.query("rollback");
        }
      }
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("refuses to provision supplier cost even if a plan reaches it", async () => {
    await expect(grants.create(shirts({ fields: ["supplier_cost"] }))).rejects.toThrow("cannot be provisioned");
    await expect(
      grants.create(shirts({ filters: [{ field: "supplier_cost", op: "lt", value: 5 }] })),
    ).rejects.toThrow("cannot be provisioned");
  });

  it("rolls back fully when view creation fails", async () => {
    const spec = shirts({ filters: [{ field: "body_length_inches", op: "eq", value: "not-a-number" }] });
    await expect(grants.create(spec)).rejects.toThrow();
    const { rowCount } = await pool.query("select 1 from pg_roles where rolname = $1", [`lild_api_${spec.apiId}`]);
    expect(rowCount).toBe(0);
  });

  it("escapes a malicious filter literal", async () => {
    const { credential } = await provision({ filters: [{ field: "name", op: "eq", value: "x' or '1'='1" }] });
    const { rows } = await login(credential, (client) => client.query(`select * from ${credential.view}`));
    expect(rows).toEqual([]);
  });

  it.each([
    ["field", { fields: ['id" from public.supplier_costs --'] }],
    ["filter field", { filters: [{ field: "id; drop table x", op: "eq" as const, value: 1 }] }],
    ["inherited field", { fields: ["constructor"] }],
    ["resource", { resource: "public.supplier_costs" }],
    ["api id", { apiId: 'x"; drop role postgres; --' }],
    ["merchant id", { merchantId: "x' or true --" }],
    ["limit", { limit: 0 }],
  ])("rejects a malicious %s", async (_name, overrides) => {
    await expect(grants.create(shirts(overrides))).rejects.toThrow();
  });

  it("rejects reads after expiry, with an error rather than empty rows", async () => {
    const { credential } = await provision({ expiresAt: new Date(Date.now() + 6_000).toISOString() });
    const before = await login(credential, (client) => client.query(`select * from ${credential.view}`));
    expect(before.rows.length).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 7_000));
    await expect(login(credential, (client) => client.query(`select * from ${credential.view}`))).rejects.toThrow(
      /api expired/,
    );
  });

  it("revokes idempotently and ends access", async () => {
    const { spec, credential } = await provision();
    await grants.revoke(spec.apiId);
    await grants.revoke(spec.apiId);
    await expect(login(credential, (client) => client.query(`select * from ${credential.view}`))).rejects.toThrow(
      /does not exist/,
    );
  });

  it("handles concurrent creates and revokes", async () => {
    const provisioned = await Promise.all(Array.from({ length: 6 }, () => provision()));
    await Promise.all(provisioned.map(({ spec }) => grants.revoke(spec.apiId)));
    const ids = provisioned.map(({ spec }) => spec.apiId);
    const { rowCount } = await pool.query("select 1 from lild.grants where api_id = any($1)", [ids]);
    expect(rowCount).toBe(0);
  });

  it("loads classifications from the database", async () => {
    const policy = await store.loadPolicy(merchantId);
    expect(policy.resources.products!.fields.body_length_inches?.classification).toBe("reviewable");
    expect(policy.resources.products!.fields.supplier_cost?.classification).toBe("private");
    expect(policy.resources.carts!.fields.user_id?.classification).toBe("custodial");
  });

  describe("end to end, with fake Relay and actor", () => {
    function setup() {
      const config = { apiKey: process.env.OPENAI_API_KEY!, model: process.env.OPENAI_MODEL! };
      const relay = new FakeRelay();
      const actors = new FakeActors();
      // Records the config for the assertions below, then configures the real actor when available.
      const real = process.env.LIVE_TERSE ? new TerseActors(terse.TemporaryApi) : null;
      const configure = actors.configure.bind(actors);
      actors.configure = async (apiId, config) => {
        await real?.configure(apiId, config, new AbortController().signal).catch((error) => { console.error("ACTOR ERROR", String(error).slice(0, 500)); throw error; });
        await configure(apiId, config);
      };
      const newId = () => randomBytes(16).toString("hex");
      const harness = new Harness(
        {
          relay,
          actors,
          grants,
          store,
          planner: new OpenAIPlanner(config),
          reviewer: new OpenAIReviewer(config),
          now: () => new Date(),
          newId,
          newToken: () => randomBytes(32).toString("base64url"),
        },
        { merchantId, gatewayBaseUrl: "https://gateway.test", deadlines: { modelMs: 60_000, remoteMs: 10_000, relayMs: 10_000 } },
      );
      return { relay, actors, harness };
    }

    const send = async (text: string) => {
      const ctx = setup();
      const outcome = await ctx.harness.handle({ eventId: randomUUID(), from: "customer", text });
      if ("requestId" in outcome) requests.push(outcome.requestId);
      return { ...ctx, outcome };
    };

    it("answers the demo request with matching shirts and durable records", { timeout: 120_000 }, async () => {
      const { outcome, relay, actors } = await send("Which in-stock shirts have a body length under 30 inches?");
      expect(outcome).toMatchObject({ status: "active" });
      if (outcome.status !== "active") return;
      created.push(outcome.apiId);

      const reply = relay.replies[0];
      if (reply?.kind !== "api") throw new Error("expected an API reply");
      const credential = actors.configured.get(outcome.apiId)!.credential;
      const { rows } = await login(credential, (client) => client.query(`select * from ${credential.view}`));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].product_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(rows[0].variant_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(reply.contract.fields).toEqual(expect.arrayContaining(["product_id", "variant_id"]));
      expect(JSON.stringify(rows)).not.toContain("unit_cost");
      if (process.env.LIVE_TERSE) {
        const status = await (terse.TemporaryApi.get(outcome.apiId) as unknown as { getStatus(): Promise<{ state: string }> }).getStatus();
        expect(status.state).toBe("active");
      }

      const api = await pool.query("select category, state, plan from lild.apis where api_id = $1", [outcome.apiId]);
      expect(api.rows[0]).toMatchObject({ category: "product_discovery", state: "active" });
      const log = await pool.query("select type, outcome, approver_type from lild.interactions where request_id = $1 order by id", [outcome.requestId]);
      expect(log.rows.map((row) => row.type)).toEqual(["review_decision", "api_delivered"]);
      const dump = JSON.stringify([api.rows, log.rows]);
      expect(dump).not.toContain(reply.token);
    });

    it("refuses supplier cost and records the refusal", { timeout: 120_000 }, async () => {
      const { outcome } = await send("What is the supplier cost of each shirt?");
      expect(outcome.status).toBe("refused");
      if (outcome.status !== "refused") return;
      const request = await pool.query("select state from lild.requests where request_id = $1", [outcome.requestId]);
      expect(request.rows[0].state).toBe("rejected");
    });

    it("refuses a cart request as needing authentication", { timeout: 120_000 }, async () => {
      const { outcome } = await send("Show me the cart for customer 42.");
      expect(outcome).toMatchObject({ status: "refused", code: "authentication_required" });
    });

    it("ignores a redelivered event", { timeout: 120_000 }, async () => {
      const ctx = setup();
      const eventId = randomUUID();
      const first = await ctx.harness.handle({ eventId, from: "customer", text: "Show me the cart for customer 42." });
      if ("requestId" in first) requests.push(first.requestId);
      expect(await ctx.harness.handle({ eventId, from: "customer", text: "anything" })).toEqual({ status: "duplicate" });
    });
  });
});
