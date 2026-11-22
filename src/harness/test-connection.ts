/**
 * "Test" for a harness setting (Settings → Harnesses, POST /api/v1/harnesses/test, MCP
 * polpo_harnesses_get { test }): one tiny model request FROM THIS SERVER (never the VM), with the
 * configured authentication and model, in the format the runtime will use:
 *
 * - Anthropic format (API key, Vercel AI Gateway, custom gateways for Claude Code):
 *   POST {base}/v1/messages, stream: true, max_tokens 16, one trivial tool with tool_choice "any".
 *   Passes on message_start → a tool_use block → message_stop (the runtime needs streaming and tools).
 * - OpenAI Responses (Codex): POST {base}/responses, stream: true, max_output_tokens 16, one
 *   function tool. Passes on response.completed (or incomplete at the token limit).
 * - Bedrock: a minimal Converse call with the model (Bedrock API key or SigV4 access keys).
 * - Vertex AI: a minimal rawPredict call (service account → OAuth token).
 * - OpenCode: the format of its provider: Anthropic Messages, OpenAI Responses, OpenAI Chat
 *   Completions (streamed, with a tool), Gemini generateContent, Bedrock Converse with the Bedrock
 *   API key, the Vercel AI Gateway's Chat Completions endpoint.
 *
 * Returns ok, latency, and a labelled error (authentication, model access, network, timeout,
 * protocol, configuration) with every secret scrubbed.
 */
import { createHash, createHmac, createSign } from "node:crypto";
import { HARNESS_NAMES, type AgentHarnessEngine, type HarnessesSettings, type HarnessId, type VaultStore } from "@polpo-ai/core";
import { resolveHarnessAuth, scrubSecrets, type ResolvedHarnessAuth } from "./credentials.js";
import { classifyHarnessError, type HarnessProvider } from "./errors.js";

export type HarnessTestErrorKind = "config" | "auth" | "model" | "network" | "timeout" | "protocol" | "upstream";

export interface HarnessTestResult {
  ok: boolean;
  harness: HarnessId;
  /** The auth type tested. */
  auth?: string;
  model?: string;
  /** Where the request went (host and path, no query). */
  endpoint?: string;
  latencyMs: number;
  /** HTTP status of the model request. */
  status?: number;
  errorKind?: HarnessTestErrorKind;
  error?: string;
  /** Passed, with a remark (e.g. stopped at the token limit). */
  note?: string;
}

/** Models used when none is configured (cheap ones). */
const DEFAULT_MODELS = {
  anthropic: "claude-haiku-4-5",
  aiGatewayAnthropic: "anthropic/claude-haiku-4.5",
  openai: "gpt-5-mini",
  aiGatewayOpenai: "openai/gpt-5-mini",
  vertex: "claude-haiku-4-5@20251001",
};

function bedrockDefaultModel(region: string): string {
  const geo = region.startsWith("us") ? "us" : region.startsWith("eu") ? "eu" : region.startsWith("ap") ? "apac" : "global";
  return `${geo}.anthropic.claude-haiku-4-5-20251001-v1:0`;
}

