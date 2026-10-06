/**
 * Integration tests for POST /v1/chat/completions.
 *
 * These tests use a real Orchestrator with file stores in a temp dir,
 * and mock only the pi-ai LLM boundary. All Polpo code — model resolution,
 * system prompt, tool execution, SSE formatting, session persistence — runs
 * for real.
 */

import { describe, test, expect, beforeAll, afterAll, vi, type Mock } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator } from "../core/orchestrator.js";

// ── Mock pi-ai and pi-client BEFORE any imports that pull them in ──

// We dynamically set what streamSimple returns per test via `streamSimpleImpl`.
let streamSimpleImpl: (...args: unknown[]) => unknown;

async function buildMockPiModule() {
  const { buildPiAiMock, mockTextStream } = await import("./helpers/mock-llm.js");
  streamSimpleImpl ??= () => mockTextStream("Default mock response.");
  const base = buildPiAiMock((...args: unknown[]) => streamSimpleImpl(...args) as any);
  return {
    ...base,
    streamSimple: (...args: unknown[]) => streamSimpleImpl(...args),
  };
}

vi.mock("@earendil-works/pi-ai", buildMockPiModule);
vi.mock("@earendil-works/pi-ai/compat", buildMockPiModule);
vi.mock("@earendil-works/pi-ai/providers/all", async () => {
  const { mockModel } = await import("./helpers/mock-llm.js");
  return {
    getBuiltinModel: () => mockModel(),
    getBuiltinModels: () => [mockModel()],
    getBuiltinProviders: () => ["anthropic"],
  };
});

// Mock the Polpo pi-client layer — resolveModel, resolveApiKeyAsync, etc.
// These functions normally need a real model spec from config; we bypass them.
vi.mock("../llm/pi-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/pi-client.js")>();
  const { mockModel } = await import("./helpers/mock-llm.js");
  return {
    ...actual,
    resolveModel: () => mockModel(),
    resolveModelSpec: (spec: unknown) => spec ?? "anthropic:mock-model",
    resolveApiKeyAsync: async () => "mock-api-key",
    streamSimpleWithAuth: (...args: unknown[]) => streamSimpleImpl(...args),
    buildStreamOpts: (apiKey?: string, reasoning?: string, maxTokens?: number) => {
      const opts: Record<string, unknown> = {};
      if (apiKey) opts.apiKey = apiKey;
      return Object.keys(opts).length > 0 ? opts : undefined;
    },
  };
});

// Import after mock is set up
import {
  mockTextStream,
  mockToolCallStream,
  mockTextResponse,
  mockToolCallResponse,
  mockTurnSequence,
  mockStream,
  mockTextStreamEvents,
  mockToolCallStreamEvents,
} from "./helpers/mock-llm.js";

// ── Test Setup ──────────────────────────────────────────

const POLPO_CONFIG = JSON.stringify({
  project: "test-completions",
  team: {
    name: "test-team",
    agents: [
      { name: "agent-1", role: "Test agent" },
    ],
  },
  settings: { maxRetries: 2, logLevel: "quiet" },
}, null, 2);

let tmpDir: string;
let app: any; // OpenAPIHono — `any` to avoid Hono<> vs OpenAPIHono<> generic mismatch
let orchestrator: Orchestrator;

/** Override the streamSimple implementation for the next call(s). */
function setStreamImpl(impl: (...args: unknown[]) => unknown) {
  streamSimpleImpl = impl;
}

/** POST /v1/chat/completions helper. */
async function postCompletions(body: Record<string, unknown>, headers?: Record<string, string>) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Parse a non-streaming completion response body. */
async function parseJson(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

/** Parse an SSE stream into an array of parsed data chunks. */
async function parseSSE(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  const chunks: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      const data = line.slice(6);
      if (data === "[DONE]") break;
      try {
        chunks.push(JSON.parse(data));
      } catch { /* skip non-JSON lines */ }
    }
  }
  return chunks;
}

// ── Lifecycle ───────────────────────────────────────────

test("model failures emit a terminal SSE error instead of a success", async () => {
  setStreamImpl(() => mockStream([{ type: "error", reason: "error", error: { errorMessage: "Could not process image" } }] as any, mockTextResponse("")));
  const res = await postCompletions({ stream: true, messages: [{ role: "user", content: "QA error" }] }, { "x-session-id": "new" });
  const body = await res.text();
  expect(body).toContain('"code":"model_stream_failed"');
  expect(body).not.toContain('[DONE]');
});

