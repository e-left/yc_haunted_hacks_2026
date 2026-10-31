import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TerseActors, type TemporaryApiClient } from "../src/adapters/terse.js";
import type { ActorConfig } from "../src/ports/index.js";

const config = (expiresAt: string, planHash = "hash-a"): ActorConfig => ({
  plan: { version: 1, resource: "products", fields: ["id"], filters: [], limit: 1, inputs: [], purpose: "p" },
  planHash,
  tokenHash: "secret-token-hash",
  credential: { role: "r", view: "v" },
  expiresAt,
});
const live = () => new AbortController().signal;

describe("Terse adapter", () => {
  it("passes actor failures to the pipeline", async () => {
    const client: TemporaryApiClient = {
      get: () => ({
        configure: async () => {
          throw new Error("terse down");
        },
      }),
    };
    await expect(new TerseActors(client).configure("a", config("2026-01-01T00:00:00Z"), live())).rejects.toThrow("terse down");
  });

  it("does not call an actor after the deadline", async () => {
    let called = false;
    const client: TemporaryApiClient = {
      get: () => ({
        configure: async () => {
          called = true;
          return { configured: true };
        },
      }),
    };
    const controller = new AbortController();
    controller.abort();
    await expect(new TerseActors(client).configure("a", config("2026-01-01T00:00:00Z"), controller.signal)).rejects.toThrow();
    expect(called).toBe(false);
  });
});

describe.runIf(process.env.LIVE_TERSE)("live TemporaryApi actor", { timeout: 20_000 }, () => {
  const load = async () => {
    const path = "../generated/index.js";
    return (await import(/* @vite-ignore */ path)).actors;
  };
  const future = () => new Date(Date.now() + 60_000).toISOString();

  it("is active after configure and never returns secrets", async () => {
    const actors = await load();
    const id = randomUUID();
    const expiresAt = future();
    await new TerseActors(actors.TemporaryApi).configure(id, config(expiresAt), live());
    const status = await actors.TemporaryApi.get(id).getStatus();
    expect(status).toEqual({ state: "active", expiresAt });
    expect(JSON.stringify(status)).not.toContain("secret");
  });

  it("is idempotent for the same plan and refuses a different one", async () => {
    const actors = await load();
    const id = randomUUID();
    const expiresAt = future();
    const adapter = new TerseActors(actors.TemporaryApi);
    await adapter.configure(id, config(expiresAt), live());
    await expect(adapter.configure(id, config(expiresAt), live())).resolves.toBeUndefined();
    await expect(adapter.configure(id, config(expiresAt, "hash-b"), live())).rejects.toThrow();
  });

  it("drops its credential at expiry", async () => {
    const actors = await load();
    const id = randomUUID();
    await new TerseActors(actors.TemporaryApi).configure(id, config(new Date(Date.now() + 1_000).toISOString()), live());
    await expect.poll(() => actors.TemporaryApi.get(id).getStatus(), { timeout: 8_000, interval: 250 }).toEqual({
      state: "expired",
      expiresAt: null,
    });
  });
});
