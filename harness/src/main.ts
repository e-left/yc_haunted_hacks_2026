import { randomBytes } from "node:crypto";
import { PostgresStore } from "./adapters/postgres-store.js";
import { AgentRelayAdapter } from "./adapters/relay.js";
import { TerseActors, type TemporaryApiClient } from "./adapters/terse.js";
import { OpenAIPlanner, OpenAIReviewer } from "./agents/index.js";
import { createPool } from "./db.js";
import { Harness } from "./pipeline/index.js";
import { PostgresGrants } from "./provision/index.js";

const SWEEP_INTERVAL_MS = 30_000;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  process.loadEnvFile(".env");
  const pool = createPool(env("SUPABASE_DB_URL"), "supabase-ca.crt");
  pool.on("error", (error) => console.error("database pool error:", error.message));

  const store = new PostgresStore(pool);
  const grants = new PostgresGrants(pool);
  const model = { apiKey: env("OPENAI_API_KEY"), model: env("OPENAI_MODEL") };
  const generated = "../generated/index.js";
  const { actors } = (await import(generated)) as { actors: { TemporaryApi: TemporaryApiClient } };
  const name = process.env.RELAY_AGENT_NAME || "merchant";
  const relay = await AgentRelayAdapter.connect(env("RELAY_WORKSPACE_KEY"), name, ".relay-agent-token");

  const harness = new Harness(
    {
      relay,
      store,
      grants,
      actors: new TerseActors(actors.TemporaryApi),
      planner: new OpenAIPlanner(model),
      reviewer: new OpenAIReviewer(model),
      now: () => new Date(),
      newId: () => randomBytes(16).toString("hex"),
      newToken: () => randomBytes(32).toString("base64url"),
    },
    {
      merchantId: env("LILD_MERCHANT_ID"),
      gatewayBaseUrl: env("GATEWAY_BASE_URL"),
      deadlines: { modelMs: 45_000, remoteMs: 10_000, relayMs: 60_000 },
    },
  );

  const sweep = async (): Promise<void> => {
    try {
      const { closed, failed } = await grants.sweep(new Date());
      for (const apiId of closed) await store.markExpired(apiId);
      if (failed.length > 0) console.error(`sweeper could not close ${failed.length} grant(s)`);
    } catch (error) {
      console.error("sweep failed:", error instanceof Error ? error.message : error);
    }
  };
  await sweep();
  const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);

  const stop = relay.listen(
    (message) => {
      void harness.handle(message).then(
        (outcome) => console.log("request", JSON.stringify(outcome)),
        (error) => console.error("request failed:", error instanceof Error ? error.message : error),
      );
    },
    (error) => console.error("relay error:", error instanceof Error ? error.message : error),
  );
  console.log(`harness listening on Agent Relay as @${name}`);

  const shutdown = async (): Promise<void> => {
    clearInterval(timer);
    stop();
    await pool.end();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error("fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
