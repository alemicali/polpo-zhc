/**
 * Model gateways and credential brokering for agent harnesses, with every upstream mocked (no
 * network, no paid calls):
 * - the gateway auth types in the settings (validation);
 * - credentials: gateway keys, secret headers, non-Claude models, an agent's own key;
 * - Polpo's model relay: token auth and revocation, rule matching per the AI SDK type, the header
 *   swap, auth schemes, streaming passthrough, the upstream allowlist, the unix-socket hop;
 * - the sandbox session's addRequestTransformations for every provider (Daytona v2, Daytona v0,
 *   E2B through the relay; a provider with a native transformer), with the real AI SDK adapters:
 *   the VM gets placeholders only;
 * - the connection test (Anthropic Messages, OpenAI Responses, Bedrock) and its route;
 * - the engine: relay lease per run, revoked at the end; the fallback without POLPO_PUBLIC_URL.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { parseHarnessesSettings, parseAgentEngine, looksLikeSecret, harnessesVaultProblems, agentEngineProblem } from "@polpo-ai/core";
import type { RemoteDriver, RemoteProcess } from "../sandbox/remote-adapters.js";
import { HarnessRelayLease, applyTransforms, forwardToRelay, openRelayLease, presentCredential, relaySocketPath, ruleMatches } from "../harness/relay.js";
import { brokeredHarnessAuth, resolveHarnessAuth } from "../harness/credentials.js";
import { brokeringOf, createHarnessSandboxSession, remoteHarnessMachine } from "../harness/sandbox-session.js";
import { labelHarnessTestError, sigV4, testHarnessConnection } from "../harness/test-connection.js";
import { harnessRoutes } from "../server/routes/harnesses.js";
import { spawnHarnessEngine } from "../adapters/harness-engine.js";
import type { RequestTransformation } from "../harness/types.js";

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function memoryVault(seed: Record<string, Record<string, string>> = {}) {
  const m = new Map<string, any>(Object.entries(seed).map(([k, credentials]) => [k, { type: "api_key", credentials }]));
  return {
    m,
    get: async (o: string, s: string) => m.get(`${o}/${s}`),
    set: async (o: string, s: string, e: any) => { m.set(`${o}/${s}`, e); },
    remove: async (o: string, s: string) => m.delete(`${o}/${s}`),
    getAllForAgent: async () => ({}), list: async () => [], hasEntries: async () => false, patch: async () => [], renameAgent: async () => {}, removeAgent: async () => {},
  } as any;
}

const ref = (service: string) => ({ owner: "ops", service });
const enc = new TextEncoder();
const dec = new TextDecoder();

/** An upstream mock: records requests (headers, body) and answers with `answer`. */
function upstreamMock(answer: (req: Request) => Response | Promise<Response> = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string; init: RequestInit }> = [];
  const f = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const req = new Request(url, init);
    const body = init.body ? await new Response(init.body as BodyInit).text() : "";
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    calls.push({ url: String(url), method: String(init.method ?? "GET"), headers, body, init });
    return answer(req);
  });
  return { fetch: f as unknown as typeof fetch, calls };
}

// ── settings: the gateway auth types ────────────────────────────────────────

