/**
 * OpenAI-compatible chat completions endpoint.
 *
 * POST /v1/chat/completions
 *
 * This is Polpo's primary conversational interface. It accepts OpenAI-format
 * messages, runs the full agentic tool loop internally (37 tools), and returns
 * responses in OpenAI-compatible format — both streaming (SSE) and non-streaming.
 *
 * The caller talks to Polpo. Polpo decides when and how to use its tools.
 * Tools are NOT exposed to the caller.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { nanoid } from "nanoid";
import type { Orchestrator } from "../../core/orchestrator.js";
import { buildChatSystemPrompt } from "../../llm/prompts.js";
import { resolveModel, resolveApiKeyAsync, resolveModelSpec, buildStreamOpts } from "../../llm/pi-client.js";
import { streamSimple, type Message } from "@mariozechner/pi-ai";
import {
  ALL_ORCHESTRATOR_TOOLS,
  executeOrchestratorTool,
  isInteractive,
} from "../../llm/orchestrator-tools.js";
import type { AskUserQuestion } from "../../core/types.js";
import type { ToolCallInfo } from "../../core/session-store.js";

const MAX_TURNS = 20;

/**
 * Redact sensitive credential values from vault tool call arguments before persistence.
 * Returns a sanitized copy — original is NOT mutated.
 */