test("mobile multimodal request persists an attachment receipt readable from another client", async () => {
  setStreamImpl(() => mockTextStream("Attachment received."));
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA3sAAAAASUVORK5CYII=";
  const res = await postCompletions({ agent: "agent-1", stream: true, messages: [{ role: "user", content: [
    { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
    { type: "file", file: { filename: "notes.txt", file_data: "data:text/plain;base64,aGVsbG8=" } },
  ] }] }, { "x-session-id": "new" });
  expect(res.status).toBe(200);
  await res.text();
  const sid = res.headers.get("x-session-id");
  const messageId = res.headers.get("x-user-message-id");
  expect(messageId).toBeTruthy();
  const history = await (await app.request(`/api/v1/chat/sessions/${sid}/messages`)).json();
  const user = history.data.messages.find((m: any) => m.id === messageId);
  expect(user.content).toBe("");
  expect(user.attachments).toHaveLength(2);
  const download = await app.request(`/api/v1/attachments/${user.attachments[0].id}/download`);
  expect(download.status).toBe(200);
  expect(Buffer.from(await download.arrayBuffer()).toString("base64")).toBe(png);
});

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-completions-test-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), POLPO_CONFIG);

  const { Orchestrator: OrchestratorClass } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");

  orchestrator = new OrchestratorClass(tmpDir);
  await orchestrator.initInteractive("test-completions", {
    name: "test-team",
    agents: [{ name: "agent-1", role: "Test agent" }],
  });

  const sseBridge = new SSEBridge(orchestrator);
  sseBridge.start();

  // No API keys → no auth required
  app = createApp(orchestrator, sseBridge);
}, 60_000);

