/**
 * One turn per session (session leases), single-flight queue dispatch, auto-send after a restart,
 * steer retries/withdrawals, queue limits, scoped branches and undoing a branch mid-answer —
 * on the real completions pipeline (only the LLM boundary is mocked).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator } from "../core/orchestrator.js";

let streamSimpleImpl: (...args: unknown[]) => unknown;

async function buildMockPiModule() {
  const { buildPiAiMock, mockTextStream } = await import("./helpers/mock-llm.js");
  streamSimpleImpl ??= () => mockTextStream("Default mock response.");
  const base = buildPiAiMock((...args: unknown[]) => streamSimpleImpl(...args) as any);
  return { ...base, streamSimple: (...args: unknown[]) => streamSimpleImpl(...args) };
}

vi.mock("@earendil-works/pi-ai", buildMockPiModule);
vi.mock("@earendil-works/pi-ai/compat", buildMockPiModule);
vi.mock("@earendil-works/pi-ai/providers/all", async () => {
  const { mockModel } = await import("./helpers/mock-llm.js");
  return { getBuiltinModel: () => mockModel(), getBuiltinModels: () => [mockModel()], getBuiltinProviders: () => ["anthropic"] };
});
vi.mock("../llm/pi-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/pi-client.js")>();
  const { mockModel } = await import("./helpers/mock-llm.js");
  return {
    ...actual,
    resolveModel: () => mockModel(),
    resolveModelSpec: (spec: unknown) => spec ?? "anthropic:mock-model",
    resolveApiKeyAsync: async () => "mock-api-key",
    streamSimpleWithAuth: (...args: unknown[]) => streamSimpleImpl(...args),
    buildStreamOpts: () => undefined,
  };
});

import { mockTextStream, mockToolCallStream } from "./helpers/mock-llm.js";

let tmpDir: string;
let app: any;
let orchestrator: Orchestrator;

/** Every LLM call's conversation, in order. */
let calls: any[][] = [];

/** Plays `responses` in order; a response may wait for a gate before streaming. */
function script(responses: Array<() => any>, gates: Record<number, Promise<void>> = {}, reached: Record<number, () => void> = {}) {
  calls = [];
  streamSimpleImpl = (_model: unknown, context: any) => {
    const index = calls.length;
    calls.push(structuredClone(context.messages));
    reached[index]?.();
    const stream = responses[Math.min(index, responses.length - 1)]();
    const gate = gates[index];
    if (!gate) return stream;
    return {
      async *[Symbol.asyncIterator]() { await gate; yield* stream; },
      result: () => stream.result(),
    };
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function startStream(body: Record<string, unknown>, headers: Record<string, string> = { "x-session-id": "new" }) {
  const res: Response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ stream: true, ...body }),
  });
  return { res, turnId: res.headers.get("x-turn-id")!, sessionId: res.headers.get("x-session-id")!, text: res.text() };
}

function chunks(text: string): any[] {
  return text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
    .filter(Boolean);
}

const extra = (all: any[], key: string) => all.map((c) => c.choices?.[0]?.[key]).filter(Boolean);

async function messagesOf(sessionId: string): Promise<any[]> {
  const res = await app.request(`/api/v1/chat/sessions/${sessionId}/messages`);
  return (await res.json()).data.messages;
}

async function waitFor<T>(check: () => Promise<T | undefined> | T | undefined, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
}

const idle = async (sessionId: string) => {
  const res = await app.request(`/v1/chat/completions/active-turn?sessionId=${sessionId}`);
  return (await res.json()).data.turnId === null;
};

