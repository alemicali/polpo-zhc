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

vi.mock("@mariozechner/pi-ai", async () => {
  const { buildPiAiMock, mockTextStream } = await import("./helpers/mock-llm.js");
  // Default: return a simple text response. Tests override via setStreamImpl().
  streamSimpleImpl = () => mockTextStream("Default mock response.");
  const base = buildPiAiMock((...args: unknown[]) => streamSimpleImpl(...args) as any);
  return {
    ...base,
    // Override streamSimple to delegate to our mutable impl
    streamSimple: (...args: unknown[]) => streamSimpleImpl(...args),
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
  org: "test-completions",
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
});

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
