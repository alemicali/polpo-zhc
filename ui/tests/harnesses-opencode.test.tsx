import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@/hooks/use-vault-catalog", () => ({
  useVaultCatalog: () => ({ entries: [{ owner: "ops", service: "bedrock", type: "api_key", keys: ["apiKey"], allowedAgents: [] }], loading: false, error: null, refresh: () => {} }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { HarnessesSection } from "../src/components/config/harnesses-section";
import { BrandIcon } from "../src/components/shared/brand-icon";
import { cleanHarnessSettings, openCodeModelExample, settingsFromOverview, type HarnessesOverview } from "../src/lib/harnesses-api";
import { agentEngineId, authBrand, engineBrand, engineLabel, openCodeProviderIcon } from "../src/lib/run-context";

let root: Root;
let container: HTMLDivElement;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON request bodies, read in assertions
let calls: Array<{ method: string; path: string; body?: any }>;
let overview: HarnessesOverview;
const ok = (data: unknown) => Promise.resolve(new Response(JSON.stringify({ ok: true, data }), { status: 200 }));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  calls = [];
  overview = {
    allowHost: false, computers: ["nina"], relay: { available: true, url: "https://p.example/api/v1/harness-relay/", path: "/api/v1/harness-relay/" },
    harnesses: [
      { id: "claude-code", name: "Claude Code", enabled: false, agents: [] },
      { id: "codex", name: "Codex", enabled: false, agents: [] },
      { id: "opencode", name: "OpenCode", enabled: false, agents: [] },
    ],
  };
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname.replace("/api/v1", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path, body });
    if (path === "/harnesses") return ok(overview);
    if (path === "/harnesses/sessions") return ok({ sessions: [] });
    if (path === "/harnesses/test") return ok({ ok: true, harness: "opencode", latencyMs: 300, model: "polpo-gateway/qwen3-coder", endpoint: "openrouter.ai/api/v1/chat/completions" });
    return ok({});
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
function change(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}
const q = <T extends Element>(sel: string) => container.querySelector<T>(sel)!;

test("OpenCode settings as the server takes them: provider kept for API keys, region for Bedrock, one gateway model", () => {
  expect(cleanHarnessSettings({
    enabled: ["opencode"],
    opencode: { auth: "bedrock", provider: "anthropic", credentialRef: { owner: "ops", service: "bedrock" }, bedrock: { region: "us-east-1" }, model: "global.moonshotai.kimi-k3.1" },
  }).opencode).toEqual({ auth: "bedrock", credentialRef: { owner: "ops", service: "bedrock" }, bedrock: { region: "us-east-1" }, model: "global.moonshotai.kimi-k3.1" });
  expect(cleanHarnessSettings({
    enabled: [], opencode: { auth: "gateway", credentialRef: { owner: "x", service: "y" }, gateway: { format: "openai-chat", baseUrl: "https://g/v1", authScheme: "bearer", credentialRef: { owner: "ops", service: "g" }, models: { main: "m", haiku: "h" }, nonClaude: true } },
  }).opencode).toEqual({ auth: "gateway", gateway: { format: "openai-chat", baseUrl: "https://g/v1", authScheme: "bearer", credentialRef: { owner: "ops", service: "g" }, models: { main: "m" } } });
  // incomplete: left out
  expect(cleanHarnessSettings({ enabled: [], opencode: { auth: "api-key", provider: "openai" } }).opencode).toBeUndefined();
  expect(settingsFromOverview({ ...overview, harnesses: [{ ...overview.harnesses[2]!, enabled: true, settings: { auth: "api-key", provider: "xai", credentialRef: { owner: "o", service: "s" } } }] }))
    .toEqual({ enabled: ["opencode"], opencode: { auth: "api-key", provider: "xai", credentialRef: { owner: "o", service: "s" } } });
  expect(openCodeModelExample({ auth: "bedrock" })).toBe("global.moonshotai.kimi-k3.1");
  expect(openCodeModelExample({ auth: "api-key", provider: "zai" })).toBe("glm-4.6");
});