const MODEL_ACCESS = /not available for this account|(?:do not|don't) have access to (?:the )?model|model access|not (?:been )?enabled for|model[^\n]{0,80}(?:not found|does not exist|is not supported|unavailable)|(?:invalid|unknown) model|model identifier is invalid|not_found_error|model_not_found|on-demand throughput/i;
const AUTH = /authentication|invalid (?:x-)?api[ -]?key|incorrect api key|unauthori[sz]ed|forbidden|permission|security token|ExpiredToken|UnrecognizedClient|InvalidSignature|invalid_grant|credentials/i;

/**
 * A failed model request, labelled with what to change. With a known provider (Anthropic, OpenAI,
 * Bedrock, Vertex) the words are the ones a failed run gets (src/harness/errors.ts); gateways get
 * their own (model ids, auth scheme, headers).
 */
export function labelHarnessTestError(o: { provider: string; providerId?: HarnessProvider; status?: number; text: string; model?: string }): { kind: HarnessTestErrorKind; message: string } {
  const text = o.text.trim().slice(0, 600) || "no details";
  const m = o.model ? ` "${o.model}"` : "";
  const kind: HarnessTestErrorKind = MODEL_ACCESS.test(text) || o.status === 404 ? "model"
    : o.status === 401 || o.status === 403 || AUTH.test(text) ? "auth" : "upstream";
  if (o.providerId && kind !== "upstream") {
    // the run's classifier knows the provider's own fixes (Bedrock quotas, Vertex Model Garden…)
    const c = classifyHarnessError(`API Error: ${o.status ?? "?"} ${text}`, { harnessName: "Connection test", provider: o.providerId, ...(o.model ? { model: o.model } : {}) });
    if (!c.retryable) return { kind, message: c.message };
  }
  if (kind === "model") return { kind, message: `${o.provider}: model${m} not available — check the model id (gateways often want provider/model ids) or enable it for the account (${o.status ?? "?"}: ${text})` };
  if (kind === "auth") return { kind, message: `${o.provider}: authentication failed — check the credential's vault entry (and the gateway's auth scheme and headers) in Settings → Harnesses (${o.status ?? "?"}: ${text})` };
  return { kind, message: `${o.provider}: the model request failed (${o.status ?? "?"}: ${text})` };
}

/** Server-sent events of a response body: [event, data] pairs, read to the end (bounded). */
async function readSse(res: Response, until: (event: string, data: any) => boolean, signal: AbortSignal): Promise<Array<{ event: string; data: any }>> {
  const out: Array<{ event: string; data: any }> = [];
  if (!res.body) return out;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new Error("timeout");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 2_000_000) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
        let event = "message";
        const data: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (!data.length) continue;
        let parsed: any = data.join("\n");
        try { parsed = JSON.parse(parsed); } catch { /* keep the text */ }
        const ev = event === "message" && parsed && typeof parsed === "object" && typeof parsed.type === "string" ? parsed.type : event;
        out.push({ event: ev, data: parsed });
        if (until(ev, parsed)) return out;
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return out;
}

function authHeaders(scheme: "x-api-key" | "bearer" | "none" | undefined, key: string | undefined, fallback: "x-api-key" | "bearer"): Record<string, string> {
  const s = scheme ?? fallback;
  if (!key || s === "none") return {};
  return s === "x-api-key" ? { "x-api-key": key } : { authorization: `Bearer ${key}` };
}

const endpointOf = (u: string) => { const x = new URL(u); return `${x.host}${x.pathname}`; };

async function testAnthropic(a: ResolvedHarnessAuth, model: string, f: typeof fetch, signal: AbortSignal, messagesUrl?: string): Promise<Omit<HarnessTestResult, "harness" | "latencyMs">> {
  const r = a.route!;
  const url = messagesUrl ?? `${r.upstream.replace(/\/+$/, "")}/v1/messages`;
  const provider = a.providerLabel ?? (r.mode === "direct" ? "Anthropic" : r.mode === "ai-gateway" ? "Vercel AI Gateway" : `Gateway ${new URL(r.upstream).host}`);
  const providerId: HarnessProvider | undefined = r.mode === "direct" ? "anthropic" : undefined;
  const res = await f(url, {
    method: "POST", signal,
    headers: {
      "content-type": "application/json", accept: "text/event-stream", "anthropic-version": "2023-06-01",
      ...authHeaders(r.scheme, r.key, "x-api-key"), ...r.headers,
    },
    body: JSON.stringify({
      model, max_tokens: 16, stream: true,
      messages: [{ role: "user", content: "Call the ping tool." }],
      tools: [{ name: "ping", description: "Answers ping. Call it.", input_schema: { type: "object", properties: {}, additionalProperties: false } }],
      tool_choice: { type: "any" },
    }),
  });
  const endpoint = endpointOf(url);
  if (!res.ok) {
    const l = labelHarnessTestError({ provider, providerId, status: res.status, text: await res.text().catch(() => ""), model });
    return { ok: false, status: res.status, endpoint, model, errorKind: l.kind, error: l.message };
  }
  const events = await readSse(res, (e) => e === "message_stop" || e === "error", signal);
  const seq = { start: false, tool: false, stop: false };
  for (const e of events) {
    if (e.event === "error") {
      const l = labelHarnessTestError({ provider, providerId, status: res.status, text: JSON.stringify(e.data), model });
      return { ok: false, status: res.status, endpoint, model, errorKind: l.kind, error: l.message };
    }
    if (e.event === "message_start") seq.start = true;
    if (e.event === "content_block_start" && seq.start && e.data?.content_block?.type === "tool_use") seq.tool = true;
    if (e.event === "message_stop" && seq.tool) seq.stop = true;
  }
  if (seq.start && seq.tool && seq.stop) return { ok: true, status: res.status, endpoint, model };
  const missing = !seq.start ? "message_start" : !seq.tool ? "a tool_use block (the gateway or model must support tools and tool_choice)" : "message_stop";
  return {
    ok: false, status: res.status, endpoint, model, errorKind: "protocol",
    error: `${provider}: the streamed answer has no ${missing}: ${a.openCode ? "OpenCode" : "Claude Code"} needs Anthropic Messages streaming with tools (events seen: ${[...new Set(events.map((e) => e.event))].join(", ") || "none"})`,
  };
}

