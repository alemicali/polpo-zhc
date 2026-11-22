import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentTalk, type AgentTalkRequest } from "../server/agent-talk.js";
import { execAskAgent, execMessageAgent } from "../tools/agent-talk-tools.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup(answer: (agent: string | undefined, last: string) => string = (a) => `${a} here`) {
  const dir = mkdtempSync(join(tmpdir(), "polpo-agent-talk-"));
  dirs.push(dir);
  const sessions = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>();
  let next = 0;
  const turns: Array<{ agent?: string; sessionId: string; chain: string[]; last: string }> = [];
  const posted: Array<[string, string, string | undefined]> = [];
  const delivered: Array<[string, string]> = [];
  const events: Array<Record<string, unknown>> = [];
  const io: AgentTalkRequest = {
    turn: vi.fn(async ({ agent, sessionId, messages, chain }) => {
      const id = sessionId === "new" ? `s${++next}` : sessionId;
      const last = messages.at(-1)!.content;
      turns.push({ agent, sessionId: id, chain, last });
      const text = answer(agent, last);
      sessions.set(id, [...(sessions.get(id) ?? []), { role: "user", content: last }, { role: "assistant", content: text }]);
      return { text, sessionId: id };
    }),
    history: async (id) => sessions.get(id) ?? [],
    agents: async () => [{ name: "health-coach" }, { name: "wealth-coach" }, { name: "researcher" }, { name: "ops" }],
    post: vi.fn(async (origin, text, agent) => { posted.push([origin.chatId, text, agent]); }),
    deliver: async (sessionId, content) => { delivered.push([sessionId, content]); },
    emit: (_event, data) => events.push({ ...data }),
  };
  return { talk: new AgentTalk(dir, io), turns, posted, delivered, events, sessions, dir };
}

describe("agents talking during a chat", () => {
  it("ask returns at once; the answer arrives in the asker's web chat live", async () => {
    const { talk, turns, dir, delivered, events } = setup();
    const from = { agent: "health-coach", chain: [], sessionId: "chat-1" };
    expect(await talk.ask(from, "Wealth-Coach", "How much for the gym?")).toMatchObject({ to: "wealth-coach" });
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(turns[0]).toMatchObject({ agent: "wealth-coach", sessionId: "s1", chain: ["health-coach"] });
    expect(turns[0]!.last).toMatch(/^\[health-coach asks you.*\]\nHow much for the gym\?$/s);
    // no extra turn for the asker: the chat takes the answer itself
    expect(turns).toHaveLength(1);
    expect(delivered[0]).toEqual(["chat-1", "[wealth-coach answered your question]\nwealth-coach here"]);
    expect(events.map((e) => e.status)).toEqual(["working", "answered"]);
    expect(events[1]).toMatchObject({ from: "health-coach", to: "wealth-coach", kind: "question", dmSessionId: "s1", fromSessionId: "chat-1", answer: "wealth-coach here" });
    expect(JSON.parse(readFileSync(join(dir, "agent-dms.json"), "utf-8"))).toEqual({ "agent-dm:health-coach:wealth-coach": "s1" });
    await talk.ask(from, "wealth-coach", "And next month?");
    await vi.waitFor(() => expect(delivered).toHaveLength(2));
    // same conversation: it sees the earlier exchange
    expect(turns[1]).toMatchObject({ sessionId: "s1" });
    // Polpo asking is another conversation
    await talk.ask({ chain: [], sessionId: "polpo-chat" }, "wealth-coach", "Status?");
    await vi.waitFor(() => expect(delivered).toHaveLength(3));
    expect(turns[2]).toMatchObject({ sessionId: "s2", chain: ["polpo"] });
    const overview = talk.overview();
    expect(overview.conversations).toEqual([
      { from: "health-coach", to: "wealth-coach", sessionId: "s1" },
      { from: "Polpo", to: "wealth-coach", sessionId: "s2" },
    ]);
    expect(overview.recent.map((e) => e.message)).toEqual(["Status?", "And next month?", "How much for the gym?"]);
  });

  it("a failed answer still reaches the asker, saying so", async () => {
    const { talk, delivered, events } = setup((agent) => { if (agent === "ops") throw new Error("model down"); return "ok"; });
    await talk.ask({ agent: "researcher", chain: [], sessionId: "c" }, "ops", "?");
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(delivered[0]![1]).toBe("[ops answered your question]\n(no answer: model down)");
    expect(events.at(-1)).toMatchObject({ status: "failed", error: "model down" });
  });

  it("no loops, at most three hops, no talking to yourself, known agents only", async () => {
    const { talk } = setup();
    await expect(talk.ask({ agent: "wealth-coach", chain: ["health-coach"] }, "health-coach", "?")).rejects.toThrow(/already in this exchange \(health-coach → wealth-coach\)/);
    await expect(talk.ask({ agent: "ops", chain: ["polpo", "health-coach", "wealth-coach"] }, "researcher", "?")).rejects.toThrow(/Too many agents in a row/);
    await expect(talk.ask({ agent: "ops", chain: [] }, "ops", "?")).rejects.toThrow(/yourself/);
    await expect(talk.ask({ agent: "ops", chain: [] }, "nobody", "?")).rejects.toThrow(/No agent "nobody"/);
    expect(await talk.ask({ agent: "researcher", chain: ["polpo", "health-coach"] }, "ops", "?")).toMatchObject({ to: "ops" });
  });

  it("from Telegram: the reply wakes the sender there and its answer is posted", async () => {
    const { talk, turns, posted, delivered } = setup((agent, last) => (agent === "researcher" ? "Found 3 gyms" : last.startsWith("[researcher replied") ? "Ada, here are 3 gyms near you" : "ok"));
    const origin = { channel: "health-bot", chatId: "42" };
    expect(await talk.send({ agent: "health-coach", chain: [], sessionId: "chat-ada", origin }, "researcher", "Find gyms near Ada")).toMatchObject({ to: "researcher" });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(turns.map((t) => [t.agent, t.sessionId])).toEqual([["researcher", "s1"], ["health-coach", "chat-ada"]]);
    expect(turns[1]!.last).toBe("[researcher replied to what you handed them]\nFound 3 gyms");
    expect(posted[0]).toEqual(["42", "Ada, here are 3 gyms near you", "health-coach"]);
    expect(delivered).toHaveLength(0);
  });

  it("the tools answer in words at once, errors included", async () => {
    const { talk } = setup();
    expect(await execAskAgent({ agent: "wealth-coach", question: "x" }, talk, { agent: "health-coach", chain: [] })).toMatch(/^Asked wealth-coach\. Their answer will arrive/);
    expect(await execAskAgent({ agent: "health-coach", question: "x" }, talk, { agent: "health-coach", chain: [] })).toMatch(/^Error: You cannot write to yourself/);
    expect(await execAskAgent({ agent: "", question: "x" }, talk, { chain: [] })).toMatch(/required/);
    expect(await execMessageAgent({ agent: "researcher", message: "go" }, talk, { agent: "ops", chain: [] })).toMatch(/^Handed to researcher/);
    expect(await execMessageAgent({ agent: "researcher", message: "go" }, undefined, { chain: [] })).toMatch(/cannot be reached/);
  });
});
