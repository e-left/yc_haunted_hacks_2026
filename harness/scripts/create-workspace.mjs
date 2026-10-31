// Creates a new Agent Relay workspace and stores its key in .env. The key is never printed.
// Run it once: npm run relay:workspace
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { AgentRelay } from "@agent-relay/sdk";

const name = `lild-demo-${randomBytes(3).toString("hex")}`;
const relay = await AgentRelay.createWorkspace({ name });
if (!relay.workspaceKey) throw new Error("Relay returned no workspace key");

const env = readFileSync(".env", "utf8");
if (!/^RELAY_WORKSPACE_KEY=/m.test(env)) throw new Error(".env has no RELAY_WORKSPACE_KEY line");
writeFileSync(".env", env.replace(/^RELAY_WORKSPACE_KEY=.*$/m, () => `RELAY_WORKSPACE_KEY=${relay.workspaceKey}`));
console.log(`Created workspace ${name}. Key stored in harness/.env.`);
process.exit(0);
