import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { withDeadline } from "./pipeline/index.js";

const API_PATH = /^\/apis\/([a-f0-9]{32})$/;
const INVOKE_DEADLINE_MS = 20_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;

export type InvokeResult =
  | { outcome: "ok"; rows: Record<string, unknown>[] }
  | { outcome: "unauthorized" }
  | { outcome: "expired" };

export interface GatewayDeps {
  invoke(apiId: string, tokenHash: string): Promise<InvokeResult>;
  /** Must persist before rows are returned. A failure blocks the response (spec FR-8). */
  record(apiId: string, outcome: string): Promise<void>;
  now?(): number;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function bearer(request: IncomingMessage): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(request.headers.authorization ?? "");
  return match?.[1] ?? null;
}

/** The API has no inputs, so the body is never read and cannot broaden the request. */
export function createGateway(deps: GatewayDeps): Server {
  const now = deps.now ?? Date.now;
  const windows = new Map<string, { start: number; count: number }>();

  const limited = (apiId: string): boolean => {
    const window = windows.get(apiId);
    if (!window || now() - window.start >= RATE_WINDOW_MS) {
      windows.set(apiId, { start: now(), count: 1 });
      return false;
    }
    window.count += 1;
    return window.count > RATE_LIMIT;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = new URL(request.url ?? "/", "http://gateway").pathname;
    if (request.method === "GET" && path === "/health") return send(response, 200, { status: "ok" });

    const apiId = API_PATH.exec(path)?.[1];
    if (!apiId) return send(response, 404, { error: "not_found" });
    if (request.method !== "POST") return send(response, 405, { error: "method_not_allowed" });
    const token = bearer(request);
    if (!token) return send(response, 401, { error: "unauthorized" });
    if (limited(apiId)) return send(response, 429, { error: "rate_limited" });

    const tokenHash = createHash("sha256").update(token).digest("hex");
    const result = await withDeadline("invoke", INVOKE_DEADLINE_MS, () => deps.invoke(apiId, tokenHash));

    // A wrong token on a guessed ID stays unrecorded, so callers cannot fill the audit log.
    if (result.outcome === "unauthorized") return send(response, 401, { error: "unauthorized" });
    await deps.record(apiId, result.outcome);
    if (result.outcome === "expired") return send(response, 410, { error: "expired" });
    return send(response, 200, { rows: result.rows, count: result.rows.length });
  };

  return createServer((request, response) => {
    request.resume();
    handle(request, response).catch((error) => {
      console.error("gateway error:", error instanceof Error ? error.message : error);
      if (!response.headersSent) send(response, 503, { error: "unavailable" });
    });
  });
}
