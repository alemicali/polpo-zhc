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
import { resolveModel, resolveApiKeyAsync, resolveModelSpec } from "../../llm/pi-client.js";
import { streamSimple, type Message } from "@mariozechner/pi-ai";
import {
  ALL_ORCHESTRATOR_TOOLS,
  executeOrchestratorTool,
} from "../../llm/orchestrator-tools.js";

const MAX_TURNS = 20;

// ── Zod Schemas ────────────────────────────────────────────────────────

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]).openapi({
    description: "Message role. System messages are appended as additional context (Polpo has its own system prompt).",
  }),
  content: z.string().openapi({ description: "Message content" }),
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
    finish_reason: z.enum(["stop", "length"]),
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

function convertMessages(messages: z.infer<typeof messageSchema>[]): { piMessages: Message[]; extraSystemParts: string[] } {
  const piMessages: Message[] = [];
  const extraSystemParts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      extraSystemParts.push(msg.content);
    } else if (msg.role === "user") {
      piMessages.push({ role: "user", content: msg.content, timestamp: Date.now() });
    } else if (msg.role === "assistant") {
      piMessages.push({
        role: "user",
        content: `[Previous assistant response]\n${msg.content}\n[End previous response]`,
        timestamp: Date.now(),
      });
    }
  }

  return { piMessages, extraSystemParts };
}

function sseChunk(id: string, delta: { content?: string; role?: string }, finishReason: string | null = null): string {
  return JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "polpo",
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason,
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
    const modelSpec = resolveModelSpec(orchestrator.getConfig()?.settings?.orchestratorModel);
    const m = resolveModel(modelSpec);
    const apiKey = await resolveApiKeyAsync(m.provider as string);
    const streamOpts = apiKey ? { apiKey } : undefined;

    const completionId = `chatcmpl-${nanoid(24)}`;

    if (body.stream) {
      // ── Streaming mode ──
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({ data: sseChunk(completionId, { role: "assistant" }) });

        const messages: Message[] = [...piMessages];
        let finalText = "";

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
              await stream.writeSSE({ data: sseChunk(completionId, { content: event.delta }) });
            } else if (event.type === "error") {
              streamError = (event as any).error?.errorMessage ?? "Model returned an error";
            }
          }

          if (streamError) {
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

          for (const call of toolCalls) {
            const result = executeOrchestratorTool(call.name, call.arguments, orchestrator);
            messages.push({
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: "text", text: result }],
              isError: result.startsWith("Error:"),
              timestamp: Date.now(),
            });
          }
        }

        await stream.writeSSE({ data: sseChunk(completionId, {}, "stop") });
        await stream.writeSSE({ data: "[DONE]" });
      }) as any;
    } else {
      // ── Non-streaming mode ──
      const messages: Message[] = [...piMessages];
      let finalText = "";

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

        for (const call of toolCalls) {
          const result = executeOrchestratorTool(call.name, call.arguments, orchestrator);
          messages.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: result }],
            isError: result.startsWith("Error:"),
            timestamp: Date.now(),
          });
        }
      }

      const promptTokens = Math.ceil(fullSystemPrompt.length / 4);
      const completionTokens = Math.ceil(finalText.length / 4);
      return c.json(completionResponse(completionId, finalText, promptTokens, completionTokens));
    }
  });

  return app;
}
