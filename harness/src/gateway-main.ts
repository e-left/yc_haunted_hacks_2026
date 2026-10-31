import { PostgresStore } from "./adapters/postgres-store.js";
import { createPool } from "./db.js";
import { createGateway, type InvokeResult } from "./gateway.js";

process.loadEnvFile(".env");
const url = process.env.SUPABASE_DB_URL;
if (!url) throw new Error("SUPABASE_DB_URL is not set");

const generated = "../generated/index.js";
const { actors } = (await import(generated)) as {
  actors: { TemporaryApi: { get(id: string): { invoke(tokenHash: string): Promise<InvokeResult> } } };
};
const pool = createPool(url, "supabase-ca.crt");
pool.on("error", (error) => console.error("database pool error:", error.message));
const store = new PostgresStore(pool);

const port = Number(process.env.PORT ?? 3001);
createGateway({
  invoke: (apiId, tokenHash) => actors.TemporaryApi.get(apiId).invoke(tokenHash),
  record: (apiId, outcome) => store.recordInvocation(apiId, outcome, new Date().toISOString()),
}).listen(port, "0.0.0.0", () => console.log(`gateway listening on ${port}`));
