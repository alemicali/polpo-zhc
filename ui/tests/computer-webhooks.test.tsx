import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// ── SDK mock: SSE buffer ────────────────────────────────────────────────────
type FakeEvent = { id: string; event: string; data: unknown; timestamp: string };
const sse = vi.hoisted(() => ({
  events: [] as FakeEvent[],
  listeners: new Set<() => void>(),
  push(event: string, data: unknown) {
    sse.events = [...sse.events, { id: String(sse.events.length + 1), event, data, timestamp: new Date().toISOString() }];
    sse.listeners.forEach((l) => l());
  },
}));
vi.mock("@polpo-ai/react", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useEvents: (filter?: string[]) => {
      const all = useSyncExternalStore(
        (cb) => { sse.listeners.add(cb); return () => sse.listeners.delete(cb); },
        () => sse.events,
      );
      return { events: filter?.length ? all.filter((e) => filter.includes(e.event)) : all };
    },
  };
});

import { MemoryRouter } from "react-router-dom";
import { ComputerWebhooksSection } from "../src/components/config/computer-webhooks-section";
import type { ComputerWebhookEvent, ComputerWebhookStatus } from "../src/lib/computers-api";

const base = (p: "daytona" | "e2b", extra: Partial<ComputerWebhookStatus> = {}): ComputerWebhookStatus => ({
  provider: p, label: p === "daytona" ? "Daytona" : "E2B", registration: p === "daytona" ? "manual" : "api", secretSet: false,
  inUse: true, received: 0, rejected: 0, ignored: 0, errors: 0, state: "not-configured", url: `https://host.ts.net/lumea/api/v1/computers/webhooks/${p}`, ...extra,
});

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const ev = (id: string, extra: Partial<ComputerWebhookEvent>): ComputerWebhookEvent => ({
  id, provider: "daytona", receivedAt: ago(3), outcome: "ignored", httpStatus: 200, signature: "valid", processingMs: 2, bytes: 120, ...extra,
});

let providers: ComputerWebhookStatus[];
let log: ComputerWebhookEvent[];
let calls: Array<{ method: string; path: string; body?: unknown; search?: string }>;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  sse.events = [];
  providers = [base("daytona"), base("e2b")];
  log = [];
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname.replace("/api/v1", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body, search: url.search });
    const reply = (data: unknown, status = 200) => new Response(JSON.stringify(status === 200 ? { ok: true, data } : { ok: false, error: data }), { status });
    if (path === "/computer-webhooks") return reply({ providers, note: "Behind Tailscale Funnel, expose the path /<instance>/api/v1/computers/webhooks/ as well.", reconcileOnly: ["vercel"] });
    if (path === "/computer-webhooks/daytona/secret" && method === "PUT") { providers[0] = { ...providers[0]!, secretSet: true, state: "configured" }; return reply(providers[0]); }
    if (path === "/computer-webhooks/e2b/register" && method === "POST") { providers[1] = { ...providers[1]!, secretSet: true, registered: true, state: "configured" }; return reply(providers[1]); }
    const list = path.match(/^\/computer-webhooks\/(daytona|e2b)\/events$/);
    if (list) {
      const outcomes = url.searchParams.get("outcome")?.split(",") ?? [];
      const mine = log.filter((e) => e.provider === list[1]);
      const counts = { accepted: 0, ignored: 0, rejected: 0, error: 0 };
      for (const e of mine) counts[e.outcome]++;
      const events = mine.filter((e) => !outcomes.length || outcomes.includes(e.outcome)).map(({ payload: _p, headers: _h, ...s }) => s);
      return reply({ provider: list[1], events, total: mine.length, counts });
    }
    const one = path.match(/^\/computer-webhooks\/(daytona|e2b)\/events\/(.+)$/);
    if (one) {
      const e = log.find((x) => x.id === decodeURIComponent(one[2]!));
      return e ? reply(e) : reply("No delivery", 404);
    }
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
const $$ = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const render = async () => {
  await act(async () => root.render(<MemoryRouter><ComputerWebhooksSection /></MemoryRouter>));
  await flush();
};

