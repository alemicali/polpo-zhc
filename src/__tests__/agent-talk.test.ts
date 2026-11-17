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
  };
  return { talk: new AgentTalk(dir, io), turns, posted, sessions, dir };
}

describe("agents talking during a chat", () => {
  it("ask: the other agent answers in its conversation with the asker, which it remembers", async () => {
    const { talk, turns, dir } = setup();
    const from = { agent: "health-coach", chain: [] };
    expect(await talk.ask(from, "Wealth-Coach", "How much for the gym?")).toBe("wealth-coach here");
    expect(turns[0]).toMatchObject({ agent: "wealth-coach", sessionId: "s1", chain: ["health-coach"] });
    expect(turns[0]!.last).toMatch(/^\[health-coach asks you.*\]\nHow much for the gym\?$/s);
    expect(JSON.parse(readFileSync(join(dir, "agent-dms.json"), "utf-8"))).toEqual({ "agent-dm:health-coach:wealth-coach": "s1" });
    await talk.ask(from, "wealth-coach", "And next month?");
    // same conversation: it sees the earlier exchange
    expect(turns[1]).toMatchObject({ sessionId: "s1" });
    // Polpo asking is another conversation
    await talk.ask({ chain: [] }, "wealth-coach", "Status?");
    expect(turns[2]).toMatchObject({ sessionId: "s2", chain: ["polpo"] });
  });

  it("no loops, at most three hops, no talking to yourself, known agents only", async () => {
    const { talk } = setup();
    await expect(talk.ask({ agent: "wealth-coach", chain: ["health-coach"] }, "health-coach", "?")).rejects.toThrow(/already in this exchange \(health-coach → wealth-coach\)/);
    await expect(talk.ask({ agent: "ops", chain: ["polpo", "health-coach", "wealth-coach"] }, "researcher", "?")).rejects.toThrow(/Too many agents in a row/);
    await expect(talk.ask({ agent: "ops", chain: [] }, "ops", "?")).rejects.toThrow(/yourself/);
    await expect(talk.ask({ agent: "ops", chain: [] }, "nobody", "?")).rejects.toThrow(/No agent "nobody"/);
    expect(await talk.ask({ agent: "researcher", chain: ["polpo", "health-coach"] }, "ops", "?")).toBe("ops here");
  });

  it("send: the handoff runs in the background, then the reply wakes the sender where it wrote from", async () => {
    const { talk, turns, posted } = setup((agent, last) => (agent === "researcher" ? "Found 3 gyms" : last.startsWith("[researcher replied") ? "Ada, here are 3 gyms near you" : "ok"));
    const origin = { channel: "health-bot", chatId: "42" };
    expect(await talk.send({ agent: "health-coach", chain: [], sessionId: "chat-ada", origin }, "researcher", "Find gyms near Ada")).toEqual({ to: "researcher" });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(turns.map((t) => [t.agent, t.sessionId])).toEqual([["researcher", "s1"], ["health-coach", "chat-ada"]]);
    expect(turns[1]!.last).toBe("[researcher replied to what you handed them]\nFound 3 gyms");
    expect(posted[0]).toEqual(["42", "Ada, here are 3 gyms near you", "health-coach"]);
  });

  it("the tools answer in words, errors included", async () => {
    const { talk } = setup();
    expect(await execAskAgent({ agent: "wealth-coach", question: "x" }, talk, { agent: "health-coach", chain: [] })).toBe("wealth-coach answered:\nwealth-coach here");
    expect(await execAskAgent({ agent: "health-coach", question: "x" }, talk, { agent: "health-coach", chain: [] })).toMatch(/^Error: You cannot write to yourself/);
    expect(await execAskAgent({ agent: "", question: "x" }, talk, { chain: [] })).toMatch(/required/);
    expect(await execMessageAgent({ agent: "researcher", message: "go" }, talk, { agent: "ops", chain: [] })).toMatch(/^Handed to researcher/);
    expect(await execMessageAgent({ agent: "researcher", message: "go" }, undefined, { chain: [] })).toMatch(/cannot be reached/);
  });
});
