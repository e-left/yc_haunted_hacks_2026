import { readFileSync } from "node:fs";
import pg from "pg";

/** Certificate verification is always on. There is deliberately no option to disable it. */
export function createPool(connectionUrl: string, caPath: string): pg.Pool {
  const url = new URL(connectionUrl);
  return new pg.Pool({
    host: url.hostname,
    port: Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    max: 5,
    connectionTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: true, ca: readFileSync(caPath, "utf8"), servername: url.hostname },
  });
}

/** Runs one transaction as a restricted role, so the pool's own admin rights are never used. */
export async function asRole<T>(
  pool: pg.Pool,
  role: string,
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local statement_timeout = '5s'");
    await client.query(`set local role ${pg.escapeIdentifier(role)}`);
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
