import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// the vault picker reads the catalog: two entries
vi.mock("@/hooks/use-vault-catalog", () => ({
  useVaultCatalog: () => ({
    entries: [
      { owner: "ops", service: "cloudflare", type: "api_key", keys: ["token"], allowedAgents: [] },
      { owner: "ops", service: "openrouter", type: "api_key", keys: ["apiKey"], allowedAgents: [] },
    ],
    loading: false, error: null, refresh: () => {},
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { HarnessesSection, cleanHarnessSettings } from "../src/components/config/harnesses-section";
import { GATEWAY_PRESET_INFO, cloudflareIds, settingsFromOverview, type HarnessesOverview } from "../src/lib/harnesses-api";

let root: Root;
let container: HTMLDivElement;
let calls: Array<{ method: string; path: string; body?: any }>;
let overview: HarnessesOverview;

const ok = (data: unknown) => Promise.resolve(new Response(JSON.stringify({ ok: true, data }), { status: 200 }));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  calls = [];
  overview = {
    allowHost: false, computers: ["nina"],
    relay: { available: false, path: "/api/v1/harness-relay/", warning: "POLPO_PUBLIC_URL is not set: computers cannot reach Polpo's model relay." },
    harnesses: [
      { id: "claude-code", name: "Claude Code", enabled: false, agents: [] },
      { id: "codex", name: "Codex", enabled: false, agents: [] },
    ],
  };
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname.replace("/api/v1", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (path === "/harnesses") return ok(overview);
    if (path === "/harnesses/sessions") return ok({ sessions: [] });
    if (path === "/config/settings") return ok({});
    if (path === "/harnesses/test") {
      return ok(body.harness === "claude-code"
        ? { ok: true, harness: "claude-code", latencyMs: 412, model: "claude-sonnet-4-5", endpoint: "gateway.ai.cloudflare.com/v1/acc/gw/anthropic/v1/messages" }
        : { ok: false, harness: "codex", latencyMs: 80, errorKind: "auth", error: "Gateway: authentication failed" });
    }
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

test("presets build the gateway: Cloudflare ids → URL, cf-aig-authorization from the vault; cleaning drops empty slots", () => {
  const cf = GATEWAY_PRESET_INFO.find((p) => p.id === "cloudflare")!;
  expect(cf.baseUrl("claude-code", { account: "acc", gateway: "gw" })).toBe("https://gateway.ai.cloudflare.com/v1/acc/gw/anthropic");
  expect(cf.baseUrl("codex", { account: "acc", gateway: "gw" })).toBe("https://gateway.ai.cloudflare.com/v1/acc/gw/openai");
  expect(cloudflareIds("https://gateway.ai.cloudflare.com/v1/acc/gw/anthropic")).toEqual({ account: "acc", gateway: "gw" });
  expect(GATEWAY_PRESET_INFO.find((p) => p.id === "portkey")!.headers!("codex")).toEqual([{ name: "x-portkey-api-key" }, { name: "x-portkey-provider", value: "openai" }]);
  expect(cleanHarnessSettings({
    enabled: ["claude-code"],
    "claude-code": { auth: "gateway", credentialRef: { owner: "ops", service: "old" }, gateway: { format: "anthropic", baseUrl: "https://x", authScheme: "none", credentialRef: { owner: "a", service: "b" }, headers: [{ name: "" }, { name: "x-a", value: "1" }], models: { main: "" } } },
    codex: { auth: "ai-gateway", gateway: { baseUrl: "", credentialRef: { owner: "ops", service: "v" }, headers: [{ name: "x", value: "y" }] } },
  })).toEqual({
    enabled: ["claude-code"],
    "claude-code": { auth: "gateway", gateway: { format: "anthropic", baseUrl: "https://x", authScheme: "none", headers: [{ name: "x-a", value: "1" }] } },
    codex: { auth: "ai-gateway", gateway: { credentialRef: { owner: "ops", service: "v" } } },
  });
  // the form edits the setting as saved (gateway included)
  const saved = { auth: "gateway" as const, gateway: { format: "anthropic" as const, baseUrl: "https://x", authScheme: "bearer" as const, headers: [{ name: "h", credentialRef: { owner: "o", service: "s" }, credentialFound: true }] } };
  expect(settingsFromOverview({ ...overview, harnesses: [{ ...overview.harnesses[0]!, enabled: true, settings: saved }, overview.harnesses[1]!] })["claude-code"]!.gateway!.headers).toEqual([{ name: "h", credentialRef: { owner: "o", service: "s" } }]);
});

test("Settings → Harnesses: relay warning, a Cloudflare gateway for Claude Code, Test connection, and a test after every save", async () => {
  await act(async () => root.render(<MemoryRouter><HarnessesSection /></MemoryRouter>));
  await flush();
  expect(q('[data-testid="harness-relay-warning"]').textContent).toMatch(/POLPO_PUBLIC_URL is not set/);

  await act(async () => (q<HTMLInputElement>('input[aria-label="Enable Claude Code"]')).click());
  await act(async () => change(q<HTMLSelectElement>('select[aria-label="Claude Code authentication"]'), "gateway"));
  expect(q('[data-testid="claude-code-gateway"]')).toBeTruthy();
  await act(async () => change(q<HTMLSelectElement>('select[aria-label="claude-code gateway preset"]'), "cloudflare"));
  await act(async () => change(q<HTMLInputElement>('input[aria-label="claude-code Cloudflare Account id"]'), "acc"));
  await act(async () => change(q<HTMLInputElement>('input[aria-label="claude-code Cloudflare Gateway id"]'), "gw"));
  expect(q<HTMLInputElement>('input[aria-label="claude-code gateway base URL"]').value).toBe("https://gateway.ai.cloudflare.com/v1/acc/gw/anthropic");
  // the preset's auth: no key, the gateway token in cf-aig-authorization (a secret header: vault)
  expect(q<HTMLSelectElement>('select[aria-label="claude-code gateway auth scheme"]').value).toBe("none");
  expect(q<HTMLInputElement>('input[aria-label="claude-code header 1 name"]').value).toBe("cf-aig-authorization");
  expect(q<HTMLSelectElement>('select[aria-label="claude-code header 1 kind"]').value).toBe("secret");
  await act(async () => change(q<HTMLInputElement>('input[aria-label="claude-code gateway model main"]'), "claude-sonnet-4-5"));

  // Test connection: the settings being edited go to the server; the result is shown
  await act(async () => (q<HTMLButtonElement>('button[aria-label="Test Claude Code connection"]')).click());
  await flush();
  const test = calls.find((c) => c.path === "/harnesses/test")!;
  expect(test.body).toMatchObject({ harness: "claude-code", settings: { "claude-code": { auth: "gateway", gateway: { preset: "cloudflare", baseUrl: "https://gateway.ai.cloudflare.com/v1/acc/gw/anthropic", authScheme: "none", models: { main: "claude-sonnet-4-5" } } } } });
  expect(q('[data-testid="harness-test-claude-code"]').textContent).toMatch(/Connected in 412 ms/);

  // Save: the cleaned settings, then a test per enabled harness
  calls.length = 0;
  await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save")!.click());
  await flush();
  const save = calls.find((c) => c.path === "/config/settings")!;
  expect(save.body.harnesses).toMatchObject({ enabled: ["claude-code"], "claude-code": { auth: "gateway", gateway: { format: "anthropic", authScheme: "none" } } });
  expect(save.body.harnesses["claude-code"].credentialRef).toBeUndefined();
  expect(calls.filter((c) => c.path === "/harnesses/test").map((c) => c.body)).toEqual([{ harness: "claude-code" }]);
});