async function testResponses(a: ResolvedHarnessAuth, model: string, f: typeof fetch, signal: AbortSignal): Promise<Omit<HarnessTestResult, "harness" | "latencyMs">> {
  const r = a.route!;
  const base = r.upstream.replace(/\/+$/, "");
  // Codex adds /v1 to the AI Gateway's base URL
  const url = `${r.mode === "ai-gateway" && !/\/v1$/.test(base) ? `${base}/v1` : base}/responses`;
  const provider = a.providerLabel ?? (r.mode === "direct" ? "OpenAI" : r.mode === "ai-gateway" ? "Vercel AI Gateway" : `Gateway ${new URL(r.upstream).host}`);
  const providerId: HarnessProvider | undefined = r.mode === "direct" ? "openai" : undefined;
  const res = await f(url, {
    method: "POST", signal,
    headers: { "content-type": "application/json", accept: "text/event-stream", ...authHeaders(r.scheme, r.key, "bearer"), ...r.headers },
    body: JSON.stringify({
      model, input: "Call the ping tool.", max_output_tokens: 16, stream: true,
      tools: [{ type: "function", name: "ping", description: "Answers ping. Call it.", parameters: { type: "object", properties: {}, additionalProperties: false } }],
    }),
  });
  const endpoint = endpointOf(url);
  if (!res.ok) {
    const l = labelHarnessTestError({ provider, providerId, status: res.status, text: await res.text().catch(() => ""), model });
    return { ok: false, status: res.status, endpoint, model, errorKind: l.kind, error: l.message };
  }
  const events = await readSse(res, (e) => e === "response.completed" || e === "response.incomplete" || e === "response.failed" || e === "error", signal);
  const last = events.at(-1);
  if (last?.event === "response.completed") return { ok: true, status: res.status, endpoint, model };
  if (last?.event === "response.incomplete" && /max_output_tokens/.test(JSON.stringify(last.data?.response?.incomplete_details ?? ""))) {
    return { ok: true, status: res.status, endpoint, model, note: "the model stopped at the 16-token limit of the test (it answered)" };
  }
  if (last && (last.event === "error" || last.event === "response.failed")) {
    const l = labelHarnessTestError({ provider, providerId, status: res.status, text: JSON.stringify(last.data), model });
    return { ok: false, status: res.status, endpoint, model, errorKind: l.kind, error: l.message };
  }
  return {
    ok: false, status: res.status, endpoint, model, errorKind: "protocol",
    error: `${provider}: no response.completed event: ${a.openCode ? "OpenCode" : "Codex"} needs the OpenAI Responses API with streaming (events seen: ${[...new Set(events.map((e) => e.event))].join(", ") || "none"})`,
  };
}

// ── Bedrock (Converse), signed with a Bedrock API key or SigV4 ──────────