describe("harness settings: gateways", () => {
  const cf = {
    preset: "cloudflare", format: "anthropic", baseUrl: "https://gateway.ai.cloudflare.com/v1/acc123/gw1/anthropic", authScheme: "none",
    headers: [{ name: "cf-aig-authorization", credentialRef: ref("cf"), prefix: "Bearer " }],
  };

  it("accepts the Vercel AI Gateway and custom gateways (Cloudflare, OpenRouter, Portkey, LiteLLM, Codex on /v1)", () => {
    const s = parseHarnessesSettings({
      enabled: ["claude-code", "codex"],
      "claude-code": { auth: "gateway", gateway: cf, model: "claude-sonnet-4-5" },
      codex: { auth: "ai-gateway", gateway: { credentialRef: ref("vercel") }, model: "openai/gpt-5" },
    });
    expect(s["claude-code"]).toMatchObject({ auth: "gateway", gateway: { authScheme: "none", headers: [{ name: "cf-aig-authorization", credentialRef: ref("cf"), prefix: "Bearer " }] } });
    expect(s["claude-code"]!.credentialRef).toBeUndefined();
    expect(s.codex).toMatchObject({ auth: "ai-gateway", gateway: { credentialRef: ref("vercel") } });
    expect(parseHarnessesSettings({ enabled: [], "claude-code": { auth: "gateway", gateway: { format: "anthropic", baseUrl: "https://openrouter.ai/api/", authScheme: "bearer", credentialRef: ref("or"), models: { main: "anthropic/claude-sonnet-4.5" } } } })["claude-code"]!.gateway!.baseUrl).toBe("https://openrouter.ai/api");
    expect(parseHarnessesSettings({ enabled: [], codex: { auth: "gateway", gateway: { format: "openai-responses", baseUrl: "https://api.portkey.ai/v1", authScheme: "none", headers: [{ name: "x-portkey-api-key", credentialRef: ref("pk") }, { name: "x-portkey-provider", value: "openai" }], models: { main: "gpt-5" } } } }).codex!.gateway!.headers).toHaveLength(2);
    // Cloudflare's OpenAI endpoint has no /v1 at the end
    expect(() => parseHarnessesSettings({ enabled: [], codex: { auth: "gateway", gateway: { format: "openai-responses", baseUrl: "https://gateway.ai.cloudflare.com/v1/a/g/openai", authScheme: "bearer", credentialRef: ref("k"), models: { main: "gpt-5" } } } })).not.toThrow();
    // LiteLLM on this server (http only for localhost)
    expect(() => parseHarnessesSettings({ enabled: [], "claude-code": { auth: "gateway", gateway: { format: "anthropic", baseUrl: "http://localhost:4000", authScheme: "bearer", credentialRef: ref("ll") } } })).not.toThrow();
  });

  it("refuses unsafe or inconsistent gateways, with the field in the message", () => {
    const g = (gateway: Record<string, unknown>, harness: "claude-code" | "codex" = "claude-code") => () => parseHarnessesSettings({ enabled: [], [harness]: { auth: "gateway", gateway } });
    const base = { format: "anthropic", baseUrl: "https://gw.example.com", authScheme: "bearer", credentialRef: ref("k") };
    expect(g({ ...base, baseUrl: "http://gw.example.com" })).toThrow(/must use https/);
    expect(g({ ...base, baseUrl: "https://user:pw@gw.example.com" })).toThrow(/user or password/);
    expect(g({ ...base, baseUrl: "https://gw.example.com/?key=abc" })).toThrow(/query string/);
    expect(g({ ...base, baseUrl: "https://gw.example.com/v1/messages" })).toThrow(/drop \/v1\/messages/);
    expect(g({ ...base, format: "openai-responses" })).toThrow(/speaks "anthropic"/);
    expect(g({ ...base, format: "openai-responses", baseUrl: "https://gw.example.com/api", models: { main: "gpt-5" } }, "codex")).toThrow(/must end in \/v1/);
    expect(g({ ...base, format: "openai-responses", baseUrl: "https://gw.example.com/v1" }, "codex")).toThrow(/models\.main is required/);
    expect(g({ ...base, nonClaude: true })).toThrow(/models\.main is required for non-Claude models/);
    expect(g({ ...base, credentialRef: undefined })).toThrow(/credentialRef is required with authScheme "bearer"/);
    expect(g({ ...base, headers: [{ name: "Authorization", value: "x" }] })).toThrow(/managed by Polpo/);
    expect(g({ ...base, headers: [{ name: "anthropic-beta", value: "x" }] })).toThrow(/managed by Polpo/);
    expect(g({ ...base, headers: [{ name: "Host", value: "x" }] })).toThrow(/managed by Polpo/);
    expect(g({ ...base, headers: [{ name: "Content-Length", value: "1" }] })).toThrow(/managed by Polpo/);
    expect(g({ ...base, headers: [{ name: "bad header", value: "x" }] })).toThrow(/HTTP header name/);
    expect(g({ ...base, headers: [{ name: "x-portkey-api-key", value: "pk-live-9f8e7d6c5b4a39281706f5e4" }] })).toThrow(/looks like a secret/);
    expect(g({ ...base, headers: [{ name: "cf-aig-authorization", value: "Bearer abc" }] })).toThrow(/looks like a secret/);
    expect(g({ ...base, headers: [{ name: "x-a", credentialRef: ref("a"), value: "b" }] })).toThrow(/either credentialRef/);
    expect(g({ ...base, apiKey: "sk-123" })).toThrow(/secrets never go in the settings/);
    // a string for the key is refused (vault references only)
    expect(g({ ...base, credentialRef: "sk-ant-123" })).toThrow(/vault reference/);
    // the Claude subscription refusal stays
    expect(() => parseHarnessesSettings({ enabled: [], "claude-code": { auth: "subscription", credentialRef: ref("x") } })).toThrow(/Anthropic's terms/);
    expect(looksLikeSecret("anthropic")).toBe(false);
    expect(looksLikeSecret("sk-or-v1-abc")).toBe(true);
  });

  it("an agent's own credential is a vault reference, only where it replaces a key", () => {
    expect(parseAgentEngine({ harness: "claude-code", credentialRef: ref("team-a") })).toEqual({ harness: "claude-code", credentialRef: ref("team-a") });
    expect(() => parseAgentEngine({ harness: "claude-code", credentialRef: "sk-ant-x" })).toThrow(/vault reference/);
    const settings = { harnesses: { enabled: ["claude-code"], allowHost: true, "claude-code": { auth: "bedrock", credentialRef: ref("b"), bedrock: { region: "us-east-1" } } } };
    expect(agentEngineProblem({ name: "ada", engine: { harness: "claude-code", credentialRef: ref("x") } }, settings)).toMatch(/uses bedrock here/);
  });

  it("secret gateway headers must be in the vault to save (with the field asked for)", async () => {
    const s = parseHarnessesSettings({ enabled: [], "claude-code": { auth: "gateway", gateway: { ...cf, headers: [{ name: "cf-aig-authorization", credentialRef: ref("cf"), field: "token", prefix: "Bearer " }] } } });
    expect(await harnessesVaultProblems(s, memoryVault())).toEqual([expect.stringMatching(/cf-aig-authorization.*ops \/ cf does not exist/)]);
    expect(await harnessesVaultProblems(s, memoryVault({ "ops/cf": { apiKey: "x" } }))).toEqual([expect.stringMatching(/has no field "token"/)]);
    expect(await harnessesVaultProblems(s, memoryVault({ "ops/cf": { token: "x" } }))).toEqual([]);
  });
});

// ── credentials ────────────────────────────────────────────────────────────

describe("gateway credentials", () => {
  const vault = memoryVault({
    "ops/or": { apiKey: "sk-or-secret-1" }, "ops/cf": { token: "cf-secret-2" }, "ops/vercel": { apiKey: "vck-secret-3" },
    "ops/anthropic": { apiKey: "sk-ant-api03-main" }, "ops/team-a": { apiKey: "sk-ant-api03-team-a" },
  });

  it("custom gateway, non-Claude models: env, model aliases, headers resolved from the vault", async () => {
    const settings = parseHarnessesSettings({
      enabled: ["claude-code"],
      "claude-code": { auth: "gateway", gateway: {
        format: "anthropic", baseUrl: "https://gateway.ai.cloudflare.com/v1/a/g/anthropic", authScheme: "bearer", credentialRef: ref("or"), nonClaude: true,
        headers: [{ name: "cf-aig-authorization", credentialRef: ref("cf"), field: "token", prefix: "Bearer " }, { name: "x-team", value: "growth" }],
        models: { main: "moonshotai/kimi-k2", haiku: "moonshotai/kimi-k2-mini" },
      } },
    });
    const a = await resolveHarnessAuth({ harness: "claude-code" }, settings, vault);
    expect(a.auth).toEqual({ ANTHROPIC_AUTH_TOKEN: "sk-or-secret-1", ANTHROPIC_BASE_URL: "https://gateway.ai.cloudflare.com/v1/a/g/anthropic" });
    expect(a.env).toMatchObject({
      ANTHROPIC_MODEL: "moonshotai/kimi-k2", ANTHROPIC_DEFAULT_HAIKU_MODEL: "moonshotai/kimi-k2-mini", ANTHROPIC_SMALL_FAST_MODEL: "moonshotai/kimi-k2-mini",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "moonshotai/kimi-k2", ANTHROPIC_DEFAULT_OPUS_MODEL: "moonshotai/kimi-k2",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1", CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
    });
    expect(a.nonClaude).toBe(true);
    expect(a.route).toMatchObject({ mode: "gateway", scheme: "bearer", headers: { "cf-aig-authorization": "Bearer cf-secret-2", "x-team": "growth" } });
    expect(a.secrets).toEqual(expect.arrayContaining(["sk-or-secret-1", "cf-secret-2"]));
    // brokered by the relay: the base URL is the relay's, the headers are not sent from the VM
    const relayed = brokeredHarnessAuth(a, "relay", "https://polpo.example/x/api/v1/harness-relay/T");
    expect(relayed.auth.ANTHROPIC_BASE_URL).toBe("https://polpo.example/x/api/v1/harness-relay/T");
    expect(relayed.headers).toBeUndefined();
    // not brokered (no relay reachable): the headers go with the requests from the VM
    expect(brokeredHarnessAuth(a, "none").headers).toEqual({ "cf-aig-authorization": "Bearer cf-secret-2", "x-team": "growth" });
  });

  it("Vercel AI Gateway for both harnesses; an agent's own key replaces the main one", async () => {
    const settings = parseHarnessesSettings({
      enabled: ["claude-code", "codex"],
      "claude-code": { auth: "api-key", credentialRef: ref("anthropic") },
      codex: { auth: "ai-gateway", gateway: { credentialRef: ref("vercel") }, model: "openai/gpt-5" },
    });
    const c = await resolveHarnessAuth({ harness: "codex" }, settings, vault);
    expect(c.auth).toEqual({ AI_GATEWAY_API_KEY: "vck-secret-3", AI_GATEWAY_BASE_URL: "https://ai-gateway.vercel.sh" });
    expect(brokeredHarnessAuth(c, "relay", "https://p/api/v1/harness-relay/T").auth.AI_GATEWAY_BASE_URL).toBe("https://p/api/v1/harness-relay/T");
    const own = await resolveHarnessAuth({ harness: "claude-code", credentialRef: ref("team-a") }, settings, vault);
    expect(own.auth).toEqual({ ANTHROPIC_API_KEY: "sk-ant-api03-team-a" });
    expect(own.route).toMatchObject({ mode: "direct", upstream: "https://api.anthropic.com", key: "sk-ant-api03-team-a" });
    // Codex, direct, brokered: the AI SDK brokers CODEX_API_KEY
    const direct = await resolveHarnessAuth({ harness: "codex" }, parseHarnessesSettings({ enabled: ["codex"], codex: { auth: "api-key", credentialRef: ref("or") } }), vault);
    expect(brokeredHarnessAuth(direct, "relay", "https://p/r").auth).toEqual({ CODEX_API_KEY: "sk-or-secret-1", OPENAI_BASE_URL: "https://p/r" });
  });
});

// ── the relay ──────────────────────────────────────────────────────────────

describe("model relay", () => {
  const PUBLIC = "https://host.ts.net/insurtech";

  /** The rule the AI SDK registers (createCredentialRequestTransformation) for a base URL. */
  const sdkRule = (baseUrl: string, header: string, placeholder: string, real: string): RequestTransformation => {
    const u = new URL(baseUrl);
    return { match: { host: u.hostname, path: { startsWith: u.pathname.replace(/\/+$/, "") }, headers: [{ key: { exact: header }, value: { exact: placeholder } }] }, transform: { headers: { [header]: real } } };
  };

  it("rule matching follows the AI SDK type: host, path exact/startsWith/regex, method, query, headers", () => {
    const views = [new URL("https://api.example.com/v1/messages?beta=true")];
    const headers = new Headers({ "X-Api-Key": "ph", "anthropic-version": "2023-06-01" });
    const r = (match: Record<string, unknown>): RequestTransformation => ({ match: { host: "api.example.com", ...match } as any, transform: { headers: {} } });
    expect(ruleMatches(r({}), { method: "POST", views, headers })).toBe(true);
    expect(ruleMatches({ ...r({}), match: { host: "other.example.com" } }, { method: "POST", views, headers })).toBe(false);
    expect(ruleMatches(r({ path: { exact: "/v1/messages" } }), { method: "POST", views, headers })).toBe(true);
    expect(ruleMatches(r({ path: { exact: "/v1" } }), { method: "POST", views, headers })).toBe(false);
    expect(ruleMatches(r({ path: { startsWith: "/v1" } }), { method: "POST", views, headers })).toBe(true);
    expect(ruleMatches(r({ path: { regex: "^/v1/(messages|complete)$" } }), { method: "POST", views, headers })).toBe(true);
    expect(ruleMatches(r({ path: { regex: "(" } }), { method: "POST", views, headers })).toBe(false);
    expect(ruleMatches(r({ method: ["post"] }), { method: "POST", views, headers })).toBe(true);
    expect(ruleMatches(r({ method: ["GET"] }), { method: "POST", views, headers })).toBe(false);
    expect(ruleMatches(r({ queryString: [{ key: { exact: "beta" }, value: { exact: "true" } }] }), { method: "POST", views, headers })).toBe(true);
    expect(ruleMatches(r({ queryString: [{ key: { exact: "beta" }, value: { exact: "false" } }] }), { method: "POST", views, headers })).toBe(false);
    // header names are case-insensitive, values are not
    expect(ruleMatches(r({ headers: [{ key: { exact: "x-api-key" }, value: { exact: "ph" } }] }), { method: "POST", views, headers })).toBe(true);
    expect(ruleMatches(r({ headers: [{ key: { exact: "X-API-KEY" }, value: { exact: "PH" } }] }), { method: "POST", views, headers })).toBe(false);
    expect(ruleMatches(r({ headers: [{ key: { startsWith: "anthropic-" } }] }), { method: "POST", views, headers })).toBe(true);
    expect(ruleMatches(r({ headers: [{ value: { regex: "^2023-" } }] }), { method: "POST", views, headers })).toBe(true);
    const h = new Headers({ a: "1" });
    applyTransforms(h, [{ match: { host: "x" }, transform: { headers: { a: "", b: "2" } } }]);
    expect([...h.entries()]).toEqual([["b", "2"]]);
  });

  it("auth schemes: the brokered key is presented as x-api-key, a Bearer token, or not at all", () => {
    const rule = sdkRule("https://r.example/p", "Authorization", "Bearer ph", "Bearer real");
    expect(presentCredential([rule], undefined)[0]).toBe(rule);
    expect(presentCredential([rule], "x-api-key")[0]!.transform.headers).toEqual({ "x-api-key": "real", authorization: "" });
    expect(presentCredential([sdkRule("https://r.example/p", "x-api-key", "ph", "real")], "bearer")[0]!.transform.headers).toEqual({ authorization: "Bearer real", "x-api-key": "" });
    expect(presentCredential([rule], "none")[0]!.transform.headers).toEqual({ authorization: "", "x-api-key": "" });
  });

  function lease(o: Partial<ConstructorParameters<typeof HarnessRelayLease>[0]> = {}, answer?: Parameters<typeof upstreamMock>[0]) {
    const up = upstreamMock(answer);
    const l = new HarnessRelayLease({ polpoDir: "/nowhere", publicUrl: PUBLIC, upstream: "https://api.anthropic.com", fetch: up.fetch, listen: false, ...o });
    return { l, up };
  }
  const vmRequest = (l: HarnessRelayLease, rest: string, headers: Record<string, string>, body = '{"model":"claude","stream":true}', init: RequestInit = {}) =>
    l.handle(new Request(`${l.baseUrl}${rest}`, { method: "POST", headers, body, ...init }), rest.split("?")[0]!);

  it("swaps the placeholder for the key outside the VM; client credentials stripped; anthropic-* and the body untouched", async () => {
    const { l, up } = lease({ headers: { "cf-aig-authorization": "Bearer cf-secret" } });
    expect(l.baseUrl).toMatch(/^https:\/\/host\.ts\.net\/insurtech\/api\/v1\/harness-relay\/[A-Za-z0-9_-]{43}$/);
    // the SDK registered its rule for the relay URL it was given (the VM's base URL)
    l.addRules([sdkRule(l.baseUrl, "x-api-key", "aisdkhc_placeholder", "sk-ant-real")]);
    const res = await vmRequest(l, "/v1/messages?beta=true", {
      "x-api-key": "aisdkhc_placeholder", authorization: "Bearer leaked", cookie: "c=1",
      "anthropic-beta": "fine-grained-tool-streaming-2025-05-14", "anthropic-version": "2023-06-01", "content-type": "application/json",
    });
    expect(res.status).toBe(200);
    expect(up.calls).toHaveLength(1);
    const call = up.calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(call.headers).toMatchObject({ "x-api-key": "sk-ant-real", "anthropic-beta": "fine-grained-tool-streaming-2025-05-14", "anthropic-version": "2023-06-01", "cf-aig-authorization": "Bearer cf-secret", "accept-encoding": "identity" });
    expect(call.headers.authorization).toBeUndefined();
    expect(call.headers.cookie).toBeUndefined();
    expect(JSON.stringify(call.headers)).not.toContain("aisdkhc_placeholder");
    expect(call.body).toBe('{"model":"claude","stream":true}');
    expect(call.init.redirect).toBe("manual");
  });

  it("refuses a stale placeholder, a path that leaves the upstream, and other hosts; never an open proxy", async () => {
    const { l, up } = lease();
    l.addRules([sdkRule(l.baseUrl, "x-api-key", "ph", "real")]);
    expect((await vmRequest(l, "/v1/messages", { "x-api-key": "old-placeholder" })).status).toBe(401);
    expect((await vmRequest(l, "/../evil", { "x-api-key": "ph" })).status).toBe(400);
    expect((await vmRequest(l, "/v1/%2e%2e/evil", { "x-api-key": "ph" })).status).toBe(400);
    expect((await vmRequest(l, "/v1%2fx", { "x-api-key": "ph" })).status).toBe(400);
    expect((await vmRequest(l, "@evil.com/x", { "x-api-key": "ph" })).status).toBe(400);
    expect(up.calls).toHaveLength(0);
    // a gateway base path is a prefix the request must stay under
    const g = lease({ upstream: "https://gw.example.com/v1/acc/gw/anthropic" });
    g.l.addRules([sdkRule(g.l.baseUrl, "x-api-key", "ph", "real")]);
    expect((await vmRequest(g.l, "/v1/messages", { "x-api-key": "ph" })).status).toBe(200);
    expect(g.up.calls[0]!.url).toBe("https://gw.example.com/v1/acc/gw/anthropic/v1/messages");
  });

  it("Polpo's gateway rules and auth scheme: x-api-key gateway for Codex's Bearer key; 'none' drops it", async () => {
    const x = lease({ upstream: "https://gw.example.com/v1", scheme: "x-api-key" });
    x.l.addRules([sdkRule(x.l.baseUrl, "Authorization", "Bearer ph", "Bearer real-key")]);
    await vmRequest(x.l, "/responses", { authorization: "Bearer ph" });
    expect(x.up.calls[0]!.headers).toMatchObject({ "x-api-key": "real-key" });
    expect(x.up.calls[0]!.headers.authorization).toBeUndefined();
    const n = lease({ upstream: "https://gw.example.com", scheme: "none", headers: { "cf-aig-authorization": "Bearer cf" } });
    n.l.addRules([sdkRule(n.l.baseUrl, "Authorization", "Bearer ph", "Bearer polpo-gateway-no-key")]);
    await vmRequest(n.l, "/v1/messages", { authorization: "Bearer ph" });
    expect(n.up.calls[0]!.headers.authorization).toBeUndefined();
    expect(n.up.calls[0]!.headers["x-api-key"]).toBeUndefined();
    expect(n.up.calls[0]!.headers["cf-aig-authorization"]).toBe("Bearer cf");
    // setRules replaces the runtime's rules
    n.l.setRules([sdkRule(n.l.baseUrl, "Authorization", "Bearer ph2", "Bearer k")]);
    expect((await vmRequest(n.l, "/v1/messages", { authorization: "Bearer ph" })).status).toBe(401);
  });

  it("streams SSE through as it arrives (backpressure), reports gateway cost headers, aborts upstream when the client goes", async () => {
    let push!: (s: string) => void;
    let end!: () => void;
    let upstreamSignal: AbortSignal | undefined;
    const { l } = lease({}, (req) => {
      upstreamSignal = req.signal;
      const body = new ReadableStream<Uint8Array>({ start(c) { push = (s) => c.enqueue(enc.encode(s)); end = () => c.close(); } });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "content-encoding": "gzip", "x-litellm-response-cost": "0.0125" } });
    });
    l.addRules([sdkRule(l.baseUrl, "x-api-key", "ph", "real")]);
    const res = await vmRequest(l, "/v1/messages", { "x-api-key": "ph" });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(l.costUsd).toBeCloseTo(0.0125);
    const reader = res.body!.getReader();
    push("event: message_start\ndata: {}\n\n");
    expect(dec.decode((await reader.read()).value)).toBe("event: message_start\ndata: {}\n\n");
    push("event: ping\ndata: {}\n\n");
    expect(dec.decode((await reader.read()).value)).toContain("ping");
    end();
    expect((await reader.read()).done).toBe(true);

    // the client disconnects mid-stream: the upstream request is aborted
    const res2 = await vmRequest(l, "/v1/messages", { "x-api-key": "ph" });
    const r2 = res2.body!.getReader();
    push("data: 1\n\n");
    await r2.read();
    await r2.cancel();
    expect(upstreamSignal!.aborted).toBe(true);
  });

  it("suspended while the computer hibernates (503), revoked for good at the end (401)", async () => {
    const { l, up } = lease();
    l.addRules([sdkRule(l.baseUrl, "x-api-key", "ph", "real")]);
    l.suspend();
    expect((await vmRequest(l, "/v1/messages", { "x-api-key": "ph" })).status).toBe(503);
    l.resume();
    expect((await vmRequest(l, "/v1/messages", { "x-api-key": "ph" })).status).toBe(200);
    await l.revoke();
    expect((await vmRequest(l, "/v1/messages", { "x-api-key": "ph" })).status).toBe(401);
    expect(() => l.addRules([])).toThrow(/revoked/);
    expect(up.calls).toHaveLength(1);
  });

  it("server → unix socket → lease: streams end to end; unknown and revoked tokens get the same 401", async () => {
    const polpoDir = tmp("polpo-relay-");
    const env = { POLPO_RELAY_SOCKET_DIR: tmp("rs-") } as NodeJS.ProcessEnv;
    const up = upstreamMock(() => new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode("event: message_start\n\n")); c.enqueue(enc.encode("event: message_stop\n\n")); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const l = await openRelayLease({ polpoDir, publicUrl: PUBLIC, upstream: "https://api.anthropic.com", fetch: up.fetch, env });
    l.addRules([sdkRule(l.baseUrl, "x-api-key", "ph", "sk-real")]);
    const socket = relaySocketPath(polpoDir, l.token, env);
    expect(existsSync(socket)).toBe(true);
    // the public route, as mounted on the Polpo server
    const app = new Hono();
    app.all("/api/v1/harness-relay/*", (c) => forwardToRelay({ polpoDir, env, path: c.req.path.slice("/api/v1/harness-relay".length), request: c.req.raw }));
    const res = await app.request(`/api/v1/harness-relay/${l.token}/v1/messages?beta=true`, { method: "POST", headers: { "x-api-key": "ph", "content-type": "application/json" }, body: '{"a":1}' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("event: message_start\n\nevent: message_stop\n\n");
    expect(up.calls[0]).toMatchObject({ url: "https://api.anthropic.com/v1/messages?beta=true", body: '{"a":1}' });
    expect(up.calls[0]!.headers["x-api-key"]).toBe("sk-real");
    expect(up.calls[0]!.headers["x-polpo-relay-token"]).toBeUndefined();
    const unknown = await app.request(`/api/v1/harness-relay/${"A".repeat(43)}/v1/messages`, { method: "POST", body: "{}" });
    const malformed = await app.request("/api/v1/harness-relay/short/v1/messages", { method: "POST", body: "{}" });
    expect([unknown.status, malformed.status]).toEqual([401, 401]);
    await l.revoke();
    expect(existsSync(socket)).toBe(false);
    const after = await app.request(`/api/v1/harness-relay/${l.token}/v1/messages`, { method: "POST", headers: { "x-api-key": "ph" }, body: "{}" });
    expect(after.status).toBe(401);
    expect(JSON.stringify(await after.json())).not.toContain(l.token);
  });
});

