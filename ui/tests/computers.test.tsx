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
import { ComputersPage } from "../src/pages/computers";
import { AgentComputerCard } from "../src/components/agents/agent-computer-card";
import {
  EMPTY_COMPUTER_FORM, availableActions, computerInput, formatLastUsed, formatUptime, validateComputerForm,
  type Computer,
} from "../src/lib/computers-api";

// ── Fake server ─────────────────────────────────────────────────────────────
const HOST: Computer = { id: "host", name: "This server", kind: "host", status: "running", uptimeMinutes: 0, builtin: true, agents: [{ name: "dev", isDefault: true }] };
const nina = (extra: Partial<Computer> = {}): Computer => ({
  id: "nina", name: "Nina", kind: "daytona", status: "stopped", uptimeMinutes: 125, lastUsedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  lifecycle: { idleStopMinutes: 15 }, agents: [{ name: "sitoinchat", isDefault: true }], ...extra,
});

let server: { computers: Computer[]; calls: Array<{ method: string; path: string; body?: unknown }> };

function ok(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify({ ok: true, data }), { status }));
}

function installFetch() {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/api/v1", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    server.calls.push({ method, path: `${path}${url.search}`, body });
    if (path === "/computers" && method === "GET") return ok({ computers: server.computers });
    if (path === "/computers" && method === "POST") {
      const created: Computer = { ...body, status: "missing", uptimeMinutes: 0, agents: [] };
      server.computers = [...server.computers, created];
      return ok(created, 201);
    }
    if (path.startsWith("/agents/")) return ok({});
    const [, , id, action] = path.split("/");
    const current = server.computers.find((c) => c.id === id)!;
    const save = (next: Computer) => { server.computers = server.computers.map((c) => (c.id === id ? next : c)); return next; };
    if (!action && method === "PATCH") return ok(save({ ...current, ...body }));
    if (!action && method === "DELETE") { server.computers = server.computers.filter((c) => c.id !== id); return ok({ deleted: id }); }
    if (action === "start" || action === "restart" || action === "reset") return ok(save({ ...current, status: "running" }));
    if (action === "stop") return ok(save({ ...current, status: "stopped" }));
    throw new Error(`unexpected ${method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// ── DOM helpers ─────────────────────────────────────────────────────────────
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  sse.events = [];
  server = { computers: [HOST, nina()], calls: [] };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const byText = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.trim() === text);
const inDialog = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((el) => el.textContent?.trim() === text);
const click = (el: Element | null | undefined) => act(async () => { (el as HTMLElement).click(); });
const card = (id: string) => document.querySelector<HTMLElement>(`[data-testid="computer-card-${id}"]`)!;
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function render(node: React.ReactNode) {
  await act(async () => root.render(<MemoryRouter>{node}</MemoryRouter>));
  await flush();
}

// ── Helpers ─────────────────────────────────────────────────────────────────
test("actions by status, uptime and last use, form validation and body", () => {
  expect(availableActions({ status: "running", kind: "daytona" })).toEqual(["stop", "restart", "reset"]);
  expect(availableActions({ status: "missing", kind: "e2b" })).toEqual(["start"]);
  expect(availableActions({ status: "creating", kind: "e2b" })).toEqual([]);
  expect(availableActions({ status: "running", kind: "host", builtin: true })).toEqual([]);
  expect(formatUptime(125)).toBe("2 h 5 min");
  expect(formatUptime(0)).toBe("—");
  expect(formatLastUsed(undefined)).toBe("never");
  expect(formatLastUsed(new Date(Date.now() - 3 * 3600_000).toISOString())).toBe("3 h ago");
  expect(validateComputerForm({ ...EMPTY_COMPUTER_FORM, id: "host" })).toMatchObject({ id: "This id is reserved" });
  expect(validateComputerForm({ ...EMPTY_COMPUTER_FORM, id: "nina" }, ["nina"])).toMatchObject({ id: expect.stringMatching(/exists/) });
  expect(validateComputerForm({ ...EMPTY_COMPUTER_FORM, id: "x", idleStopMinutes: "0" })).toHaveProperty("idleStopMinutes");
  expect(computerInput({ ...EMPTY_COMPUTER_FORM, id: "nina", name: "Nina", image: "polpo-runner-1", autoArchiveDays: "7", start: true }))
    .toEqual({ id: "nina", name: "Nina", kind: "daytona", snapshot: "polpo-runner-1", lifecycle: { idleStopMinutes: 15, autoArchiveDays: 7 }, start: true });
  // editing clears what was emptied
  expect(computerInput({ ...EMPTY_COMPUTER_FORM, id: "nina", name: "Nina" }, true)).toEqual({ name: "Nina", snapshot: null, image: null, lifecycle: { idleStopMinutes: 15 } });
});

// ── Page ────────────────────────────────────────────────────────────────────
test("cards show provider, status, agents, last use and uptime; host has no buttons", async () => {
  installFetch();
  await render(<ComputersPage />);
  const n = card("nina");
  expect(n.textContent).toContain("Daytona");
  expect(n.querySelector('[data-testid="computer-status"]')!.textContent).toBe("Stopped");
  expect(n.querySelector('[data-testid="computer-agents"]')!.textContent).toBe("sitoinchat");
  expect(n.textContent).toContain("10 min ago");
  expect(n.textContent).toContain("2 h 5 min");
  expect(card("host").querySelectorAll("button")).toHaveLength(0);
  // the first load asks the providers (live); later refreshes use the cached state
  expect(server.calls[0]!.path).toBe("/computers");
});

test("start and stop; reset and delete ask first", async () => {
  installFetch();
  await render(<ComputersPage />);
  await click(button("Start Nina"));
  await flush();
  expect(card("nina").querySelector('[data-testid="computer-status"]')!.textContent).toBe("Running");
  await click(button("Stop Nina"));
  await flush();
  expect(server.calls.some((c) => c.method === "POST" && c.path === "/computers/nina/stop")).toBe(true);

  await click(button("Reset Nina"));
  expect(document.querySelector('[role="dialog"]')!.textContent).toMatch(/everything on its disk/);
  expect(server.calls.some((c) => c.path === "/computers/nina/reset")).toBe(false);
  await click(inDialog("Reset"));
  await flush();
  expect(server.calls.find((c) => c.path === "/computers/nina/reset")!.body).toEqual({ confirm: true });

  await click(button("Delete Nina"));
  await click(inDialog("Delete"));
  await flush();
  expect(server.calls.find((c) => c.method === "DELETE")!.body).toEqual({ confirm: true });
  expect(document.querySelector('[data-testid="computer-card-nina"]')).toBeNull();
});

test("create a computer from the dialog", async () => {
  installFetch();
  server.computers = [HOST];
  await render(<ComputersPage />);
  await click(byText("New computer"));
  const inputs = [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input')];
  await type(inputs[0]!, "box");
  await type(inputs[1]!, "Box");
  await click(byText("Create"));
  await flush();
  const post = server.calls.find((c) => c.method === "POST" && c.path === "/computers")!;
  expect(post.body).toEqual({ id: "box", name: "Box", kind: "daytona", lifecycle: { idleStopMinutes: 15 } });
  expect(card("box")).toBeTruthy();
});

test("live: computer:changed refreshes from the cached state", async () => {
  installFetch();
  await render(<ComputersPage />);
  server.computers = [HOST, nina({ status: "creating" })];
  await act(async () => { sse.push("computer:changed", { id: "nina", action: "status", status: "creating" }); });
  await flush();
  expect(server.calls.at(-1)!.path).toBe("/computers?live=0");
  expect(card("nina").querySelector('[data-testid="computer-status"]')!.textContent).toBe("Creating");
});

test("a computer whose snapshot is inactive says so", async () => {
  installFetch();
  server.computers = [HOST, nina({ status: "missing", snapshotState: "inactive" })];
  await render(<ComputersPage />);
  expect(card("nina").querySelector('[data-testid="computer-snapshot"]')!.textContent).toMatch(/inactive: it is activated on the next start/);
});

// ── Agent's Sandbox tab ─────────────────────────────────────────────────────
test("the agent's default computer is chosen in its Sandbox tab", async () => {
  installFetch();
  const onSaved = vi.fn();
  await render(<AgentComputerCard agentName="sitoinchat" onSaved={onSaved} />);
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Default computer"]')!;
  expect([...select.options].map((o) => o.value)).toEqual(["host", "nina"]);
  expect(select.value).toBe("host");
  await act(async () => {
    select.value = "nina";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click(byText("Save"));
  await flush();
  expect(server.calls.find((c) => c.path === "/agents/sitoinchat")!.body).toEqual({ defaultComputer: "nina", computers: ["nina"] });
  expect(onSaved).toHaveBeenCalled();
});