const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();
const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

/** SigV4 headers for a JSON POST (service "bedrock"). Exported for tests. */
export function sigV4(o: { url: URL; body: string; region: string; service: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string; now?: Date }): Record<string, string> {
  const now = o.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    "content-type": "application/json", host: o.url.host, "x-amz-date": amzDate, "x-amz-content-sha256": sha256(o.body),
    ...(o.sessionToken ? { "x-amz-security-token": o.sessionToken } : {}),
  };
  const signed = Object.keys(headers).sort();
  // non-S3 services: each path segment is URI-encoded twice in the canonical request
  const canonicalUri = o.url.pathname.split("/").map((s) => encodeURIComponent(s)).join("/");
  const canonical = ["POST", canonicalUri, "", ...signed.map((k) => `${k}:${headers[k]}`), "", signed.join(";"), headers["x-amz-content-sha256"]].join("\n");
  const scope = `${date}/${o.region}/${o.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${o.secretAccessKey}`, date), o.region), o.service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  const { host: _host, ...rest } = headers;
  return { ...rest, authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}` };
}

async function testBedrock(a: ResolvedHarnessAuth, f: typeof fetch, signal: AbortSignal, modelId?: string): Promise<Omit<HarnessTestResult, "harness" | "latencyMs">> {
  const c = a.cloud as Extract<NonNullable<ResolvedHarnessAuth["cloud"]>, { kind: "bedrock" }>;
  const model = modelId ?? a.model ?? bedrockDefaultModel(c.region);
  const url = new URL(`https://bedrock-runtime.${c.region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`);
  const body = JSON.stringify({ messages: [{ role: "user", content: [{ text: "Say ok." }] }], inferenceConfig: { maxTokens: 16 } });
  const headers = c.bearer
    ? { "content-type": "application/json", authorization: `Bearer ${c.bearer}` }
    : sigV4({ url, body, region: c.region, service: "bedrock", accessKeyId: c.accessKeyId!, secretAccessKey: c.secretAccessKey!, ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}) });
  const res = await f(url, { method: "POST", headers, body, signal });
  const endpoint = endpointOf(url.toString());
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const l = labelHarnessTestError({ provider: "Bedrock", providerId: "bedrock", status: res.status, text, model });
    return { ok: false, status: res.status, endpoint, model, errorKind: l.kind, error: l.message };
  }
  return { ok: true, status: res.status, endpoint, model };
}

// ── Vertex AI (rawPredict), with the service account's OAuth token ──────

async function vertexToken(json: string, f: typeof fetch, signal: AbortSignal): Promise<string> {
  const sa = JSON.parse(json) as { client_email?: string; private_key?: string; token_uri?: string };
  if (!sa.client_email || !sa.private_key) throw new Error("the service account JSON has no client_email / private_key");
  const now = Math.floor(Date.now() / 1000);
  const b64 = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64url");
  const head = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: sa.token_uri ?? "https://oauth2.googleapis.com/token", iat: now, exp: now + 600 })}`;
  const sig = createSign("RSA-SHA256").update(head).sign(sa.private_key).toString("base64url");
  const res = await f(sa.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST", signal, headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${sig}` }).toString(),
  });
  const body = await res.json().catch(() => ({})) as { access_token?: string; error_description?: string; error?: string };
  if (!res.ok || !body.access_token) throw Object.assign(new Error(`Google token exchange failed: ${body.error_description ?? body.error ?? res.status}`), { status: res.status });
  return body.access_token;
}

