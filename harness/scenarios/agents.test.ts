import { describe, expect, it } from "vitest";
import { OpenAIPlanner, OpenAIReviewer } from "../src/agents/index.js";
import { SEED_POLICY } from "../src/adapters/fake.js";
import type { Plan } from "../src/contracts/index.js";

const signal = new AbortController().signal;
const plannerInput = { requestText: "hi", exposed: [] };
const completed = (payload: unknown) =>
  new Response(
    JSON.stringify({
      status: "completed",
      output: [{ content: [{ type: "output_text", text: JSON.stringify(payload) }] }],
    }),
  );
const planner = (response: Response) =>
  new OpenAIPlanner({ apiKey: "k", model: "m", fetch: async () => response });

describe("OpenAI adapter", () => {
  it("fixes version and inputs in code", async () => {
    const plan = { resource: "products", fields: ["id"], filters: [], limit: 1, purpose: "p" };
    expect(await planner(completed({ kind: "plan", code: null, reason: "", plan })).plan(plannerInput, signal)).toEqual({
      kind: "plan",
      plan: { ...plan, version: 1, inputs: [] },
    });
  });

  it("throws on an HTTP error", async () => {
    await expect(planner(new Response("{}", { status: 500 })).plan(plannerInput, signal)).rejects.toThrow("HTTP 500");
  });

  it("throws on an incomplete response", async () => {
    const response = new Response(JSON.stringify({ status: "incomplete" }));
    await expect(planner(response).plan(plannerInput, signal)).rejects.toThrow("incomplete");
  });

  it("throws on a response with no text", async () => {
    const response = new Response(JSON.stringify({ status: "completed", output: [] }));
    await expect(planner(response).plan(plannerInput, signal)).rejects.toThrow("no text");
  });

  it("never sends private or custodial field names to the reviewer", async () => {
    let body = "";
    const reviewer = new OpenAIReviewer({
      apiKey: "k",
      model: "m",
      fetch: async (_url, init) => {
        body = String(init?.body);
        return completed({});
      },
    });
    const plan: Plan = { version: 1, resource: "products", fields: ["id"], filters: [], limit: 1, inputs: [], purpose: "p" };
    await reviewer.review({ requestText: "hi", plan, planHash: "h", policy: SEED_POLICY }, signal);
    expect(body).toContain("body_length_in");
    expect(body).not.toContain("supplier_cost");
    expect(body).not.toContain("customer_id");
  });
});