// ── the sandbox session, for every provider ─────────────────────────────────

/** A driver as a provider would give it: Daytona v2 (process API + ports), v0 / E2B (same contract here). */
function providerDriver(kind: "daytona-v2" | "daytona-v0" | "e2b", spawned: Array<{ command: string; env?: Record<string, string> }>, native?: RequestTransformation[][]): RemoteDriver {
  const files = new Map<string, Uint8Array>();
  const d: RemoteDriver = {
    remoteId: `${kind}-vm`,
    exec: async (command) => {
      if (command.includes("printf") && command.includes("HOME")) return { exitCode: 0, stdout: "/root", stderr: "" };
      if (command.startsWith("stat ")) return { exitCode: 1, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    readFile: async (p) => files.get(p) ?? new Uint8Array(),
    writeFile: async (p, data) => { files.set(p, data); },
    suspend: async () => {}, resume: async () => {}, destroy: async () => {},
    spawn: async (command, o) => {
      spawned.push({ command, ...(o.env ? { env: o.env } : {}) });
      // stop the adapter right after it starts its bridge: the test needs the VM's environment only
      throw new Error("test: bridge not started");
    },
    portEndpoint: async (port) => ({ url: `wss://${port}-${kind}.proxy` }),
  };
  if (native) d.requestTransformations = async (rules, o) => { native.push(o.replace ? [...rules] : [...(native.at(-1) ?? []), ...rules]); };
  return d;
}

describe("credential brokering in the sandbox session (any provider)", () => {
  const PUBLIC = "https://host.ts.net/insurtech";

  for (const kind of ["daytona-v2", "daytona-v0", "e2b"] as const) {
    it(`${kind}: addRequestTransformations through Polpo's relay; the real AI SDK puts placeholders in the VM (Codex)`, async () => {
      const spawned: Array<{ command: string; env?: Record<string, string> }> = [];
      const d = providerDriver(kind, spawned);
      const machine = remoteHarnessMachine({ driver: async () => d, workDir: "/work", label: kind, nativeTransformations: !!d.requestTransformations });
      const up = upstreamMock(() => new Response("{}", { status: 200 }));
      const l = new HarnessRelayLease({ polpoDir: "/nowhere", publicUrl: PUBLIC, upstream: "https://api.openai.com/v1", fetch: up.fetch, listen: false });
      expect(brokeringOf(machine, { lease: l })).toBe("relay");
      const session: any = createHarnessSandboxSession(machine, { port: 4001, broker: { lease: l } });
      expect(typeof session.addRequestTransformations).toBe("function");
      expect(typeof session.setRequestTransformations).toBe("function");
      // the restricted view (tools) cannot change request transformations
      expect(Object.keys(session.restricted())).not.toContain("addRequestTransformations");

      const resolved = await resolveHarnessAuth({ harness: "codex" }, parseHarnessesSettings({ enabled: ["codex"], codex: { auth: "api-key", credentialRef: ref("openai") } }), memoryVault({ "ops/openai": { apiKey: "sk-proj-REAL-openai-key" } }));
      const auth = brokeredHarnessAuth(resolved, "relay", l.baseUrl);
      const { createCodex } = await import("@ai-sdk/harness-codex");
      const harness: any = createCodex({ auth: auth.auth, startupTimeoutMs: 1000 });
      await expect(harness.doStart({ sessionId: "s1", sessionWorkDir: "/work", sandboxSession: session })).rejects.toThrow(/bridge not started/);
      // the VM's environment: a placeholder and the relay's URL, never the key
      const env = spawned[0]!.env!;
      expect(env.CODEX_API_KEY).toMatch(/^aisdkhc_[A-Za-z0-9_-]{43}$/);
      expect(env.OPENAI_BASE_URL).toBe(l.baseUrl);
      expect(JSON.stringify(spawned)).not.toContain("sk-proj-REAL-openai-key");
      // the rule the SDK registered: the placeholder → the key, applied by the relay
      expect(l.registeredRules).toHaveLength(1);
      const res = await l.handle(new Request(`${l.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${env.CODEX_API_KEY}` }, body: "{}" }), "/responses");
      expect(res.status).toBe(200);
      expect(up.calls[0]).toMatchObject({ url: "https://api.openai.com/v1/responses" });
      expect(up.calls[0]!.headers.authorization).toBe("Bearer sk-proj-REAL-openai-key");
    });
  }

  it("Claude Code through the relay: the SDK's rule is for the relay URL, and the placeholder works end to end", async () => {
    const spawned: Array<{ command: string; env?: Record<string, string> }> = [];
    const d = providerDriver("daytona-v2", spawned);
    const up = upstreamMock(() => new Response("{}", { status: 200 }));
    const l = new HarnessRelayLease({ polpoDir: "/nowhere", publicUrl: PUBLIC, upstream: "https://api.anthropic.com", fetch: up.fetch, listen: false });
    const session: any = createHarnessSandboxSession(remoteHarnessMachine({ driver: async () => d, workDir: "/work", label: "nina" }), { port: 4002, broker: { lease: l } });
    const resolved = await resolveHarnessAuth({ harness: "claude-code" }, parseHarnessesSettings({ enabled: ["claude-code"], "claude-code": { auth: "api-key", credentialRef: ref("a") } }), memoryVault({ "ops/a": { apiKey: "sk-ant-api03-REAL" } }));
    const auth = brokeredHarnessAuth(resolved, "relay", l.baseUrl);
    const { createClaudeCode } = await import("@ai-sdk/harness-claude-code");
    const harness: any = createClaudeCode({ auth: auth.auth, env: auth.env, startupTimeoutMs: 1000 });
    await expect(harness.doStart({ sessionId: "s1", sessionWorkDir: "/work", sandboxSession: session })).rejects.toThrow(/bridge not started/);
    expect(JSON.stringify(spawned)).not.toContain("sk-ant-api03-REAL");
    const rule = l.registeredRules[0]!;
    expect(rule.match.host).toBe("host.ts.net");
    expect(rule.match.path).toEqual({ startsWith: new URL(l.baseUrl).pathname });
    const placeholder = (rule.match.headers![0]!.value as { exact: string }).exact;
    expect(placeholder).toMatch(/^aisdkhc_/);
    const res = await l.handle(new Request(`${l.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": placeholder }, body: "{}" }), "/v1/messages");
    expect(res.status).toBe(200);
    expect(up.calls[0]!.headers["x-api-key"]).toBe("sk-ant-api03-REAL");
  });

  it("a provider with a native egress transformer gets the same rules (Polpo's first), and no relay", async () => {
    const spawned: Array<{ command: string; env?: Record<string, string> }> = [];
    const native: RequestTransformation[][] = [];
    const d = providerDriver("daytona-v2", spawned, native);
    const machine = remoteHarnessMachine({ driver: async () => d, workDir: "/work", label: "vercel", nativeTransformations: true });
    const polpoRule: RequestTransformation = { match: { host: "gw.example.com" }, transform: { headers: { "cf-aig-authorization": "Bearer cf" } } };
    expect(brokeringOf(machine, { scheme: "none", rules: [polpoRule] })).toBe("native");
    const session: any = createHarnessSandboxSession(machine, { port: 4003, broker: { scheme: "none", rules: [polpoRule] } });
    const sdk = { match: { host: "gw.example.com", headers: [{ key: { exact: "Authorization" }, value: { exact: "Bearer ph" } }] }, transform: { headers: { Authorization: "Bearer polpo-gateway-no-key" } } };
    await session.addRequestTransformations([sdk]);
    expect(native[0]).toEqual([polpoRule, { match: sdk.match, transform: { headers: { authorization: "", "x-api-key": "" } } }]);
    await session.addRequestTransformations([sdk]);
    expect(native[1]).toHaveLength(3);
    await session.setRequestTransformations([]);
    expect(native[2]).toEqual([polpoRule]);
    // without a broker: no request transformations (the SDK forwards the key; the fallback)
    expect((createHarnessSandboxSession(machine, { port: 1 }) as any).addRequestTransformations).toBeUndefined();
  });
});

// ── the connection test ────────────────────────────────────────────────────

const sse = (events: Array<[string, unknown]>) => new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

describe("connection test", () => {
  const vault = memoryVault({ "ops/a": { apiKey: "sk-ant-api03-TEST" }, "ops/or": { apiKey: "sk-or-TEST" }, "ops/b": { apiKey: "bedrock-TEST" }, "ops/cf": { token: "cf-TEST" } });

  it("Anthropic format: message_start → tool_use → message_stop passes; the request is what Claude Code needs", async () => {
    const up = upstreamMock(() => sse([["message_start", { type: "message_start" }], ["content_block_start", { type: "content_block_start", content_block: { type: "tool_use", name: "ping" } }], ["message_stop", { type: "message_stop" }]]));
    const settings = parseHarnessesSettings({ enabled: [], "claude-code": { auth: "gateway", gateway: { format: "anthropic", baseUrl: "https://openrouter.ai/api", authScheme: "bearer", credentialRef: ref("or"), headers: [{ name: "x-cf", credentialRef: ref("cf"), field: "token" }], models: { main: "anthropic/claude-sonnet-4.5" } } } });
    const r = await testHarnessConnection({ harness: "claude-code", settings, vault, fetch: up.fetch });
    expect(r).toMatchObject({ ok: true, harness: "claude-code", auth: "gateway", model: "anthropic/claude-sonnet-4.5", endpoint: "openrouter.ai/api/v1/messages", status: 200 });
    const body = JSON.parse(up.calls[0]!.body);
    expect(body).toMatchObject({ stream: true, max_tokens: 16, tool_choice: { type: "any" }, tools: [{ name: "ping" }] });
    expect(up.calls[0]!.headers).toMatchObject({ authorization: "Bearer sk-or-TEST", "x-cf": "cf-TEST", "anthropic-version": "2023-06-01" });
  });

  it("labels failures: no tool_use (protocol), 401 (auth), model not found, network, with secrets scrubbed", async () => {
    const settings = parseHarnessesSettings({ enabled: [], "claude-code": { auth: "api-key", credentialRef: ref("a") } });
    const noTool = await testHarnessConnection({ harness: "claude-code", settings, vault, fetch: upstreamMock(() => sse([["message_start", {}], ["content_block_start", { content_block: { type: "text" } }], ["message_stop", {}]])).fetch });
    expect(noTool).toMatchObject({ ok: false, errorKind: "protocol", error: expect.stringMatching(/no a tool_use block/) });
    const auth = await testHarnessConnection({ harness: "claude-code", settings, vault, fetch: upstreamMock(() => new Response('{"error":{"type":"authentication_error","message":"invalid x-api-key sk-ant-api03-TEST"}}', { status: 401 })).fetch });
    expect(auth).toMatchObject({ ok: false, status: 401, errorKind: "auth", error: expect.stringMatching(/^Anthropic: authentication failed/) });
    expect(auth.error).not.toContain("sk-ant-api03-TEST");
    const model = await testHarnessConnection({ harness: "claude-code", settings, vault, fetch: upstreamMock(() => new Response('{"error":{"type":"not_found_error","message":"model: claude-x"}}', { status: 404 })).fetch });
    expect(model).toMatchObject({ ok: false, errorKind: "model" });
    const down = await testHarnessConnection({ harness: "claude-code", settings, vault, fetch: (async () => { throw new TypeError("fetch failed"); }) as any });
    expect(down).toMatchObject({ ok: false, errorKind: "network" });
    const missing = await testHarnessConnection({ harness: "claude-code", settings: parseHarnessesSettings({ enabled: [], "claude-code": { auth: "api-key", credentialRef: ref("gone") } }), vault });
    expect(missing).toMatchObject({ ok: false, errorKind: "config", error: expect.stringMatching(/missing/) });
    expect(labelHarnessTestError({ provider: "Bedrock", status: 400, text: "on-demand throughput isn't supported" }).kind).toBe("model");
  });

  it("OpenAI Responses (Codex): response.completed passes; Vercel AI Gateway gets /v1/responses", async () => {
    const up = upstreamMock(() => sse([["response.created", { type: "response.created" }], ["response.completed", { type: "response.completed" }]]));
    const settings = parseHarnessesSettings({ enabled: [], codex: { auth: "ai-gateway", gateway: { credentialRef: ref("or") }, model: "openai/gpt-5" } });
    const r = await testHarnessConnection({ harness: "codex", settings, vault, fetch: up.fetch });
    expect(r).toMatchObject({ ok: true, endpoint: "ai-gateway.vercel.sh/v1/responses", model: "openai/gpt-5" });
    expect(JSON.parse(up.calls[0]!.body)).toMatchObject({ stream: true, max_output_tokens: 16, tools: [{ type: "function", name: "ping" }] });
    expect(up.calls[0]!.headers.authorization).toBe("Bearer sk-or-TEST");
    const failed = await testHarnessConnection({ harness: "codex", settings, vault, fetch: upstreamMock(() => sse([["response.failed", { type: "response.failed", response: { error: { message: "model gpt-x does not exist" } } }]])).fetch });
    expect(failed).toMatchObject({ ok: false, errorKind: "model" });
  });

  it("Bedrock: a Converse call with the model (Bedrock API key; SigV4 for access keys)", async () => {
    const up = upstreamMock(() => new Response('{"output":{}}', { status: 200 }));
    const settings = parseHarnessesSettings({ enabled: [], "claude-code": { auth: "bedrock", credentialRef: ref("b"), bedrock: { region: "eu-west-1" } } });
    const r = await testHarnessConnection({ harness: "claude-code", settings, vault, fetch: up.fetch });
    expect(r).toMatchObject({ ok: true, model: "eu.anthropic.claude-haiku-4-5-20251001-v1:0", endpoint: "bedrock-runtime.eu-west-1.amazonaws.com/model/eu.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse" });
    expect(up.calls[0]!.headers.authorization).toBe("Bearer bedrock-TEST");
    const h = sigV4({ url: new URL("https://bedrock-runtime.us-east-1.amazonaws.com/model/m%3A0/converse"), body: "{}", region: "us-east-1", service: "bedrock", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", now: new Date("2026-01-01T00:00:00Z") });
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260101\/us-east-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  });

  it("POST /harnesses/test: saved or edited settings, an agent's own credential; validation errors are 400", async () => {
    const up = upstreamMock(() => sse([["message_start", {}], ["content_block_start", { content_block: { type: "tool_use" } }], ["message_stop", {}]]));
    const saved = { harnesses: { enabled: ["claude-code"], "claude-code": { auth: "api-key", credentialRef: ref("a") } } } as any;
    const app = harnessRoutes({
      polpoDir: () => "/nowhere", settings: () => saved, vault: () => vault, manager: () => ({}) as any,
      agents: async () => [{ name: "ada", role: "dev", engine: { harness: "claude-code", credentialRef: ref("or") } } as any],
      testConnection: (o) => testHarnessConnection({ ...o, fetch: up.fetch }),
    });
    const post = (body: unknown) => app.request("/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const ok = await (await post({ harness: "claude-code" })).json();
    expect(ok).toMatchObject({ ok: true, data: { ok: true, harness: "claude-code" } });
    expect(up.calls[0]!.headers["x-api-key"]).toBe("sk-ant-api03-TEST");
    await post({ harness: "claude-code", agent: "ada" });
    expect(up.calls[1]!.headers["x-api-key"]).toBe("sk-or-TEST");
    const bad = await post({ harness: "claude-code", settings: { enabled: [], "claude-code": { auth: "gateway", gateway: { format: "anthropic", baseUrl: "http://x.example.com", authScheme: "bearer", credentialRef: ref("a") } } } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/https/);
    expect((await post({ harness: "nope" })).status).toBe(400);
  });
});

// ── the engine ─────────────────────────────────────────────────────────────

describe("harness engine: brokering per run", () => {
  const task = { id: "t9", title: "Notes", description: "x", expectations: [], status: "in_progress" } as any;
  const agent = { name: "ada", role: "dev", engine: { harness: "claude-code" } } as any;

  function run(publicUrl: string | undefined) {
    const root = tmp("polpo-hgw-");
    const polpoDir = join(root, ".polpo");
    mkdirSync(polpoDir, { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "x");
    const vault = memoryVault({ "ops/a": { apiKey: "sk-ant-api03-ENGINE" } });
    let spec: any;
    let sandbox: any;
    const leases: HarnessRelayLease[] = [];
    const machine = {
      id: "nina", description: "", workDir: root,
      exec: async (c: string) => ({ exitCode: 0, stdout: c.startsWith("for p in") ? "4009" : "", stderr: "" }),
      readFile: async () => null, writeFile: async () => {}, stat: async () => null, list: async () => null, remove: async () => false,
      spawn: async () => { throw new Error("no"); }, portEndpoint: async () => ({ url: "ws://x" }), close: () => {},
    };
    const transcript: any[] = [];
    const handle = spawnHarnessEngine(agent, task, root, { polpoDir, outputDir: join(polpoDir, "output", "t9"), vaultStore: vault } as any, {
      // (the engine check passes with allowHost; the machine below is a remote computer's)
      settings: () => ({ harnesses: { enabled: ["claude-code"], allowHost: true, "claude-code": { auth: "api-key", credentialRef: ref("a") } } }) as any,
      publicUrl: () => publicUrl,
      openRelayLease: async (o) => { const l = new HarnessRelayLease({ ...o, listen: false }); leases.push(l); return l; },
      openMachine: async () => ({ machine: machine as any, computerId: "nina", hold: () => () => {} }),
      runtimeFactory: (s) => { spec = s; return { harness: "claude-code", createSession: async (o: any) => { sandbox = o.sandbox; return {
        sessionId: "hs", workDir: root, isResume: false, steer: async () => {}, detach: async () => ({}), stop: async () => ({}), destroy: async () => {},
        turn: async () => ({ text: "done", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 }, costUsd: 0.01 }),
      }; } } as any; },
      recordUsage: async () => {},
    });
    handle.onTranscript = (e) => transcript.push(e);
    return { handle, transcript, leases, getSpec: () => spec, getSandbox: () => sandbox };
  }

  it("with POLPO_PUBLIC_URL: a relay lease per run; the runtime gets the relay URL; revoked at the end", async () => {
    const env = run("https://host.ts.net/insurtech");
    const r = await env.handle.done;
    expect(r.exitCode).toBe(0);
    const l = env.leases[0]!;
    expect(l.upstream.toString()).toBe("https://api.anthropic.com/");
    expect(env.getSpec().auth.auth).toEqual({ ANTHROPIC_API_KEY: "sk-ant-api03-ENGINE", ANTHROPIC_BASE_URL: l.baseUrl });
    expect(typeof env.getSandbox().addRequestTransformations).toBe("function");
    expect(l.status).toBe("revoked");
    expect(env.transcript.some((e) => /brokered by Polpo's model relay/.test(e.message ?? ""))).toBe(true);
    // the token never reaches the transcript
    expect(JSON.stringify(env.transcript)).not.toContain(l.token);
  });

  it("without POLPO_PUBLIC_URL: the key goes into the VM, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = run(undefined);
    await env.handle.done;
    expect(env.leases).toHaveLength(0);
    expect(env.getSandbox().addRequestTransformations).toBeUndefined();
    expect(env.getSpec().auth.auth).toEqual({ ANTHROPIC_API_KEY: "sk-ant-api03-ENGINE" });
    expect(env.transcript.some((e) => /POLPO_PUBLIC_URL is not set/.test(e.message ?? ""))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/POLPO_PUBLIC_URL is not set/));
    warn.mockRestore();
  });
});
