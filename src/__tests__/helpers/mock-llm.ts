/**
 * Mock LLM helpers for deterministic integration tests.
 *
 * Inspired by Vercel AI SDK's MockLanguageModel and simulateReadableStream.
 * Provides factory functions to create fake pi-ai responses (AssistantMessage)
 * and fake streams (AssistantMessageEventStream) that the completions endpoint
 * and other LLM consumers can use without hitting a real provider.
 *
 * IMPORTANT: This module must NOT import from @mariozechner/pi-ai at the top
 * level, because tests vi.mock that module. Instead we implement a lightweight
 * duck-typed EventStream that matches the real interface.
 */

// ── Types (copied from pi-ai to avoid import) ────────

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

interface TextContent { type: "text"; text: string }
interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
type ContentBlock = TextContent | ToolCallContent;

interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
  api: string;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: string;
  timestamp: number;
}

type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallContent; partial: AssistantMessage }
  | { type: "done"; reason: string; message: AssistantMessage }
  | { type: "error"; reason: string; error: AssistantMessage };

interface Context {
  systemPrompt?: string;
  messages: unknown[];
  tools?: unknown[];
}

interface Model {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

// ── Duck-typed EventStream ───────────────────────────

/**
 * Minimal EventStream implementation that matches pi-ai's interface:
 * - AsyncIterable<AssistantMessageEvent> via for-await
 * - .result() returns Promise<AssistantMessage>
 */
class MockEventStream {
  private events: AssistantMessageEvent[];
  private finalResult: AssistantMessage;
  private resultPromise: Promise<AssistantMessage>;

  constructor(events: AssistantMessageEvent[], result: AssistantMessage) {
    this.events = events;
    this.finalResult = result;
    this.resultPromise = Promise.resolve(result);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    for (const event of this.events) {
      yield event;
    }
  }

  result(): Promise<AssistantMessage> {
    return this.resultPromise;
  }
}

// ── Usage helper ──────────────────────────────────────

function mockUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 150,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}

// ── AssistantMessage factories ────────────────────────

/** Create a simple text-only AssistantMessage. */
export function mockTextResponse(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "mock-model",
    usage: mockUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Create an AssistantMessage containing a single tool call. */
export function mockToolCallResponse(
  toolName: string,
  args: Record<string, unknown>,
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: toolName,
      arguments: args,
    }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "mock-model",
    usage: mockUsage(),
    stopReason: "toolUse",
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Create an AssistantMessage with both text and a tool call. */
export function mockTextAndToolCallResponse(
  text: string,
  toolName: string,
  args: Record<string, unknown>,
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text },
      {
        type: "toolCall",
        id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: toolName,
        arguments: args,
      },
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "mock-model",
    usage: mockUsage(),
    stopReason: "toolUse",
    timestamp: Date.now(),
    ...overrides,
  };
}

// ── Stream factories ──────────────────────────────────

/**
 * Build the standard event sequence for a text-only response stream.
 * Mirrors what pi-ai emits: start -> text_start -> text_delta(s) -> text_end -> done.
 */
export function mockTextStreamEvents(text: string, finalMessage: AssistantMessage): AssistantMessageEvent[] {
  const partialBase: AssistantMessage = {
    ...finalMessage,
    content: [{ type: "text", text: "" }],
    stopReason: "stop",
  };

  const events: AssistantMessageEvent[] = [
    { type: "start", partial: { ...partialBase, content: [] } },
    { type: "text_start", contentIndex: 0, partial: partialBase },
  ];

  // Split text into chunks (simulate streaming)
  const chunkSize = Math.max(1, Math.ceil(text.length / 3));
  let accumulated = "";
  for (let i = 0; i < text.length; i += chunkSize) {
    const delta = text.slice(i, i + chunkSize);
    accumulated += delta;
    events.push({
      type: "text_delta",
      contentIndex: 0,
      delta,
      partial: { ...partialBase, content: [{ type: "text", text: accumulated }] },
    });
  }

  events.push({
    type: "text_end",
    contentIndex: 0,
    content: text,
    partial: { ...partialBase, content: [{ type: "text", text }] },
  });
  events.push({ type: "done", reason: "stop", message: finalMessage });

  return events;
}

