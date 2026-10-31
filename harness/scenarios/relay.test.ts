import { describe, expect, it } from "vitest";
import { formatReply, isOverloaded, parseReply, toRelayMessage, withRelayRetry } from "../src/adapters/relay.js";

const event = (from: string | undefined, text: string) => ({
  message: { messageId: "m1", text, ...(from ? { from: { name: from } } : {}) },
});

describe("Relay adapter", () => {
  it("maps a DM to a harness message", () => {
    expect(toRelayMessage(event("customer", "hello"), "merchant")).toEqual({ eventId: "m1", from: "customer", text: "hello" });
  });

  it("ignores its own messages, so replies cannot loop", () => {
    expect(toRelayMessage(event("merchant", "hello"), "merchant")).toBeNull();
  });

  it("ignores messages with no sender or text", () => {
    expect(toRelayMessage(event(undefined, "hello"), "merchant")).toBeNull();
    expect(toRelayMessage(event("customer", "   "), "merchant")).toBeNull();
  });

  it("retries an overloaded send until it works", async () => {
    let calls = 0;
    const result = await withRelayRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error("The database is temporarily overloaded.");
      return "sent";
    }, 1);
    expect(result).toBe("sent");
    expect(calls).toBe(3);
  });

  it("gives up after a bounded number of attempts", async () => {
    let calls = 0;
    const send = async () => {
      calls += 1;
      throw Object.assign(new Error("busy"), { status: 503 });
    };
    await expect(withRelayRetry(send, 1)).rejects.toThrow("busy");
    expect(calls).toBe(4);
  });

  it("does not retry a real failure", async () => {
    let calls = 0;
    const send = async () => {
      calls += 1;
      throw Object.assign(new Error("forbidden"), { status: 403 });
    };
    await expect(withRelayRetry(send, 1)).rejects.toThrow("forbidden");
    expect(calls).toBe(1);
    expect(isOverloaded(new Error("forbidden"))).toBe(false);
  });

  it("round-trips a structured reply through the message text", () => {
    const reply = { kind: "refused", requestId: "r", code: "data_unavailable", message: "This data is not available." } as const;
    const text = formatReply(reply);
    expect(text.startsWith("Refused (data_unavailable): This data is not available.")).toBe(true);
    expect(parseReply(text)).toEqual(reply);
  });

  it("returns null for text with no reply block", () => {
    expect(parseReply("hello")).toBeNull();
    expect(parseReply("```json\nnot json\n```")).toBeNull();
  });

  it("keeps the token out of the summary line", () => {
    const text = formatReply({
      kind: "api",
      requestId: "r",
      apiId: "a",
      url: "u",
      contract: { method: "POST", fields: ["id"], filters: [], limit: 1, inputs: [] },
      expiresAt: "e",
      token: "secret",
    });
    expect(text.split("\n")[0]).not.toContain("secret");
  });
});
