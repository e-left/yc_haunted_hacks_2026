import type {
  ApiRecord,
  ExposedResource,
  Filter,
  InteractionRecord,
  MerchantPolicy,
  Plan,
  Reply,
  RequestLogEntry,
  RequestLogPatch,
  RequestRecord,
  RequestState,
} from "../contracts/index.js";

export interface RelayMessage {
  eventId: string;
  /** Routing only. A Relay sender is never treated as a customer identity. */
  from: string;
  text: string;
  threadId?: string;
}

export interface RelayPort {
  reply(message: RelayMessage, reply: Reply): Promise<void>;
}

/** Agents return `unknown`: their output is untrusted until a schema has parsed it. */
export interface PlannerPort {
  plan(input: { requestText: string; exposed: ExposedResource[] }, signal: AbortSignal): Promise<unknown>;
}

export interface ReviewerPort {
  review(
    input: { requestText: string; plan: Plan; planHash: string; policy: MerchantPolicy },
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface GrantSpec {
  apiId: string;
  merchantId: string;
  resource: string;
  fields: string[];
  filters: Filter[];
  limit: number;
  expiresAt: string;
}

export interface GrantCredential {
  role: string;
  view: string;
}

export interface GrantsPort {
  create(spec: GrantSpec, signal: AbortSignal): Promise<GrantCredential>;
  revoke(apiId: string, signal: AbortSignal): Promise<void>;
}

export interface ActorConfig {
  plan: Plan;
  planHash: string;
  tokenHash: string;
  credential: GrantCredential;
  expiresAt: string;
}

export interface ActorsPort {
  configure(apiId: string, config: ActorConfig, signal: AbortSignal): Promise<void>;
}

export interface StorePort {
  /** Returns false when this Relay event was already recorded. */
  createRequest(record: RequestRecord, signal: AbortSignal): Promise<boolean>;
  setRequestState(requestId: string, state: RequestState, reason: string, signal: AbortSignal): Promise<void>;
  createApi(record: ApiRecord, signal: AbortSignal): Promise<void>;
  setApiState(apiId: string, state: RequestState, signal: AbortSignal): Promise<void>;
  addInteraction(record: InteractionRecord, signal: AbortSignal): Promise<void>;
  loadPolicy(merchantId: string, signal: AbortSignal): Promise<MerchantPolicy>;
  startRequestLog(entry: RequestLogEntry, signal: AbortSignal): Promise<void>;
  updateRequestLog(requestId: string, patch: RequestLogPatch, signal: AbortSignal): Promise<void>;
}

export interface Dependencies {
  relay: RelayPort;
  planner: PlannerPort;
  reviewer: ReviewerPort;
  grants: GrantsPort;
  actors: ActorsPort;
  store: StorePort;
  now(): Date;
  newId(): string;
  newToken(): string;
}
