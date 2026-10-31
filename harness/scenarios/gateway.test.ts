import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway, type GatewayDeps, type InvokeResult } from "../src/gateway.js";

const API = "a".repeat(32);
const TOKEN = "t".repeat(43);
const hash = createHash("sha256").update(TOKEN).digest("hex");
let server: Server | undefined;

afterEach(() => server?.close());

async function start(deps: Partial<GatewayDeps> & { result?: InvokeResult } = {}) {
  const records: string[] = [];
  server = createGateway({
    invoke: async (_id, tokenHash) => (tokenHash === hash ? (deps.result ?? { outcome: "ok", rows: [{ id: 1 }] }) : { outcome: "unauthorized" }),
    record: async (_id, outcome) => void records.push(outcome),
    ...deps,
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const call = (path = `/apis/${API}`, init: RequestInit = { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }) =>
    fetch(`http://127.0.0.1:${port}${path}`, init);
  return { call, records };
}

describe("gateway", () => {
  it("returns rows and records the invocation first", async () => {
    const { call, records } = await start();
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rows: [{ id: 1 }], count: 1 });
    expect(records).toEqual(["ok"]);
  });

  it("rejects a missing token", async () => {
    const { call } = await start();
    expect((await call(undefined, { method: "POST" })).status).toBe(401);
  });

  it("rejects a wrong token without recording it", async () => {
    const { call, records } = await start();
    const response = await call(undefined, { method: "POST", headers: { authorization: `Bearer ${"x".repeat(43)}` } });
    expect(response.status).toBe(401);
    expect(records).toEqual([]);
  });

  it("returns 410 after expiry", async () => {
    const { call, records } = await start({ result: { outcome: "expired" } });
    expect((await call()).status).toBe(410);
    expect(records).toEqual(["expired"]);
  });

  it("never turns an actor failure into an empty result", async () => {
    const { call } = await start({
      invoke: async () => {
        throw new Error("database down");
      },
    });
    const response = await call();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("database down");
  });

  it("withholds rows when the audit write fails", async () => {
    const { call } = await start({
      record: async () => {
        throw new Error("audit down");
      },
    });
    const response = await call();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("rows");
  });

  it("ignores any request body", async () => {
    const { call } = await start();
    const response = await call(undefined, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ max_length: 100 }),
    });
    expect(await response.json()).toEqual({ rows: [{ id: 1 }], count: 1 });
  });

  it("rejects other methods and paths", async () => {
    const { call } = await start();
    expect((await call(undefined, { method: "GET" })).status).toBe(405);
    expect((await call("/apis/not-an-id")).status).toBe(404);
  });

  it("rate limits one API", async () => {
    const { call } = await start();
    const responses = await Promise.all(Array.from({ length: 31 }, () => call()));
    expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
  });
});
