import pg from "pg";
import { PRODUCT_FIELDS, PRODUCTS_FROM, type CatalogField } from "../catalog.js";
import type { Filter } from "../contracts/index.js";
import { asRole } from "../db.js";
import type { GrantCredential, GrantsPort, GrantSpec } from "../ports/index.js";

const OPERATORS: Record<Filter["op"], string> = { eq: "=", lt: "<", lte: "<=", gt: ">", gte: ">=" };
const API_ID = /^[a-f0-9]{32}$/;
const MERCHANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Grants all change one shared schema ACL, which Postgres cannot update concurrently. */
const GRANT_LOCK = "select pg_advisory_xact_lock(hashtext('lild_grants'))";

function source(name: string): string {
  const field: CatalogField | undefined = Object.hasOwn(PRODUCT_FIELDS, name) ? PRODUCT_FIELDS[name] : undefined;
  if (!field?.sql) throw new Error("field cannot be provisioned");
  return field.sql;
}

function literal(value: Filter["value"]): string {
  if (typeof value === "string") return pg.escapeLiteral(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (!Number.isFinite(value)) throw new Error("invalid number");
  return String(value);
}

function roleName(apiId: string): string {
  if (!API_ID.test(apiId)) throw new Error("invalid api id");
  return `lild_api_${apiId}`;
}

/** Every statement runs under a restricted role, so a bad plan fails instead of using admin rights. */
export class PostgresGrants implements GrantsPort {
  constructor(private readonly pool: pg.Pool) {}

  async create(spec: GrantSpec): Promise<GrantCredential> {
    if (spec.resource !== "products") throw new Error("unsupported resource");
    if (!MERCHANT_ID.test(spec.merchantId)) throw new Error("invalid merchant id");
    if (!Number.isInteger(spec.limit) || spec.limit < 1) throw new Error("invalid limit");
    if (spec.fields.length === 0) throw new Error("no fields");
    const expires = new Date(spec.expiresAt);
    if (Number.isNaN(expires.getTime())) throw new Error("invalid expiry");

    const role = roleName(spec.apiId);
    const quoted = pg.escapeIdentifier(role);
    const columns = spec.fields.map((name) => `${source(name)} as ${pg.escapeIdentifier(name)}`).join(", ");
    const predicates = [
      `lild.require_unexpired(${pg.escapeLiteral(expires.toISOString())}::timestamptz)`,
      `v.merchant_id = ${pg.escapeLiteral(spec.merchantId)}::uuid`,
      ...spec.filters.map((filter) => `${source(filter.field)} ${OPERATORS[filter.op]} ${literal(filter.value)}`),
    ];

    await asRole(this.pool, "lild_provisioner", async (client) => {
      await client.query(GRANT_LOCK);
      await client.query(
        `create role ${quoted} nologin noinherit`,
      );
      await client.query("insert into lild.grants (api_id, role_name, view_name, expires_at) values ($1, $2, $2, $3)", [
        spec.apiId,
        role,
        expires.toISOString(),
      ]);
      await client.query("set local role lild_view_owner");
      await client.query(
        `create view lild_api.${quoted} with (security_barrier = true) as
         select ${columns} from ${PRODUCTS_FROM} where ${predicates.join(" and ")} order by v.id limit ${spec.limit}`,
      );
      await client.query(`grant usage on schema lild_api to ${quoted}`);
      await client.query(`grant select on lild_api.${quoted} to ${quoted}`);
      await client.query("set local role lild_provisioner");
      await client.query(`grant ${quoted} to lild_executor with inherit false, set true`);
    });
    return { role, view: `lild_api.${role}` };
  }

  /** Idempotent, so it can follow a create that failed or timed out. */
  async revoke(apiId: string): Promise<void> {
    const role = roleName(apiId);
    const quoted = pg.escapeIdentifier(role);
    await asRole(this.pool, "lild_view_owner", async (client) => {
      await client.query(GRANT_LOCK);
      const exists = await client.query("select 1 from pg_roles where rolname = $1", [role]);
      await client.query(`drop view if exists lild_api.${quoted}`);
      if (exists.rowCount) await client.query(`revoke usage on schema lild_api from ${quoted}`);
      await client.query("set local role lild_provisioner");
      await client.query(`drop role if exists ${quoted}`);
      await client.query("delete from lild.grants where api_id = $1", [apiId]);
    });
  }

  /** Removes every expired grant and returns the API IDs it closed. One failure does not stop the rest. */
  async sweep(now: Date): Promise<{ closed: string[]; failed: string[] }> {
    const expired = await asRole(this.pool, "lild_provisioner", async (client) => {
      const rows = await client.query<{ api_id: string }>("select api_id from lild.grants where expires_at <= $1", [now.toISOString()]);
      return rows.rows.map((row) => row.api_id);
    });
    const results = await Promise.allSettled(expired.map((apiId) => this.revoke(apiId)));
    return {
      closed: expired.filter((_, index) => results[index]?.status === "fulfilled"),
      failed: expired.filter((_, index) => results[index]?.status === "rejected"),
    };
  }
}
