/**
 * OpenAI-compatible chat completions endpoint.
 *
 * POST /v1/chat/completions
 *
 * This is Polpo's primary conversational interface. It accepts OpenAI-format
 * messages, runs the full agentic tool loop internally, and returns
 * responses in OpenAI-compatible format — both streaming (SSE) and non-streaming.
 *
 * Supports two modes:
 * - **Orchestrator mode** (default): The caller talks to Polpo. Polpo has 100+
 *   orchestration tools (tasks, missions, agents, vault, etc.).
 * - **Agent-direct mode** (`agent` field): The caller talks directly to a
 *   specific agent. The agent uses its own model, system prompt, and coding
 *   tools — bypassing the orchestrator entirely.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { nanoid } from "nanoid";
import { agentMemoryScope } from "@polpo-ai/core";
import { streamRegistry } from "../stream-registry.js";

const MAX_TURNS = 20;

type MessageSegment =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool"; toolId: string };

const appendTextSegment = (segments: MessageSegment[], content: string): void => {
  if (!content) return;
  const last = segments[segments.length - 1];
  if (last?.type === "text") {
    last.content += content;
    return;
  }
  segments.push({ type: "text", content });
};

const appendThinkingSegment = (segments: MessageSegment[], content: string): void => {
  if (!content) return;
  const last = segments[segments.length - 1];
  if (last?.type === "thinking") {
    last.content += content;
    return;
  }
  segments.push({ type: "thinking", content });
};

const ensureToolSegment = (segments: MessageSegment[], toolId: string): void => {
  if (!toolId) return;
  if (segments.some((s) => s.type === "tool" && s.toolId === toolId)) return;
  segments.push({ type: "tool", toolId });
};

/** Tools that write/modify files — emit file:changed after successful execution */
const FILE_WRITE_TOOLS: Record<string, "created" | "modified"> = {
  write_file: "created",
  edit_file: "modified",
};

/** Emit file:changed if a file-writing tool succeeded */
function emitFileChanged(
  toolName: string,
  args: Record<string, unknown>,
  result: string,
  emit: (event: string, data: any) => void,
): void {
  const action = FILE_WRITE_TOOLS[toolName];
  if (!action || result.startsWith("Error:")) return;
  const path = args.path as string | undefined;
  if (!path) return;
  const dir = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : ".";
  emit("file:changed", { path, dir, action, source: "chat" });
}

/**
 * Redact sensitive credential values from tool call arguments before persistence.
 * Returns a sanitized copy — original is NOT mutated.
 *
 * Covers:
 *   - set_vault_entry / update_vault_credentials → wholesale `credentials` redaction
 *   - email_send (gated approval-preview path) → SMTP password override
 *
 * The vault tools store creds permanently in the encrypted vault, so chat
 * persistence must NEVER hold the plain values. email_send only carries
 * smtp_pass when the LLM hand-rolls one (rare — usually resolved from
 * vault/env), but redact defensively.
 */
function redactVaultToolCalls(toolCalls: any[]): any[] {
  // @ts-ignore — ToolCallInfo shape preserved via duck typing
  return toolCalls.map(tc => {
    if (!tc.arguments) return tc;
    if (tc.name === "set_vault_entry" || tc.name === "update_vault_credentials") {
      const args = { ...tc.arguments };
      if (args.credentials && typeof args.credentials === "object") {
        const redacted: Record<string, string> = {};
        for (const key of Object.keys(args.credentials as Record<string, string>)) {
          redacted[key] = "[REDACTED]";
        }
        args.credentials = redacted;
      }
      return { ...tc, arguments: args };
    }
    if (tc.name === "email_send" && typeof tc.arguments.smtp_pass === "string") {
      return { ...tc, arguments: { ...tc.arguments, smtp_pass: "[REDACTED]" } };
    }
    return tc;
  });
}

async function persistAssistantMessage(
  sessionStore: { updateMessage: (sessionId: string, messageId: string, content: string, toolCalls?: any[], segments?: MessageSegment[]) => Promise<boolean> },
  sessionId: string,
  messageId: string,
  finalText: string,
  toolCalls: any[],
  segments: MessageSegment[],
): Promise<void> {
  const text = finalText.trim();
  if (text) {
    await sessionStore.updateMessage(sessionId, messageId, text, toolCalls, segments);
    return;
  }

  if (toolCalls.length > 0) {
    await sessionStore.updateMessage(sessionId, messageId, "", toolCalls, segments);
    return;
  }

  await sessionStore.updateMessage(sessionId, messageId, "", toolCalls, segments);
}

// ── Zod Schemas ────────────────────────────────────────────────────────

/** OpenAI-compatible content part (text or image_url). */
const contentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image_url"),
    image_url: z.object({
      url: z.string().openapi({ description: "Data URL (data:image/…;base64,…) or HTTPS URL" }),
      detail: z.enum(["auto", "low", "high"]).optional(),
    }),
  }),
]);

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]).openapi({
    description: "Message role. System messages are appended as additional context (Polpo has its own system prompt).",
  }),
  content: z.union([
    z.string(),
    z.array(contentPartSchema),
  ]).openapi({ description: "Message content — plain string or array of content parts (text / image_url)" }),
});

const completionRequestSchema = z.object({
  messages: z.array(messageSchema).min(1).openapi({
    description: "Conversation messages in OpenAI format",
  }),
  stream: z.boolean().optional().default(false).openapi({
    description: "If true, returns an SSE stream of OpenAI-format chunks. If false, returns a complete response.",
  }),
  model: z.string().optional().openapi({
    description: "Ignored. Polpo uses its configured orchestrator model (or the agent's model in agent-direct mode).",
  }),
  temperature: z.number().optional().openapi({
    description: "Ignored. Reserved for future use.",
  }),
  max_tokens: z.number().int().optional().openapi({
    description: "Ignored. Reserved for future use.",
  }),
  agent: z.string().optional().openapi({
    description: "Target a specific agent by name for direct conversation. Uses the agent's own model, system prompt, and coding tools instead of the orchestrator. Omit to talk to the orchestrator (default).",
  }),
  project: z.string().optional().openapi({
    description: "Deprecated. Ignored.",
  }),
});

