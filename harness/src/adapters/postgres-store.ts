import type pg from "pg";
import { buildPolicy, type ClassificationRow } from "../catalog.js";
import type {
  ApiRecord,
  InteractionRecord,
  MerchantPolicy,
  RequestLogEntry,
  RequestLogPatch,
  RequestRecord,
  RequestState,
} from "../contracts/index.js";
import { asRole } from "../db.js";
import type { StorePort } from "../ports/index.js";

const ROLE = "lild_recorder";

export class PostgresStore implements StorePort {
  constructor(private readonly pool: pg.Pool) {}

  private write(sql: string, values: unknown[]): Promise<number> {
    return asRole(this.pool, ROLE, async (client) => (await client.query(sql, values)).rowCount ?? 0);
  }

  /** An update that matched nothing did not persist, so it must not look like success. */
  private async update(sql: string, values: unknown[]): Promise<void> {
    if ((await this.write(sql, values)) !== 1) throw new Error("record not found");
  }

  async createRequest(record: RequestRecord): Promise<boolean> {
    const count = await this.write(
      `insert into lild.requests (request_id, event_id, merchant_id, received_at, state, reason)
       values ($1, $2, $3, $4, $5, $6) on conflict (event_id) do nothing`,
      [record.requestId, record.eventId, record.merchantId, record.receivedAt, record.state, record.reason ?? null],
    );
    return count === 1;
  }

  setRequestState(requestId: string, state: RequestState, reason: string): Promise<void> {
    return this.update("update lild.requests set state = $2, reason = $3 where request_id = $1", [requestId, state, reason]);
  }

  async createApi(record: ApiRecord): Promise<void> {
    await this.write(
      `insert into lild.apis (api_id, request_id, merchant_id, category, purpose, plan, plan_hash,
         access_categories, created_at, expires_at, state)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        record.apiId,
        record.requestId,
        record.merchantId,
        record.category,
        record.purpose,
        JSON.stringify(record.plan),
        record.planHash,
        record.accessCategories,
        record.createdAt,
        record.expiresAt,
        record.state,
      ],
    );
  }

  setApiState(apiId: string, state: RequestState): Promise<void> {
    return this.update("update lild.apis set state = $2 where api_id = $1", [apiId, state]);
  }

  async addInteraction(record: InteractionRecord): Promise<void> {
    await this.write(
      `insert into lild.interactions (request_id, api_id, type, outcome, approver_type, access_category, reason, at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        record.requestId,
        record.apiId ?? null,
        record.type,
        record.outcome,
        record.approverType ?? null,
        record.accessCategory ?? null,
        record.reason ?? null,
        record.at,
      ],
    );
  }

  async loadPolicy(merchantId: string): Promise<MerchantPolicy> {
    const rows = await asRole(this.pool, ROLE, async (client) => {
      const result = await client.query<ClassificationRow>(
        "select resource, field_name, category from public.data_classifications where merchant_id = $1",
        [merchantId],
      );
      return result.rows;
    });
    if (rows.length === 0) throw new Error("no classifications for merchant");
    return buildPolicy(merchantId, rows);
  }

  async startRequestLog(entry: RequestLogEntry): Promise<void> {
    await this.write(
      `insert into lild.request_log (request_id, event_id, merchant_id, sender, request_text)
       values ($1, $2, $3, $4, $5)`,
      [entry.requestId, entry.eventId, entry.merchantId, entry.sender, entry.requestText],
    );
  }

  updateRequestLog(requestId: string, patch: RequestLogPatch): Promise<void> {
    const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value));
    return this.update(
      `update lild.request_log set
         status = coalesce($2, status), status_code = coalesce($3, status_code),
         planner_output = coalesce($4::jsonb, planner_output), plan = coalesce($5::jsonb, plan),
         plan_hash = coalesce($6, plan_hash), review = coalesce($7::jsonb, review),
         reply = coalesce($8::jsonb, reply), api_id = coalesce($9, api_id),
         actor_class = coalesce($10, actor_class), actor_id = coalesce($11, actor_id),
         api_url = coalesce($12, api_url), contract = coalesce($13::jsonb, contract),
         expires_at = coalesce($14, expires_at), updated_at = now()
       where request_id = $1`,
      [
        requestId,
        patch.status ?? null,
        patch.statusCode ?? null,
        json(patch.plannerOutput),
        json(patch.plan),
        patch.planHash ?? null,
        json(patch.review),
        json(patch.reply),
        patch.apiId ?? null,
        patch.actorClass ?? null,
        patch.actorId ?? null,
        patch.apiUrl ?? null,
        json(patch.contract),
        patch.expiresAt ?? null,
      ],
    );
  }

  /** Linked through the API row, so a caller can never choose which request gets the record. */
  async recordInvocation(apiId: string, outcome: string, at: string): Promise<void> {
    const count = await this.write(
      `insert into lild.interactions (request_id, api_id, type, outcome, at)
       select request_id, api_id, 'invocation', $2, $3 from lild.apis where api_id = $1`,
      [apiId, outcome, at],
    );
    if (count !== 1) throw new Error("invocation not recorded");
    await this.write(
      "update lild.request_log set invocation_count = invocation_count + 1, last_invoked_at = $2, updated_at = now() where api_id = $1",
      [apiId, at],
    );
  }

  /** Closes the API and its request together, so the two records cannot disagree. */
  async markExpired(apiId: string): Promise<void> {
    await asRole(this.pool, ROLE, async (client) => {
      const api = await client.query<{ request_id: string }>(
        "update lild.apis set state = 'expired' where api_id = $1 returning request_id",
        [apiId],
      );
      const requestId = api.rows[0]?.request_id;
      if (!requestId) throw new Error("record not found");
      await client.query("update lild.requests set state = 'expired', reason = 'expired' where request_id = $1", [requestId]);
      await client.query("update lild.request_log set status = 'expired', updated_at = now() where request_id = $1", [requestId]);
    });
  }
}