async function testVertex(a: ResolvedHarnessAuth, f: typeof fetch, signal: AbortSignal): Promise<Omit<HarnessTestResult, "harness" | "latencyMs">> {
  const c = a.cloud as Extract<NonNullable<ResolvedHarnessAuth["cloud"]>, { kind: "vertex" }>;
  const model = a.model ?? DEFAULT_MODELS.vertex;
  let token: string;
  try { token = await vertexToken(c.serviceAccountJson, f, signal); } catch (err) {
    const l = labelHarnessTestError({ provider: "Vertex AI", providerId: "vertex", status: (err as { status?: number }).status ?? 401, text: (err as Error).message, model });
    return { ok: false, model, errorKind: l.kind === "upstream" ? "auth" : l.kind, error: l.message };
  }
  const host = c.region === "global" ? "aiplatform.googleapis.com" : `${c.region}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${c.projectId}/locations/${c.region}/publishers/anthropic/models/${model}:rawPredict`;
  const res = await f(url, {
    method: "POST", signal, headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ anthropic_version: "vertex-2023-10-16", max_tokens: 16, messages: [{ role: "user", content: "Say ok." }] }),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const l = labelHarnessTestError({ provider: "Vertex AI", providerId: "vertex", status: res.status, text, model });
    return { ok: false, status: res.status, endpoint: endpointOf(url), model, errorKind: l.kind, error: l.message };
  }
  return { ok: true, status: res.status, endpoint: endpointOf(url), model };
}

// ── OpenCode: its provider's own format ─────────────────────────────────

/** OpenAI Chat Completions, streamed, with one tool (OpenCode's openai-compatible providers). */
async function testChat(a: ResolvedHarnessAuth, model: string, url: string, f: typeof fetch, signal: AbortSignal): Promise<Omit<HarnessTestResult, "harness" | "latencyMs">> {
  const r = a.route!;
  const provider = a.providerLabel ?? `Gateway ${new URL(r.upstream).host}`;
  const res = await f(url, {
    method: "POST", signal,
    headers: { "content-type": "application/json", accept: "text/event-stream", ...authHeaders(r.scheme, r.key, "bearer"), ...r.headers },
    body: JSON.stringify({
      model, stream: true, max_tokens: 16,
      messages: [{ role: "user", content: "Call the ping tool." }],
      tools: [{ type: "function", function: { name: "ping", description: "Answers ping. Call it.", parameters: { type: "object", properties: {} } } }],
    }),
  });
  const endpoint = endpointOf(url);
  if (!res.ok) {
    const l = labelHarnessTestError({ provider, status: res.status, text: await res.text().catch(() => ""), model });
    return { ok: false, status: res.status, endpoint, model, errorKind: l.kind, error: l.message };
  }
  const events = await readSse(res, (_e, d) => d === "[DONE]" || !!d?.error || !!d?.choices?.[0]?.finish_reason, signal);
  const err = events.find((e) => e.data?.error);
  if (err) {
    const l = labelHarnessTestError({ provider, status: res.status, text: JSON.stringify(err.data.error), model });
    return { ok: false, status: res.status, endpoint, model, errorKind: l.kind, error: l.message };
  }
  if (events.some((e) => Array.isArray(e.data?.choices))) return { ok: true, status: res.status, endpoint, model };
  return { ok: false, status: res.status, endpoint, model, errorKind: "protocol", error: `${provider}: no streamed Chat Completions chunk: OpenCode needs streaming Chat Completions with tools` };
}

