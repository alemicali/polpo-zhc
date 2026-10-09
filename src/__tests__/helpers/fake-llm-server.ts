/**
 * Tiny OpenAI / Anthropic-compatible HTTP server for provider tests.
 * Records every request (method, path, headers, parsed body) and streams a fixed reply.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: any;
}

export interface FakeLlmServer {
  url: string;
  port: number;
  requests: RecordedRequest[];
  /** Reject chat requests whose body contains these fields with HTTP 400 (vLLM-like strictness). */
  rejectFields: Set<string>;
  /** Override the next response for a path. */
  next: Map<string, { status: number; headers?: Record<string, string>; body: string }>;
  close(): Promise<void>;
}

function sseOpenAI(model: string, text: string): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return chunk({ role: "assistant", content: text }, null)
    + chunk({}, "stop")
    + `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model, choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n`
    + "data: [DONE]\n\n";
}

function sseAnthropic(model: string, text: string): string {
  const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return ev("message_start", { message: { id: "m1", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } })
    + ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
    + ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } })
    + ev("content_block_stop", { index: 0 })
    + ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })
    + ev("message_stop", {});
}

export async function startFakeLlmServer(opts: { reply?: string; models?: string[] } = {}): Promise<FakeLlmServer> {
  const reply = opts.reply ?? "OK";
  const modelIds = opts.models ?? ["fake-model", "fake-model-2"];
  const requests: RecordedRequest[] = [];
  const rejectFields = new Set<string>();
  const next = new Map<string, { status: number; headers?: Record<string, string>; body: string }>();

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      let body: any;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
      const path = (req.url ?? "/").split("?")[0];
      requests.push({ method: req.method ?? "GET", path, headers: req.headers, body });

      const override = next.get(path);
      if (override) {
        next.delete(path);
        res.writeHead(override.status, { "content-type": "application/json", ...override.headers });
        res.end(override.body);
        return;
      }
      if (req.method === "GET" && path.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: modelIds.map((id) => ({ id, object: "model", max_model_len: 32768 })) }));
        return;
      }
      if (req.method === "GET" && path === "/api/tags") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: modelIds.map((name) => ({ name })) }));
        return;
      }
      if (req.method === "GET" && path === "/model/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: modelIds.map((id) => ({ model_name: id, model_info: { max_input_tokens: 65536, max_output_tokens: 4096, input_cost_per_token: 0.000001, output_cost_per_token: 0.000002, supports_vision: true } })) }));
        return;
      }
      if (req.method === "POST" && path.endsWith("/chat/completions")) {
        for (const field of rejectFields) {
          if (body && field in body) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: `Unrecognized request argument supplied: ${field}`, type: "invalid_request_error" } }));
            return;
          }
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sseOpenAI(body?.model ?? "fake", reply));
        return;
      }
      if (req.method === "POST" && path.endsWith("/v1/messages")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sseAnthropic(body?.model ?? "fake", reply));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    rejectFields,
    next,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