test("Settings → Computers: each provider's webhook state and URL; Daytona's secret goes to the vault; E2B registers", async () => {
  // a secret removed after events came in: not configured, its last event still shown
  providers[0] = base("daytona", { received: 3, lastEventAt: ago(2), lastEventType: "sandbox.state.updated" });
  await render();
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
  expect(calls.find((c) => c.method === "PUT")).toMatchObject({ method: "PUT", path: "/computer-webhooks/daytona/secret", body: { secret: "whsec_abcdefghijklmnopqrstuvwxyz" } });
  expect($('[data-testid="webhook-daytona"] [data-testid="webhook-state"]')!.textContent).toBe("Configured");
  const register = [...$('[data-testid="webhook-e2b"]')!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Register")!;
  await act(async () => { register.click(); });
  await flush();
  expect(calls.some((c) => c.method === "POST" && c.path === "/computer-webhooks/e2b/register")).toBe(true);
  expect([...$('[data-testid="webhook-e2b"]')!.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Unregister")).toBe(true);
});

test("configured, nothing received: the waiting note (Daytona v2); counters per outcome; no stale 'not configured' problem", async () => {
  providers[0] = base("daytona", {
    secretSet: true, state: "configured", rejected: 4,
    waitingNote: "Waiting for the first event. Daytona currently sends webhooks only for its classic sandboxes (containers), not for Daytona v2 VMs, so v2 computers may never produce one. Polpo also checks every computer at its provider every 5 minutes and whenever it is used.",
  });
  await render();
  const daytona = $('[data-testid="webhook-daytona"]')!;
  expect(daytona.querySelector('[data-testid="webhook-waiting"]')!.textContent).toMatch(/Daytona v2 VMs.*every 5 minutes/);
  expect(daytona.querySelector('[data-testid="webhook-counts"]')!.textContent).toMatch(/0 accepted · 0 ignored · 4 rejected/);
  expect(daytona.querySelector('[data-testid="webhook-last-error"]')).toBeNull();
  // the log is empty: it says why
  await act(async () => { daytona.querySelector<HTMLButtonElement>('[data-testid="webhook-events-open"]')!.click(); });
  await flush();
  expect($('[data-testid="webhook-events-empty"]')!.textContent).toMatch(/No delivery received yet.*Daytona v2 VMs/);
});

test("a provider's row opens its events: outcome badges, sandbox → computer link, reasons; filter; live; a delivery's details and redacted payload", async () => {
  providers[0] = base("daytona", { secretSet: true, state: "receiving", received: 2, ignored: 1, rejected: 1, lastEventAt: ago(1), lastEventType: "sandbox.state.updated" });
  log = [
    ev("e3", { outcome: "accepted", eventType: "sandbox.state.updated", sandboxId: "sbx-1", computerId: "nina", receivedAt: ago(1), deliveryId: "msg_3",
      providerState: { from: "started", to: "stopped" }, statusChange: { from: "running", to: "stopped", appliedAt: ago(1) }, action: 'Checked computer "nina" at Daytona: running → stopped',
      payload: { event: "sandbox.state.updated", id: "sbx-1", token: "[redacted]" }, headers: { "svix-id": "msg_3" } }),
    ev("e2", { outcome: "ignored", eventType: "sandbox.state.updated", sandboxId: "someone-elses", reason: "Not about one of this instance's computers (sandbox someone-elses)", receivedAt: ago(5) }),
    ev("e1", { outcome: "rejected", httpStatus: 401, signature: "invalid", eventType: "sandbox.created", reason: "Signature refused: signature does not match", receivedAt: ago(9) }),
  ];
  await render();
  await act(async () => { $<HTMLButtonElement>('[data-testid="webhook-daytona"] [data-testid="webhook-events-open"]')!.click(); });
  await flush();
  const sheet = $('[data-testid="webhook-events-sheet"]')!;
  expect(sheet.textContent).toMatch(/Daytona webhook events/);
  let rows = $$('[data-testid="webhook-event-row"]');
  expect(rows.map((r) => r.querySelector('[data-testid="webhook-outcome"]')!.textContent)).toEqual(["Accepted", "Ignored", "Rejected"]);
  expect(rows[0]!.textContent).toMatch(/sbx-1→nina/);
  expect(rows[0]!.querySelector("a")!.getAttribute("href")).toBe("/computers/nina");
  expect(rows[0]!.textContent).toMatch(/running → stopped/);
  expect(rows[1]!.textContent).toMatch(/Not about one of this instance's computers/);
  expect(rows[2]!.textContent).toMatch(/Signature refused/);
  expect($('[data-testid="webhook-filter-rejected"]')!.textContent).toMatch(/Rejected1/);
  // filter by outcome
  await act(async () => { $<HTMLButtonElement>('[data-testid="webhook-filter-rejected"]')!.click(); });
  await flush();
  expect(calls.at(-1)).toMatchObject({ path: "/computer-webhooks/daytona/events", search: expect.stringContaining("outcome=rejected") });
  expect($$('[data-testid="webhook-event-row"]')).toHaveLength(1);
  await act(async () => { $<HTMLButtonElement>('[data-testid="webhook-filter-all"]')!.click(); });
  await flush();
  // live: a new delivery for this provider reloads the list (another provider's does not)
  log.unshift(ev("e4", { outcome: "error", eventType: "sandbox.state.updated", reason: "Could not apply it: Daytona is down", receivedAt: ago(0) }));
  const lists = () => calls.filter((c) => c.path === "/computer-webhooks/daytona/events").length;
  const statuses = () => calls.filter((c) => c.path === "/computer-webhooks").length;
  const [beforeLists, beforeStatuses] = [lists(), statuses()];
  await act(async () => { sse.push("computer:webhook", { provider: "e2b", id: "x", action: "recorded", outcome: "ignored" }); });
  await flush();
  expect(lists()).toBe(beforeLists);
  // the cards' counters reload on any delivery
  expect(statuses()).toBe(beforeStatuses + 1);
  await act(async () => { sse.push("computer:webhook", { provider: "daytona", id: "e4", action: "recorded", outcome: "error" }); });
  await flush();
  rows = $$('[data-testid="webhook-event-row"]');
  expect(rows[0]!.querySelector('[data-testid="webhook-outcome"]')!.textContent).toBe("Error");
  // a delivery's details
  await act(async () => { rows[1]!.click(); });
  await flush();
  const dialog = $('[data-testid="webhook-event-dialog"]')!;
  expect(calls.at(-1)).toMatchObject({ path: "/computer-webhooks/daytona/events/e3" });
  expect(dialog.querySelector('[data-testid="webhook-event-action"]')!.textContent).toBe('Checked computer "nina" at Daytona: running → stopped');
  expect(dialog.textContent).toMatch(/Provider saysstarted → stopped/);
  expect(dialog.textContent).toMatch(/Delivery idmsg_3/);
  expect(dialog.querySelector('[data-testid="webhook-event-payload"]')!.textContent).toContain('"token": "[redacted]"');
  expect(dialog.querySelector('[data-slot="dialog-body"]')).not.toBeNull();
  expect(dialog.querySelector('[data-slot="dialog-footer"]')!.className).toMatch(/sticky/);
});
