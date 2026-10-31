import type {
  ApiRecord,
  InteractionRecord,
  MerchantPolicy,
  Reply,
  RequestRecord,
  RequestState,
} from "../contracts/index.js";
import type {
  ActorConfig,
  ActorsPort,
  GrantCredential,
  GrantsPort,
  GrantSpec,
  PlannerPort,
  RelayMessage,
  RelayPort,
  ReviewerPort,
  StorePort,
} from "../ports/index.js";

/** Test seed. It mirrors the spec's demo classifications; `internal_notes` is left unclassified on purpose. */
export const SEED_POLICY: MerchantPolicy = {
  merchantId: "seed-merchant",
  maxApiTtlSeconds: 900,
  maxRowLimit: 100,
  resources: {
    products: {
      category: "product_discovery",
      fields: {
        id: { classification: "reviewable", type: "string" },
        name: { classification: "reviewable", type: "string" },
        kind: { classification: "reviewable", type: "string" },
        body_length_in: { classification: "reviewable", type: "number" },
        in_stock: { classification: "reviewable", type: "boolean" },
        supplier_cost: { classification: "private", type: "number" },
      },
    },
    carts: {
      category: "cart_access",
      fields: {
        customer_id: { classification: "custodial", type: "string" },
        items: { classification: "custodial", type: "string" },
      },
    },
  },
};

export type Script<T> = () => T | Promise<T>;

export class FakePlanner implements PlannerPort {
  calls: Parameters<PlannerPort["plan"]>[0][] = [];
  constructor(private readonly script: Script<unknown>) {}
  async plan(input: Parameters<PlannerPort["plan"]>[0]): Promise<unknown> {
    this.calls.push(input);
    return this.script();
  }
}

export class FakeReviewer implements ReviewerPort {
  calls = 0;
  constructor(private readonly script: (planHash: string) => unknown) {}
  async review(input: Parameters<ReviewerPort["review"]>[0]): Promise<unknown> {
    this.calls += 1;
    return this.script(input.planHash);
  }
}

export class FakeRelay implements RelayPort {
  replies: Reply[] = [];
  failOnKind?: Reply["kind"];
  delayMs = 0;
  async reply(_message: RelayMessage, reply: Reply): Promise<void> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (reply.kind === this.failOnKind) throw new Error("relay down");
    this.replies.push(reply);
  }
}

export class FakeGrants implements GrantsPort {
  active = new Map<string, GrantSpec>();
  created = 0;
  failCreate = false;
  failRevoke = false;
  async create(spec: GrantSpec): Promise<GrantCredential> {
    if (this.failCreate) throw new Error("grant failed");
    this.created += 1;
    this.active.set(spec.apiId, spec);
    return { role: `api_${spec.apiId}`, view: `api_${spec.apiId}_view` };
  }
  async revoke(apiId: string): Promise<void> {
    if (this.failRevoke) throw new Error("revoke failed");
    this.active.delete(apiId);
  }
}

export class FakeActors implements ActorsPort {
  configured = new Map<string, ActorConfig>();
  fail = false;
  async configure(apiId: string, config: ActorConfig): Promise<void> {
    if (this.fail) throw new Error("terse down");
    this.configured.set(apiId, config);
  }
}

export class FakeStore implements StorePort {
  requests = new Map<string, RequestRecord>();
  apis = new Map<string, ApiRecord>();
  interactions: InteractionRecord[] = [];
  private events = new Set<string>();
  /** Names of store methods that should throw. */
  failing = new Set<keyof StorePort>();
  /** Fails `setRequestState` only when moving to this state. */
  failStateTo?: RequestState;
  /** Fails `addInteraction` only for this type. */
  failInteraction?: InteractionRecord["type"];

  private guard(method: keyof StorePort): void {
    if (this.failing.has(method)) throw new Error(`${method} failed`);
  }
  async createRequest(record: RequestRecord): Promise<boolean> {
    this.guard("createRequest");
    if (this.events.has(record.eventId)) return false;
    this.events.add(record.eventId);
    this.requests.set(record.requestId, record);
    return true;
  }
  async setRequestState(requestId: string, state: RequestState, reason: string): Promise<void> {
    this.guard("setRequestState");
    if (state === this.failStateTo) throw new Error("state write failed");
    const record = this.requests.get(requestId);
    if (!record) throw new Error("unknown request");
    this.requests.set(requestId, { ...record, state, reason });
  }
  async createApi(record: ApiRecord): Promise<void> {
    this.guard("createApi");
    this.apis.set(record.apiId, record);
  }
  async setApiState(apiId: string, state: RequestState): Promise<void> {
    this.guard("setApiState");
    const record = this.apis.get(apiId);
    if (!record) throw new Error("unknown api");
    this.apis.set(apiId, { ...record, state });
  }
  async addInteraction(record: InteractionRecord): Promise<void> {
    this.guard("addInteraction");
    if (record.type === this.failInteraction) throw new Error("interaction write failed");
    this.interactions.push(record);
  }
  async loadPolicy(): Promise<MerchantPolicy> {
    this.guard("loadPolicy");
    return SEED_POLICY;
  }
}