/** Gemini generateContent with the API key header. */
async function testGemini(a: ResolvedHarnessAuth, model: string, f: typeof fetch, signal: AbortSignal): Promise<Omit<HarnessTestResult, "harness" | "latencyMs">> {
  const r = a.route!;
  const url = `${r.upstream.replace(/\/+$/, "")}/models/${encodeURIComponent(model)}:generateContent`;
  const res = await f(url, {
    method: "POST", signal,
    headers: { "content-type": "application/json", ...(r.key ? { "x-goog-api-key": r.key } : {}) },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Say ok." }] }], generationConfig: { maxOutputTokens: 16 } }),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const l = labelHarnessTestError({ provider: a.providerLabel ?? "Google", status: res.status, text, model });
    return { ok: false, status: res.status, endpoint: endpointOf(url), model, errorKind: l.kind, error: l.message };
  }
  return { ok: true, status: res.status, endpoint: endpointOf(url), model };
}

async function testOpenCode(a: ResolvedHarnessAuth, f: typeof fetch, signal: AbortSignal): Promise<Omit<HarnessTestResult, "harness" | "latencyMs">> {
  const oc = a.openCode!;
  const r = a.route!;
  const base = r.upstream.replace(/\/+$/, "");
  const model = oc.modelId;
  let out: Omit<HarnessTestResult, "harness" | "latencyMs">;
  switch (r.format) {
    case "bedrock": out = await testBedrock(a, f, signal, model); break;
    case "anthropic": out = await testAnthropic(a, model, f, signal, `${base}/messages`); break;
    case "openai-responses": out = await testResponses(a, model, f, signal); break;
    case "google": out = await testGemini(a, model, f, signal); break;
    // the AI Gateway's OpenAI-compatible endpoint (OpenCode itself speaks the gateway's own protocol)
    case "ai-gateway": out = await testChat(a, model, `${base.replace(/\/v1\/ai$/, "")}/v1/chat/completions`, f, signal); break;
    default: out = await testChat(a, model, `${base}/chat/completions`, f, signal);
  }
  // the model as OpenCode names it (provider/model)
  return { ...out, model: a.model ?? out.model };
}

/**
 * Test one harness's settings (saved or not) from this server. `agent`: test with that agent's
 * engine (its own credential and model). Never throws.
 */
export async function testHarnessConnection(o: {
  harness: HarnessId;
  settings: HarnessesSettings;
  vault: VaultStore | undefined;
  agentEngine?: AgentHarnessEngine;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<HarnessTestResult> {
  const t0 = Date.now();
  const f = o.fetch ?? fetch;
  const h = o.settings[o.harness];
  const base = { harness: o.harness, ...(h?.auth ? { auth: h.auth } : {}) };
  const engine: AgentHarnessEngine = { ...(o.agentEngine ?? {}), harness: o.harness };
  // the test works for a harness that is not enabled yet
  const settings: HarnessesSettings = { ...o.settings, enabled: [...new Set([...o.settings.enabled, o.harness])] };
  let a: ResolvedHarnessAuth;
  try {
    a = await resolveHarnessAuth(engine, settings, o.vault);
  } catch (err) {
    return { ...base, ok: false, latencyMs: Date.now() - t0, errorKind: "config", error: (err as Error).message };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), o.timeoutMs ?? 30_000);
  try {
    let r: Omit<HarnessTestResult, "harness" | "latencyMs">;
    if (a.openCode) r = await testOpenCode(a, f, ac.signal);
    else if (a.cloud?.kind === "bedrock") r = await testBedrock(a, f, ac.signal);
    else if (a.cloud?.kind === "vertex") r = await testVertex(a, f, ac.signal);
    else if (a.route?.format === "openai-responses") r = await testResponses(a, a.model ?? (a.route.mode === "ai-gateway" ? DEFAULT_MODELS.aiGatewayOpenai : DEFAULT_MODELS.openai), f, ac.signal);
    else r = await testAnthropic(a, a.model ?? (a.route?.mode === "ai-gateway" ? DEFAULT_MODELS.aiGatewayAnthropic : DEFAULT_MODELS.anthropic), f, ac.signal);
    const out: HarnessTestResult = { ...base, ...r, latencyMs: Date.now() - t0 };
    if (out.error) out.error = scrubSecrets(out.error, a.secrets);
    return out;
  } catch (err) {
    const timedOut = ac.signal.aborted;
    const msg = scrubSecrets((err as Error)?.message ?? String(err), a.secrets);
    const cause = scrubSecrets(String(((err as { cause?: { code?: string; message?: string } }).cause?.code ?? (err as { cause?: { message?: string } }).cause?.message) ?? ""), a.secrets);
    return {
      ...base, ok: false, latencyMs: Date.now() - t0, ...(a.model ? { model: a.model } : {}),
      errorKind: timedOut ? "timeout" : "network",
      error: timedOut
        ? `${HARNESS_NAMES[o.harness]}: no answer within ${Math.round((o.timeoutMs ?? 30_000) / 1000)} s`
        : `${HARNESS_NAMES[o.harness]}: the model endpoint could not be reached from this server (${msg}${cause ? `: ${cause}` : ""})`,
    };
  } finally {
    clearTimeout(timer);
  }
}
