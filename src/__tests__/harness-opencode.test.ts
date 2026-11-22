/**
 * OpenCode as a harness engine, with the AI SDK adapter mocked where a model or a bridge would
 * run (no network, no paid calls):
 * - settings: auth types (provider API key, Bedrock API key, AI Gateway, custom gateways in three
 *   formats), refusals (logins, subscriptions, SigV4 keys);
 * - credentials: Polpo writes OpenCode's provider config; brokered runs carry a placeholder and the
 *   relay's URL, and Polpo's own rule swaps it for the key outside the VM;
 * - the real `@ai-sdk/harness-opencode` adapter over Polpo's sandbox session: the VM's environment
 *   has no key and no provider variable of the computer;
 * - the SDK wrapper: createOpenCode wiring and OpenCode's per-step cost;
 * - the engine (relay lease with Polpo's rule, blanked environment, cost mapping) and the
 *   connection test (Chat Completions, Bedrock Converse).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPENCODE_SUBSCRIPTION_REFUSAL, agentEngineProblem, parseAgentEngine, parseHarnessesSettings,
} from "@polpo-ai/core";
import type { RemoteDriver } from "../sandbox/remote-adapters.js";

const sdk = vi.hoisted(() => ({
  openCode: [] as any[], agents: [] as any[], parts: [] as any[][],
}));
vi.mock("@ai-sdk/harness-opencode", async () => {
  const actual = await vi.importActual<typeof import("@ai-sdk/harness-opencode")>("@ai-sdk/harness-opencode");
  return { ...actual, createOpenCode: (s: any) => { sdk.openCode.push(s); return { harnessId: "opencode", settings: s }; }, actualCreateOpenCode: actual.createOpenCode };
});
vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    constructor(readonly settings: any) { sdk.agents.push(settings); }
    async createSession(o: any) {
      return { sessionId: o.sessionId ?? "oc-1", isResume: !!o.resumeFrom, getSessionWorkDir: () => "/w", detach: async () => ({ type: "resume-session", data: {} }), stop: async () => ({}), destroy: async () => {} };
    }
    async stream() { const parts = sdk.parts.shift() ?? []; return { fullStream: (async function* () { yield* parts; })() }; }
    async continueStream() { return { fullStream: (async function* () {})() }; }
    async experimental_steer() {}
  },
}));

const { brokeredHarnessAuth, openCodeCredentialRules, resolveHarnessAuth } = await import("../harness/credentials.js");
const { createSdkHarnessRuntime, buildHarness, stepCostUsd, openCodeReasoningVariant } = await import("../harness/sdk.js");
const { HarnessRelayLease } = await import("../harness/relay.js");
const { createHarnessSandboxSession, remoteHarnessMachine } = await import("../harness/sandbox-session.js");
const { spawnHarnessEngine, OPENCODE_BLANK_ENV } = await import("../adapters/harness-engine.js");
const { testHarnessConnection } = await import("../harness/test-connection.js");
const { classifyHarnessError } = await import("../harness/errors.js");

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
beforeEach(() => { sdk.openCode.length = 0; sdk.agents.length = 0; sdk.parts.length = 0; });
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function memoryVault(seed: Record<string, Record<string, string>> = {}) {
  const m = new Map<string, any>(Object.entries(seed).map(([k, credentials]) => [k, { type: "api_key", credentials }]));
  return {
    get: async (o: string, s: string) => m.get(`${o}/${s}`), set: async () => {}, remove: async () => true,
    getAllForAgent: async () => ({}), list: async () => [], hasEntries: async () => false, patch: async () => [], renameAgent: async () => {}, removeAgent: async () => {},
  } as any;
}
const ref = (service: string) => ({ owner: "ops", service });
const PUBLIC = "https://host.ts.net/polpo";
const BEDROCK_KEY = "ABSKQmVkcm9ja0FQSUtleS1REAL-bedrock-bearer";

const bedrock = { enabled: ["opencode"], opencode: { auth: "bedrock", credentialRef: ref("bedrock"), bedrock: { region: "us-east-1" }, model: "amazon-bedrock/global.moonshotai.kimi-k3.1" } };

// ── settings ────────────────────────────────────────────────────────────

describe("OpenCode settings", () => {
  it("parses a provider API key, a Bedrock API key, the AI Gateway and custom gateways in three formats", () => {
    // the provider prefix of the model is dropped: the setting keeps the provider's own id
    expect(parseHarnessesSettings(bedrock).opencode).toEqual({ auth: "bedrock", credentialRef: ref("bedrock"), bedrock: { region: "us-east-1" }, model: "global.moonshotai.kimi-k3.1" });
    expect(parseHarnessesSettings({ enabled: [], opencode: { auth: "api-key", provider: "openrouter", credentialRef: ref("or"), model: "moonshotai/kimi-k2" } }).opencode)
      .toEqual({ auth: "api-key", provider: "openrouter", credentialRef: ref("or"), model: "moonshotai/kimi-k2" });
    expect(parseHarnessesSettings({ enabled: [], opencode: { auth: "ai-gateway", gateway: { credentialRef: ref("v") }, model: "vercel/zai/glm-4.6" } }).opencode!.model).toBe("zai/glm-4.6");
    for (const format of ["openai-chat", "openai-responses", "anthropic"] as const) {
      const baseUrl = format === "anthropic" ? "https://litellm.example.com" : "https://litellm.example.com/v1";
      expect(parseHarnessesSettings({ enabled: [], opencode: { auth: "gateway", gateway: { format, baseUrl, authScheme: "bearer", credentialRef: ref("ll"), models: { main: "qwen3-coder" } } } }).opencode!.gateway!.format).toBe(format);
    }
    expect(parseAgentEngine({ harness: "opencode", model: "kimi-k2" })).toEqual({ harness: "opencode", model: "kimi-k2" });
  });

  it("refuses logins and subscriptions, unknown providers, a gateway without a model, other harnesses' fields", () => {
    for (const auth of ["subscription", "chatgpt", "copilot", "opencode-zen", "oauth"]) {
      expect(() => parseHarnessesSettings({ enabled: [], opencode: { auth } })).toThrow(OPENCODE_SUBSCRIPTION_REFUSAL);
    }
    expect(() => parseHarnessesSettings({ enabled: [], opencode: { auth: "api-key", provider: "github-copilot", credentialRef: ref("x") } })).toThrow(/explicit credential only/);
    expect(() => parseHarnessesSettings({ enabled: [], opencode: { auth: "api-key", provider: "acme", credentialRef: ref("x") } })).toThrow(/provider must be one of/);
    expect(() => parseHarnessesSettings({ enabled: [], opencode: { auth: "api-key", provider: "amazon-bedrock", credentialRef: ref("x") } })).toThrow(/auth "bedrock"/);
    expect(() => parseHarnessesSettings({ enabled: [], opencode: { auth: "bedrock", credentialRef: ref("x") } })).toThrow(/bedrock.region/);
    expect(() => parseHarnessesSettings({ enabled: [], opencode: { auth: "api-key", provider: "openai", credentialRef: ref("x"), apiKey: "sk-x" } })).toThrow(/secrets never go in the settings/);
    expect(() => parseHarnessesSettings({ enabled: [], opencode: { auth: "gateway", gateway: { format: "openai-chat", baseUrl: "https://gw.example.com/v1", authScheme: "bearer", credentialRef: ref("g") } } })).toThrow(/models.main is required for OpenCode/);
    expect(() => parseHarnessesSettings({ enabled: [], opencode: { auth: "gateway", gateway: { format: "openai-chat", baseUrl: "https://gw.example.com/v1", authScheme: "bearer", credentialRef: ref("g"), models: { main: "m", haiku: "h" } } } })).toThrow(/one model/);
    expect(() => parseHarnessesSettings({ enabled: [], opencode: { auth: "gateway", gateway: { format: "openai-chat", baseUrl: "https://gw.example.com/v1/chat/completions", authScheme: "bearer", credentialRef: ref("g"), models: { main: "m" } } } })).toThrow(/adds \/chat\/completions/);
    expect(() => parseHarnessesSettings({ enabled: ["opencode"] })).toThrow(/settings.harnesses.opencode/);
    // Claude Code and Codex keep their single format
    expect(() => parseHarnessesSettings({ enabled: [], codex: { auth: "gateway", gateway: { format: "openai-chat", baseUrl: "https://gw.example.com/v1", authScheme: "bearer", credentialRef: ref("g"), models: { main: "m" } } } })).toThrow(/speaks "openai-responses"/);
  });

  it("an agent's own key may replace OpenCode's Bedrock API key (it is a key, not a signature)", () => {
    const settings = { harnesses: { ...bedrock, allowHost: true } };
    expect(agentEngineProblem({ name: "kim", engine: { harness: "opencode", credentialRef: ref("mine") } }, settings)).toBeNull();
    expect(agentEngineProblem({ name: "kim", engine: { harness: "opencode" } }, { harnesses: { enabled: [] } })).toMatch(/OpenCode is not enabled/);
  });
});

// ── credentials and OpenCode's config ───────────────────────────────────

describe("OpenCode credentials", () => {
  const vault = memoryVault({
    "ops/bedrock": { apiKey: BEDROCK_KEY },
    "ops/sigv4": { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" },
    "ops/moonshot": { MOONSHOT_API_KEY: "sk-moonshot-REAL" },
    "ops/gw": { apiKey: "gw-REAL-key" },
    "ops/pk": { apiKey: "pk-secret-header" },
  });

  it("Bedrock: the API key, region and model; brokered through the relay, the VM gets a placeholder and the relay URL", async () => {
    const a = await resolveHarnessAuth({ harness: "opencode" }, parseHarnessesSettings(bedrock), vault);
    expect(a).toMatchObject({ model: "amazon-bedrock/global.moonshotai.kimi-k3.1", provider: "bedrock", auth: {}, env: {}, secrets: [BEDROCK_KEY] });
    expect(a.route).toMatchObject({ format: "bedrock", upstream: "https://bedrock-runtime.us-east-1.amazonaws.com" });

    const relayUrl = `${PUBLIC}/api/v1/harness-relay/tok`;
    const b = brokeredHarnessAuth(a, "relay", relayUrl);
    const provider = (b.openCodeConfig as any).provider["amazon-bedrock"];
    expect(b.openCodeConfig).toMatchObject({ enabled_providers: ["amazon-bedrock"], model: "amazon-bedrock/global.moonshotai.kimi-k3.1", small_model: "amazon-bedrock/global.moonshotai.kimi-k3.1" });
    expect(provider.options).toMatchObject({ region: "us-east-1", endpoint: relayUrl });
    expect(provider.options.apiKey).toMatch(/^polpo-placeholder-/);
    expect(provider.models).toEqual({ "global.moonshotai.kimi-k3.1": {} });
    expect(JSON.stringify(b.openCodeConfig)).not.toContain(BEDROCK_KEY);
    expect(b.credentialRules).toEqual([{
      match: { host: "bedrock-runtime.us-east-1.amazonaws.com", headers: [{ key: { exact: "authorization" }, value: { exact: `Bearer ${provider.options.apiKey}` } }] },
      transform: { headers: { authorization: `Bearer ${BEDROCK_KEY}`, "x-api-key": "" } },
    }]);

    // not brokered (no relay reachable): the key goes into OpenCode's config, Bedrock's own endpoint
    const n = brokeredHarnessAuth(a, "none");
    expect((n.openCodeConfig as any).provider["amazon-bedrock"].options).toEqual({ region: "us-east-1", apiKey: BEDROCK_KEY });
    expect(n.credentialRules).toBeUndefined();
  });

  it("Bedrock refuses AWS access keys (SigV4 cannot be brokered) and asks for a model", async () => {
    await expect(resolveHarnessAuth({ harness: "opencode" }, parseHarnessesSettings({ ...bedrock, opencode: { ...bedrock.opencode, credentialRef: ref("sigv4") } }), vault))
      .rejects.toThrow(/Bedrock API key[\s\S]*SigV4/);
    const { model: _m, ...noModel } = bedrock.opencode;
    await expect(resolveHarnessAuth({ harness: "opencode" }, parseHarnessesSettings({ ...bedrock, opencode: noModel }), vault)).rejects.toThrow(/OpenCode needs a model/);
  });

  it("a provider API key (Moonshot): the provider's own vault field; an agent's model and own key win", async () => {
    const s = parseHarnessesSettings({ enabled: ["opencode"], opencode: { auth: "api-key", provider: "moonshotai", credentialRef: ref("moonshot"), model: "kimi-k2-0905-preview" } });
    const a = await resolveHarnessAuth({ harness: "opencode", model: "moonshotai/kimi-k2-turbo-preview" }, s, vault);
    expect(a).toMatchObject({ model: "moonshotai/kimi-k2-turbo-preview", providerLabel: "Moonshot AI", route: { format: "openai-chat", upstream: "https://api.moonshot.ai/v1", key: "sk-moonshot-REAL" } });
    const b = brokeredHarnessAuth(a, "relay", `${PUBLIC}/r/tok`);
    expect((b.openCodeConfig as any).provider.moonshotai.options).toEqual({ apiKey: expect.stringMatching(/^polpo-placeholder-/), baseURL: `${PUBLIC}/r/tok` });
    const own = await resolveHarnessAuth({ harness: "opencode", credentialRef: ref("gw") }, s, vault);
    expect(own.route!.key).toBe("gw-REAL-key");
  });

  it("custom gateway: Anthropic format with a Bearer key (authToken), secret headers by the relay or in the config", async () => {
    const s = parseHarnessesSettings({ enabled: ["opencode"], opencode: {
      auth: "gateway", gateway: { format: "anthropic", baseUrl: "https://gw.example.com/anthropic", authScheme: "bearer", credentialRef: ref("gw"), headers: [{ name: "x-portkey-api-key", credentialRef: ref("pk") }], models: { main: "glm-4.6" } },
    } });
    const a = await resolveHarnessAuth({ harness: "opencode" }, s, vault);
    expect(a.route).toMatchObject({ format: "anthropic", mode: "gateway", upstream: "https://gw.example.com/anthropic/v1", scheme: "bearer", headers: { "x-portkey-api-key": "pk-secret-header" } });
    const b = brokeredHarnessAuth(a, "relay", `${PUBLIC}/r/t`);
    const p = (b.openCodeConfig as any).provider["polpo-gateway"];
    expect(p).toMatchObject({ npm: "@ai-sdk/anthropic", name: "Polpo gateway", models: { "glm-4.6": {} } });
    expect(p.options.authToken).toMatch(/^polpo-placeholder-/);
    expect(p.options.headers).toBeUndefined();
    expect(JSON.stringify(b.openCodeConfig)).not.toMatch(/gw-REAL-key|pk-secret-header/);
    const n = brokeredHarnessAuth(a, "none");
    expect((n.openCodeConfig as any).provider["polpo-gateway"].options).toEqual({ authToken: "gw-REAL-key", baseURL: "https://gw.example.com/anthropic/v1", headers: { "x-portkey-api-key": "pk-secret-header" } });
    // an OpenAI-format gateway that wants x-api-key needs the relay (OpenCode sends Bearer)
    const xk = await resolveHarnessAuth({ harness: "opencode" }, parseHarnessesSettings({ enabled: ["opencode"], opencode: {
      auth: "gateway", gateway: { format: "openai-chat", baseUrl: "https://gw.example.com/v1", authScheme: "x-api-key", credentialRef: ref("gw"), models: { main: "m" } },
    } }), vault);
    expect(() => brokeredHarnessAuth(xk, "none")).toThrow(/needs Polpo's model relay/);
    expect(openCodeCredentialRules({ upstream: "https://gw.example.com/v1", placeholder: "ph", sends: "bearer", keyHeader: "x-api-key", key: "k" })[0]!.transform.headers)
      .toEqual({ "x-api-key": "k", authorization: "" });
  });

  it("errors name the provider (Bedrock model access is not retryable)", () => {
    const c = classifyHarnessError("API Error: 403 You don't have access to the model with the specified model ID.", { harnessName: "OpenCode", provider: "bedrock", model: "amazon-bedrock/global.moonshotai.kimi-k3.1" });
    expect(c).toMatchObject({ retryable: false });
    expect(c.message).toMatch(/^Bedrock: model "amazon-bedrock\/global.moonshotai.kimi-k3.1" not enabled/);
    expect(classifyHarnessError("invalid api key", { harnessName: "OpenCode", provider: "other", providerLabel: "Moonshot AI" }).message).toMatch(/^Moonshot AI: authentication failed/);
  });
});

// ── the real adapter over Polpo's sandbox session ───────────────────────

function vmDriver(spawned: Array<{ command: string; env?: Record<string, string> }>): RemoteDriver {
  return {
    remoteId: "vm-1",
    exec: async (command) => {
      if (command.includes("HOME")) return { exitCode: 0, stdout: "/root", stderr: "" };
      if (command.startsWith("stat ")) return { exitCode: 1, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    readFile: async () => new Uint8Array(), writeFile: async () => {}, suspend: async () => {}, resume: async () => {}, destroy: async () => {},
    spawn: async (command, o) => { spawned.push({ command, ...(o.env ? { env: o.env } : {}) }); throw new Error("test: bridge not started"); },
    portEndpoint: async (port) => ({ url: `wss://${port}-vm.proxy` }),
  };
}

describe("OpenCode adapter in the VM (real @ai-sdk/harness-opencode)", () => {
  it("relay: the bridge's environment has no key and blanks the computer's provider variables; Polpo's rule swaps the placeholder", async () => {
    const vault = memoryVault({ "ops/bedrock": { apiKey: BEDROCK_KEY } });
    const upstream: Array<{ url: string; headers: Record<string, string> }> = [];
    const f = (async (url: string | URL, init: RequestInit = {}) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
      upstream.push({ url: String(url), headers });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const a = await resolveHarnessAuth({ harness: "opencode" }, parseHarnessesSettings(bedrock), vault);
    const lease = new HarnessRelayLease({ polpoDir: "/nowhere", publicUrl: PUBLIC, upstream: a.route!.upstream, fetch: f, listen: false });
    const b = brokeredHarnessAuth(a, "relay", lease.baseUrl);
    const spawned: Array<{ command: string; env?: Record<string, string> }> = [];
    const machine = remoteHarnessMachine({ driver: async () => vmDriver(spawned), workDir: "/work", label: "nina" });
    const session: any = createHarnessSandboxSession(machine, { port: 4010, broker: { lease, credentialRules: b.credentialRules }, spawnEnv: { ...OPENCODE_BLANK_ENV } });
    // Polpo's rule is the lease's from the start (the adapter registers none: its auth is empty)
    expect(lease.registeredRules).toHaveLength(1);

    const { actualCreateOpenCode } = await import("@ai-sdk/harness-opencode") as any;
    const harness: any = actualCreateOpenCode({ auth: {}, provider: "amazon-bedrock", openCodeConfig: b.openCodeConfig, startupTimeoutMs: 1000 });
    await expect(harness.doStart({ sessionId: "s1", sessionWorkDir: "/work/task", sandboxSession: session })).rejects.toThrow(/bridge not started/);
    expect(spawned).toHaveLength(1);
    const env = spawned[0]!.env!;
    expect(spawned[0]!.command).toMatch(/bridge\.mjs/);
    expect(JSON.stringify(spawned)).not.toContain(BEDROCK_KEY);
    // only the bridge's own variables are set; the computer's provider credentials are blanked
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe("");
    expect(env.OPENAI_API_KEY).toBe("");
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.AI_GATEWAY_API_KEY).toBe("");
    expect(Object.entries(env).filter(([, v]) => v !== "").map(([k]) => k).sort()).toEqual(expect.arrayContaining(["BRIDGE_WS_PORT"]));
    expect(Object.entries(env).some(([k, v]) => v !== "" && /KEY|TOKEN/.test(k) && !/^AI_SDK_HARNESS|^BRIDGE_AUTH/.test(k))).toBe(false);

    // OpenCode → relay with the placeholder → Bedrock with the key
    const placeholder = (b.openCodeConfig as any).provider["amazon-bedrock"].options.apiKey;
    const res = await lease.handle(new Request(`${lease.baseUrl}/model/global.moonshotai.kimi-k3.1/converse-stream`, { method: "POST", headers: { authorization: `Bearer ${placeholder}` }, body: "{}" }), "/model/global.moonshotai.kimi-k3.1/converse-stream");
    expect(res.status).toBe(200);
    expect(upstream[0]).toMatchObject({ url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/global.moonshotai.kimi-k3.1/converse-stream" });
    expect(upstream[0]!.headers.authorization).toBe(`Bearer ${BEDROCK_KEY}`);
    // a stale placeholder is refused
    expect((await lease.handle(new Request(`${lease.baseUrl}/model/x/converse`, { method: "POST", headers: { authorization: "Bearer polpo-placeholder-old" }, body: "{}" }), "/model/x/converse")).status).toBe(401);
  });

  it("a provider with a native egress transformer gets Polpo's rule before the bridge starts", async () => {
    const native: any[][] = [];
    const spawned: Array<{ command: string; env?: Record<string, string> }> = [];
    const d = vmDriver(spawned);
    d.requestTransformations = async (rules) => { native.push([...rules]); };
    const machine = remoteHarnessMachine({ driver: async () => d, workDir: "/work", label: "nina", nativeTransformations: true });
    const rules = openCodeCredentialRules({ upstream: "https://api.moonshot.ai/v1", placeholder: "ph", sends: "bearer", keyHeader: "bearer", key: "sk-real" });
    const session: any = createHarnessSandboxSession(machine, { port: 4011, broker: { credentialRules: rules } });
    expect(native).toHaveLength(0);
    await expect(session.spawn({ command: "node bridge.mjs" })).rejects.toThrow(/bridge not started/);
    expect(native[0]).toEqual(rules);
  });
});

// ── SDK wrapper ─────────────────────────────────────────────────────────

describe("OpenCode SDK wrapper", () => {
  const spec = (o: Record<string, unknown> = {}) => ({
    harness: "opencode" as const, id: "kim", instructions: "Be brief.", skills: [], permissionMode: "allow-all" as const, maxTurns: 10,
    model: "amazon-bedrock/global.moonshotai.kimi-k3.1",
    auth: { auth: {}, env: {}, secrets: [], openCode: { provider: "amazon-bedrock" }, openCodeConfig: { enabled_providers: ["amazon-bedrock"], provider: { "amazon-bedrock": { options: { region: "us-east-1", apiKey: "polpo-placeholder-x" } } } } },
    tools: [{ name: "register_outcome", description: "Register", inputSchema: { type: "object", properties: {} }, execute: async () => "ok" }],
    ...o,
  });

  it("createOpenCode: an empty explicit auth (no env, no auth.json, no subscription), Polpo's config, the provider, effort as a variant", () => {
    const h = buildHarness(spec({ effort: "xhigh" }) as any);
    expect(h.harnessId).toBe("opencode");
    const s = sdk.openCode[0];
    expect(s.auth).toEqual({});
    expect(typeof s.auth).toBe("object");
    expect(s).toMatchObject({ provider: "amazon-bedrock", reasoningVariant: "high", openCodeConfig: { enabled_providers: ["amazon-bedrock"] } });
    expect(openCodeReasoningVariant("low")).toBe("low");
    expect(openCodeReasoningVariant(undefined)).toBeUndefined();
  });

  it("the agent gets the provider/model; a turn's cost is the sum of OpenCode's per-step costs", async () => {
    const runtime = createSdkHarnessRuntime(spec() as any);
    expect(sdk.agents[0]).toMatchObject({ model: "amazon-bedrock/global.moonshotai.kimi-k3.1", instructions: "Be brief." });
    expect(sdk.agents[0].headers).toBeUndefined();
    const session = await runtime.createSession({ sandbox: { id: "x", defaultWorkingDirectory: "/w", ports: [4000] } as any });
    const step = (cost: number | undefined) => ({ type: "finish-step", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, ...(cost !== undefined ? { providerMetadata: { opencode: { cost } } } : {}) });
    sdk.parts.push([
      { type: "text-delta", text: "ok" }, { type: "text-end" }, step(0.012), step(0.008), step(undefined),
      { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 30, outputTokens: 15, totalTokens: 45 } },
    ]);
    const r = await session.turn("go", { onEvent: () => {} });
    expect(r.costUsd).toBeCloseTo(0.02);
    expect(r.usage.totalTokens).toBe(45);
    sdk.parts.push([step(0.005), { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }]);
    expect((await session.turn("again", { onEvent: () => {} })).costUsd).toBeCloseTo(0.005);
    expect(session.cumulativeCostUsd).toBeCloseTo(0.025);
    // no cost reported: none (not 0)
    sdk.parts.push([{ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }]);
    expect((await session.turn("third", { onEvent: () => {} })).costUsd).toBeUndefined();
    expect(stepCostUsd({ harnessMetadata: { opencode: { cost: 0.1 } } })).toBe(0.1);
    expect(stepCostUsd({ providerMetadata: { "claude-code": { costUsd: 1 } } })).toBeUndefined();
  });
});

// ── the engine ──────────────────────────────────────────────────────────

describe("OpenCode engine run", () => {
  const task = { id: "t-oc", title: "Notes", description: "x", expectations: [], status: "in_progress" } as any;

  function run(o: { publicUrl?: string; turnCost?: number }) {
    const root = tmp("polpo-oc-");
    const polpoDir = join(root, ".polpo");
    mkdirSync(polpoDir, { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "x");
    const vault = memoryVault({ "ops/bedrock": { apiKey: BEDROCK_KEY } });
    let spec: any;
    let sandbox: any;
    const leases: InstanceType<typeof HarnessRelayLease>[] = [];
    const spawnedEnv: Array<Record<string, string> | undefined> = [];
    const usage: any[] = [];
    const machine = {
      id: "nina", description: "", workDir: root,
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      readFile: async () => null, writeFile: async () => {}, stat: async () => null, list: async () => null, remove: async () => false,
      spawn: async (_c: string, x: { env?: Record<string, string> }) => { spawnedEnv.push(x.env); throw new Error("no"); },
      portEndpoint: async () => ({ url: "ws://x" }), close: () => {},
    };
    const transcript: any[] = [];
    const handle = spawnHarnessEngine({ name: "kim", role: "dev", engine: { harness: "opencode" } } as any, task, root, { polpoDir, outputDir: join(polpoDir, "output", "t-oc"), vaultStore: vault } as any, {
      settings: () => ({ harnesses: { ...bedrock, allowHost: true } }) as any,
      publicUrl: () => o.publicUrl,
      openRelayLease: async (x) => { const l = new HarnessRelayLease({ ...x, listen: false }); leases.push(l); return l; },
      openMachine: async () => ({ machine: machine as any, computerId: "nina", hold: () => () => {} }),
      runtimeFactory: (s) => { spec = s; return { harness: "opencode", createSession: async (x: any) => { sandbox = x.sandbox; return {
        sessionId: "hs", workDir: root, isResume: false, steer: async () => {}, detach: async () => ({}), stop: async () => ({}), destroy: async () => {},
        turn: async () => ({ text: "done", finishReason: "stop", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 120 }, ...(o.turnCost !== undefined ? { costUsd: o.turnCost } : {}) }),
      }; } } as any; },
      recordUsage: async (r) => { usage.push(r); },
    });
    handle.onTranscript = (e) => transcript.push(e);
    return { handle, transcript, leases, usage, spawnedEnv, getSpec: () => spec, getSandbox: () => sandbox };
  }

  it("relay: Polpo's rule on the lease, the relay URL in OpenCode's config, blanked env; OpenCode's cost recorded", async () => {
    const env = run({ publicUrl: PUBLIC, turnCost: 0.0042 });
    const r = await env.handle.done;
    expect(r.exitCode).toBe(0);
    const l = env.leases[0]!;
    expect(l.upstream.toString()).toBe("https://bedrock-runtime.us-east-1.amazonaws.com/");
    const options = env.getSpec().auth.openCodeConfig.provider["amazon-bedrock"].options;
    expect(options.endpoint).toBe(l.baseUrl);
    expect(env.getSpec().model).toBe("amazon-bedrock/global.moonshotai.kimi-k3.1");
    expect(env.getSpec().auth.auth).toEqual({});
    expect(JSON.stringify(env.getSpec().auth.openCodeConfig)).not.toContain(BEDROCK_KEY);
    // the rule was the lease's before revocation (revoked: cleared)
    expect(l.status).toBe("revoked");
    // every process OpenCode starts gets the computer's provider variables blanked
    await env.getSandbox().spawn({ command: "node bridge.mjs", env: { BRIDGE_WS_PORT: "4000" } }).catch(() => undefined);
    expect(env.spawnedEnv.at(-1)).toMatchObject({ AWS_BEARER_TOKEN_BEDROCK: "", OPENAI_API_KEY: "", BRIDGE_WS_PORT: "4000" });
    expect(env.usage[0]).toMatchObject({ source: "agent_harness", provider: "opencode", model: "amazon-bedrock/global.moonshotai.kimi-k3.1", cost: 0.0042, totalTokens: 120 });
    expect(env.transcript.find((e) => e.type === "usage")).toMatchObject({ harness: "opencode", costUsd: 0.0042, costSource: "runtime" });
  });

  it("a model OpenCode has no price for (cost 0 with tokens) is recorded as tokens only", async () => {
    const env = run({ publicUrl: PUBLIC, turnCost: 0 });
    await env.handle.done;
    expect(env.transcript.find((e) => e.type === "usage")).toMatchObject({ costSource: "tokens-only" });
    expect(env.transcript.find((e) => e.type === "usage").costUsd).toBeUndefined();
  });

  it("without POLPO_PUBLIC_URL: the key in OpenCode's config (warned), no rules", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = run({});
    await env.handle.done;
    expect(env.leases).toHaveLength(0);
    expect(env.getSpec().auth.openCodeConfig.provider["amazon-bedrock"].options).toEqual({ region: "us-east-1", apiKey: BEDROCK_KEY });
    expect(env.getSandbox().addRequestTransformations).toBeUndefined();
    warn.mockRestore();
  });
});

// ── the connection test ─────────────────────────────────────────────────

describe("OpenCode connection test", () => {
  it("Chat Completions (Moonshot): streamed chunks pass; the request goes to the provider with the key", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const f = (async (url: string, init: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
      calls.push({ url, headers, body: JSON.parse(String(init.body)) });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const settings = parseHarnessesSettings({ enabled: [], opencode: { auth: "api-key", provider: "moonshotai", credentialRef: ref("m"), model: "kimi-k2-0905-preview" } });
    const r = await testHarnessConnection({ harness: "opencode", settings, vault: memoryVault({ "ops/m": { apiKey: "sk-moon" } }), fetch: f });
    expect(r).toMatchObject({ ok: true, harness: "opencode", auth: "api-key", model: "moonshotai/kimi-k2-0905-preview", endpoint: "api.moonshot.ai/v1/chat/completions" });
    expect(calls[0]!.headers.authorization).toBe("Bearer sk-moon");
    expect(calls[0]!.body).toMatchObject({ model: "kimi-k2-0905-preview", stream: true, tools: [expect.objectContaining({ type: "function" })] });
  });

  it("Bedrock: Converse with the Bedrock API key and the model; access denied is labelled, the key scrubbed", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ message: `You don't have access to the model with the specified model ID. ${BEDROCK_KEY}` }), { status: 403 })) as unknown as typeof fetch;
    const r = await testHarnessConnection({ harness: "opencode", settings: parseHarnessesSettings(bedrock), vault: memoryVault({ "ops/bedrock": { apiKey: BEDROCK_KEY } }), fetch: f });
    expect(r).toMatchObject({ ok: false, errorKind: "model", endpoint: "bedrock-runtime.us-east-1.amazonaws.com/model/global.moonshotai.kimi-k3.1/converse" });
    expect(r.error).not.toContain(BEDROCK_KEY);
    const [url, init] = (f as any).mock.calls[0];
    expect(String(url)).toContain("/model/global.moonshotai.kimi-k3.1/converse");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${BEDROCK_KEY}`);
  });

  it("a missing model is a configuration error", async () => {
    const r = await testHarnessConnection({ harness: "opencode", settings: parseHarnessesSettings({ enabled: [], opencode: { auth: "api-key", provider: "openai", credentialRef: ref("o") } }), vault: memoryVault({ "ops/o": { apiKey: "sk" } }) });
    expect(r).toMatchObject({ ok: false, errorKind: "config" });
    expect(r.error).toMatch(/OpenCode needs a model/);
  });
});
