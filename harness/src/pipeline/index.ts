import { createHash } from "node:crypto";
import {
  hashPlan,
  PlannerOutputSchema,
  ReviewDecisionSchema,
  type Classification,
  type InteractionRecord,
  type Plan,
  type RefusalCode,
  type Reply,
  type RequestState,
} from "../contracts/index.js";
import type { Dependencies, RelayMessage } from "../ports/index.js";
import { exposedInterface, validateDecision, validatePlan, withIdentifiers } from "../validate/index.js";

export interface HarnessConfig {
  merchantId: string;
  gatewayBaseUrl: string;
  /** Relay's DM endpoint alone took 11-13 seconds live, and over 30 from the VM. */
  deadlines: { modelMs: number; remoteMs: number; relayMs: number };
}

export type Outcome =
  | { status: "duplicate" }
  | { status: "active"; requestId: string; apiId: string }
  | { status: "refused"; requestId: string; code: RefusalCode }
  | { status: "error"; requestId: string; code: string };

/** Code-owned text. Model wording never reaches the caller, so it cannot carry an injection. */
const REFUSAL_MESSAGES: Record<RefusalCode, string> = {
  data_unavailable: "This data is not available.",
  authentication_required: "This request needs customer authentication, which is not implemented.",
  ambiguous: "The request is ambiguous. Send a more specific request.",
  unsupported: "This request is not supported.",
  review_denied: "Security review did not approve this request.",
};

export class DeadlineError extends Error {
  constructor(step: string) {
    super(`${step} exceeded its deadline`);
  }
}

export async function withDeadline<T>(
  step: string,
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DeadlineError(step));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : "unknown error";
}

/** Runs one Relay request to a terminal outcome. Failures always close access. */
export class Harness {
  constructor(
    private readonly deps: Dependencies,
    private readonly config: HarnessConfig,
  ) {}

  private remote<T>(step: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return withDeadline(step, this.config.deadlines.remoteMs, run);
  }

  private interaction(record: Omit<InteractionRecord, "at">): Promise<void> {
    const at = this.deps.now().toISOString();
    return this.remote("record interaction", (signal) =>
      this.deps.store.addInteraction({ ...record, at }, signal),
    );
  }

  private async sendReply(message: RelayMessage, reply: Reply): Promise<void> {
    await withDeadline("relay reply", this.config.deadlines.relayMs, () => this.deps.relay.reply(message, reply));
  }

  /** A reply delivery failure has no other channel, so it is recorded best effort and returned. */
  private async fail(message: RelayMessage, requestId: string, code: string, detail: string): Promise<Outcome> {
    const reason = `${code}: ${detail}`;
    const records = await Promise.allSettled([
      this.remote("record failure", (signal) =>
        this.deps.store.setRequestState(requestId, "rejected", reason, signal),
      ),
      this.interaction({ requestId, type: "failure", outcome: code, reason }),
    ]);
    const persisted = records.every((result) => result.status === "fulfilled");
    const finalCode = persisted ? code : "audit_unavailable";
    await this.sendReply(message, {
      kind: "error",
      requestId,
      code: finalCode,
      message: "The request could not be completed.",
    }).catch(() => undefined);
    return { status: "error", requestId, code: finalCode };
  }

  private async refuse(
    message: RelayMessage,
    requestId: string,
    code: RefusalCode,
    reason: string,
    accessCategory?: Classification,
    approverType: InteractionRecord["approverType"] = "deterministic",
  ): Promise<Outcome> {
    try {
      await this.remote("record refusal", (signal) =>
        this.deps.store.setRequestState(requestId, "rejected", `${code}: ${reason}`, signal),
      );
      await this.interaction({
        requestId,
        type: approverType === "security_agent" ? "review_decision" : "refusal",
        outcome: code,
        reason,
        approverType,
        ...(accessCategory ? { accessCategory } : {}),
      });
    } catch (error) {
      return this.fail(message, requestId, "audit_unavailable", errorMessage(error));
    }
    try {
      await this.sendReply(message, { kind: "refused", requestId, code, message: REFUSAL_MESSAGES[code] });
    } catch (error) {
      if (!(error instanceof DeadlineError)) return this.fail(message, requestId, "relay_failed", errorMessage(error));
      await this.unconfirmed(requestId);
    }
    return { status: "refused", requestId, code };
  }