afterAll(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────

describe("POST /v1/chat/completions", () => {

  // ── Basic request/response ──────────────────────────

  describe("non-streaming", () => {
    test("returns OpenAI-compatible completion for simple text response", async () => {
      setStreamImpl(() => mockTextStream("Hello from Polpo!"));

      const res = await postCompletions({
        messages: [{ role: "user", content: "Hi" }],
        stream: false,
      });

      expect(res.status).toBe(200);
      const body = await parseJson(res);
      expect(body.object).toBe("chat.completion");
      expect(body.model).toBe("polpo");
      expect(body.id).toMatch(/^chatcmpl-/);

      const choices = body.choices as any[];
      expect(choices).toHaveLength(1);
      expect(choices[0].message.role).toBe("assistant");
      expect(choices[0].message.content).toBe("Hello from Polpo!");
      expect(choices[0].finish_reason).toBe("stop");

      const usage = body.usage as Record<string, number>;
      expect(usage.total_tokens).toBeGreaterThan(0);
    });

    test("returns 400 when messages array is empty", async () => {
      const res = await postCompletions({
        messages: [],
        stream: false,
      });
      // Zod validation: min(1) on messages
      expect(res.status).toBe(400);
    });
  });

  describe("streaming", () => {
    test("returns SSE stream with text deltas and [DONE]", async () => {
      setStreamImpl(() => mockTextStream("Streamed response!"));

      const res = await postCompletions({
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      });

      expect(res.status).toBe(200);
      const text = await res.text();

      // Should contain role chunk, text deltas, finish, and [DONE]
      expect(text).toContain('"role":"assistant"');
      // Text may be split across multiple deltas; check that all content arrives
      const chunks = await parseSSE({ text: () => Promise.resolve(text) } as any);
      const allContent = chunks
        .map(c => (c.choices as any[])?.[0]?.delta?.content)
        .filter(Boolean)
        .join("");
      expect(allContent).toBe("Streamed response!");
      expect(text).toContain('"finish_reason":"stop"');
      expect(text).toContain("[DONE]");
    });

    test("SSE chunks have correct OpenAI format", async () => {
      setStreamImpl(() => mockTextStream("Test"));

      const res = await postCompletions({
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      });

      const chunks = await parseSSE(res);
      expect(chunks.length).toBeGreaterThan(0);

      // First chunk should have role
      const firstChunk = chunks[0];
      expect(firstChunk.object).toBe("chat.completion.chunk");
      expect(firstChunk.model).toBe("polpo");
      expect(firstChunk.id).toMatch(/^chatcmpl-/);
      expect((firstChunk.choices as any[])[0].delta.role).toBe("assistant");

      // Last chunk should have finish_reason
      const lastChunk = chunks[chunks.length - 1];
      expect((lastChunk.choices as any[])[0].finish_reason).toBe("stop");
    });

    test("compacts oversized context before calling the provider", async () => {
      let providerContext: any;
      setStreamImpl((_model, context) => {
        providerContext = context;
        return mockTextStream("Compacted safely.");
      });

      const large = "context-data ".repeat(18_000);
      const res = await postCompletions({
        messages: [
          { role: "user", content: large },
          { role: "assistant", content: large },
          { role: "user", content: large },
        ],
        stream: true,
      }, { "x-session-id": "new" });
      const chunks = await parseSSE(res);

      const notice = chunks.find((chunk) => (chunk.choices as any[])?.[0]?.context_compaction);
      const info = (notice?.choices as any[])?.[0]?.context_compaction;
      expect(info).toBeDefined();
      expect(info.afterTokens).toBeLessThan(info.beforeTokens);
      expect(info.afterTokens).toBeLessThanOrEqual(160_000);
      expect(providerContext.messages[0].content).toContain("Context checkpoint");
    });

    test("reuses durable compacted context on the next client turn without changing visible history", async () => {
      const contexts: any[] = [];
      setStreamImpl((_model, context) => { contexts.push(structuredClone(context)); return mockTextStream("First answer."); });
      const large = "remember-important-decision ".repeat(10_000);
      const history = [
        { role: "user", content: large }, { role: "assistant", content: large },
        { role: "user", content: "Keep these decisions and answer now." },
      ];
      const first = await postCompletions({ messages: history, stream: true }, { "x-session-id": "new" });
      const sid = first.headers.get("x-session-id")!;
      const firstChunks = await parseSSE(first);
      expect(firstChunks.some((c: any) => c.choices?.[0]?.context_compaction)).toBe(true);
      // Fresh createApp produces fresh dependency/store objects, emulating a
      // different client and process-level loss of in-memory checkpoint state.
      const { createApp } = await import("../server/app.js");
      const { SSEBridge } = await import("../server/sse-bridge.js");
      const nextApp = createApp(orchestrator, new SSEBridge(orchestrator));
      const next = await nextApp.request("/v1/chat/completions", { method: "POST",
        headers: { "Content-Type": "application/json", "x-session-id": sid },
        body: JSON.stringify({ stream: true, messages: [...history,
          { role: "assistant", content: "First answer." }, { role: "user", content: "Continue from the decisions." }] }),
      });
      const nextChunks = await parseSSE(next);
      expect(nextChunks.some((c: any) => c.choices?.[0]?.context_compaction)).toBe(false);
      expect(contexts.at(-1).messages[0].content).toContain("Context checkpoint");
      expect(contexts.at(-1).messages.at(-1).content).toBe("Continue from the decisions.");
      const persisted = await orchestrator.getSessionStore()!.getMessages(sid);
      expect(persisted.filter(m => m.role === "user").map(m => m.content)).toEqual([
        "Keep these decisions and answer now.", "Continue from the decisions.",
      ]);
      expect(persisted.some(m => m.content.includes("Context checkpoint"))).toBe(false);
    });

    test("compacts on request (/compact) without answering, and the next turn reuses it", async () => {
      const contexts: any[] = [];
      setStreamImpl((_model, context) => { contexts.push(structuredClone(context)); return mockTextStream("## Goal\nKeep going"); });
      const history = [
        { role: "user", content: "First request" }, { role: "assistant", content: "First answer" },
        { role: "user", content: "Second request" }, { role: "assistant", content: "Second answer" },
      ];
      const opened = await postCompletions({ messages: [{ role: "user", content: "hello" }], stream: false }, { "x-session-id": "new" });
      const sid = opened.headers.get("x-session-id")!;
      const res = await postCompletions({ messages: history, compact: { focus: "the requests" } } as any, { "x-session-id": sid });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.compaction).toMatchObject({ reason: "manual", focus: "the requests" });
      // nothing was added to the visible conversation
      const persisted = await orchestrator.getSessionStore()!.getMessages(sid);
      expect(persisted.map((m) => m.content)).not.toContain("Second request");
    });

    test("manual compaction needs an existing session", async () => {
      const res = await postCompletions({ messages: [{ role: "user", content: "x" }], compact: {} } as any, { "x-session-id": "new" });
      expect(res.status).toBe(400);
    });

    test("retries once with forced compaction after a provider overflow", async () => {
      let calls = 0;
      setStreamImpl(() => {
        calls += 1;
        if (calls === 1) {
          const failed = mockTextResponse("");
          return mockStream([{
            type: "error",
            reason: "error",
            error: { errorMessage: "prompt is too long: 1107869 tokens > 1000000 maximum" },
          }] as any, failed);
        }
        return mockTextStream("Recovered response.");
      });

      const res = await postCompletions({
        messages: [
          { role: "user", content: "Earlier request" },
          { role: "assistant", content: "Earlier response" },
          { role: "user", content: "Continue" },
        ],
        stream: true,
      }, { "x-session-id": "new" });
      const chunks = await parseSSE(res);
      const text = chunks.map((chunk) => (chunk.choices as any[])?.[0]?.delta?.content).filter(Boolean).join("");
      const recovery = chunks.find((chunk) =>
        (chunk.choices as any[])?.[0]?.context_compaction?.reason === "overflow"
      );

      // provider error, the compaction summary, then the retry
      expect(calls).toBe(3);
      expect(recovery).toBeDefined();
      expect(text).toBe("Recovered response.");
    });
  });

  describe("token usage", () => {
    test("records provider usage for dashboard aggregation", async () => {
      const beforeRes = await app.request("/api/v1/token-usage?range=24h");
      const before = (await beforeRes.json()).data.totalTokens as number;
      setStreamImpl(() => mockTextStream("Measured response."));

      const completion = await postCompletions({
        messages: [{ role: "user", content: "Measure this" }],
        stream: false,
      }, { "x-session-id": "new" });
      expect(completion.status).toBe(200);

      const afterRes = await app.request("/api/v1/token-usage?range=24h");
      const after = (await afterRes.json()).data;
      expect(after.totalTokens).toBe(before + 150);
      expect(after.inputTokens).toBeGreaterThanOrEqual(100);
      expect(after.outputTokens).toBeGreaterThanOrEqual(50);
    });
  });

  // ── Tool execution ──────────────────────────────────

  describe("tool execution", () => {
    test("executes get_status tool and returns result in non-streaming mode", async () => {
      // Turn 1: LLM calls get_status tool
      // Turn 2: After receiving tool result, LLM responds with text
      const turnSequence = mockTurnSequence([
        mockToolCallResponse("get_status", {}),
        mockTextResponse("The project has 0 tasks and 1 agent."),
      ]);
      setStreamImpl(turnSequence);

      const res = await postCompletions({
        messages: [{ role: "user", content: "What is the project status?" }],
        stream: false,
      });

      expect(res.status).toBe(200);
      const body = await parseJson(res);
      const choices = body.choices as any[];
      expect(choices[0].message.content).toBe("The project has 0 tasks and 1 agent.");
      expect(choices[0].finish_reason).toBe("stop");
    });

    test("executes get_status tool in streaming mode with tool_call events", async () => {
      const turnSequence = mockTurnSequence([
        mockToolCallResponse("get_status", {}),
        mockTextResponse("Status summary."),
      ]);
      setStreamImpl(turnSequence);

      const res = await postCompletions({
        messages: [{ role: "user", content: "Status?" }],
        stream: true,
      });

      const chunks = await parseSSE(res);

      // Should have tool_call chunks (preparing + calling + completed)
      const toolChunks = chunks.filter(c => {
        const choice = (c.choices as any[])?.[0];
        return choice?.tool_call != null;
      });
      expect(toolChunks.length).toBeGreaterThan(0);

      // Should stream raw arguments while the tool call is still being prepared
      const preparingArgsChunk = toolChunks.find(c => {
        const choice = (c.choices as any[])?.[0];
        return choice?.tool_call?.state === "preparing" && choice.tool_call.argumentsText === "{}";
      });
      expect(preparingArgsChunk).toBeDefined();

      // Should have a "completed" tool_call with result
      const completedChunk = toolChunks.find(c => {
        const choice = (c.choices as any[])?.[0];
        return choice?.tool_call?.state === "completed";
      });
      expect(completedChunk).toBeDefined();

      // Should end with text + stop
      const textChunks = chunks.filter(c => {
        const choice = (c.choices as any[])?.[0];
        return choice?.delta?.content != null;
      });
      expect(textChunks.length).toBeGreaterThan(0);
    });

    test("executes list_tasks tool and returns structured data", async () => {
      const turnSequence = mockTurnSequence([
        mockToolCallResponse("list_tasks", {}),
        mockTextResponse("There are no tasks yet."),
      ]);
      setStreamImpl(turnSequence);

      const res = await postCompletions({
        messages: [{ role: "user", content: "List all tasks" }],
        stream: false,
      });

      expect(res.status).toBe(200);
      const body = await parseJson(res);
      expect((body.choices as any[])[0].message.content).toBe("There are no tasks yet.");
    });

    test("wait_for_task keeps the stream alive and continues the LLM turn after completion", async () => {
      const task = await orchestrator.addTask({
        title: "Wait integration task",
        description: "Completed externally while the chat turn waits",
        assignTo: "agent-1",
        draft: true,
      });
      const turnSequence = mockTurnSequence([
        mockToolCallResponse("wait_for_task", { taskId: task.id, pollIntervalMs: 10_000 }),
        mockTextResponse("The task finished and I continued the same turn."),
      ]);
      setStreamImpl(turnSequence);

      const transition = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          orchestrator.getStore().unsafeSetStatus(task.id, "done", "wait_for_task integration test")
            .then(() => resolve(), reject);
        }, 40);
      });

      try {
        const res = await postCompletions({
          messages: [{ role: "user", content: "Wait for that task and report back" }],
          stream: true,
        });
        const chunks = await parseSSE(res);
        await transition;

        const toolEvents = chunks
          .map((chunk) => (chunk.choices as any[])?.[0]?.tool_call)
          .filter(Boolean);
        expect(toolEvents).toContainEqual(expect.objectContaining({
          name: "wait_for_task",
          state: "calling",
          progress: expect.objectContaining({ status: "draft", taskId: task.id }),
        }));
        expect(toolEvents).toContainEqual(expect.objectContaining({
          name: "wait_for_task",
          state: "completed",
        }));

        const text = chunks
          .map((chunk) => (chunk.choices as any[])?.[0]?.delta?.content)
          .filter(Boolean)
          .join("");
        expect(text).toBe("The task finished and I continued the same turn.");
      } finally {
        await orchestrator.deleteTask(task.id);
      }
    });

    test("aborting the streaming turn cancels wait_for_task and cleans up its listener", async () => {
      const task = await orchestrator.addTask({
        title: "Cancelled wait task",
        description: "The chat wait is cancelled before this task finishes",
        assignTo: "agent-1",
        draft: true,
      });
      setStreamImpl(mockTurnSequence([
        mockToolCallResponse("wait_for_task", { taskId: task.id, pollIntervalMs: 10_000 }),
        mockTextResponse("This response must not be reached."),
      ]));
      const listenersBefore = orchestrator.listenerCount("task:transition");

      try {
        const res = await postCompletions({
          messages: [{ role: "user", content: "Wait, then stop" }],
          stream: true,
        });
        const turnId = res.headers.get("x-turn-id");
        expect(turnId).toBeTruthy();
        const chunksPromise = parseSSE(res);

        await vi.waitFor(() => {
          expect(orchestrator.listenerCount("task:transition")).toBeGreaterThan(listenersBefore);
        });
        const abortRes = await app.request(`/v1/chat/completions/abort/${turnId}`, { method: "POST" });
        expect(abortRes.status).toBe(200);

        const chunks = await chunksPromise;
        await vi.waitFor(() => {
          expect(orchestrator.listenerCount("task:transition")).toBe(listenersBefore);
        });
        const toolEvents = chunks
          .map((chunk) => (chunk.choices as any[])?.[0]?.tool_call)
          .filter(Boolean);
        expect(toolEvents.some((event) => event.name === "wait_for_task" && event.state === "completed")).toBe(false);
        expect(chunks.some((chunk) => (chunk.choices as any[])?.[0]?.delta?.content === "This response must not be reached.")).toBe(false);
      } finally {
        await orchestrator.deleteTask(task.id);
      }
    });

    test("handles multi-tool turn (2 tool calls in sequence)", async () => {
      // Turn 1: list_tasks
      // Turn 2: list_agents (LLM wants more info)
      // Turn 3: final text response
      const turnSequence = mockTurnSequence([
        mockToolCallResponse("list_tasks", {}),
        mockToolCallResponse("list_agents", {}),
        mockTextResponse("You have 0 tasks and 1 agent: agent-1."),
      ]);
      setStreamImpl(turnSequence);

      const res = await postCompletions({
        messages: [{ role: "user", content: "Give me a full overview" }],
        stream: false,
      });

      expect(res.status).toBe(200);
      const body = await parseJson(res);
      expect((body.choices as any[])[0].message.content).toContain("0 tasks");
    });
  });

  // ── Interactive tools ───────────────────────────────

  describe("interactive tools", () => {
    test("ask_user returns finish_reason='ask_user' in non-streaming mode", async () => {
      setStreamImpl(() => {
        const msg = mockToolCallResponse("ask_user", {
          questions: [{ question: "Which database?", options: ["postgres", "mysql"] }],
        });
        const events = mockToolCallStreamEvents(msg);
        return mockStream(events, msg);
      });

      const res = await postCompletions({
        messages: [{ role: "user", content: "Set up the database" }],
        stream: false,
      });

      expect(res.status).toBe(200);
      const body = await parseJson(res);
      const choices = body.choices as any[];
      expect(choices[0].finish_reason).toBe("ask_user");
      expect(choices[0].ask_user).toBeDefined();
      expect(choices[0].ask_user.questions).toHaveLength(1);
    });

    test("ask_user returns finish_reason='ask_user' in streaming mode", async () => {
      setStreamImpl(() => {
        const msg = mockToolCallResponse("ask_user", {
          questions: [{ question: "Which DB?" }],
        });
        return mockStream(mockToolCallStreamEvents(msg), msg);
      });

      const res = await postCompletions({
        messages: [{ role: "user", content: "Set up DB" }],
        stream: true,
      });

      const chunks = await parseSSE(res);
      const askChunk = chunks.find(c => {
        const choice = (c.choices as any[])?.[0];
        return choice?.finish_reason === "ask_user";
      });
      expect(askChunk).toBeDefined();
    });

    test("ask_user is available in direct agent chats", async () => {
      setStreamImpl((...args: unknown[]) => {
        const options = args[1] as { systemPrompt: string; tools: Array<{ name: string }> };
        expect(options.tools.some((tool) => tool.name === "ask_user")).toBe(true);
        expect(options.systemPrompt).toContain("structured ask_user tool");
        expect(options.systemPrompt.lastIndexOf("structured ask_user tool"))
          .toBeGreaterThan(options.systemPrompt.lastIndexOf("proceed without asking questions"));
        const msg = mockToolCallResponse("ask_user", {
          questions: [{
            id: "framework",
            question: "Which framework should I use?",
            options: [
              { label: "React", description: "Use React" },
              { label: "Vue", description: "Use Vue" },
            ],
          }],
        });
        return mockStream(mockToolCallStreamEvents(msg), msg);
      });

      const res = await postCompletions({
        agent: "agent-1",
        messages: [{ role: "user", content: "Build the interface" }],
        stream: false,
      });

      expect(res.status).toBe(200);
      const body = await parseJson(res);
      const choice = (body.choices as any[])[0];
      expect(choice.finish_reason).toBe("ask_user");
      expect(choice.ask_user.questions[0].id).toBe("framework");
    });

    test("navigate_to preserves an App Preview URL", async () => {
      setStreamImpl(() => {
        const msg = mockToolCallResponse("navigate_to", {
          target: "app_preview",
          url: "https://machine.example.ts.net:3020/",
        });
        return mockStream(mockToolCallStreamEvents(msg), msg);
      });

      const res = await postCompletions({
        messages: [{ role: "user", content: "Open the active app preview" }],
        stream: false,
      });

      expect(res.status).toBe(200);
      const choice = ((await parseJson(res)).choices as any[])[0];
      expect(choice.finish_reason).toBe("navigate_to");
      expect(choice.navigate_to).toMatchObject({
        target: "app_preview",
        url: "https://machine.example.ts.net:3020/",
      });
    });
  });

  // ── Auth ────────────────────────────────────────────

  describe("auth", () => {
    test("succeeds without auth when no API keys configured", async () => {
      setStreamImpl(() => mockTextStream("No auth needed."));

      const res = await postCompletions({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(res.status).toBe(200);
    });
  });

  // ── Message formatting ──────────────────────────────

  describe("message formatting", () => {
    test("handles multi-part content (text array)", async () => {
      setStreamImpl(() => mockTextStream("Got your multi-part message."));

      const res = await postCompletions({
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Part one." },
            { type: "text", text: "Part two." },
          ],
        }],
        stream: false,
      });

      expect(res.status).toBe(200);
      const body = await parseJson(res);
      expect((body.choices as any[])[0].message.content).toBe("Got your multi-part message.");
    });

    test("handles system + user messages", async () => {
      setStreamImpl(() => mockTextStream("I see the system context."));

      const res = await postCompletions({
        messages: [
          { role: "system", content: "You are a helpful assistant for project X." },
          { role: "user", content: "What project is this?" },
        ],
        stream: false,
      });

      expect(res.status).toBe(200);
      const body = await parseJson(res);
      expect((body.choices as any[])[0].message.content).toBe("I see the system context.");
    });

    test("handles conversation history with assistant messages", async () => {
      setStreamImpl(() => mockTextStream("Continuing our conversation."));

      const res = await postCompletions({
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there!" },
          { role: "user", content: "How are you?" },
        ],
        stream: false,
      });

      expect(res.status).toBe(200);
      const body = await parseJson(res);
      expect((body.choices as any[])[0].message.content).toBe("Continuing our conversation.");
    });
  });

  // ── Session persistence ─────────────────────────────

  describe("session persistence", () => {
    test("returns x-session-id header", async () => {
      setStreamImpl(() => mockTextStream("Session test."));

      const res = await postCompletions({
        messages: [{ role: "user", content: "Hi" }],
        stream: false,
      });

      expect(res.status).toBe(200);
      const sessionId = res.headers.get("x-session-id");
      expect(sessionId).toBeTruthy();
    });

    test("reuses session when x-session-id header is sent back", async () => {
      setStreamImpl(() => mockTextStream("First."));
      const res1 = await postCompletions({
        messages: [{ role: "user", content: "Hi" }],
        stream: false,
      });
      const sessionId = res1.headers.get("x-session-id")!;

      setStreamImpl(() => mockTextStream("Second."));
      const res2 = await postCompletions(
        { messages: [{ role: "user", content: "Follow up" }], stream: false },
        { "x-session-id": sessionId },
      );

      expect(res2.headers.get("x-session-id")).toBe(sessionId);
    });

    test("internal background continuation keeps history without duplicating the user message", async () => {
      setStreamImpl(() => mockTextStream("Initial answer"));
      const initial = await postCompletions({
        messages: [{ role: "user", content: "Start an external task" }],
        stream: false,
      }, { "x-session-id": "new" });
      const sessionId = initial.headers.get("x-session-id")!;

      setStreamImpl(() => mockTextStream("The background task finished"));
      const continuation = await postCompletions({
        messages: [
          { role: "user", content: "Start an external task" },
          { role: "assistant", content: "Initial answer" },
          { role: "system", content: "The background wait is complete" },
        ],
        stream: false,
      }, {
        "x-session-id": sessionId,
        "x-polpo-internal-continuation": "background-wait",
      });

      expect(continuation.status).toBe(200);
      const messages = await orchestrator.getSessionStore()!.getMessages(sessionId);
      expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
      expect(messages.at(-1)).toMatchObject({
        role: "assistant",
        content: "The background task finished",
      });
    });

    test("creates new session when x-session-id is 'new'", async () => {
      setStreamImpl(() => mockTextStream("First."));
      const res1 = await postCompletions({
        messages: [{ role: "user", content: "Hi" }],
        stream: false,
      });
      const firstSessionId = res1.headers.get("x-session-id")!;

      setStreamImpl(() => mockTextStream("New session."));
      const res2 = await postCompletions(
        { messages: [{ role: "user", content: "New convo" }], stream: false },
        { "x-session-id": "new" },
      );

      const newSessionId = res2.headers.get("x-session-id")!;
      expect(newSessionId).toBeTruthy();
      expect(newSessionId).not.toBe(firstSessionId);
    });
  });

  // ── Edge cases ──────────────────────────────────────

  describe("edge cases", () => {
    test("handles empty LLM response gracefully", async () => {
      setStreamImpl(() => mockTextStream(""));

      const res = await postCompletions({
        messages: [{ role: "user", content: "Hi" }],
        stream: false,
      });

      expect(res.status).toBe(200);
      const body = await parseJson(res);
      expect((body.choices as any[])[0].message.content).toBeDefined();
    });
  });
});
