import { createHash } from "node:crypto";
import { z } from "zod";

const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);

export const FilterSchema = z
  .object({
    field: identifier,
    op: z.enum(["eq", "lt", "lte", "gt", "gte"]),
    value: z.union([z.string().max(100), z.number().finite(), z.boolean()]),
  })
  .strict();
export type Filter = z.infer<typeof FilterSchema>;

/** Version 1 plans are fully fixed: `inputs` must be empty, so callers cannot broaden them. */
export const PlanSchema = z
  .object({
    version: z.literal(1),
    resource: identifier,
    fields: z.array(identifier).min(1).max(50),
    filters: z.array(FilterSchema).max(20),
    limit: z.number().int().positive(),
    inputs: z.tuple([]),
    purpose: z.string().min(1).max(200),
  })
  .strict();
export type Plan = z.infer<typeof PlanSchema>;

export const RefusalCodeSchema = z.enum([
  "data_unavailable",
  "authentication_required",
  "ambiguous",
  "unsupported",
  "review_denied",
]);
export type RefusalCode = z.infer<typeof RefusalCodeSchema>;

export const PlannerOutputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan"), plan: PlanSchema }).strict(),
  z
    .object({
      kind: z.literal("refuse"),
      code: RefusalCodeSchema.exclude(["review_denied"]),
      reason: z.string().max(500),
    })
    .strict(),
]);
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

export const ReviewDecisionSchema = z
  .object({
    verdict: z.enum(["approve", "deny"]),
    planHash: z.string().regex(/^[0-9a-f]{64}$/),
    approvedFields: z.array(identifier),
    purpose: z.string().max(200),
    expiresInSeconds: z.number().int().positive(),
    reason: z.string().max(500),
  })
  .strict();
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

export type Classification = "public" | "private" | "custodial" | "reviewable";
export type FieldType = "string" | "number" | "boolean";

export interface FieldPolicy {
  classification: Classification;
  type: FieldType;
}

export interface MerchantPolicy {
  merchantId: string;
  maxApiTtlSeconds: number;
  maxRowLimit: number;
  resources: Record<
    string,
    {
      category: string;
      description?: string;
      /** Added to every plan by code, so results can always be tied to a product. */
      identifierFields?: string[];
      fields: Record<string, FieldPolicy>;
    }
  >;
}

export interface ExposedResource {
  name: string;
  description?: string;
  fields: { name: string; type: FieldType }[];
}

export type RequestState = "pending" | "active" | "rejected" | "expired";

/** Only what the catalog and audit need: no request text, sender, token or password. */
export interface RequestRecord {
  requestId: string;
  eventId: string;
  merchantId: string;
  receivedAt: string;
  state: RequestState;
  reason?: string;
}

export interface ApiRecord {
  apiId: string;
  requestId: string;
  merchantId: string;
  category: string;
  purpose: string;
  plan: Plan;
  planHash: string;
  accessCategories: Classification[];
  createdAt: string;
  expiresAt: string;
  state: RequestState;
}

export interface InteractionRecord {
  requestId: string;
  apiId?: string;
  type: "refusal" | "review_decision" | "failure" | "cleanup" | "api_delivered" | "invocation";
  outcome: string;
  approverType?: "security_agent" | "deterministic";
  accessCategory?: Classification;
  reason?: string;
  at: string;
}

/** Starts a request's row. This is the only record that keeps raw request text. */
export interface RequestLogEntry {
  requestId: string;
  eventId: string;
  merchantId: string;
  sender: string;
  requestText: string;
}

/** Stages fill in their own fields. Undefined fields keep their stored value. */
export interface RequestLogPatch {
  status?: string;
  statusCode?: string;
  plannerOutput?: unknown;
  plan?: Plan;
  planHash?: string;
  review?: unknown;
  reply?: unknown;
  apiId?: string;
  actorClass?: string;
  actorId?: string;
  apiUrl?: string;
  contract?: unknown;
  expiresAt?: string;
}

export type Reply =
  | { kind: "refused"; requestId: string; code: RefusalCode; message: string }
  | { kind: "error"; requestId: string; code: string; message: string }
  | {
      kind: "api";
      requestId: string;
      apiId: string;
      url: string;
      contract: { method: "POST"; fields: string[]; filters: Filter[]; limit: number; inputs: [] };
      expiresAt: string;
      token: string;
    };

/** The token must never reach a log: anyone holding it could call the API. */
export function withoutToken(reply: Reply): unknown {
  return reply.kind === "api" ? { ...reply, token: "[redacted]" } : reply;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonicalize(v)]));
  }
  return value;
}

export function hashPlan(plan: Plan): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(plan))).digest("hex");
}
