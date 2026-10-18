/**
 * Inbound voice channel — a smart speaker's voice provider (e.g. ElevenLabs Agents configured
 * with a "custom LLM") asks an agent for the next thing to say, OpenAI-style.
 *
 * POST /api/v1/channels/:name/voice/chat/completions
 *   Auth:    "Authorization: Bearer <inboundSecret>" (or "X-Polpo-Secret: <inboundSecret>").
 *   Headers: "X-Polpo-Peer: <device id>"            which speaker is talking (required)
 *            "X-Polpo-Error-Text: <sentence>"       optional apology spoken if the turn fails
 *            "X-Polpo-Language: <it|en|...>"        optional, language of the courtesy fillers
 *                                                   ("let me look it up…") spoken during long waits
 *            "X-Polpo-Message-Id: <id>"             optional, for idempotent retries
 *   Body:    an OpenAI chat completion request. Only the last user message is used: the
 *            conversation lives in Polpo's own session for the device (the provider's history
 *            is per call and would miss what was said in earlier sessions).
 *   Reply:   text/event-stream of chat.completion.chunk with only the words to speak
 *            (stream: false returns one chat.completion).
 *
 * A new utterance stops the answer still running for the same device (barge-in), and a caller
 * that hangs up stops its turn. Mounted before the instance auth gate: the channel's own secret
 * authenticates the caller.
 */

import { Hono } from "hono";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { NotificationChannelConfig } from "../../core/types.js";
import { resolveEnvVar } from "../../notifications/channels/webhook.js";
import { normalizeVoiceDevice, type VoiceGatewayAdapter, type VoiceTurnResult } from "../../notifications/voice-gateway-adapter.js";
import { DEFAULT_VOICE_ERROR_TEXT, voiceSseFromCompletion, voiceSseFromText } from "../../notifications/voice-stream.js";

export interface VoiceInboundDeps {
  isInitialized: () => boolean;
  getChannelConfig: (name: string) => NotificationChannelConfig | undefined;
  getAdapter: (name: string) => VoiceGatewayAdapter | undefined;
  /** Stop a running turn (the caller hung up). */
  abortTurn: (turnId: string) => void;
}

const MAX_ERROR_TEXT = 300;

/** Constant-time comparison (hash first so lengths always match). */
function secretMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function providedSecret(authorization: string | undefined, header: string | undefined): string | undefined {
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1]?.trim();
  return bearer || header?.trim() || undefined;
}

/** Text of the last user message (string content or text parts). */
function lastUserText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown } | null;
    if (!m || m.role !== "user") continue;
    const text = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter((p: any) => p?.type === "text" && typeof p.text === "string").map((p: any) => p.text).join(" ")
        : "";
    return text.trim() || undefined;
  }
  return undefined;
}

/** Calls onCancel when the consumer stops reading before the stream ended. */
function withCancel(stream: ReadableStream<Uint8Array>, onCancel: () => void): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let ended = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) { ended = true; controller.close(); return; }
      controller.enqueue(value);
    },
    async cancel(reason) {
      if (!ended) onCancel();
      await reader.cancel(reason).catch(() => {});
    },
  });
}

async function collectText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const raw = await new Response(stream).text();
  return raw.split("\n\n")
    .filter((b) => b.startsWith("data: ") && b !== "data: [DONE]")
    .map((b) => { try { return JSON.parse(b.slice(6)).choices?.[0]?.delta?.content ?? ""; } catch { return ""; } })
    .join("");
}

export function voiceInboundRoutes(deps: VoiceInboundDeps): Hono {
  const app = new Hono();

  app.post("/:name/voice/chat/completions", async (c) => {
    if (!deps.isInitialized()) return c.json({ error: "Polpo is not initialized" }, 503);

    const name = c.req.param("name");
    const config = deps.getChannelConfig(name);
    const expected = config?.type === "voice" ? resolveEnvVar(config.inboundSecret ?? "") : "";
    const given = providedSecret(c.req.header("authorization"), c.req.header("x-polpo-secret"));
    // Unknown channel, other types and wrong secrets look the same: nothing to probe.
    if (!expected || !given || !secretMatches(given, expected)) return c.json({ error: "Unauthorized" }, 401);

    const device = normalizeVoiceDevice(c.req.header("x-polpo-peer"));
    if (!device) return c.json({ error: "Missing or invalid X-Polpo-Peer (device id)" }, 400);

    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "Body must be a JSON chat completion request" }, 400); }
    const text = lastUserText(body?.messages);
    if (!text) return c.json({ error: "No user message to answer" }, 400);

    const errorText = (c.req.header("x-polpo-error-text") ?? "").trim().slice(0, MAX_ERROR_TEXT) || DEFAULT_VOICE_ERROR_TEXT;
    const id = `chatcmpl-voice-${randomUUID()}`;
    const adapter = deps.getAdapter(name);

    let result: VoiceTurnResult;
    if (!adapter) {
      result = { kind: "text", text: "" };
    } else {
      try {
        result = await adapter.turn({ device, text, messageId: c.req.header("x-polpo-message-id") || undefined });
      } catch {
        result = { kind: "text", text: errorText };
      }
    }

    let stream: ReadableStream<Uint8Array>;
    if (result.kind === "stream") {
      stream = voiceSseFromCompletion(result.body, id, {
        errorText,
        language: c.req.header("x-polpo-language")?.trim().slice(0, 16) || undefined,
        // A single non-streamed answer has no silence to fill.
        fillers: body?.stream !== false,
      });
      const turnId = result.turnId;
      if (turnId) {
        const stop = () => deps.abortTurn(turnId);
        stream = withCancel(stream, stop);
        c.req.raw.signal?.addEventListener("abort", stop, { once: true });
      }
    } else {
      stream = voiceSseFromText(result.text, id);
    }

    if (body?.stream === false) {
      const content = await collectText(stream);
      return c.json({
        id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "polpo",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      });
    }
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" },
    });
  });

  return app;
}