test("Settings → Harnesses: OpenCode with its mark, provider picker, a Chat Completions gateway, test and save", async () => {
  await act(async () => root.render(<MemoryRouter><HarnessesSection /></MemoryRouter>));
  await flush();
  const card = q('[data-testid="harness-opencode"]');
  expect(card.querySelector('[data-brand="opencode"]')).toBeTruthy();
  await act(async () => (q<HTMLInputElement>('input[aria-label="Enable OpenCode"]')).click());
  // provider API key by default: the provider picker and the model with its example
  expect(q<HTMLSelectElement>('select[aria-label="OpenCode provider"]').value).toBe("anthropic");
  await act(async () => change(q<HTMLSelectElement>('select[aria-label="OpenCode provider"]'), "moonshotai"));
  expect(q<HTMLInputElement>('input[aria-label="OpenCode model"]').placeholder).toBe("kimi-k2-0905-preview");
  // Bedrock: region and the API-key note
  await act(async () => change(q<HTMLSelectElement>('select[aria-label="OpenCode authentication"]'), "bedrock"));
  expect(q('input[aria-label="OpenCode Bedrock region"]')).toBeTruthy();
  expect(card.textContent).toMatch(/AWS access keys sign every request/);
  // a gateway: OpenAI Chat Completions by default, the OpenRouter preset's /v1 URL
  await act(async () => change(q<HTMLSelectElement>('select[aria-label="OpenCode authentication"]'), "gateway"));
  expect(q<HTMLSelectElement>('select[aria-label="opencode gateway format"]').value).toBe("openai-chat");
  await act(async () => change(q<HTMLSelectElement>('select[aria-label="opencode gateway preset"]'), "openrouter"));
  expect(q<HTMLInputElement>('input[aria-label="opencode gateway base URL"]').value).toBe("https://openrouter.ai/api/v1");
  // the Anthropic format takes the URL without /v1
  await act(async () => change(q<HTMLSelectElement>('select[aria-label="opencode gateway format"]'), "anthropic"));
  expect(q<HTMLInputElement>('input[aria-label="opencode gateway base URL"]').value).toBe("https://openrouter.ai/api");
  await act(async () => change(q<HTMLSelectElement>('select[aria-label="opencode gateway format"]'), "openai-chat"));
  await act(async () => change(q<HTMLSelectElement>('select[aria-label="opencode gateway auth scheme"]'), "none"));
  await act(async () => change(q<HTMLInputElement>('input[aria-label="opencode gateway model main"]'), "qwen3-coder"));
  expect(container.querySelector('input[aria-label="opencode gateway model haiku"]')).toBeNull();

  await act(async () => (q<HTMLButtonElement>('button[aria-label="Test OpenCode connection"]')).click());
  await flush();
  expect(calls.find((c) => c.path === "/harnesses/test")!.body).toMatchObject({
    harness: "opencode", settings: { opencode: { auth: "gateway", gateway: { format: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", authScheme: "none", models: { main: "qwen3-coder" } } } },
  });
  expect(q('[data-testid="harness-test-opencode"]').textContent).toMatch(/Connected in 300 ms/);

  calls.length = 0;
  await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save")!.click());
  await flush();
  const save = calls.find((c) => c.path === "/config/settings")!;
  expect(save.body.harnesses.enabled).toEqual(["opencode"]);
  expect(save.body.harnesses.opencode).toMatchObject({ auth: "gateway", gateway: { format: "openai-chat" } });
  expect(save.body.harnesses.opencode.provider).toBeUndefined();
});

test("engine marks: OpenCode's logo and label; its provider's mark for the auth", async () => {
  expect(engineBrand("opencode")).toBe("opencode");
  expect(engineLabel("opencode")).toBe("OpenCode");
  expect(agentEngineId({ harness: "opencode", model: "x" })).toBe("opencode");
  expect(authBrand("bedrock", "opencode", "amazon-bedrock")).toBe("bedrock");
  expect(authBrand("api-key", "opencode", "anthropic")).toBe("anthropic");
  expect(authBrand("api-key", "opencode", "moonshotai")).toBe("api-key");
  expect(openCodeProviderIcon("opencode", { kind: "api-key", provider: "moonshotai" })).toBe("moonshotai");
  expect(openCodeProviderIcon("opencode", { kind: "ai-gateway", provider: "vercel" })).toBe("vercel");
  expect(openCodeProviderIcon("opencode", { kind: "bedrock", provider: "amazon-bedrock" })).toBeUndefined();
  expect(openCodeProviderIcon("claude-code", { kind: "api-key", provider: "x" })).toBeUndefined();
  await act(async () => root.render(<BrandIcon name="opencode" size={16} />));
  const svg = q("svg");
  expect(svg.getAttribute("aria-label")).toBe("OpenCode");
  // drawn in the text colour (OpenCode's mark is black)
  expect(svg.getAttribute("class")).toMatch(/fill-current/);
});
