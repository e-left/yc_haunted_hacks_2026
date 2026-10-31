import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { AgentRelay } from "@agent-relay/sdk";
import type { RelayAgentClient } from "@agent-relay/sdk";
import type { Reply } from "../contracts/index.js";
import type { RelayMessage, RelayPort } from "../ports/index.js";

const INBOX_POLL_MS = 5_000;
const INBOX_PAGE = 20;

export interface RelayEvent {
  message: {
    messageId: string;
    text?: string;
    from?: { name?: string };
    threadId?: string;
  };
}

/** Pure, so routing rules can be tested without a network. */
export function toRelayMessage(event: RelayEvent, selfName: string): RelayMessage | null {
  const { messageId, text, from, threadId } = event.message;
  if (!from?.name || from.name === selfName || !text?.trim()) return null;
  return { eventId: messageId, from: from.name, text, ...(threadId ? { threadId } : {}) };
}

function summary(reply: Reply): string {
  if (reply.kind === "api") {
    return `Temporary API ready. Expires ${reply.expiresAt}. Fields: ${reply.contract.fields.join(", ")}.`;
  }
  return `${reply.kind === "refused" ? "Refused" : "Error"} (${reply.code}): ${reply.message}`;
}

/** Relay drops metadata on DMs, so the machine-readable reply travels in the text. */
export function formatReply(reply: Reply): string {
  return `${summary(reply)}\n\n\`\`\`json\n${JSON.stringify(reply, null, 2)}\n\`\`\``;
}

export function parseReply(text: string): Reply | null {
  const match = /\`\`\`json\n([\s\S]*)\n\`\`\`/.exec(text);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]) as Reply;
  } catch {
    return null;
  }
}

export class AgentRelayAdapter implements RelayPort {
  private constructor(
    private readonly relay: AgentRelay,
    private readonly agent: RelayAgentClient,
    private readonly name: string,
  ) {}

  /** Registration is create-only, so the issued token is kept and reused on restart. */
  static async connect(workspaceKey: string, name: string, tokenPath: string): Promise<AgentRelayAdapter> {
    const relay = new AgentRelay({ workspaceKey });
    if (existsSync(tokenPath)) {
      const agent = await relay.workspace.reconnect({ apiToken: readFileSync(tokenPath, "utf8").trim() });
      return new AgentRelayAdapter(relay, agent, name);
    }
    const agent = await relay.workspace.register({ name, type: "agent" });
    const token = agent.token;
    if (!token) throw new Error("Relay registration returned no token");
    writeFileSync(tokenPath, token, { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    return new AgentRelayAdapter(relay, agent, name);
  }

  /**
   * Requests arrive as direct messages to the merchant agent. The live event is fast but was
   * seen to miss a DM, so the durable inbox is polled as a backstop. Both paths share one
   * dedupe, and the store's unique event ID still protects against a restart.
   */
  listen(onMessage: (message: RelayMessage) => void, onError: (error: unknown) => void): () => void {
    this.relay.onError(onError);
    const seen = new Set<string>();
    const accept = (event: RelayEvent): void => {
      const message = toRelayMessage(event, this.name);
      if (!message || seen.has(message.eventId)) return;
      seen.add(message.eventId);
      onMessage(message);
    };
    const poll = async (): Promise<void> => {
      const { items } = await this.agent.inbox.list({ limit: INBOX_PAGE });
      for (const item of items) {
        if (item.state === "read" || item.state === "failed") continue;
        accept({ message: item.message as RelayEvent["message"] });
        await this.agent.inbox.ack({ inboxItemId: item.id, state: "read" });
      }
    };
    const stopEvents = this.relay.addListener("dm.received", (event) => accept(event as RelayEvent));
    const timer = setInterval(() => void poll().catch(onError), INBOX_POLL_MS);
    return () => {
      clearInterval(timer);
      stopEvents();
    };
  }

  async reply(message: RelayMessage, reply: Reply): Promise<void> {
    await this.agent.sendMessage({
      to: `@${message.from}`,
      text: formatReply(reply),
      // Per kind: an error sent after a failed delivery must not be dropped as a duplicate.
      idempotencyKey: `reply-${message.eventId}-${reply.kind}`,
    });
  }
}
