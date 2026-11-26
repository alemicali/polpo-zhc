/**
 * Communication lines in agent talk, and agents working a task talking to other agents (every
 * engine): refusals, tool descriptions naming only the reachable agents, escalate, ask-and-wait in
 * task runs, handoffs reaching the task, the runner ↔ orchestrator socket, rooms. Mocks only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig, RoomSettings, Task, TaskOutcome } from "@polpo-ai/core";
import { AgentTalk, type AgentTalkRequest } from "../server/agent-talk.js";
import { createAgentTalkTools, execAskAgent, execEscalate, execMessageAgent, type AgentTalkAccess } from "../tools/agent-talk-tools.js";
import { handleAgentTalkWire, socketAgentTalk } from "../core/agent-talk-bridge.js";
import { startNotificationServer } from "../core/notification.js";
import { deliverAgentReplyToTask } from "../server/agent-talk-task.js";
import { buildAgentToolset } from "../adapters/engine.js";
import { toHarnessHostTools } from "../harness/host-tools.js";
import { openCliToolServer } from "../cli-engine/tool-server.js";
import { RoomEngine, type AgentProfile } from "../rooms/room-engine.js";
import { FileRoomStore } from "../stores/file-room-store.js";
import type { SessionStore } from "../core/session-store.js";
import type { ChannelChatRunner } from "../notifications/channel-gateway.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/** cto manages dev and qa; writer is elsewhere; legacy has no lines. */
const TEAM: Array<Pick<AgentConfig, "name" | "reportsTo" | "talksTo">> = [
  { name: "cto", talksTo: { mode: "org" } },
  { name: "dev", reportsTo: "cto", talksTo: { mode: "org", agents: ["qa"] } },
  { name: "qa", reportsTo: "cto", talksTo: { mode: "none" } },
  { name: "writer", talksTo: { mode: "list", agents: ["dev"] } },
  { name: "legacy" },
];

function setup(opts: { team?: typeof TEAM; answer?: (agent: string | undefined, last: string) => Promise<string> | string } = {}) {
  const dir = tmp("polpo-talk-lines-");
  let next = 0;
  const turns: Array<{ agent?: string; last: string }> = [];
  const toTask: Array<{ task: { id: string; runId?: string }; reply: { from: string; kind: string; content: string } }> = [];
  const io: AgentTalkRequest = {
    turn: vi.fn(async ({ agent, sessionId, messages }) => {
      const last = messages.at(-1)!.content;
      turns.push({ agent, last });
      const text = await (opts.answer ?? ((a) => `${a} here`))(agent, last);
      return { text, sessionId: sessionId === "new" ? `s${++next}` : sessionId };
    }),
    history: async () => [],
    agents: async () => (opts.team ?? TEAM).map((a) => ({ ...a })),
    deliver: async () => {},
    toTask: async (task, reply) => { toTask.push({ task, reply }); },
  };
  return { talk: new AgentTalk(dir, io), turns, toTask, dir };
}