const steer = (turnId: string, body: Record<string, unknown>) => app.request(`/v1/chat/completions/steer/${turnId}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

const json = (method: string, body?: unknown) => ({
  method, headers: { "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-coordination-test-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({
    project: "test-coordination",
    team: { name: "test-team", agents: [{ name: "agent-1", role: "Test agent" }] },
    settings: { maxRetries: 2, logLevel: "quiet" },
  }));
  const { Orchestrator: OrchestratorClass } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  orchestrator = new OrchestratorClass(tmpDir);
  await orchestrator.initInteractive("test-coordination", { name: "test-team", agents: [{ name: "agent-1", role: "Test agent" }] });
  const bridge = new SSEBridge(orchestrator);
  bridge.start();
  app = createApp(orchestrator, bridge);
}, 60_000);

afterAll(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});


/** A text answer that takes `ms` before streaming; tracks how many answers run at once. */
let active = 0;
let maxActive = 0;
function slowText(text: string, ms: number) {
  const stream = mockTextStream(text);
  return {
    async *[Symbol.asyncIterator]() {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((r) => setTimeout(r, ms));
        yield* stream;
      } finally {
        active--;
      }
    },
    result: () => stream.result(),
  };
}

async function newSessionWithAnswer(): Promise<string> {
  script([() => mockTextStream("Hello.")]);
  const run = await startStream({ messages: [{ role: "user", content: "hi" }] });
  await run.text;
  await waitFor(() => idle(run.sessionId));
  return run.sessionId;
}

const post = (sid: string, body: unknown, headers: Record<string, string> = {}) => app.request("/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-session-id": sid, ...headers },
  body: JSON.stringify(body),
});

describe("one turn per session", () => {
  test("a second turn on a busy session is refused, or waits when asked to", async () => {
    const release = deferred();
    const reached = deferred();
    script([() => mockTextStream("First."), () => mockTextStream("Second.")], { 0: release.promise }, { 0: reached.resolve });
    const run = await startStream({ messages: [{ role: "user", content: "one" }] });
    await reached.promise;

    const busyStream = await post(run.sessionId, { stream: true, messages: [{ role: "user", content: "two" }] });
    expect(busyStream.status).toBe(409);
    expect((await busyStream.json()).error.code).toBe("session_busy");
    const busyPlain = await post(run.sessionId, { messages: [{ role: "user", content: "two" }] });
    expect(busyPlain.status).toBe(409);

    // A caller that asks to wait (channels do) gets its turn once the first one is over.
    const waiting = post(run.sessionId, { messages: [{ role: "user", content: "after" }] }, { "x-polpo-lease-wait": "5000" });
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toHaveLength(1);
    release.resolve();
    await run.text;
    const answered = await waiting;
    expect(answered.status).toBe(200);
    expect(calls).toHaveLength(2);
    const contents = (await messagesOf(run.sessionId)).map((m) => m.content);
    expect(contents).toEqual(["one", "First.", "after", "Second."]);
    expect(contents).not.toContain("two");
  });

  test("channel turns and background-wait continuations respect the running turn", async () => {
    const release = deferred();
    const reached = deferred();
    script([() => mockTextStream("Web answer."), () => mockTextStream("Channel answer.")], { 0: release.promise }, { 0: reached.resolve });
    const run = await startStream({ messages: [{ role: "user", content: "from the web" }] });
    await reached.promise;

    const continuation = (orchestrator as any).backgroundWaitContinuation as (w: unknown, t: unknown, s: AbortSignal) => Promise<string>;
    expect(await continuation({ id: "w1", sessionId: run.sessionId }, { id: "t1", title: "Task", status: "done" }, new AbortController().signal)).toBe("deferred");

    const runner = orchestrator.getChannelChatRunner()!;
    const channel = runner({ sessionId: run.sessionId, messages: [{ role: "user", content: "from telegram" }] } as any);
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toHaveLength(1); // the channel turn waits
    release.resolve();
    await run.text;
    await channel;
    expect(calls).toHaveLength(2);
    expect((await messagesOf(run.sessionId)).map((m) => m.content)).toEqual(["from the web", "Web answer.", "from telegram", "Channel answer."]);
  });

  test("queue dispatch is single-flight even when the queue store is slow", async () => {
    const sid = await newSessionWithAnswer();
    const realStore = orchestrator.getChatQueueStore();
    const slow = Object.create(realStore);
    slow.shift = async (id: string) => { await new Promise((r) => setTimeout(r, 15)); return realStore.shift(id); };
    slow.get = async (id: string) => { await new Promise((r) => setTimeout(r, 5)); return realStore.get(id); };
    const original = orchestrator.getChatQueueStore.bind(orchestrator);
    (orchestrator as any).getChatQueueStore = () => slow;
    active = 0;
    maxActive = 0;
    script([() => slowText("A done.", 40), () => slowText("B done.", 40), () => slowText("C done.", 40)]);
    try {
      const base = `/api/v1/chat/sessions/${sid}/queue`;
      // Adds and looks from several "devices" at once: every one of them kicks the dispatcher.
      await Promise.all([
        app.request(base, json("POST", { content: "A" })),
        app.request(base, json("POST", { content: "B" })),
        app.request(base),
        app.request(base, json("POST", { content: "C" })),
        app.request(base),
      ]);
      for (let i = 0; i < 5; i++) { await app.request(base); await new Promise((r) => setTimeout(r, 7)); }
      await waitFor(async () => (await messagesOf(sid)).length === 8 && await idle(sid), 8000);
      const contents = (await messagesOf(sid)).map((m) => m.content);
      expect(contents.filter((c) => ["A", "B", "C"].includes(c)).sort()).toEqual(["A", "B", "C"]);
      expect(maxActive).toBe(1);
      for (let i = 2; i < 8; i += 2) expect(contents[i + 1]).toMatch(/done\.$/);
    } finally {
      (orchestrator as any).getChatQueueStore = original;
    }
  }, 15_000);
});

describe("auto-send after a restart", () => {
  test("persisted prompts are sent once someone looks at the queue, or on startup", async () => {
    const sessions = orchestrator.getSessionStore()!;
    const queueStore = orchestrator.getChatQueueStore();
    // A conversation from before the restart, with prompts still queued.
    const sid = await sessions.create("before restart");
    await sessions.addMessage(sid, "user", "earlier");
    await sessions.addMessage(sid, "assistant", "Earlier answer.");
    await queueStore.add(sid, "still queued");
    // And one that was waiting for the user's answer: its queue must not fire on its own.
    const waitingSid = await sessions.create("waiting");
    await sessions.addMessage(waitingSid, "user", "deploy");
    await sessions.addMessage(waitingSid, "assistant", "", [{ id: "q", name: "ask_user", state: "interrupted" }]);
    await queueStore.add(waitingSid, "should wait");

    script([() => mockTextStream("Sent after restart.")]);
    await app.request(`/api/v1/chat/sessions/${sid}/queue`);
    await waitFor(async () => (await messagesOf(sid)).some((m) => m.content === "Sent after restart.") && await idle(sid));
    expect((await messagesOf(sid)).map((m) => m.content)).toEqual(["earlier", "Earlier answer.", "still queued", "Sent after restart."]);

    await app.request(`/api/v1/chat/sessions/${waitingSid}/queue`);
    await new Promise((r) => setTimeout(r, 400));
    expect((await queueStore.get(waitingSid)).items).toHaveLength(1);

    // A freshly started scheduler (the restart) resumes pending queues by itself.
    const { createTurnScheduler } = await import("@polpo-ai/server");
    const startup = await sessions.create("startup");
    await sessions.addMessage(startup, "user", "x");
    await sessions.addMessage(startup, "assistant", "y");
    await queueStore.add(startup, "resume me");
    const restarted = createTurnScheduler({
      getSessionStore: () => sessions,
      getQueueStore: () => queueStore,
      emit: () => {},
      request: (req) => app.request("/v1/chat/completions", { method: req.method, headers: req.headers, body: req.body, duplex: "half" } as any),
    });
    script([() => mockTextStream("Resumed.")]);
    try {
      await restarted.resumePending();
      await waitFor(async () => (await messagesOf(startup)).some((m) => m.content === "Resumed.") && await idle(startup));
    } finally {
      restarted.dispose();
    }
  }, 15_000);
});

describe("steers", () => {
  test("a retried steer id is never injected twice, even after delivery", async () => {
    const release = deferred();
    const reached = deferred();
    script([() => mockTextStream("One."), () => mockTextStream("Two.")], { 0: release.promise }, { 0: reached.resolve });
    const run = await startStream({ messages: [{ role: "user", content: "go" }] });
    await reached.promise;
    expect((await steer(run.turnId, { id: "same", content: "once" })).status).toBe(202);
    expect((await steer(run.turnId, { id: "same", content: "once" })).status).toBe(202);
    release.resolve();
    await run.text;
    // Retry after delivery (the client missed the answer): accepted, not sent again.
    const retry = await steer(run.turnId, { id: "same", content: "once" });
    expect(retry.status).toBe(202);
    await new Promise((r) => setTimeout(r, 500));
    expect(calls).toHaveLength(2);
    expect((await messagesOf(run.sessionId)).filter((m) => m.content === "once")).toHaveLength(1);
  });

  test("a carried-over steer can be withdrawn before it is sent; carried steers are stored in the queue", async () => {
    const release = deferred();
    const reached = deferred();
    script([
      () => mockToolCallStream("ask_user", { questions: [{ id: "q1", question: "Which?", header: "Q", options: [{ label: "a" }] }] }),
      () => mockTextStream("Should not happen."),
    ], { 0: release.promise }, { 0: reached.resolve });
    const run = await startStream({ messages: [{ role: "user", content: "ask me" }] });
    await reached.promise;
    await steer(run.turnId, { id: "carry-me", content: "never mind" });
    release.resolve();
    await run.text;
    // Stored at the head of the queue (survives a restart)…
    expect((await orchestrator.getChatQueueStore().get(run.sessionId)).items.map((i) => i.content)).toEqual(["never mind"]);
    // …and still withdrawable.
    const cancel = await app.request(`/v1/chat/completions/steer/${run.turnId}/carry-me`, { method: "DELETE" });
    expect(cancel.status).toBe(200);
    await new Promise((r) => setTimeout(r, 1800));
    expect(calls).toHaveLength(1);
    expect((await orchestrator.getChatQueueStore().get(run.sessionId)).items).toEqual([]);
  }, 10_000);
});

describe("queue limits", () => {
  test("a session queue holds at most 50 prompts; reorder takes at most 200 ids", async () => {
    const sid = await newSessionWithAnswer();
    const base = `/api/v1/chat/sessions/${sid}/queue`;
    await app.request(base, json("PATCH", { autoSend: false }));
    for (let i = 0; i < 50; i++) expect((await app.request(base, json("POST", { content: `p${i}` }))).status).toBe(201);
    const full = await app.request(base, json("POST", { content: "one too many" }));
    expect(full.status).toBe(409);
    expect((await full.json()).code).toBe("QUEUE_FULL");
    expect((await app.request(`${base}/order`, json("PUT", { ids: Array.from({ length: 201 }, (_, i) => `x${i}`) }))).status).toBe(400);
    await app.request(base, json("DELETE"));
  });
});

describe("branches", () => {
  test("a branch of a scoped (group) conversation stays scoped", async () => {
    const sessions = orchestrator.getSessionStore()!;
    const group = await sessions.create("Team", undefined, { scope: "telegram:group:-5" });
    const question = await sessions.addMessage(group, "user", "Ada: what now?");
    await sessions.addMessage(group, "assistant", "Lunch.");
    script([() => mockTextStream("Dinner.")]);
    const forked = await (await app.request(`/api/v1/chat/sessions/${group}/fork`, json("POST", { messageId: question.id }))).json();
    expect(forked.data.session).toMatchObject({ scope: "telegram:group:-5", parentSessionId: group });
    await waitFor(async () => await idle(forked.data.session.id) && (await messagesOf(forked.data.session.id)).some((m) => m.content === "Dinner."));
    expect((await sessions.getLatestSession())?.id).not.toBe(forked.data.session.id);
  });

  test("undoing a branch mid-answer stops it and nothing is recorded for it", async () => {
    const sid = await newSessionWithAnswer();
    const question = (await messagesOf(sid))[0];
    const release = deferred();
    const reached = deferred();
    script([() => mockTextStream("Late answer.")], { 0: release.promise }, { 0: reached.resolve });
    const forked = await (await app.request(`/api/v1/chat/sessions/${sid}/fork`, json("POST", { messageId: question.id }))).json();
    const forkId = forked.data.session.id;
    await reached.promise;
    const events: any[] = [];
    const onAdded = (data: any) => { if (data.sessionId === forkId) events.push(data); };
    orchestrator.on("message:added" as any, onAdded);
    try {
      const undone = await app.request(`/api/v1/chat/sessions/${forkId}/fork?force=1`, { method: "DELETE" });
      expect(undone.status).toBe(200);
      release.resolve();
      await waitFor(() => idle(forkId));
      await new Promise((r) => setTimeout(r, 200));
      expect(events).toEqual([]);
      expect((await app.request(`/api/v1/chat/sessions/${forkId}/messages`)).status).toBe(404);
      // The session is free again (no leaked lease).
      const { sessionLeases } = await import("@polpo-ai/server");
      expect(sessionLeases.isHeld(forkId)).toBe(false);
    } finally {
      orchestrator.off("message:added" as any, onAdded);
    }
  });
});