function redactVaultToolCalls(toolCalls: ToolCallInfo[]): ToolCallInfo[] {
  return toolCalls.map(tc => {
    if (tc.name !== "set_vault_entry" || !tc.arguments) return tc;
    const args = { ...tc.arguments };
    if (args.credentials && typeof args.credentials === "object") {
      // Replace each credential value with a redacted marker, preserve keys for display
      const redacted: Record<string, string> = {};
      for (const key of Object.keys(args.credentials as Record<string, string>)) {
        redacted[key] = "[REDACTED]";
      }
      args.credentials = redacted;
    }
    return { ...tc, arguments: args };
  });
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
    description: "Ignored. Polpo uses its configured orchestrator model.",
  }),
  temperature: z.number().optional().openapi({
    description: "Ignored. Reserved for future use.",
  }),
  max_tokens: z.number().int().optional().openapi({
    description: "Ignored. Reserved for future use.",
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
    finish_reason: z.enum(["stop", "length", "ask_user", "mission_preview", "vault_preview"]),
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
  summary: "Talk to Polpo (OpenAI-compatible)",
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

function convertMessages(messages: z.infer<typeof messageSchema>[]): { piMessages: Message[]; extraSystemParts: string[] } {
  const piMessages: Message[] = [];
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

export function completionRoutes(orchestrator: Orchestrator, apiKeys?: string[]): OpenAPIHono {
  const app = new OpenAPIHono();

  app.openapi(chatCompletionsRoute, async (c) => {
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

    // ── Build context ──
    const state = (() => {
      try { return orchestrator.getStore()?.getState() ?? null; }
      catch { return null; }
    })();

    const systemPrompt = buildChatSystemPrompt(orchestrator, state);
    const { piMessages, extraSystemParts } = convertMessages(body.messages);
    const fullSystemPrompt = extraSystemParts.length > 0
      ? `${systemPrompt}\n\n## Additional context from caller\n\n${extraSystemParts.join("\n\n")}`
      : systemPrompt;

    // ── Resolve model ──
    const settings = orchestrator.getConfig()?.settings;
    const modelSpec = resolveModelSpec(settings?.orchestratorModel);
    const m = resolveModel(modelSpec);
    const apiKey = await resolveApiKeyAsync(m.provider as string);
    const reasoning = settings?.reasoning;
    const streamOpts = buildStreamOpts(apiKey, reasoning);

    const completionId = `chatcmpl-${nanoid(24)}`;

    // ── Session persistence ──
    const sessionStore = orchestrator.getSessionStore();
    let sessionId: string | null = c.req.header("x-session-id") ?? null;
    if (sessionStore) {
      if (!sessionId) {
        // Reuse latest session if recent (< 30 min), otherwise create new
        const latest = sessionStore.getLatestSession();
        const timeout = 30 * 60 * 1000;
        if (latest && Date.now() - new Date(latest.updatedAt).getTime() < timeout) {
          sessionId = latest.id;
        } else {
          const firstUserMsg = body.messages.find(m => m.role === "user");
          sessionId = sessionStore.create(firstUserMsg ? extractText(firstUserMsg.content).slice(0, 60) : undefined);
        }
      }
      // Persist user message (only the last one — earlier messages are already persisted)
      const lastUserMsg = [...body.messages].reverse().find(m => m.role === "user");
      if (lastUserMsg && sessionId) {
        sessionStore.addMessage(sessionId, "user", extractText(lastUserMsg.content));
      }
    }

    // Expose session ID to the client so it can track which session is active
    if (sessionId) {
      c.header("x-session-id", sessionId);
    }

    if (body.stream) {
      // ── Streaming mode ──
      return streamSSE(c, async (stream) => {
        // Abort controller: cancelled when the client disconnects (closes SSE)
        const abortController = new AbortController();
        stream.onAbort(() => { abortController.abort(); });

        await stream.writeSSE({ data: sseChunk(completionId, { role: "assistant" }) });

        // Reserve a placeholder message in the store BEFORE streaming.
        // This guarantees the assistant message exists even if the client disconnects.
        let assistantMsgId: string | null = null;
        if (sessionStore && sessionId) {
          const placeholder = sessionStore.addMessage(sessionId, "assistant", "");
          assistantMsgId = placeholder.id;
        }

        const messages: Message[] = [...piMessages];
        let finalText = "";
        const toolCallsAccum: ToolCallInfo[] = [];

        try {
          for (let turn = 0; turn < MAX_TURNS; turn++) {
            // Bail out early if the client already disconnected
            if (abortController.signal.aborted) break;

            const piStream = streamSimple(m, {
              systemPrompt: fullSystemPrompt,
              messages,
              tools: ALL_ORCHESTRATOR_TOOLS,
            }, { ...streamOpts, signal: abortController.signal });

            let turnText = "";
            let streamError: string | undefined;

            for await (const event of piStream) {
              if (abortController.signal.aborted) break;
              if (event.type === "text_delta") {
                turnText += event.delta;
                await stream.writeSSE({ data: sseChunk(completionId, { content: event.delta }) });
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
              await stream.writeSSE({ data: sseChunk(completionId, { content: `\n\nError: ${streamError}` }) });
              break;
            }

            const response = await piStream.result();
            messages.push(response);
            finalText += turnText;

            const toolCalls = response.content.filter(
              (cc): cc is { type: "toolCall"; id: string; name: string; arguments: Record<string, any> } =>
                cc.type === "toolCall"
            );

            if (toolCalls.length === 0) break;

            // Check for interactive tools — intercept and pause the stream
            const interactiveCall = toolCalls.find(tc => isInteractive(tc.name));
            if (interactiveCall) {
              // Persist the interactive tool call so it survives session reload
              toolCallsAccum.push({
                id: interactiveCall.id,
                name: interactiveCall.name,
                arguments: interactiveCall.arguments,
                state: "interrupted",
              });

              if (interactiveCall.name === "ask_user") {
                const questions = (interactiveCall.arguments as any)?.questions as AskUserQuestion[] ?? [];
                await stream.writeSSE({
                  data: sseChunk(completionId, {}, "ask_user", { ask_user: { questions } }),
                });
              } else if (interactiveCall.name === "create_mission") {
                const args = interactiveCall.arguments as Record<string, unknown>;
                let missionData: unknown;
                try { missionData = JSON.parse(args.data as string); } catch { missionData = args.data; }
                await stream.writeSSE({
                  data: sseChunk(completionId, {}, "mission_preview", {
                    mission_preview: {
                      name: args.name as string,
                      data: missionData,
                      prompt: args.prompt as string | undefined,
                    },
                  }),
                });
              } else if (interactiveCall.name === "set_vault_entry") {
                const args = interactiveCall.arguments as Record<string, unknown>;
                await stream.writeSSE({
                  data: sseChunk(completionId, {}, "vault_preview", {
                    vault_preview: {
                      agent: args.agent as string,
                      service: args.service as string,
                      type: args.type as string,
                      label: args.label as string | undefined,
                      credentials: args.credentials as Record<string, string>,
                    },
                  }),
                });
              }
              await stream.writeSSE({ data: "[DONE]" });
              return; // finally block will persist whatever finalText we have
            }

            for (const call of toolCalls) {
              // Stop executing tools if client disconnected
              if (abortController.signal.aborted) break;

              // Notify client that a tool is being called
              await stream.writeSSE({
                data: sseChunk(completionId, {}, null, {
                  tool_call: { id: call.id, name: call.name, arguments: call.arguments, state: "calling" },
                }),
              });

              const result = await executeOrchestratorTool(call.name, call.arguments, orchestrator);
              const isError = result.startsWith("Error:");

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
                await stream.writeSSE({
                  data: sseChunk(completionId, {}, null, {
                    tool_call: { id: call.id, name: call.name, result, state: isError ? "error" : "completed" },
                  }),
                });
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
            await stream.writeSSE({ data: sseChunk(completionId, {}, "stop") });
            await stream.writeSSE({ data: "[DONE]" });
          }
        } catch (err) {
          // Suppress AbortError — expected when client disconnects
          if (!(err instanceof DOMException && err.name === "AbortError") && !abortController.signal.aborted) {
            throw err;
          }
        } finally {
          // Always persist the assistant response — even on disconnect.
          // SECURITY: Redact vault credentials before persisting to SQLite
          const safeToolCalls = redactVaultToolCalls(toolCallsAccum);
          if (sessionStore && sessionId && assistantMsgId) {
            if (finalText.trim()) {
              sessionStore.updateMessage(sessionId, assistantMsgId, finalText.trim(), safeToolCalls);
            }
            // If finalText is empty (LLM never responded), remove the empty placeholder
            // by setting content to a marker that indicates an interrupted response
            else {
              sessionStore.updateMessage(sessionId, assistantMsgId, "[Response interrupted]", safeToolCalls);
            }
          }
        }
      }) as any;
    } else {
      // ── Non-streaming mode ──
      // Reserve placeholder so the message is visible even if the request is interrupted
      let assistantMsgId: string | null = null;
      if (sessionStore && sessionId) {
        const placeholder = sessionStore.addMessage(sessionId, "assistant", "");
        assistantMsgId = placeholder.id;
      }

      const messages: Message[] = [...piMessages];
      let finalText = "";
      const toolCallsAccum: ToolCallInfo[] = [];

      try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const piStream = streamSimple(m, {
            systemPrompt: fullSystemPrompt,
            messages,
            tools: ALL_ORCHESTRATOR_TOOLS,
          }, streamOpts);

          let turnText = "";
          let streamError: string | undefined;
          for await (const event of piStream) {
            if (event.type === "text_delta") {
              turnText += event.delta;
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
            (cc): cc is { type: "toolCall"; id: string; name: string; arguments: Record<string, any> } =>
              cc.type === "toolCall"
          );

          if (toolCalls.length === 0) break;

          // Check for interactive tools — return control to client
          const interactiveCall = toolCalls.find(tc => isInteractive(tc.name));
          if (interactiveCall) {
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
              const questions = (interactiveCall.arguments as any)?.questions as AskUserQuestion[] ?? [];
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
            // Note: finally block persists finalText + toolCallsAccum
          }

          for (const call of toolCalls) {
            const result = await executeOrchestratorTool(call.name, call.arguments, orchestrator);
            const isError = result.startsWith("Error:");

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
          if (finalText.trim()) {
            sessionStore.updateMessage(sessionId, assistantMsgId, finalText.trim(), safeToolCalls);
          } else {
            sessionStore.updateMessage(sessionId, assistantMsgId, "[Response interrupted]", safeToolCalls);
          }
        }
      }
    }
  });

  return app;
}