describe("agent talk: communication lines", () => {
  it("refuses a target outside the sender's lines, naming who it can talk to", async () => {
    const { talk } = setup();
    await expect(talk.ask({ agent: "dev", chain: [] }, "writer", "hi")).rejects.toThrow("writer is outside your communication lines (org). You can talk to: cto, qa.");
    expect(await execMessageAgent({ agent: "writer", message: "go" }, talk, { agent: "dev", chain: [] }))
      .toBe("Error: writer is outside your communication lines (org). You can talk to: cto, qa.");
    // an unknown name lists only the reachable agents, not the whole team
    expect(await execAskAgent({ agent: "ghost", question: "x" }, talk, { agent: "dev", chain: [] })).toBe('Error: No agent "ghost" you can talk to. You can talk to: cto, qa');
    // within the lines it goes
    expect(await talk.ask({ agent: "dev", chain: [] }, "qa", "hi")).toMatchObject({ to: "qa" });
  });

  it("Polpo talks to everyone; agents without lines talk to anyone", async () => {
    const { talk } = setup();
    expect(await talk.ask({ chain: [] }, "qa", "status?")).toMatchObject({ to: "qa" });
    expect(await talk.send({ agent: "legacy", chain: [] }, "writer", "x")).toMatchObject({ to: "writer" });
  });

  it("escalate reaches the manager whatever the lines; without a manager it says so", async () => {
    const { talk, turns } = setup();
    await expect(talk.ask({ agent: "qa", chain: [] }, "cto", "x")).rejects.toThrow(/outside your communication lines \(none\)\. You cannot talk to other agents\. To escalate to your manager \(cto\), use escalate\./);
    expect(await talk.escalate({ agent: "qa", chain: [] }, "the build is red and I may not fix CI")).toMatchObject({ to: "cto" });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0]!.last).toMatch(/^\[qa, who reports to you, escalates this to you/);
    expect(await execEscalate({ reason: "help" }, talk, { agent: "writer", chain: [] })).toMatch(/^Error: You have no manager \(reportsTo\) to escalate to/);
  });

  it("the tools name only the agents its lines reach; no ask/message without any, escalate only with a manager", async () => {
    const { talk } = setup();
    const tools = async (agent: string) => createAgentTalkTools(talk, () => ({ agent, chain: [] }), { reach: await talk.lines(agent) });
    const dev = await tools("dev");
    expect(dev.map((t) => t.name)).toEqual(["ask_agent", "message_agent", "escalate"]);
    expect(dev[0]!.description).toMatch(/Your communication lines: you can talk only to cto, qa\.$/);
    expect(dev[0]!.description).not.toMatch(/writer|legacy/);
    expect(dev[2]!.description).toMatch(/Your manager: cto\.$/);
    const qa = await tools("qa");
    expect(qa.map((t) => t.name)).toEqual(["escalate"]);
    const writer = await tools("writer");
    expect(writer.map((t) => t.name)).toEqual(["ask_agent", "message_agent"]);
    expect(writer[0]!.description).toMatch(/you can talk only to dev\./);
    expect((await tools("legacy"))[0]!.description).toMatch(/Agents you can talk to: cto, dev, qa, writer\./);
  });

  it("the receiver's acceptFrom: lines refuses senders outside its lines", async () => {
    const team = TEAM.map((a) => a.name === "qa" ? { ...a, talksTo: { mode: "org" as const, acceptFrom: "lines" as const } } : a);
    const { talk } = setup({ team });
    // dev lists qa as an extra; qa's own lines (org) include dev? no: dev is not its manager nor its report
    await expect(talk.ask({ agent: "dev", chain: [] }, "qa", "x")).rejects.toThrow(/qa only accepts messages from its own communication lines/);
    expect(await talk.ask({ agent: "cto", chain: [] }, "qa", "x")).toMatchObject({ to: "qa" });
  });
});

describe("agent talk from a task run", () => {
  const task = { id: "task-1", runId: "run-1" };

  it("ask_agent waits for the answer and returns it as the tool result", async () => {
    const { talk, toTask } = setup({ answer: (a) => `${a}: use the staging DB` });
    const out = await execAskAgent({ agent: "cto", question: "which DB?" }, talk, { agent: "dev", chain: [], task });
    expect(out).toBe("cto answered:\ncto: use the staging DB");
    expect(toTask).toEqual([]);
    expect(talk.overview().recent[0]).toMatchObject({ from: "dev", to: "cto", kind: "question", status: "answered", fromTaskId: "task-1" });
  });

  it("an answer slower than the wait: the run goes on, and the answer reaches the task later", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { talk, toTask } = setup({ answer: async (a) => { await gate; return `${a} late`; } });
    const r = await talk.askAndWait({ agent: "dev", chain: [], task }, "cto", "which DB?", { waitMs: 20 });
    expect(r).toEqual({ to: "cto", id: expect.any(String) });
    expect(toTask).toEqual([]);
    release();
    await vi.waitFor(() => expect(toTask).toHaveLength(1));
    expect(toTask[0]).toEqual({ task, reply: { from: "cto", kind: "question", content: "[cto answered your question]\ncto late" } });
  });

  it("message_agent hands off and goes on; the reply reaches the task", async () => {
    const { talk, toTask } = setup();
    expect(await execMessageAgent({ agent: "qa", message: "test the login" }, talk, { agent: "dev", chain: [], task }))
      .toBe("Handed to qa: they are working on it. Go on with this task; their reply will reach it.");
    await vi.waitFor(() => expect(toTask).toHaveLength(1));
    expect(toTask[0]!.reply).toEqual({ from: "qa", kind: "handoff", content: "[qa replied to what you handed them]\nqa here" });
  });

  it("escalate from a task waits for the manager's answer", async () => {
    const { talk } = setup({ answer: () => "go ahead" });
    expect(await execEscalate({ reason: "need a decision" }, talk, { agent: "qa", chain: [], task })).toBe("cto (your manager) answered:\ngo ahead");
  });
});