  /** Best effort: the outcome is unknown, and the caller may already hold the reply. */
  private async unconfirmed(requestId: string, apiId?: string): Promise<void> {
    await this.interaction({
      requestId,
      ...(apiId ? { apiId } : {}),
      type: "failure",
      outcome: "delivery_unconfirmed",
    }).catch(() => undefined);
  }

  /** Closes a grant that can no longer be delivered. A failed teardown is reported, not hidden. */
  private async closeGrant(message: RelayMessage, requestId: string, apiId: string, code: string, detail: string, apiCreated: boolean): Promise<Outcome> {
    let finalCode = code;
    try {
      await this.remote("revoke grant", (signal) => this.deps.grants.revoke(apiId, signal));
    } catch (error) {
      finalCode = "cleanup_failed";
      await this.interaction({
        requestId,
        apiId,
        type: "cleanup",
        outcome: "revoke_failed",
        reason: errorMessage(error),
      }).catch(() => undefined);
    }
    if (apiCreated) {
      const state: RequestState = "rejected";
      await this.remote("record api state", (signal) =>
        this.deps.store.setApiState(apiId, state, signal),
      ).catch(() => {
        finalCode = finalCode === "cleanup_failed" ? finalCode : "audit_unavailable";
      });
    }
    return this.fail(message, requestId, finalCode, detail);
  }

