/**
 * Steering, server-side queue and conversation branches on the real completions pipeline
 * (Orchestrator + file stores in a temp dir; only the LLM boundary is mocked).
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
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-steering-test-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({
    project: "test-steering",
    team: { name: "test-team", agents: [{ name: "agent-1", role: "Test agent" }] },
    settings: { maxRetries: 2, logLevel: "quiet" },
  }));
  const { Orchestrator: OrchestratorClass } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  orchestrator = new OrchestratorClass(tmpDir);
  await orchestrator.initInteractive("test-steering", { name: "test-team", agents: [{ name: "agent-1", role: "Test agent" }] });
  const bridge = new SSEBridge(orchestrator);
  bridge.start();
  app = createApp(orchestrator, bridge);
});

afterAll(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("steering", () => {
  test("a steer is injected after the round's tool results and splits the answer", async () => {
    const release = deferred();
    const reached = deferred();
    script([
      () => mockToolCallStream("set_session_title", { title: "Long job" }),
      () => mockTextStream("Done, and noted."),
    ], { 0: release.promise }, { 0: reached.resolve });

    const run = await startStream({ messages: [{ role: "user", content: "do the long job" }] });
    await reached.promise;
    const accepted = await steer(run.turnId, { id: "s1", content: "also use metric units" });
    expect(accepted.status).toBe(202);
    expect((await accepted.json()).data.status).toBe("pending");
    release.resolve();

    const all = chunks(await run.text);
    const turn = extra(all, "turn")[0];
    expect(turn.assistant_message_id).toBeTruthy();
    const applied = extra(all, "steer_applied");
    expect(applied).toHaveLength(1);
    expect(applied[0].previous_assistant_message_id).toBe(turn.assistant_message_id);
    expect(applied[0].steers[0]).toMatchObject({ id: "s1", content: "also use metric units" });

    // The model saw the tool result, then the steer, before answering again.
    expect(calls).toHaveLength(2);
    const second = calls[1];
    expect(second.at(-2).role).toBe("toolResult");
    expect(second.at(-1)).toMatchObject({ role: "user", content: "also use metric units" });

    const stored = await messagesOf(run.sessionId);
    expect(stored.map((m) => [m.role, m.content])).toEqual([
      ["user", "do the long job"],
      ["assistant", ""],
      ["user", "also use metric units"],
      ["assistant", "Done, and noted."],
    ]);
    expect(stored[1].id).toBe(turn.assistant_message_id);
    expect(stored[1].toolCalls[0].name).toBe("set_session_title");
    expect(stored[2].id).toBe(applied[0].steers[0].message_id);
    expect(stored[3].id).toBe(applied[0].assistant_message_id);
  });

  test("a steer arriving while the model finishes keeps the turn going", async () => {
    const release = deferred();
    const reached = deferred();
    script([() => mockTextStream("First answer."), () => mockTextStream("Second answer.")], { 0: release.promise }, { 0: reached.resolve });

    const run = await startStream({ messages: [{ role: "user", content: "hi" }] });
    await reached.promise;
    expect((await steer(run.turnId, { content: "and in French?" })).status).toBe(202);
    release.resolve();
    await run.text;

    expect(calls).toHaveLength(2);
    expect(calls[1].at(-1)).toMatchObject({ role: "user", content: "and in French?" });
    expect((await messagesOf(run.sessionId)).map((m) => m.content)).toEqual(["hi", "First answer.", "and in French?", "Second answer."]);
    // The turn is over: a late steer becomes the next message instead.
    script([() => mockTextStream("Late reply.")]);
    const late = await steer(run.turnId, { content: "one more thing" });
    expect(late.status).toBe(202);
    expect((await late.json()).data.status).toBe("scheduled");
    await waitFor(async () => (await messagesOf(run.sessionId)).some((m) => m.content === "Late reply.") && await idle(run.sessionId));
    expect((await messagesOf(run.sessionId)).map((m) => m.content).slice(-2)).toEqual(["one more thing", "Late reply."]);
  });

  test("a withdrawn steer is never delivered", async () => {
    const release = deferred();
    const reached = deferred();
    script([() => mockTextStream("Only answer.")], { 0: release.promise }, { 0: reached.resolve });
    const run = await startStream({ messages: [{ role: "user", content: "hello" }] });
    await reached.promise;
    await steer(run.turnId, { id: "gone", content: "never mind" });
    const cancel = await app.request(`/v1/chat/completions/steer/${run.turnId}/gone`, { method: "DELETE" });
    expect(cancel.status).toBe(200);
    release.resolve();
    await run.text;
    expect(calls).toHaveLength(1);
    expect((await app.request(`/v1/chat/completions/steer/${run.turnId}/gone`, { method: "DELETE" })).status).toBe(409);
    expect((await messagesOf(run.sessionId)).map((m) => m.content)).toEqual(["hello", "Only answer."]);
  });

  test("Stop hands pending steers back instead of sending them", async () => {
    const reached = deferred();
    const never = new Promise<void>(() => {});
    script([() => mockTextStream("never streamed")], { 0: never }, { 0: reached.resolve });
    const run = await startStream({ messages: [{ role: "user", content: "slow" }] });
    await reached.promise;
    await steer(run.turnId, { id: "back", content: "put me back" });
    const abort = await app.request(`/v1/chat/completions/abort/${run.turnId}`, { method: "POST" });
    expect(await abort.json()).toEqual({ ok: true, returnedSteers: [{ id: "back", content: "put me back" }] });
    const late = await steer(run.turnId, { content: "too late" });
    expect(late.status).toBe(409);
    expect((await late.json()).code).toBe("turn_aborted");
    // Replay for other devices carries the returned steer.
    const replay = await (await app.request(`/v1/chat/completions/resume/${run.turnId}`)).text();
    expect(extra(chunks(replay), "steer_returned")[0]).toMatchObject({ reason: "aborted", steers: [{ id: "back" }] });
    await new Promise((r) => setTimeout(r, 400));
    expect((await messagesOf(run.sessionId)).some((m) => m.content === "put me back")).toBe(false);
  });

  test("a steer that misses a turn ending on ask_user is sent as the next message", async () => {
    const release = deferred();
    const reached = deferred();
    script([
      () => mockToolCallStream("ask_user", { questions: [{ id: "q1", question: "Which env?", header: "Env", options: [{ label: "prod" }, { label: "dev" }] }] }),
      () => mockTextStream("Using staging then."),
    ], { 0: release.promise }, { 0: reached.resolve });
    const started: any[] = [];
    const onStarted = (data: any) => started.push(data);
    orchestrator.on("chat:turn-started" as any, onStarted);
    try {
      const run = await startStream({ messages: [{ role: "user", content: "deploy" }] });
      await reached.promise;
      await steer(run.turnId, { id: "s-env", content: "use staging" });
      release.resolve();
      const returned = extra(chunks(await run.text), "steer_returned");
      expect(returned[0]).toMatchObject({ reason: "turn_ended", scheduled: true, steers: [{ id: "s-env", content: "use staging" }] });

      await waitFor(() => started.find((e) => e.sessionId === run.sessionId), 4000);
      expect(started.find((e) => e.sessionId === run.sessionId).reason).toBe("steer");
      await waitFor(async () => await idle(run.sessionId) && (await messagesOf(run.sessionId)).some((m) => m.content === "Using staging then."));
      const stored = await messagesOf(run.sessionId);
      expect(stored.map((m) => m.content).slice(-2)).toEqual(["use staging", "Using staging then."]);
      expect(stored[1].toolCalls[0]).toMatchObject({ name: "ask_user", state: "interrupted" });
    } finally {
      orchestrator.off("chat:turn-started" as any, onStarted);
    }
  }, 10_000);

  test("steer validation", async () => {
    expect((await steer("turn-missing", { content: "x" })).status).toBe(404);
    expect((await steer("turn-missing", { content: "" })).status).toBe(400);
    expect((await app.request("/v1/chat/completions/abort/turn-missing", { method: "POST" })).status).toBe(404);
  });
});

describe("server-side queue", () => {
  test("queued prompts are sent one after another when turns complete", async () => {
    const release = deferred();
    const reached = deferred();
    script([
      () => mockTextStream("First."),
      () => mockTextStream("Second."),
      () => mockTextStream("Third."),
    ], { 0: release.promise }, { 0: reached.resolve });
    const run = await startStream({ messages: [{ role: "user", content: "one" }] });
    await reached.promise;
    const base = `/api/v1/chat/sessions/${run.sessionId}/queue`;
    const a = await (await app.request(base, json("POST", { content: "two" }))).json();
    await app.request(base, json("POST", { content: "three" }));
    const zero = await (await app.request(base, json("POST", { content: "zero", front: true }))).json();
    expect((await (await app.request(base)).json()).data.items.map((i: any) => i.content)).toEqual(["zero", "two", "three"]);
    expect((await app.request(`${base}/${zero.data.id}`, json("DELETE"))).status).toBe(200);
    expect((await (await app.request(`${base}/${a.data.id}`, json("PATCH", { content: "two!" }))).json()).data.content).toBe("two!");
    release.resolve();
    await run.text;

    await waitFor(async () => (await messagesOf(run.sessionId)).length === 6 && await idle(run.sessionId), 6000);
    expect((await messagesOf(run.sessionId)).map((m) => m.content)).toEqual(["one", "First.", "two!", "Second.", "three", "Third."]);
    expect((await (await app.request(base)).json()).data.items).toEqual([]);
  }, 10_000);

  test("auto-send off keeps the queue; send now while a turn runs steers it", async () => {
    const release = deferred();
    const reached = deferred();
    script([() => mockTextStream("Working."), () => mockTextStream("With the extra.")], { 0: release.promise }, { 0: reached.resolve });
    const run = await startStream({ messages: [{ role: "user", content: "start" }] });
    await reached.promise;
    const base = `/api/v1/chat/sessions/${run.sessionId}/queue`;
    await app.request(base, json("PATCH", { autoSend: false }));
    const later = await (await app.request(base, json("POST", { content: "later" }))).json();
    const now = await (await app.request(base, json("POST", { content: "right now" }))).json();
    const sent = await (await app.request(`${base}/${now.data.id}/send`, json("POST"))).json();
    expect(sent.data).toMatchObject({ mode: "steer", turnId: run.turnId });
    const reordered = await (await app.request(`${base}/order`, json("PUT", { ids: [later.data.id] }))).json();
    expect(reordered.data.items.map((i: any) => i.content)).toEqual(["later"]);
    release.resolve();
    await run.text;
    await new Promise((r) => setTimeout(r, 500));
    expect((await messagesOf(run.sessionId)).map((m) => m.content)).toEqual(["start", "Working.", "right now", "With the extra."]);
    const state = (await (await app.request(base)).json()).data;
    expect(state).toMatchObject({ autoSend: false, items: [{ content: "later" }] });
    // Idle: send now starts a turn.
    script([() => mockTextStream("Later handled.")]);
    const idleSend = await (await app.request(`${base}/${later.data.id}/send`, json("POST"))).json();
    expect(idleSend.data.mode).toBe("turn");
    await waitFor(async () => await idle(run.sessionId) && (await messagesOf(run.sessionId)).some((m) => m.content === "Later handled."));
    expect((await app.request(base, json("DELETE"))).status).toBe(200);
  }, 10_000);
});

describe("branches", () => {
  test("fork from a user message, answer again, then undo", async () => {
    script([() => mockTextStream("Answer A.")]);
    const first = await startStream({ messages: [{ role: "user", content: "question one" }] });
    await first.text;
    const sid = first.sessionId;
    script([() => mockTextStream("Answer B.")]);
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA3sAAAAASUVORK5CYII=";
    const second = await startStream({ messages: [
      { role: "user", content: "question one" }, { role: "assistant", content: "Answer A." },
      { role: "user", content: [{ type: "text", text: "question two" }, { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }] },
    ] }, { "x-session-id": sid });
    await second.text;
    const parentMessages = await messagesOf(sid);
    const forkPoint = parentMessages[2];
    expect(forkPoint.attachments).toHaveLength(1);

    // Only user messages can be branched from.
    expect((await app.request(`/api/v1/chat/sessions/${sid}/fork`, json("POST", { messageId: parentMessages[1].id }))).status).toBe(400);

    script([() => mockTextStream("Answer B, take two.")]);
    const forked = await (await app.request(`/api/v1/chat/sessions/${sid}/fork`, json("POST", { messageId: forkPoint.id }))).json();
    const fork = forked.data.session;
    expect(fork).toMatchObject({ parentSessionId: sid, forkMessageId: forkPoint.id, messageCount: 3 });
    expect(forked.data.turnId).toBeTruthy();
    await waitFor(async () => await idle(fork.id) && (await messagesOf(fork.id)).some((m) => m.content === "Answer B, take two."));
    // The model answered the copied question again, without a duplicate user message.
    expect(calls.at(-1)!.filter((m: any) => m.role === "user").length).toBeGreaterThanOrEqual(2);
    const forkMessages = await messagesOf(fork.id);
    expect(forkMessages.map((m) => m.content)).toEqual(["question one", "Answer A.", "question two", "Answer B, take two."]);
    expect(forkMessages[2].attachments[0].path).toBe(forkPoint.attachments[0].path);
    expect(forkMessages[2].attachments[0].id).not.toBe(forkPoint.attachments[0].id);
    // The parent lists its branch at the fork point.
    const parentView = await (await app.request(`/api/v1/chat/sessions/${sid}/messages`)).json();
    expect(parentView.data.forks).toEqual([expect.objectContaining({ id: fork.id, forkMessageId: forkPoint.id })]);

    // Deleting the branch's copy of the attachment keeps the parent's file.
    const file = join(tmpDir, forkPoint.attachments[0].path);
    expect(existsSync(file)).toBe(true);
    expect((await app.request(`/api/v1/attachments/${forkMessages[2].attachments[0].id}`, { method: "DELETE" })).status).toBe(200);
    expect(existsSync(file)).toBe(true);

    // Undo: confirmation needed once the user wrote in the branch.
    script([() => mockTextStream("Branch reply.")]);
    const more = await startStream({ messages: [{ role: "user", content: "branch only" }] }, { "x-session-id": fork.id });
    await more.text;
    const refused = await app.request(`/api/v1/chat/sessions/${fork.id}/fork`, { method: "DELETE" });
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("FORK_HAS_MESSAGES");
    const undone = await (await app.request(`/api/v1/chat/sessions/${fork.id}/fork?force=1`, { method: "DELETE" })).json();
    expect(undone.data).toMatchObject({ parentSessionId: sid, forkMessageId: forkPoint.id });
    expect((await app.request(`/api/v1/chat/sessions/${fork.id}/messages`)).status).toBe(404);
    expect(existsSync(file)).toBe(true);
    expect((await messagesOf(sid)).length).toBe(4);
    expect((await app.request(`/api/v1/chat/sessions/${sid}/fork`, { method: "DELETE" })).status).toBe(400);
  }, 15_000);
});