const completionResponseSchema = z.object({
  id: z.string().openapi({ description: "Unique completion ID (chatcmpl-...)" }),
  object: z.literal("chat.completion"),
  created: z.number().int().openapi({ description: "Unix timestamp" }),
  model: z.literal("polpo"),
  choices: z.array(z.object({
    index: z.number().int(),
    message: z.object({
      role: z.literal("assistant"),
      content: z.string(),
    }),
    finish_reason: z.enum(["stop", "length", "ask_user", "mission_preview", "vault_preview", "open_file", "navigate_to", "open_tab", "set_design", "widget_render"]),
  })),
  usage: z.object({
    prompt_tokens: z.number().int(),
    completion_tokens: z.number().int(),
    total_tokens: z.number().int(),
  }),
});

const errorResponseSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    code: z.string().optional(),
  }),
});

// ── Route definition ───────────────────────────────────────────────────

const chatCompletionsRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Chat Completions"],
  summary: "Chat completions",
  description: "Polpo's primary conversational interface. Send messages in OpenAI format, receive responses in OpenAI format. Polpo runs its full 37-tool agentic loop internally — you describe what you need, Polpo handles the rest. Supports streaming (SSE) and non-streaming modes.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: completionRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: completionResponseSchema,
        },
      },
      description: "Chat completion response (non-streaming). When stream=true, returns text/event-stream with OpenAI-format chunks ending with data: [DONE].",
    },
    400: {
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
      description: "Invalid request (missing messages or no project available)",
    },
    401: {
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
      description: "Invalid API key",
    },
  },
});

// ── Helpers ────────────────────────────────────────────────────────────

/** Extract plain text from a content field (string or content-part array). */
function extractText(content: z.infer<typeof messageSchema>["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/** Convert OpenAI-format content to pi-ai UserMessage content. */
function toPiContent(content: z.infer<typeof messageSchema>["content"]): string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] {
  if (typeof content === "string") return content;

  // Check if there are any image parts
  const hasImages = content.some((p) => p.type === "image_url");
  if (!hasImages) {
    // Text-only array → flatten to plain string
    return content.map((p) => (p as { type: "text"; text: string }).text).join("\n");
  }

  // Mixed content → convert to pi-ai TextContent | ImageContent array
  return content.map((p) => {
    if (p.type === "text") {
      return { type: "text" as const, text: p.text };
    }
    // image_url → ImageContent
    const url = p.image_url.url;
    // data:image/png;base64,... → extract mimeType and base64 data
    const match = url.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      return { type: "image" as const, data: match[2], mimeType: match[1] };
    }
    // HTTPS URL — pass as-is (pi-ai may or may not support external URLs depending on provider)
    return { type: "image" as const, data: url, mimeType: "image/png" };
  });
}

function convertMessages(messages: z.infer<typeof messageSchema>[]): { piMessages: any[]; extraSystemParts: string[] } {
  const piMessages: any[] = [];
  const extraSystemParts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      extraSystemParts.push(extractText(msg.content));
    } else if (msg.role === "user") {
      piMessages.push({ role: "user", content: toPiContent(msg.content), timestamp: Date.now() });
    } else if (msg.role === "assistant") {
      piMessages.push({
        role: "user",
        content: `[Previous assistant response]\n${extractText(msg.content)}\n[End previous response]`,
        timestamp: Date.now(),
      });
    }
  }

  return { piMessages, extraSystemParts };
}

/** Maximum HTML payload size for render_widget (bytes). */
const RENDER_WIDGET_MAX_HTML_BYTES = 8192;

/** Patterns that disqualify widget HTML (external resources, nested iframes). */
const RENDER_WIDGET_FORBIDDEN_PATTERNS: RegExp[] = [
  /<script[^>]+\bsrc\s*=/i,
  /<link[^>]+\bhref\s*=\s*["']?https?:/i,
  /<img[^>]+\bsrc\s*=\s*["']?https?:/i,
  /<iframe/i,
];

/**
 * Validate render_widget tool args.
 * Returns null on success, or an error string suitable for handing back to the LLM as a tool result
 * so it can retry.
 */
function validateRenderWidgetArgs(args: Record<string, unknown>): string | null {
  const html = typeof args.html === "string" ? args.html : "";
  if (!html) return "Error: render_widget requires a non-empty 'html' string argument.";
  // UTF-8 byte length — emoji/non-ASCII count more than chars.
  const byteLen = Buffer.byteLength(html, "utf8");
  if (byteLen > RENDER_WIDGET_MAX_HTML_BYTES) {
    return "Error: Widget HTML exceeds 8KB. Trim it (remove comments, minify CSS, simplify SVG paths) and retry.";
  }
  for (const pat of RENDER_WIDGET_FORBIDDEN_PATTERNS) {
    if (pat.test(html)) {
      return "Error: Widget HTML must be self-contained: no external scripts/links/images, no nested iframes.";
    }
  }
  // height removed — auto-size always.
  return null;
}

function sseChunk(
  id: string,
  delta: { content?: string; role?: string },
  finishReason: string | null = null,
  extra?: Record<string, unknown>,
): string {
  return JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "polpo",
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason,
      ...extra,
    }],
  });
}