  async handle(message: RelayMessage): Promise<Outcome> {
    const requestId = this.deps.newId();
    const { merchantId } = this.config;
    let created: boolean;
    try {
      created = await this.remote("record request", (signal) =>
        this.deps.store.createRequest(
          {
            requestId,
            eventId: message.eventId,
            merchantId,
            receivedAt: this.deps.now().toISOString(),
            state: "pending",
          },
          signal,
        ),
      );
    } catch {
      await this.sendReply(message, {
        kind: "error",
        requestId,
        code: "audit_unavailable",
        message: "The request could not be completed.",
      }).catch(() => undefined);
      return { status: "error", requestId, code: "audit_unavailable" };
    }
    if (!created) return { status: "duplicate" };

    let policy;
    try {
      policy = await this.remote("load policy", (signal) => this.deps.store.loadPolicy(merchantId, signal));
    } catch (error) {
      return this.fail(message, requestId, "database_failed", errorMessage(error));
    }

    let rawPlan: unknown;
    try {
      rawPlan = await withDeadline("planner", this.config.deadlines.modelMs, (signal) =>
        this.deps.planner.plan({ requestText: message.text, exposed: exposedInterface(policy) }, signal),
      );
    } catch (error) {
      return this.fail(message, requestId, "planner_failed", errorMessage(error));
    }
    const planned = PlannerOutputSchema.safeParse(rawPlan);
    if (!planned.success) return this.fail(message, requestId, "planner_failed", "malformed output");
    if (planned.data.kind === "refuse") {
      const category = planned.data.code === "authentication_required" ? "custodial" : undefined;
      return this.refuse(message, requestId, planned.data.code, planned.data.reason, category);
    }

    const plan: Plan = withIdentifiers(planned.data.plan, policy);
    const checked = validatePlan(plan, policy);
    if (!checked.ok) {
      const category = checked.code === "authentication_required" ? "custodial" : undefined;
      return this.refuse(message, requestId, checked.code, checked.detail, category);
    }
    const planHash = hashPlan(plan);

    let rawDecision: unknown;
    try {
      rawDecision = await withDeadline("reviewer", this.config.deadlines.modelMs, (signal) =>
        this.deps.reviewer.review({ requestText: message.text, plan, planHash, policy }, signal),
      );
    } catch (error) {
      return this.fail(message, requestId, "review_unavailable", errorMessage(error));
    }
    const decision = ReviewDecisionSchema.safeParse(rawDecision);
    if (!decision.success) return this.fail(message, requestId, "review_unavailable", "malformed output");

    const approval = validateDecision(decision.data, plan, planHash, policy);
    if (!approval.ok) {
      return this.refuse(
        message,
        requestId,
        approval.code,
        `${approval.detail}: ${decision.data.reason}`.slice(0, 500),
        "reviewable",
        "security_agent",
      );
    }

    const apiId = this.deps.newId();
    const createdAt = this.deps.now();
    const expiresAt = new Date(createdAt.getTime() + approval.ttlSeconds * 1000).toISOString();
    try {
      await this.interaction({
        requestId,
        apiId,
        type: "review_decision",
        outcome: "approved",
        approverType: "security_agent",
        accessCategory: "reviewable",
        reason: decision.data.reason,
      });
    } catch (error) {
      return this.fail(message, requestId, "audit_unavailable", errorMessage(error));
    }

    let credential;
    try {
      credential = await this.remote("create grant", (signal) =>
        this.deps.grants.create(
          {
            apiId,
            merchantId,
            resource: plan.resource,
            fields: plan.fields,
            filters: plan.filters,
            limit: plan.limit,
            expiresAt,
          },
          signal,
        ),
      );
    } catch (error) {
      return this.closeGrant(message, requestId, apiId, "grant_failed", errorMessage(error), false);
    }

    const token = this.deps.newToken();
    const tokenHash = createHash("sha256").update(token).digest("hex");
    try {
      await this.remote("configure actor", (signal) =>
        this.deps.actors.configure(apiId, { plan, planHash, tokenHash, credential, expiresAt }, signal),
      );
    } catch (error) {
      return this.closeGrant(message, requestId, apiId, "actor_failed", errorMessage(error), false);
    }

    let apiCreated = false;
    try {
      await this.remote("record api", (signal) =>
        this.deps.store.createApi(
          {
            apiId,
            requestId,
            merchantId,
            // Checked by validatePlan: the resource exists in this policy.
            category: policy.resources[plan.resource]!.category,
            purpose: plan.purpose,
            plan,
            planHash,
            accessCategories: checked.accessCategories,
            createdAt: createdAt.toISOString(),
            expiresAt,
            state: "active",
          },
          signal,
        ),
      );
      apiCreated = true;
      await this.remote("record request state", (signal) =>
        this.deps.store.setRequestState(requestId, "active", "approved", signal),
      );
    } catch (error) {
      return this.closeGrant(message, requestId, apiId, "audit_unavailable", errorMessage(error), apiCreated);
    }

    try {
      await this.sendReply(message, {
        kind: "api",
        requestId,
        apiId,
        url: `${this.config.gatewayBaseUrl}/apis/${apiId}`,
        contract: { method: "POST", fields: plan.fields, filters: plan.filters, limit: plan.limit, inputs: [] },
        expiresAt,
        token,
      });
    } catch (error) {
      // A timed-out send may still arrive, as seen live. Only the caller can hold this token
      // and the API expires by itself, so revoking would only strand a delivered API.
      if (!(error instanceof DeadlineError)) {
        return this.closeGrant(message, requestId, apiId, "relay_failed", errorMessage(error), true);
      }
      await this.unconfirmed(requestId, apiId);
      return { status: "active", requestId, apiId };
    }

    try {
      await this.interaction({ requestId, apiId, type: "api_delivered", outcome: "delivered" });
    } catch {
      // The caller already holds a working API, so report the gap rather than revoke it silently.
      return { status: "error", requestId, code: "audit_unavailable" };
    }
    return { status: "active", requestId, apiId };
  }
}