/**
 * Build stream events for a tool call response.
 * Emits: start -> toolcall_start -> toolcall_delta -> toolcall_end -> done.
 */
export function mockToolCallStreamEvents(finalMessage: AssistantMessage): AssistantMessageEvent[] {
  const toolCall = finalMessage.content.find(c => c.type === "toolCall") as ToolCallContent | undefined;
  if (!toolCall) throw new Error("mockToolCallStreamEvents: finalMessage has no toolCall content");

  const partialBase: AssistantMessage = {
    ...finalMessage,
    content: [toolCall],
    stopReason: "toolUse",
  };

  const argsJson = JSON.stringify(toolCall.arguments);

  return [
    { type: "start", partial: { ...partialBase, content: [] } },
    { type: "toolcall_start", contentIndex: 0, partial: partialBase },
    { type: "toolcall_delta", contentIndex: 0, delta: argsJson, partial: partialBase },
    { type: "toolcall_end", contentIndex: 0, toolCall, partial: partialBase },
    { type: "done", reason: "toolUse", message: finalMessage },
  ];
}

/**
 * Create a fake stream from a list of events and a final result.
 * Returns a duck-typed object matching pi-ai's AssistantMessageEventStream.
 */
export function mockStream(
  events: AssistantMessageEvent[],
  finalMessage: AssistantMessage,
): MockEventStream {
  return new MockEventStream(events, finalMessage);
}

/** Convenience: create a stream for a simple text response. */
export function mockTextStream(text: string): MockEventStream {
  const msg = mockTextResponse(text);
  return mockStream(mockTextStreamEvents(text, msg), msg);
}

/** Convenience: create a stream for a tool call response. */
export function mockToolCallStream(
  toolName: string,
  args: Record<string, unknown>,
): MockEventStream {
  const msg = mockToolCallResponse(toolName, args);
  return mockStream(mockToolCallStreamEvents(msg), msg);
}

// ── Model factory ─────────────────────────────────────

/** Create a minimal mock Model that passes resolveModel checks. */
export function mockModel(): Model {
  return {
    id: "mock-model",
    name: "Mock Model",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://mock.example.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  };
}

// ── Multi-turn scenario builder ───────────────────────

/**
 * Create a streamSimple mock that plays a sequence of turns.
 * Each call to streamSimple returns the next response in the sequence.
 * After the sequence is exhausted, returns the last response repeatedly.
 */
export function mockTurnSequence(responses: AssistantMessage[]): () => MockEventStream {
  let callIndex = 0;
  return () => {
    const idx = Math.min(callIndex++, responses.length - 1);
    const msg = responses[idx];
    const hasToolCall = msg.content.some(c => c.type === "toolCall");
    const events = hasToolCall
      ? mockToolCallStreamEvents(msg)
      : mockTextStreamEvents(
          msg.content.filter(c => c.type === "text").map(c => (c as TextContent).text).join(""),
          msg,
        );
    return mockStream(events, msg);
  };
}

// ── Full pi-ai module mock builder ────────────────────

/**
 * Build a complete mock of @mariozechner/pi-ai suitable for vi.mock().
 *
 * @param streamFactory - Called each time streamSimple is invoked.
 */
export function buildPiAiMock(
  streamFactory: (model: Model, context: Context, options?: unknown) => MockEventStream,
) {
  return {
    streamSimple: (model: Model, context: Context, options?: unknown) => {
      return streamFactory(model, context, options);
    },
    completeSimple: async (model: Model, context: Context, options?: unknown) => {
      const stream = streamFactory(model, context, options);
      for await (const _event of stream) { /* consume */ }
      return stream.result();
    },

    getModel: () => mockModel(),
    getModels: () => [mockModel()],
    getProviders: () => ["anthropic"],
    getEnvApiKey: () => "mock-api-key",
    calculateCost: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
    createAssistantMessageEventStream: () => {
      throw new Error("Use mockStream() instead of createAssistantMessageEventStream() in tests");
    },
  };
}
