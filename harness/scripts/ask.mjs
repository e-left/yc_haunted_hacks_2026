// A customer agent: DMs a question to the merchant over Agent Relay and prints the reply.
// Usage: npm run ask -- "Which in-stock shirts have a body length under 30 inches?"
import { randomBytes } from "node:crypto";
import { AgentRelay } from "@agent-relay/sdk";

process.loadEnvFile(".env");
const question = process.argv[2];
if (!question) throw new Error('usage: npm run ask -- "<question>"');

const relay = new AgentRelay({ workspaceKey: process.env.RELAY_WORKSPACE_KEY });
const customer = await relay.workspace.register({ name: `customer-${randomBytes(3).toString("hex")}`, type: "agent" });
const merchant = process.env.RELAY_AGENT_NAME || "merchant";
// The live event can miss a DM, so the durable inbox is polled alongside it.
const pending = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("no reply within 120s")), 120_000);
  const done = (message) => {
    clearTimeout(timer);
    clearInterval(poll);
    resolve(message);
  };
  relay.addListener("dm.received", ({ message }) => {
    if (message.from?.name === merchant) done(message);
  });
  const poll = setInterval(async () => {
    const { items } = await customer.inbox.list({ limit: 5 }).catch(() => ({ items: [] }));
    const item = items.find((entry) => entry.message.from?.name === merchant);
    if (item) done(item.message);
  }, 4_000);
});
await new Promise((resolve) => setTimeout(resolve, 1_500)); // Let the event stream attach.
await customer.sendMessage({ to: `@${merchant}`, text: question });
const message = await pending;
// Hide the token by default so demo screens and logs stay clean. Agents read the real value.
const block = /```json\n([\s\S]*)\n```/.exec(message.text);
if (!block) throw new Error("reply had no structured block; refusing to print it");
const reply = JSON.parse(block[1]);
const token = reply.token;
if (reply.token) reply.token = "[hidden]";
console.log(JSON.stringify(reply, null, 2));

// The second half of the flow: call the temporary API with the token from the reply.
if (reply.kind === "api") {
  const response = await fetch(reply.url, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  const body = await response.json();
  console.log(`\nPOST ${reply.url} -> ${response.status}`);
  console.log(JSON.stringify({ count: body.count, sample: body.rows?.slice(0, 3), error: body.error }, null, 2));
}
process.exit(0);
