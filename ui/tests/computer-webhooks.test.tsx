import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ComputerWebhooksSection } from "../src/components/config/computer-webhooks-section";
import type { ComputerWebhookStatus } from "../src/lib/computers-api";

const base = (p: "daytona" | "e2b", extra: Partial<ComputerWebhookStatus> = {}): ComputerWebhookStatus => ({
  provider: p, label: p === "daytona" ? "Daytona" : "E2B", registration: p === "daytona" ? "manual" : "api", secretSet: false,
  inUse: true, received: 0, rejected: 0, ignored: 0, state: "not-configured", url: `https://host.ts.net/lumea/api/v1/computers/webhooks/${p}`, ...extra,
});

let providers: ComputerWebhookStatus[];
let calls: Array<{ method: string; path: string; body?: unknown }>;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  providers = [base("daytona"), base("e2b")];
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname.replace("/api/v1", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const reply = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200 });
    if (path === "/computer-webhooks") return reply({ providers, note: "Behind Tailscale Funnel, expose the path /<instance>/api/v1/computers/webhooks/ as well.", reconcileOnly: ["vercel"] });
    if (path === "/computer-webhooks/daytona/secret" && method === "PUT") { providers[0] = { ...providers[0]!, secretSet: true, state: "configured" }; return reply(providers[0]); }
    if (path === "/computer-webhooks/e2b/register" && method === "POST") { providers[1] = { ...providers[1]!, secretSet: true, registered: true, state: "configured" }; return reply(providers[1]); }
    throw new Error(`unexpected ${method} ${path}`);
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

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

test("Settings → Computers: each provider's webhook state and URL; Daytona's secret goes to the vault; E2B registers", async () => {
  // a secret removed after events came in: not configured, its last event still shown
  providers[0] = base("daytona", { received: 3, lastEventAt: new Date(Date.now() - 2 * 60_000).toISOString(), lastEventType: "sandbox.state.updated" });
  await act(async () => root.render(<ComputerWebhooksSection />));
  await flush();
  const daytona = $('[data-testid="webhook-daytona"]')!;
  expect(daytona.querySelector('[data-testid="webhook-state"]')!.textContent).toBe("Not configured");
  expect(daytona.querySelector('[data-testid="webhook-url"]')!.textContent).toBe("https://host.ts.net/lumea/api/v1/computers/webhooks/daytona");
  expect(daytona.textContent).toMatch(/2 min ago · sandbox\.state\.updated/);
  expect(document.body.textContent).toMatch(/Tailscale Funnel/);
  const input = daytona.querySelector<HTMLInputElement>('input[aria-label="Daytona signing secret"]')!;
  expect(input.type).toBe("password");
  expect(input.getAttribute("data-setup-field")).toBe("secret");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "whsec_abcdefghijklmnopqrstuvwxyz");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { daytona.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
  await flush();
  expect(calls.find((c) => c.method === "PUT")).toEqual({ method: "PUT", path: "/computer-webhooks/daytona/secret", body: { secret: "whsec_abcdefghijklmnopqrstuvwxyz" } });
  expect($('[data-testid="webhook-daytona"] [data-testid="webhook-state"]')!.textContent).toBe("Configured, no events yet");
  const register = [...$('[data-testid="webhook-e2b"]')!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Register")!;
  await act(async () => { register.click(); });
  await flush();
  expect(calls.some((c) => c.method === "POST" && c.path === "/computer-webhooks/e2b/register")).toBe(true);
  expect([...$('[data-testid="webhook-e2b"]')!.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Unregister")).toBe(true);
});
