import type {
  Classification,
  ExposedResource,
  FieldPolicy,
  MerchantPolicy,
  Plan,
  RefusalCode,
  ReviewDecision,
} from "../contracts/index.js";

export type Check<T = object> =
  | ({ ok: true } & T)
  | { ok: false; code: RefusalCode; detail: string };

/** The planner sees reviewable field names and types only, never private or custodial fields. */
export function exposedInterface(policy: MerchantPolicy): ExposedResource[] {
  return Object.entries(policy.resources).flatMap(([name, resource]) => {
    const fields = Object.entries(resource.fields)
      .filter(([, field]) => field.classification === "reviewable")
      .map(([fieldName, field]) => ({ name: fieldName, type: field.type }));
    if (fields.length === 0) return [];
    return [{ name, ...(resource.description ? { description: resource.description } : {}), fields }];
  });
}

function lookup<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function matchesType(value: unknown, field: FieldPolicy): boolean {
  return typeof value === field.type;
}

/** Adds a resource's reviewable identifiers before validation and review, so approval covers them. */
export function withIdentifiers(plan: Plan, policy: MerchantPolicy): Plan {
  const resource = lookup(policy.resources, plan.resource);
  const missing = (resource?.identifierFields ?? []).filter(
    (name) => lookup(resource!.fields, name)?.classification === "reviewable" && !plan.fields.includes(name),
  );
  return { ...plan, fields: [...missing, ...plan.fields] };
}

/** Filters count as data use: a filter on a field can disclose it, so both are classified. */
export function validatePlan(
  plan: Plan,
  policy: MerchantPolicy,
): Check<{ accessCategories: Classification[] }> {
  const resource = lookup(policy.resources, plan.resource);
  if (!resource) return { ok: false, code: "data_unavailable", detail: "unknown resource" };

  const used = [...plan.fields, ...plan.filters.map((filter) => filter.field)];
  const policies = used.map((name) => lookup(resource.fields, name));

  // Private and unclassified outrank custodial, so one bad field cannot be retried with auth.
  if (policies.some((field) => !field || field.classification === "private")) {
    return { ok: false, code: "data_unavailable", detail: "private or unclassified field" };
  }
  if (policies.some((field) => field?.classification === "custodial")) {
    return { ok: false, code: "authentication_required", detail: "custodial field" };
  }
  if (new Set(plan.fields).size !== plan.fields.length) {
    return { ok: false, code: "unsupported", detail: "duplicate field" };
  }
  if (plan.limit > policy.maxRowLimit) {
    return { ok: false, code: "unsupported", detail: "limit exceeds merchant maximum" };
  }
  for (const filter of plan.filters) {
    const field = lookup(resource.fields, filter.field);
    if (!field || !matchesType(filter.value, field)) {
      return { ok: false, code: "unsupported", detail: "filter value has the wrong type" };
    }
    if (field.type !== "number" && filter.op !== "eq") {
      return { ok: false, code: "unsupported", detail: "operator not supported for field type" };
    }
  }
  return { ok: true, accessCategories: ["reviewable"] };
}

/** An approval must match this exact plan. A partial approval is rejected, never narrowed silently. */
export function validateDecision(
  decision: ReviewDecision,
  plan: Plan,
  planHash: string,
  policy: MerchantPolicy,
): Check<{ ttlSeconds: number }> {
  if (decision.verdict !== "approve") {
    return { ok: false, code: "review_denied", detail: "denied by security agent" };
  }
  if (decision.planHash !== planHash) {
    return { ok: false, code: "review_denied", detail: "approval is for a different plan" };
  }
  if (decision.purpose !== plan.purpose) {
    return { ok: false, code: "review_denied", detail: "approval is for a different purpose" };
  }
  const required = new Set([...plan.fields, ...plan.filters.map((filter) => filter.field)]);
  const approved = new Set(decision.approvedFields);
  const sameFields =
    required.size === approved.size && [...required].every((field) => approved.has(field));
  if (!sameFields) {
    return { ok: false, code: "review_denied", detail: "approved fields do not match the plan" };
  }
  return { ok: true, ttlSeconds: Math.min(decision.expiresInSeconds, policy.maxApiTtlSeconds) };
}