function completionResponse(id: string, content: string, promptTokens: number, completionTokens: number) {
  return {
    id,
    object: "chat.completion" as const,
    created: Math.floor(Date.now() / 1000),
    model: "polpo" as const,
    choices: [{
      index: 0,
      message: { role: "assistant" as const, content },
      finish_reason: "stop" as const,
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

// ── Route factory ──────────────────────────────────────────────────────

/**
 * Completion route dependencies.
 *
 * The consumer provides LLM resolution and tool creation — this allows
 * the route to run on any runtime (Node.js with full tools, or edge with no tools).
 */
export interface CompletionRouteDeps {
  getAgents: () => Promise<any[]>;
  getConfig: () => any;
  getMemoryStore: () => any;
  getSessionStore: () => any;
  getStore: () => any;
  emit: (event: string, data: any) => void;
  /** Resolve agent model + streaming options. */
  resolveAgentModel: (agentConfig: any, settingsReasoning?: string) => Promise<{ model: any; streamOpts: any }>;
  /** Build agent system prompt for conversational mode. */
  buildAgentPrompt: (agentConfig: any) => string | Promise<string>;
  /** Create tools + executor for the agent. Return empty arrays for chat-only. */
  resolveAgentTools: (agentConfig: any) => Promise<{
    tools: any[];
    executor: (name: string, args: Record<string, unknown>) => Promise<string>;
    isInteractive?: (name: string) => boolean;
  }>;
  /** LLM streaming function (streamSimple from pi-ai). */
  streamLLM: (model: any, opts: { systemPrompt: string; messages: any[]; tools: any[] }, streamOpts: any) => any;
  /** Orchestrator mode support (optional — returns 501 if not provided). */
  resolveOrchestratorContext?: () => Promise<{
    systemPrompt: string;
    model: any;
    streamOpts: any;
    tools: any[];
    executor: (name: string, args: Record<string, unknown>) => Promise<string>;
    isInteractive: (name: string) => boolean;
  }>;
}

export function completionRoutes(getDeps: () => CompletionRouteDeps, apiKeys?: string[]): OpenAPIHono {
  const app = new OpenAPIHono();

  app.openapi(chatCompletionsRoute, async (c) => {
    const deps = getDeps();

    // ── Auth ──
    if (apiKeys && apiKeys.length > 0) {
      const auth = c.req.header("Authorization");
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      if (!token || !apiKeys.includes(token)) {
        return c.json({ error: { message: "Invalid API key", type: "invalid_request_error", code: "invalid_api_key" } }, 401);
      }
    }

    // ── Parse body ──
    const body = c.req.valid("json");
    const agentMode = !!body.agent;

    // ── Resolve effective context (orchestrator vs agent-direct) ──
    let fullSystemPrompt: string;
    let m: any;
    let streamOpts: any;
    let effectiveTools: any[];
    let effectiveToolExecutor: (name: string, args: Record<string, unknown>) => Promise<string>;
    let isInteractiveFn: ((name: string) => boolean) | undefined;

    const { piMessages, extraSystemParts } = convertMessages(body.messages);

    if (agentMode) {
      // ── Agent-direct mode ──
      const agents = await deps.getAgents();
      const agentConfig = agents.find((a: any) => a.name === body.agent);
      if (!agentConfig) {
        return c.json({ error: { message: `Agent "${body.agent}" not found`, type: "invalid_request_error", code: "agent_not_found" } }, 404);
      }

      // Build system prompt via dep
      const agentSystemPrompt = await deps.buildAgentPrompt(agentConfig);
      const conversationalPreamble = [
        "You are now in interactive conversation mode with the user.",
        "Unlike task execution, you should engage in dialogue: ask clarifying questions,",
        "explain your reasoning, and wait for user input when needed.",
        "You still have access to all your coding tools to help the user.",
        "You may also use the client-side UI tools open_file, navigate_to, and open_tab when",
        "the user asks to view a file, move to a Polpo page, or open an external URL.",
        "After one of those client-side tools completes, the UI sends a system acknowledgement;",
        "treat it as the tool result and do not repeat the same UI action for the same request.",
      ].join("\n");

      const basePrompt = `${conversationalPreamble}\n\n${agentSystemPrompt}`;
      fullSystemPrompt = extraSystemParts.length > 0
        ? `${basePrompt}\n\n## Additional context from caller\n\n${extraSystemParts.join("\n\n")}`
        : basePrompt;

      // Inject agent memory
      const memoryStore = deps.getMemoryStore();
      const agentMemory = await memoryStore?.get(agentMemoryScope(agentConfig.name));
      if (agentMemory) {
        fullSystemPrompt += `\n\n## Your persistent memory\n\n${agentMemory}`;
      }

      // Resolve model via dep
      const reasoning = agentConfig.reasoning ?? deps.getConfig()?.settings?.reasoning;
      let resolved;
      try {
        resolved = await deps.resolveAgentModel(agentConfig, reasoning);
      } catch (modelErr) {
        const msg = modelErr instanceof Error ? modelErr.message : String(modelErr);
        return c.json({ error: { message: msg, type: "invalid_request_error" } }, 400 as any);
      }
      m = resolved.model;
      streamOpts = resolved.streamOpts;

      // Resolve tools via dep
      const { tools, executor, isInteractive } = await deps.resolveAgentTools(agentConfig);
      effectiveTools = tools;
      effectiveToolExecutor = executor;
      isInteractiveFn = isInteractive;
    } else {
      // ── Orchestrator mode (default) ──
      if (!deps.resolveOrchestratorContext) {
        return c.json({
          error: { message: "Orchestrator mode is not available. Use agent-direct mode by specifying the 'agent' field.", type: "invalid_request_error", code: "orchestrator_unavailable" },
        }, 501 as any);
      }

      const ctx = await deps.resolveOrchestratorContext();
      fullSystemPrompt = extraSystemParts.length > 0
        ? `${ctx.systemPrompt}\n\n## Additional context from caller\n\n${extraSystemParts.join("\n\n")}`
        : ctx.systemPrompt;
      m = ctx.model;
      streamOpts = ctx.streamOpts;
      effectiveTools = ctx.tools;
      effectiveToolExecutor = ctx.executor;
      isInteractiveFn = ctx.isInteractive;
    }

    const completionId = `chatcmpl-${nanoid(24)}`;

    // ── Session persistence ──
    const sessionStore = deps.getSessionStore();
    const rawSessionHeader = c.req.header("x-session-id") ?? null;
    const forceNewSession = rawSessionHeader === "new";
    let sessionId: string | null = forceNewSession ? null : rawSessionHeader;
    // Tracks whether this is the FIRST turn of the session (no prior
    // messages persisted). Drives the system-prompt addendum that forces
    // the agent to call set_session_title at the end of its reply.
    let isFirstTurn = false;
    if (sessionStore) {
      if (!sessionId) {
        const firstUserMsg = body.messages.find(m => m.role === "user");
        const sessionTitle = firstUserMsg ? extractText(firstUserMsg.content).slice(0, 60) : undefined;
        // Agent scope: orchestrator sessions use null, agent sessions use the agent name
        const agentScope = agentMode ? body.agent! : null;

        if (forceNewSession) {
          // Client explicitly requested a new session — skip recency heuristic
          sessionId = await sessionStore.create(sessionTitle, agentScope ?? undefined);
          isFirstTurn = true;
        } else {
          // Reuse latest session if recent (< 30 min), scoped by agent
          const latest = await sessionStore.getLatestSession(agentScope);
          const timeout = 30 * 60 * 1000;
          if (latest && Date.now() - new Date(latest.updatedAt).getTime() < timeout) {
            sessionId = latest.id;
          } else {
            sessionId = await sessionStore.create(sessionTitle, agentScope ?? undefined);
            isFirstTurn = true;
          }
        }
      } else {
        // Reused an existing session id — check whether it already has
        // messages. If not, treat this as a first turn (covers the case
        // where the UI pre-created the session id before the first send).
        try {
          const existing = await sessionStore.getSession(sessionId);
          if (existing && (existing.messageCount ?? 0) === 0) isFirstTurn = true;
        } catch { /* non-fatal */ }
      }
      // Persist user message (only the last one — earlier messages are already persisted)
      const lastUserMsg = [...body.messages].reverse().find(m => m.role === "user");
      if (lastUserMsg && sessionId) {
        await sessionStore.addMessage(sessionId, "user", extractText(lastUserMsg.content));
      }
    }

    // First-turn nudge: inject a system addendum telling the agent to call
    // `set_session_title` once it's done responding. The tool is available
    // on every turn but we only force it here — later turns rely on the
    // tool's own description to remind the model not to re-rename unless
    // the user explicitly asks. Applied after fullSystemPrompt is built.
    if (isFirstTurn) {
      fullSystemPrompt = `${fullSystemPrompt}\n\n## First-turn directive\nThis is the FIRST message of a brand new chat session. After completing your response (or as your final tool call), you MUST call \`set_session_title\` with a SHORT (≤50 chars), meaningful title summarising what the user is asking. Do not over-think it — one line in Title Case. On future turns do NOT call set_session_title unless the user explicitly asks for a rename.`;
    }

    // Expose session ID to the client so it can track which session is active
    if (sessionId) {
      c.header("x-session-id", sessionId);
    }

    if (body.stream) {
      // ── Streaming mode ──
      // Resumable: each turn gets a registry entry. Buffered deltas survive
      // client disconnect, so a returning client can replay + tail.
      const turnId = `turn-${nanoid(20)}`;
      const registryEntry = streamRegistry.register(turnId, sessionId ?? "anon");
      // Surface the turn id so the client can persist it for resume.
      c.header("x-turn-id", turnId);

      return streamSSE(c, async (stream) => {
        // Client-disconnect ≠ LLM-abort. Disconnect just means stop trying to
        // write to this socket; the LLM keeps running and feeds the registry.
        // Explicit user cancel goes through registry.abort() which fires
        // registryEntry.abortController.
        let clientGone = false;
        stream.onAbort(() => { clientGone = true; });

        const abortController = registryEntry.abortController;

        // Single emit point: append to the registry (always) AND best-effort
        // write to the still-connected client.
        const emit = async (data: string) => {
          streamRegistry.append(turnId, data);
          if (clientGone) return;
          try {
            await stream.writeSSE({ data });
          } catch {
            clientGone = true;
          }
        };

        await emit(sseChunk(completionId, { role: "assistant" }));

        // Reserve a placeholder message in the store BEFORE streaming.
        // This guarantees the assistant message exists even if the client disconnects.
        let assistantMsgId: string | null = null;
        if (sessionStore && sessionId) {
          const placeholder = await sessionStore.addMessage(sessionId, "assistant", "");
          assistantMsgId = placeholder.id;
        }

        const messages: any[] = [...piMessages];
        let finalText = "";
        const toolCallsAccum: any[] = [];
        const segmentsAccum: MessageSegment[] = [];

        try {
          for (let turn = 0; turn < MAX_TURNS; turn++) {
            // Bail out early if the client already disconnected
            if (abortController.signal.aborted) break;

            const piStream = deps.streamLLM(m, {
              systemPrompt: fullSystemPrompt,
              messages,
              tools: effectiveTools,
            }, { ...streamOpts, signal: abortController.signal });

            let turnText = "";
            let streamError: string | undefined;
            const toolCallPartials = new Map<number, { id: string; name: string; argumentsText: string }>();

            for await (const event of piStream) {
              if (abortController.signal.aborted) break;
              if (event.type === "thinking_delta") {
                appendThinkingSegment(segmentsAccum, event.delta);
                await emit(sseChunk(completionId, {}, null, { thinking: event.delta }));
              } else if (event.type === "text_delta") {
                turnText += event.delta;
                appendTextSegment(segmentsAccum, event.delta);
                await emit(sseChunk(completionId, { content: event.delta }));
              } else if (event.type === "toolcall_start") {
                // Emit early "preparing" signal — the LLM has started generating a tool call
                // but arguments are not yet complete. Lets the UI show immediate feedback.
                const block = event.partial.content[event.contentIndex] as
                  | { type: "toolCall"; id: string; name: string } | undefined;
                if (block?.type === "toolCall") {
                  ensureToolSegment(segmentsAccum, block.id);
                  toolCallPartials.set(event.contentIndex, { id: block.id, name: block.name, argumentsText: "" });
                  await emit(sseChunk(completionId, {}, null, {
                    tool_call: { id: block.id, name: block.name, state: "preparing" },
                  }));
                }
              } else if (event.type === "toolcall_delta") {
                const contentIndex = (event as any).contentIndex as number;
                const block = (event as any).partial?.content?.[contentIndex] as
                  | { type: "toolCall"; id: string; name: string } | undefined;
                let partial = toolCallPartials.get(contentIndex);
                if (!partial && block?.type === "toolCall") {
                  ensureToolSegment(segmentsAccum, block.id);
                  partial = { id: block.id, name: block.name, argumentsText: "" };
                  toolCallPartials.set(contentIndex, partial);
                }
                if (partial) {
                  partial.argumentsText += String((event as any).delta ?? "");
                  await emit(sseChunk(completionId, {}, null, {
                    tool_call: {
                      id: partial.id,
                      name: partial.name,
                      argumentsText: partial.argumentsText,
                      state: "preparing",
                    },
                  }));
                }
              } else if (event.type === "error") {
                streamError = (event as any).error?.errorMessage ?? "Model returned an error";
              }
            }

            // If aborted, stop the loop — skip error/tool processing
            if (abortController.signal.aborted) {
              finalText += turnText;
              break;
            }

            if (streamError) {
              finalText += `\n\nError: ${streamError}`;
              await emit(sseChunk(completionId, { content: `\n\nError: ${streamError}` }));
              break;
            }

            const response = await piStream.result();
            messages.push(response);
            finalText += turnText;

            const toolCalls = response.content.filter(
              (cc: any): cc is { type: "toolCall"; id: string; name: string; arguments: Record<string, any> } =>
                cc.type === "toolCall"
            );
            for (const call of toolCalls) {
              ensureToolSegment(segmentsAccum, call.id);
            }

            if (toolCalls.length === 0) break;

            // Check for interactive tools. Orchestrator has its full preview/input
            // set; agent-direct mode only gets UI-side tools supplied by deps.
            // NB: render_widget is NOT interactive — viene eseguito normalmente
            // nel for-loop sotto, emettendo widget_render come side-effect e
            // permettendo N widget per turn invece di uno solo.
            const interactiveCall = toolCalls.find((tc: any) => isInteractiveFn?.(tc.name));
            // Tool-call ids handled inline (per ora vuoto — niente skipIds da
            // questa branch dopo lo spostamento di render_widget al for-loop).
            const skipIds = new Set<string>();
            if (interactiveCall) {
              ensureToolSegment(segmentsAccum, interactiveCall.id);
              // Persist the interactive tool call so it survives session reload
              toolCallsAccum.push({
                id: interactiveCall.id,
                name: interactiveCall.name,
                arguments: interactiveCall.arguments,
                state: "interrupted",
              });

              if (interactiveCall.name === "ask_user") {
                const questions = (interactiveCall.arguments as any)?.questions as any[] ?? [];
                await emit(sseChunk(completionId, {}, "ask_user", { ask_user: { questions } }));
              } else if (interactiveCall.name === "create_mission") {
                const args = interactiveCall.arguments as Record<string, unknown>;
                let missionData: unknown;
                try { missionData = JSON.parse(args.data as string); } catch { missionData = args.data; }
                await emit(sseChunk(completionId, {}, "mission_preview", {
                  mission_preview: {
                    name: args.name as string,
                    data: missionData,
                    prompt: args.prompt as string | undefined,
                  },
                }));
              } else if (interactiveCall.name === "set_vault_entry") {
                const args = interactiveCall.arguments as Record<string, unknown>;
                await emit(sseChunk(completionId, {}, "vault_preview", {
                  vault_preview: {
                    agent: args.agent as string,
                    service: args.service as string,
                    type: args.type as string,
                    label: args.label as string | undefined,
                    credentials: args.credentials as Record<string, string>,
                  },
                }));
              } else if (interactiveCall.name === "open_file") {
                const args = interactiveCall.arguments as Record<string, unknown>;
                await emit(sseChunk(completionId, {}, "open_file", {
                  open_file: {
                    path: args.path as string,
                  },
                }));
              } else if (interactiveCall.name === "navigate_to") {
                const args = interactiveCall.arguments as Record<string, unknown>;
                await emit(sseChunk(completionId, {}, "navigate_to", {
                  navigate_to: {
                    target: args.target as string,
                    id: args.id as string | undefined,
                    name: args.name as string | undefined,
                    path: args.path as string | undefined,
                    highlight: args.highlight as string | undefined,
                  },
                }));
              } else if (interactiveCall.name === "open_tab") {
                const args = interactiveCall.arguments as Record<string, unknown>;
                await emit(sseChunk(completionId, {}, "open_tab", {
                  open_tab: {
                    url: args.url as string,
                    label: args.label as string | undefined,
                  },
                }));
              } else if (interactiveCall.name === "set_design") {
                const args = interactiveCall.arguments as Record<string, unknown>;
                await emit(sseChunk(completionId, {}, "set_design", {
                  set_design: {
                    enabled: args.enabled as boolean | undefined,
                    light: args.light as Record<string, unknown> | undefined,
                    dark: args.dark as Record<string, unknown> | undefined,
                    primary: args.primary as string | undefined,
                    secondary: args.secondary as string | undefined,
                    text: args.text as string | undefined,
                    radius: args.radius as number | undefined,
                    fontFamily: args.fontFamily as string | undefined,
                  },
                }));
              } else if (interactiveCall.name === "whatsapp_send") {
                // Side-effect gate: emit a preview chunk so the UI can
                // show the outbound text + recipient and require explicit
                // confirmation before the message actually goes out.
                // After confirmation the UI POSTs /api/v1/whatsapp/send.
                const args = interactiveCall.arguments as Record<string, unknown>;
                await emit(sseChunk(completionId, {}, "whatsapp_preview", {
                  whatsapp_preview: {
                    kind: "text",
                    to: args.to as string,
                    message: args.message as string,
                  },
                }));
              } else if (interactiveCall.name === "whatsapp_send_file") {
                const args = interactiveCall.arguments as Record<string, unknown>;
                await emit(sseChunk(completionId, {}, "whatsapp_preview", {
                  whatsapp_preview: {
                    kind: "file",
                    to: args.to as string,
                    path: args.path as string,
                    caption: args.caption as string | undefined,
                    mediaKind: args.mediaKind as string | undefined,
                    mimeType: args.mimeType as string | undefined,
                    fileName: args.fileName as string | undefined,
                    viewOnce: args.viewOnce as boolean | undefined,
                  },
                }));
              } else if (interactiveCall.name === "email_send") {
                // Side-effect gate: emit a preview chunk so the UI can
                // show the outbound email and require explicit
                // confirmation before SMTP fires. The REST handler still
                // re-validates emailAllowedDomains at send time — the
                // preview UI is NOT a security boundary, only a UX gate.
                const args = interactiveCall.arguments as Record<string, unknown>;
                await emit(sseChunk(completionId, {}, "email_preview", {
                  email_preview: {
                    to: args.to,
                    subject: args.subject as string,
                    body: args.body as string,
                    html: args.html as boolean | undefined,
                    cc: args.cc,
                    bcc: args.bcc,
                    from: args.from as string | undefined,
                    reply_to: args.reply_to as string | undefined,
                    attachments: args.attachments as Array<{ path: string; filename?: string }> | undefined,
                  },
                }));
              }
              await emit("[DONE]");
              return; // finally block will persist whatever finalText we have
            }

            for (const call of toolCalls) {
              // Stop executing tools if client disconnected
              if (abortController.signal.aborted) break;
              // Skip calls that were already handled inline (e.g. render_widget validation failure).
              if (skipIds.has(call.id)) continue;
              ensureToolSegment(segmentsAccum, call.id);

              // Notify client that a tool is being called
              await emit(sseChunk(completionId, {}, null, {
                tool_call: { id: call.id, name: call.name, arguments: call.arguments, state: "calling" },
              }));

              // ── set_session_title intercept ──
              // Server-side rename: doesn't need the executor (orchestrator
              // / agent path agnostic). Validates input, hits the session
              // store directly, emits a `session_title` SSE chunk so the
              // sidebar refreshes in real time. Result text is fed back to
              // the model so it knows the rename succeeded.
              if (call.name === "set_session_title") {
                const args = (call.arguments ?? {}) as Record<string, unknown>;
                const raw = typeof args.title === "string" ? args.title : "";
                const title = raw.trim().slice(0, 80);
                let resultText: string;
                let isErr = false;
                if (!title) {
                  resultText = "Error: title must be a non-empty string.";
                  isErr = true;
                } else if (!sessionId) {
                  resultText = "Error: no session in context — cannot rename.";
                  isErr = true;
                } else if (!sessionStore) {
                  resultText = "Error: session store unavailable.";
                  isErr = true;
                } else {
                  try {
                    const ok = await sessionStore.renameSession(sessionId, title);
                    if (ok) {
                      resultText = `Session title set to: "${title}".`;
                      await emit(sseChunk(completionId, {}, null, {
                        session_title: { sessionId, title },
                      }));
                    } else {
                      resultText = "Error: session not found.";
                      isErr = true;
                    }
                  } catch (e: any) {
                    resultText = `Error: ${e?.message ?? "rename failed"}`;
                    isErr = true;
                  }
                }
                toolCallsAccum.push({
                  id: call.id,
                  name: call.name,
                  arguments: call.arguments,
                  result: resultText,
                  state: isErr ? "error" : "completed",
                });
                if (!abortController.signal.aborted) {
                  await emit(sseChunk(completionId, {}, null, {
                    tool_call: { id: call.id, name: call.name, result: resultText, state: isErr ? "error" : "completed" },
                  }));
                }
                messages.push({
                  role: "toolResult",
                  toolCallId: call.id,
                  toolName: call.name,
                  content: [{ type: "text", text: resultText }],
                  isError: isErr,
                  timestamp: Date.now(),
                });
                continue;
              }

              const result = await effectiveToolExecutor(call.name, call.arguments);
              const isError = result.startsWith("Error:");
              emitFileChanged(call.name, call.arguments, result, deps.emit);

              // render_widget side-effect: emit widget_render chunk so the
              // client renders the HTML widget inline. Non blocca il turn —
              // il modello continua a generare prose / chiamare altri tool /
              // emettere altri widget. validateRenderWidgetArgs è già stato
              // applicato dentro effectiveToolExecutor (se invalid, result
              // inizia con "Error:" e isError = true → skippiamo l'emit).
              if (call.name === "render_widget" && !isError) {
                const args = call.arguments as Record<string, unknown>;
                await emit(sseChunk(completionId, {}, null, {
                  widget_render: {
                    html: args.html as string,
                    title: (args.title as string | undefined) ?? null,
                    description: (args.description as string | undefined) ?? null,
                    chrome: (args.chrome as boolean | undefined) ?? true,
                    stream: (args.stream as boolean | undefined) ?? false,
                  },
                }));
              }

              // Accumulate for persistence
              toolCallsAccum.push({
                id: call.id,
                name: call.name,
                arguments: call.arguments,
                result,
                state: isError ? "error" : "completed",
              });

              // Notify client with tool result (skip if aborted mid-tool)
              if (!abortController.signal.aborted) {
                await emit(sseChunk(completionId, {}, null, {
                  tool_call: { id: call.id, name: call.name, result, state: isError ? "error" : "completed" },
                }));
              }

              messages.push({
                role: "toolResult",
                toolCallId: call.id,
                toolName: call.name,
                content: [{ type: "text", text: result }],
                isError,
                timestamp: Date.now(),
              });
            }
          }

          if (!abortController.signal.aborted) {
            await emit(sseChunk(completionId, {}, "stop"));
            await emit("[DONE]");
          }
        } catch (err) {
          // Suppress AbortError — expected when explicit user abort fires
          if (!(err instanceof DOMException && err.name === "AbortError") && !abortController.signal.aborted) {
            // Surface to subscribers so resume clients see the failure
            streamRegistry.error(turnId, (err as Error)?.message ?? "stream failed");
            throw err;
          }
        } finally {
          // Mark the registry entry as done so resume subscribers terminate
          // cleanly. abort() may already have flipped the status — complete()
          // is a no-op in that case.
          streamRegistry.complete(turnId);

          // Always persist the assistant response — even on disconnect.
          // SECURITY: Redact vault credentials before persisting to SQLite
          const safeToolCalls = redactVaultToolCalls(toolCallsAccum);
          if (sessionStore && sessionId && assistantMsgId) {
            await persistAssistantMessage(sessionStore, sessionId, assistantMsgId, finalText, safeToolCalls, segmentsAccum);
          }
        }
      }) as any;
    } else {
      // ── Non-streaming mode ──
      // Reserve placeholder so the message is visible even if the request is interrupted
      let assistantMsgId: string | null = null;
      if (sessionStore && sessionId) {
        const placeholder = await sessionStore.addMessage(sessionId, "assistant", "");
        assistantMsgId = placeholder.id;
      }

      const messages: any[] = [...piMessages];
      let finalText = "";
      const toolCallsAccum: any[] = [];
      const segmentsAccum: MessageSegment[] = [];

      try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const piStream = deps.streamLLM(m, {
            systemPrompt: fullSystemPrompt,
            messages,
            tools: effectiveTools,
          }, streamOpts);

          let turnText = "";
          let streamError: string | undefined;
          for await (const event of piStream) {
            if (event.type === "text_delta") {
              turnText += event.delta;
              appendTextSegment(segmentsAccum, event.delta);
            } else if (event.type === "thinking_delta") {
              appendThinkingSegment(segmentsAccum, event.delta);
            } else if (event.type === "error") {
              streamError = (event as any).error?.errorMessage ?? "Model returned an error";
            }
          }

          if (streamError) {
            return c.json({ error: { message: streamError, type: "upstream_error" } }, 502 as any);
          }

          const response = await piStream.result();
          messages.push(response);
          finalText += turnText;

          const toolCalls = response.content.filter(
            (cc: any): cc is { type: "toolCall"; id: string; name: string; arguments: Record<string, any> } =>
              cc.type === "toolCall"
          );
          for (const call of toolCalls) {
            ensureToolSegment(segmentsAccum, call.id);
          }

          if (toolCalls.length === 0) break;

          // Check for interactive tools. Orchestrator has its full preview/input
          // set; agent-direct mode only gets UI-side tools supplied by deps.
          let interactiveCall = toolCalls.find((tc: any) => isInteractiveFn?.(tc.name));
          // Tool-call ids that have already been handled inline (e.g. failed widget
          // validation) and must NOT be re-executed by the trailing for-loop.
          const skipIds = new Set<string>();
          // render_widget: validate args BEFORE returning the intercept response.
          // Invalid args fall through to the regular tool-execution path so the
          // model can see the error and retry within the same turn.
          if (interactiveCall?.name === "render_widget") {
            const widgetValidationError = validateRenderWidgetArgs(interactiveCall.arguments);
            if (widgetValidationError) {
              ensureToolSegment(segmentsAccum, interactiveCall.id);
              toolCallsAccum.push({
                id: interactiveCall.id,
                name: interactiveCall.name,
                arguments: interactiveCall.arguments,
                result: widgetValidationError,
                state: "error",
              });
              messages.push({
                role: "toolResult",
                toolCallId: interactiveCall.id,
                toolName: interactiveCall.name,
                content: [{ type: "text", text: widgetValidationError }],
                isError: true,
                timestamp: Date.now(),
              });
              skipIds.add(interactiveCall.id);
              interactiveCall = undefined;
            }
          }
          if (interactiveCall) {
            ensureToolSegment(segmentsAccum, interactiveCall.id);
            // Persist the interactive tool call so it survives session reload
            toolCallsAccum.push({
              id: interactiveCall.id,
              name: interactiveCall.name,
              arguments: interactiveCall.arguments,
              state: "interrupted",
            });

            const baseResponse = {
              id: completionId,
              object: "chat.completion" as const,
              created: Math.floor(Date.now() / 1000),
              model: "polpo" as const,
              usage: {
                prompt_tokens: Math.ceil(fullSystemPrompt.length / 4),
                completion_tokens: Math.ceil(finalText.length / 4),
                total_tokens: Math.ceil(fullSystemPrompt.length / 4) + Math.ceil(finalText.length / 4),
              },
            };

            if (interactiveCall.name === "ask_user") {
              const questions = (interactiveCall.arguments as any)?.questions as any[] ?? [];
              return c.json({
                ...baseResponse,
                choices: [{
                  index: 0,
                  message: { role: "assistant" as const, content: finalText },
                  finish_reason: "ask_user" as const,
                  ask_user: { questions },
                }],
              });
            }

            if (interactiveCall.name === "create_mission") {
              const args = interactiveCall.arguments as Record<string, unknown>;
              let missionData: unknown;
              try { missionData = JSON.parse(args.data as string); } catch { missionData = args.data; }
              return c.json({
                ...baseResponse,
                choices: [{
                  index: 0,
                  message: { role: "assistant" as const, content: finalText },
                  finish_reason: "mission_preview" as const,
                  mission_preview: {
                    name: args.name as string,
                    data: missionData,
                    prompt: args.prompt as string | undefined,
                  },
                }],
              });
            }

            if (interactiveCall.name === "set_vault_entry") {
              const args = interactiveCall.arguments as Record<string, unknown>;
              return c.json({
                ...baseResponse,
                choices: [{
                  index: 0,
                  message: { role: "assistant" as const, content: finalText },
                  finish_reason: "vault_preview" as const,
                  vault_preview: {
                    agent: args.agent as string,
                    service: args.service as string,
                    type: args.type as string,
                    label: args.label as string | undefined,
                    credentials: args.credentials as Record<string, string>,
                  },
                }],
              });
            }

            if (interactiveCall.name === "open_file") {
              const args = interactiveCall.arguments as Record<string, unknown>;
              return c.json({
                ...baseResponse,
                choices: [{
                  index: 0,
                  message: { role: "assistant" as const, content: finalText },
                  finish_reason: "open_file" as const,
                  open_file: {
                    path: args.path as string,
                  },
                }],
              });
            }

            if (interactiveCall.name === "navigate_to") {
              const args = interactiveCall.arguments as Record<string, unknown>;
              return c.json({
                ...baseResponse,
                choices: [{
                  index: 0,
                  message: { role: "assistant" as const, content: finalText },
                  finish_reason: "navigate_to" as const,
                  navigate_to: {
                    target: args.target as string,
                    id: args.id as string | undefined,
                    name: args.name as string | undefined,
                    path: args.path as string | undefined,
                    highlight: args.highlight as string | undefined,
                  },
                }],
              });
            }

            if (interactiveCall.name === "open_tab") {
              const args = interactiveCall.arguments as Record<string, unknown>;
              return c.json({
                ...baseResponse,
                choices: [{
                  index: 0,
                  message: { role: "assistant" as const, content: finalText },
                  finish_reason: "open_tab" as const,
                  open_tab: {
                    url: args.url as string,
                    label: args.label as string | undefined,
                  },
                }],
              });
            }

            if (interactiveCall.name === "set_design") {
              const args = interactiveCall.arguments as Record<string, unknown>;
              return c.json({
                ...baseResponse,
                choices: [{
                  index: 0,
                  message: { role: "assistant" as const, content: finalText },
                  finish_reason: "set_design" as const,
                  set_design: {
                    enabled: args.enabled as boolean | undefined,
                    light: args.light as Record<string, unknown> | undefined,
                    dark: args.dark as Record<string, unknown> | undefined,
                    primary: args.primary as string | undefined,
                    secondary: args.secondary as string | undefined,
                    text: args.text as string | undefined,
                    radius: args.radius as number | undefined,
                    fontFamily: args.fontFamily as string | undefined,
                  },
                }],
              });
            }

            if (interactiveCall.name === "render_widget") {
              const args = interactiveCall.arguments as Record<string, unknown>;
              return c.json({
                ...baseResponse,
                choices: [{
                  index: 0,
                  message: { role: "assistant" as const, content: finalText },
                  finish_reason: "widget_render" as const,
                  widget_render: {
                    html: args.html as string,
                    title: (args.title as string | undefined) ?? null,
                    description: (args.description as string | undefined) ?? null,
                    chrome: (args.chrome as boolean | undefined) ?? true,
                    stream: (args.stream as boolean | undefined) ?? false,
                  },
                }],
              });
            }

            if (interactiveCall.name === "whatsapp_send") {
              const args = interactiveCall.arguments as Record<string, unknown>;
              return c.json({
                ...baseResponse,
                choices: [{
                  index: 0,
                  message: { role: "assistant" as const, content: finalText },
                  finish_reason: "whatsapp_preview" as const,
                  whatsapp_preview: {
                    kind: "text",
                    to: args.to as string,
                    message: args.message as string,
                  },
                }],
              });
            }

            if (interactiveCall.name === "whatsapp_send_file") {
              const args = interactiveCall.arguments as Record<string, unknown>;
              return c.json({
                ...baseResponse,
                choices: [{
                  index: 0,
                  message: { role: "assistant" as const, content: finalText },
                  finish_reason: "whatsapp_preview" as const,
                  whatsapp_preview: {
                    kind: "file",
                    to: args.to as string,
                    path: args.path as string,
                    caption: args.caption as string | undefined,
                    mediaKind: args.mediaKind as string | undefined,
                    mimeType: args.mimeType as string | undefined,
                    fileName: args.fileName as string | undefined,
                    viewOnce: args.viewOnce as boolean | undefined,
                  },
                }],
              });
            }

            if (interactiveCall.name === "email_send") {
              const args = interactiveCall.arguments as Record<string, unknown>;
              return c.json({
                ...baseResponse,
                choices: [{
                  index: 0,
                  message: { role: "assistant" as const, content: finalText },
                  finish_reason: "email_preview" as const,
                  email_preview: {
                    to: args.to,
                    subject: args.subject as string,
                    body: args.body as string,
                    html: args.html as boolean | undefined,
                    cc: args.cc,
                    bcc: args.bcc,
                    from: args.from as string | undefined,
                    reply_to: args.reply_to as string | undefined,
                    attachments: args.attachments as Array<{ path: string; filename?: string }> | undefined,
                  },
                }],
              });
            }
            // Note: finally block persists finalText + toolCallsAccum
          }

          for (const call of toolCalls) {
            if (skipIds.has(call.id)) continue;
            ensureToolSegment(segmentsAccum, call.id);
            const result = await effectiveToolExecutor(call.name, call.arguments);
            const isError = result.startsWith("Error:");
            emitFileChanged(call.name, call.arguments, result, deps.emit);

            // Accumulate for persistence
            toolCallsAccum.push({
              id: call.id,
              name: call.name,
              arguments: call.arguments,
              result,
              state: isError ? "error" : "completed",
            });

            messages.push({
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: "text", text: result }],
              isError,
              timestamp: Date.now(),
            });
          }
        }

        const promptTokens = Math.ceil(fullSystemPrompt.length / 4);
        const completionTokens = Math.ceil(finalText.length / 4);
        return c.json(completionResponse(completionId, finalText, promptTokens, completionTokens));
      } finally {
        // Always persist the final text + tool calls — even on early return (ask_user) or error
        // SECURITY: Redact vault credentials before persisting to SQLite
        const safeToolCalls = redactVaultToolCalls(toolCallsAccum);
        if (sessionStore && sessionId && assistantMsgId) {
          await persistAssistantMessage(sessionStore, sessionId, assistantMsgId, finalText, safeToolCalls, segmentsAccum);
        }
      }
    }
  });

  // ── Resumable streaming endpoints ──────────────────────────────────────
  //
  // GET  /resume/:turnId       — replay buffered deltas + tail until done
  // POST /abort/:turnId        — explicit user cancel (kills LLM call)
  // GET  /active-turn          — query: ?sessionId=X — returns live turnId, if any
  //
  // These complement the POST root that opens new streams. A client that
  // disconnects mid-stream can come back to /resume/:turnId and pick up
  // exactly where it left off.

  app.get("/resume/:turnId", async (c) => {
    if (apiKeys && apiKeys.length > 0) {
      const auth = c.req.header("Authorization");
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      if (!token || !apiKeys.includes(token)) {
        return c.json({ error: { message: "Invalid API key", type: "invalid_request_error" } }, 401);
      }
    }

    const turnId = c.req.param("turnId");
    const entry = streamRegistry.get(turnId);
    if (!entry) {
      return c.json({ error: { message: "Turn not found or expired", type: "invalid_request_error" } }, 404);
    }

    return streamSSE(c, async (stream) => {
      let clientGone = false;
      stream.onAbort(() => { clientGone = true; });

      const safeWrite = async (data: string) => {
        if (clientGone) return;
        try { await stream.writeSSE({ data }); } catch { clientGone = true; }
      };

      // Pump events from registry → this client. Replay first (subscribe
      // calls push synchronously for the existing buffer), then live tail.
      let done = false;
      const pending: Array<Promise<void>> = [];
      const unsubscribe = streamRegistry.subscribe(turnId, {
        push: (ev) => {
          pending.push(safeWrite(ev.data));
        },
        finish: () => {
          done = true;
        },
      });

      // Wait until the entry finishes or the client leaves. Polling is
      // light here — most of the wait time is sleep, not CPU.
      while (!done && !clientGone) {
        if (pending.length > 0) {
          await Promise.all(pending.splice(0));
        } else {
          await new Promise<void>((r) => setTimeout(r, 25));
        }
      }
      // Drain any final writes
      if (pending.length > 0) {
        try { await Promise.all(pending.splice(0)); } catch { /* ignore */ }
      }

      if (unsubscribe) unsubscribe();
    }) as any;
  });

  app.post("/abort/:turnId", async (c) => {
    if (apiKeys && apiKeys.length > 0) {
      const auth = c.req.header("Authorization");
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      if (!token || !apiKeys.includes(token)) {
        return c.json({ error: { message: "Invalid API key", type: "invalid_request_error" } }, 401);
      }
    }
    const turnId = c.req.param("turnId");
    const ok = streamRegistry.abort(turnId);
    if (!ok) {
      return c.json({ ok: false, error: "Turn not found or already finished" }, 404);
    }
    return c.json({ ok: true });
  });

  app.get("/active-turn", async (c) => {
    if (apiKeys && apiKeys.length > 0) {
      const auth = c.req.header("Authorization");
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      if (!token || !apiKeys.includes(token)) {
        return c.json({ error: { message: "Invalid API key", type: "invalid_request_error" } }, 401);
      }
    }
    const sessionId = c.req.query("sessionId");
    if (!sessionId) {
      return c.json({ ok: false, error: "sessionId is required" }, 400);
    }
    const turnId = streamRegistry.getActiveTurnForSession(sessionId);
    return c.json({ ok: true, data: { turnId: turnId ?? null } });
  });

  return app;
}
