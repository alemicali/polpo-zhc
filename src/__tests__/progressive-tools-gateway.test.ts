/**
 * Progressive tool discovery in Polpo's channel loop (Telegram/WhatsApp text turns): the turn
 * starts without Polpo's optional areas, tools_load declares them mid-turn, and the next turn
 * starts with them. The model is scripted; nothing reaches a provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockModel, mockTextResponse, mockToolCallResponse, mockTurnSequence } from "./helpers/mock-llm.js";

const requests: Array<{ messages: any[]; tools: any[] }> = [];
let script: ReturnType<typeof mockTurnSequence>;
const executed: string[] = [];

vi.mock("../llm/pi-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/pi-client.js")>();
  return {
    ...actual,
    resolveModel: () => mockModel(),
    streamSimpleWithAuth: async (_model: unknown, context: { messages: any[]; tools: any[] }) => {
      requests.push({ messages: [...context.messages], tools: context.tools });
      return script();
    },
  };
});
vi.mock("../llm/prompts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../llm/prompts.js")>()),
  buildChatSystemPrompt: async () => "You are Polpo.",
}));
vi.mock("../llm/orchestrator-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../llm/orchestrator-tools.js")>()),
  executeOrchestratorTool: async (name: string) => { executed.push(name); return `${name} ran`; },
}));

const { ChannelGateway } = await import("../notifications/channel-gateway.js");
const { FileSessionStore } = await import("../stores/file-session-store.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "polpo-progressive-gateway-"));
  requests.length = 0;
  executed.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function gateway() {
  const sessionStore = new FileSessionStore(dir);
  const orchestrator = {
    getStore: () => ({ getState: async () => ({ processes: [] }) }),
    getAgents: () => [],
    getConfig: () => ({ project: "test", settings: {} }),
    getMemoryStore: () => undefined,
    emit: () => {},
  } as any;
  const mapped = new Map<string, string>();
  const peerStore = {
    getPeer: () => undefined,
    upsertPeer: (input: any) => ({ id: `${input.channel}:${input.externalId}`, channel: input.channel, externalId: input.externalId }),
    isAllowed: () => true,
    getSessionId: (key: string) => mapped.get(key),
    setSessionId: (key: string, value: string) => { mapped.set(key, value); },
    resolveCanonicalId: (id: string) => id,
    updatePresence: () => {},
  } as any;
  const g = new ChannelGateway({
    orchestrator, peerStore, sessionStore,
    channelConfig: { type: "telegram", botToken: "x", chatId: "1", gateway: { enableInbound: true, dmPolicy: "open" } } as any,
  });
  return { g, sessionStore };
}

const names = (tools: Array<{ name: string }>) => tools.map((t) => t.name);
const message = (text: string) => ({ channel: "telegram", externalId: "42", chatId: "chat-42", text } as any);

describe("channel turns: progressive tools for Polpo", () => {
  it("starts without the optional areas, loads one mid-turn, and keeps it next turn", async () => {
    const { g, sessionStore } = gateway();
    script = mockTurnSequence([
      mockToolCallResponse("tools_load", { names: ["phone"] }),
      mockToolCallResponse("phone_list_calls", {}),
      mockTextResponse("No calls today."),
    ]);
    const reply = await g.handleMessage(message("any calls today?"));
    expect(reply).toBe("No calls today.");
    expect(requests).toHaveLength(3);

    const first = names(requests[0].tools);
    expect(first).toEqual(expect.arrayContaining(["get_status", "create_task", "tools_search", "tools_load"]));
    expect(first).not.toContain("phone_list_calls");
    // the top-level list does not change during the turn; the group is declared after tools_load
    expect(names(requests[1].tools)).toEqual(first);
    const declared = requests[1].messages.find((m) => m.role === "system" && m.toolsAdded);
    expect(names(declared.toolsAdded)).toEqual(expect.arrayContaining(["phone_call", "phone_list_calls"]));
    expect(executed).toEqual(["phone_list_calls"]);

    requests.length = 0;
    script = mockTurnSequence([mockTextResponse("Still none.")]);
    await g.handleMessage(message("and now?"));
    expect(names(requests[0].tools)).toContain("phone_list_calls");
    expect(names(requests[0].tools)).not.toContain("data_query");
  });
});