describe("the runner ↔ orchestrator socket", () => {
  it("a task run's tools go through the notification socket, as the run's agent (never the request's)", async () => {
    const dir = tmp("polpo-talk-sock-");
    const { talk, toTask } = setup({ answer: (a, last) => `${a} read: ${last.split("\n")[1]}` });
    const runs: Record<string, { agentName: string; taskId: string; status: string }> = {
      "run-1": { agentName: "dev", taskId: "task-1", status: "running" },
      "run-old": { agentName: "dev", taskId: "task-1", status: "completed" },
    };
    const socket = join(dir, "orchestrator.sock");
    const server = startNotificationServer(dir, () => {}, undefined, undefined,
      (msg) => handleAgentTalkWire(msg, { talk, run: async (id) => runs[id] }));
    await new Promise((r) => server.once("listening", r));
    try {
      const client = socketAgentTalk(socket, "run-1");
      const caller = { agent: "someone-else", chain: [] };
      // ask: waits and returns the answer
      expect(await client.askAndWait!(caller, "cto", "which DB?")).toMatchObject({ ok: true, to: "cto", answer: "cto read: which DB?" });
      expect(talk.overview().recent[0]).toMatchObject({ from: "dev", fromTaskId: "task-1" });
      // the lines are the run's agent's
      await expect(client.ask(caller, "writer", "x")).rejects.toThrow(/writer is outside your communication lines/);
      // send: hands off; the reply reaches the task
      expect(await client.send(caller, "qa", "check it")).toMatchObject({ ok: true, to: "qa" });
      await vi.waitFor(() => expect(toTask).toHaveLength(1));
      expect(toTask[0]!.task).toEqual({ id: "task-1", runId: "run-1" });
      // escalate
      expect(await client.escalate!(caller, "blocked")).toMatchObject({ to: "cto" });
      // a run that is not running is refused
      await expect(socketAgentTalk(socket, "run-old").ask(caller, "cto", "x")).rejects.toThrow("this run is not running");
      // the fire-and-forget messages still work
      const done = vi.fn();
      const server2 = startNotificationServer(tmp("polpo-talk-sock2-"), done);
      server2.close();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("no orchestrator listening: the tool says the agents cannot be reached", async () => {
    const client = socketAgentTalk(join(tmp("polpo-talk-nosock-"), "none.sock"), "run-1");
    expect(await execAskAgent({ agent: "cto", question: "x" }, client, { agent: "dev", chain: [], task: { id: "t" } })).toMatch(/^Error: Polpo cannot be reached from this run/);
  });
});

describe("task runs get the talk tools on every engine", () => {
  const task = { id: "t1", title: "T", description: "d", assignTo: "dev", dependsOn: [], status: "in_progress", expectations: [], metrics: [], retries: 0, maxRetries: 1, createdAt: "", updatedAt: "" } as unknown as Task;

  async function toolset(withTalk: boolean) {
    const polpoDir = tmp("polpo-talk-toolset-");
    writeFileSync(join(polpoDir, "polpo.json"), JSON.stringify({ project: "t", team: { name: "t", agents: [{ name: "dev" }] }, settings: {} }));
    const calls: string[] = [];
    const talk: AgentTalkAccess = {
      ask: async () => ({ to: "x" }),
      send: async (_f, to) => { calls.push(`send ${to}`); return { to }; },
      escalate: async () => ({ to: "cto" }),
      askAndWait: async (from, to, q, o) => { calls.push(`${o?.escalation ? "escalate" : "ask"} ${to ?? ""} ${from.agent} ${from.task?.id}`); return { to: to ?? "cto", answer: "42" }; },
    };
    const ts = await buildAgentToolset({
      agentConfig: { name: "dev" } as AgentConfig, cwd: polpoDir, sandboxProvider: "local", browserProfileDir: join(polpoDir, "bp"), hasExtendedTools: false, task,
      ctx: { polpoDir, ...(withTalk ? { agentTalk: { talk, reach: { reachable: ["cto", "qa"], manager: "cto", mode: "org" }, task: { id: "t1", runId: "r1" } } } : {}) },
    });
    await ts.connectorManager?.closeAll();
    return { tools: ts.tools, calls };
  }

  it("Polpo's engine: ask_agent, message_agent and escalate, naming the reachable agents", async () => {
    const { tools, calls } = await toolset(true);
    const ask = tools.find((t) => t.name === "ask_agent")!;
    expect(ask.description).toMatch(/^Ask another agent a quick question while you work this task/);
    expect(ask.description).toMatch(/you can talk only to cto, qa\.$/);
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["ask_agent", "message_agent", "escalate"]));
    const r = await ask.execute("c1", { agent: "cto", question: "which DB?" });
    expect(r.content[0]).toMatchObject({ text: "cto answered:\n42" });
    await tools.find((t) => t.name === "escalate")!.execute("c2", { reason: "blocked" });
    expect(calls).toEqual(["ask cto dev t1", "escalate  dev t1"]);
    // without the bridge (an old runner, the cloud): no talk tools
    expect((await toolset(false)).tools.map((t) => t.name)).not.toContain("ask_agent");
  });

  it("a harness and a CLI get them as host tools, never gated (a task cannot ask a person)", async () => {
    const { tools, calls } = await toolset(true);
    const host = toHarnessHostTools(tools, { interactive: true });
    const talkTools = host.filter((t) => ["ask_agent", "message_agent", "escalate"].includes(t.name));
    expect(talkTools.map((t) => t.name).sort()).toEqual(["ask_agent", "escalate", "message_agent"]);
    expect(talkTools.every((t) => !t.approval)).toBe(true);
    expect(await talkTools.find((t) => t.name === "message_agent")!.execute({ agent: "qa", message: "go" }, { toolCallId: "x" } as never))
      .toBe("Handed to qa: they are working on it. Go on with this task; their reply will reach it.");
    expect(calls).toContain("send qa");
    const cli = await openCliToolServer({ tools: toHarnessHostTools(tools), loopback: true });
    try {
      expect(cli.toolNames).toEqual(expect.arrayContaining(["ask_agent", "message_agent", "escalate"]));
    } finally {
      await cli.close();
    }
  });
});

describe("a reply reaching a task", () => {
  function host(runStatus: string | undefined, opts: { directionFails?: boolean } = {}) {
    const polpoDir = tmp("polpo-talk-task-");
    mkdirSync(join(polpoDir, "logs"));
    writeFileSync(join(polpoDir, "logs", "run-r1.jsonl"), "");
    const task: { outcomes?: TaskOutcome[] } = {};
    const directions: string[] = [];
    return {
      polpoDir, task, directions,
      host: {
        getPolpoDir: () => polpoDir,
        getRunStore: () => ({
          getRun: async () => (runStatus ? { status: runStatus } : undefined),
          getRunByTaskId: async () => (runStatus ? { id: "r1", status: runStatus } : undefined),
        }),
        getStore: () => ({ getTask: async () => task, updateTask: async (_id: string, u: { outcomes: TaskOutcome[] }) => { task.outcomes = u.outcomes; } }),
        sendDirection: async (_id: string, message: string) => { if (opts.directionFails) throw new Error("stopping"); directions.push(message); },
      },
    };
  }
  const reply = { from: "qa", kind: "handoff" as const, content: "[qa replied to what you handed them]\nall green" };

  it("while the run works: into the run (a follow-up), and in its log", async () => {
    const h = host("running");
    expect(await deliverAgentReplyToTask(h.host, { id: "t1", runId: "r1" }, reply)).toBe("run");
    expect(h.directions).toEqual([reply.content]);
    expect(h.task.outcomes).toBeUndefined();
    const line = JSON.parse(readFileSync(join(h.polpoDir, "logs", "run-r1.jsonl"), "utf-8").trim());
    expect(line).toMatchObject({ event: "agent:reply", data: { from: "qa", kind: "handoff", text: reply.content } });
  });

  it("after the run (or when it cannot take it): on the task as a text outcome", async () => {
    for (const h of [host("completed"), host("running", { directionFails: true })]) {
      expect(await deliverAgentReplyToTask(h.host, { id: "t1", runId: "r1" }, reply)).toBe("task");
      expect(h.task.outcomes).toEqual([expect.objectContaining({ type: "text", label: "Reply from qa", text: reply.content, producedBy: "message_agent" })]);
    }
  });
});

describe("rooms: an agent's reply sets off only the agents it may talk to", () => {
  const PROFILES: Record<string, AgentProfile> = {
    dev: { id: "dev", name: "Dev", role: "Builds", responsibilities: [] },
    writer: { id: "writer", name: "Writer", role: "Writes", responsibilities: [] },
    polpo: { id: "polpo", name: "Polpo", role: "the orchestrator", responsibilities: [] },
  };
  function room(mayTalk?: (from: string, to: string) => boolean, settings: RoomSettings = {}) {
    const rooms = new FileRoomStore(tmp("polpo-talk-room-"));
    const list: Array<{ id: string; agent?: string; scope?: string; updatedAt: string }> = [];
    const sessions = {
      listSessions: async () => list,
      create: async (_t?: string, agent?: string, o?: { scope?: string }) => { const id = `s${list.length + 1}`; list.push({ id, ...(agent ? { agent } : {}), ...(o?.scope ? { scope: o.scope } : {}), updatedAt: new Date().toISOString() }); return id; },
      getRecentMessages: async () => [],
    } as unknown as SessionStore;
    const replies: Record<string, string[]> = { dev: ["@writer can you document it?"], writer: ["documented"], polpo: ["@writer and @dev, noted"] };
    const runner: ChannelChatRunner = async ({ agent }) => ({ text: replies[agent ?? "polpo"]?.shift() ?? "ok" });
    const engine = new RoomEngine({ rooms, sessions, runner: () => runner, profile: async (a) => PROFILES[a]!, emit: () => {}, ...(mayTalk ? { mayTalk } : {}) });
    const ready = rooms.ensureRoom({ id: "web:r", kind: "web", title: "R", agents: ["dev", "writer", "polpo"], settings: { replyMode: "mentions", ...settings } });
    const say = async (text: string) => {
      await ready;
      await engine.post("web:r", { id: "web:user", name: "Ada" }, text);
      await engine.settled();
      return (await rooms.getRecentMessages("web:r", 50)).map((m) => `${m.authorName}: ${m.text}`);
    };
    return { say };
  }

  it("dev mentioning writer outside its lines does not set writer off", async () => {
    expect(await room((from, to) => !(from === "dev" && to === "writer")).say("@dev ship it")).toEqual(["Ada: @dev ship it", "Dev: @writer can you document it?"]);
  });

  it("within the lines (or with no lines check) it does", async () => {
    expect(await room(() => true).say("@dev ship it")).toEqual(["Ada: @dev ship it", "Dev: @writer can you document it?", "Writer: documented"]);
  });

  it("a person's mentions and Polpo's replies are not limited", async () => {
    const lines = await room(() => false).say("@polpo and @writer, status?");
    expect(lines).toContain("Writer: documented");
    expect(lines).toContain("Polpo: @writer and @dev, noted");
    // Polpo's mentions set the agents off even though no agent may talk to another
    expect(lines.filter((l) => l.startsWith("Dev:"))).toHaveLength(1);
  });
});
