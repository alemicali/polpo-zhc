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

// ── Agent detail mock: the agent lives on the fake server; refetch re-reads it ──
type Agent = { name: string; identity?: { displayName?: string }; defaultComputer?: string; computers?: string[]; browserHeaded?: boolean };
const agentStore = vi.hoisted(() => ({
  agent: { name: "sitoinchat" } as Agent,
  listeners: new Set<() => void>(),
  set(next: Agent) { agentStore.agent = next; agentStore.listeners.forEach((l) => l()); },
}));
vi.mock("../src/components/agents/agent-detail-context", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useAgentDetail: () => {
      const agent = useSyncExternalStore(
        (cb) => { agentStore.listeners.add(cb); return () => agentStore.listeners.delete(cb); },
        () => agentStore.agent,
      );
      return {
        state: { agent },
        actions: { refetch: async () => agentStore.set({ ...server.agent }) },
        meta: { agentName: agent.name },
      };
    },
  };
});

import { MemoryRouter } from "react-router-dom";
import { AgentComputerTab } from "../src/components/agents/agent-computer-tab";
import { suggestComputerId, type Computer } from "../src/lib/computers-api";

// ── Fake server ─────────────────────────────────────────────────────────────
const HOST: Computer = { id: "host", name: "This server", kind: "host", status: "running", uptimeMinutes: 0, builtin: true, agents: [] };
const machine = (id: string, extra: Partial<Computer> = {}): Computer => ({
  id, name: id[0]!.toUpperCase() + id.slice(1), kind: "daytona", status: "stopped", uptimeMinutes: 125,
  lastUsedAt: new Date(Date.now() - 10 * 60_000).toISOString(), lifecycle: { idleStopMinutes: 15 }, agents: [], ...extra,
});

let server: { agent: Agent; computers: Computer[]; calls: Array<{ method: string; path: string; body?: unknown }> };

function ok(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify({ ok: true, data }), { status }));
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
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
    if (path.startsWith("/agents/") && method === "PATCH") {
      server.agent = body.browserHeaded !== undefined
        ? { ...server.agent, browserHeaded: body.browserHeaded }
        : { ...server.agent, computers: body.computers ?? server.agent.computers, defaultComputer: body.defaultComputer || undefined };
      return ok(server.agent);
    }
    const [, , id, action] = path.split("/");
    const current = server.computers.find((c) => c.id === id)!;
    const save = (next: Computer) => { server.computers = server.computers.map((c) => (c.id === id ? next : c)); return next; };
    if (action === "desktop") return ok({ desktop: { computerId: id, state: "stopped", display: ":99" }, control: { computerId: id, holder: "agent", requests: [], open: [] } });
    if (action === "start" || action === "restart" || action === "reset") return ok(save({ ...current, status: "running" }));
    if (action === "stop") return ok(save({ ...current, status: "stopped" }));
    throw new Error(`unexpected ${method} ${path}`);
  }));
}

// ── DOM helpers ─────────────────────────────────────────────────────────────
let root: Root;
let container: HTMLDivElement;
function setup(agent: Agent, computers: Computer[]) {
  server = { agent, computers, calls: [] };
  agentStore.agent = { ...agent };
  installFetch();
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  sse.events = [];
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); });
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const button = (label: string) => $<HTMLButtonElement>(`button[aria-label="${label}"]`);
const byText = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.trim() === text);
const inDialog = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((el) => el.textContent?.trim() === text);
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const card = (id: string) => $(`[data-testid="computer-card-${id}"]`);
const patches = () => server.calls.filter((c) => c.method === "PATCH" && c.path === "/agents/sitoinchat").map((c) => c.body);
async function render() {
  await act(async () => root.render(<MemoryRouter><AgentComputerTab /></MemoryRouter>));
  await flush();
}

// ── Tests ───────────────────────────────────────────────────────────────────
test("suggests a free computer id from the agent's name", () => {
  expect(suggestComputerId("Nina Bot", [])).toBe("nina-bot");
  expect(suggestComputerId("nina", ["nina"])).toBe("nina-2");
  expect(suggestComputerId("host", [])).toBe("host-2");
  expect(suggestComputerId("__", [])).toBe("computer");
});

test("empty state: the agent runs on this server and is offered its own computer", async () => {
  setup({ name: "sitoinchat", identity: { displayName: "Sito" } }, [HOST, machine("box")]);
  await render();
  expect($('[data-testid="agent-works-on"]')!.textContent).toContain("This server (host)");
  expect($('[data-testid="agent-computer-empty"]')!.textContent).toMatch(/Sito has no computer/);
  expect(byText("Create its computer")).toBeTruthy();
  // an existing computer of the instance can be added
  expect([...$<HTMLSelectElement>('select[aria-label="Existing computer"]')!.options].map((o) => o.value)).toEqual(["box"]);
  expect(card("box")).toBeNull();
});

test("its computers as cards: status, default badge, egress, snapshot notice; others are not shown", async () => {
  setup({ name: "sitoinchat", defaultComputer: "nina", computers: ["lab"] }, [
    HOST,
    machine("nina", { status: "running" }),
    machine("lab", { kind: "host", status: "running", egress: "home", uptimeMinutes: 0 }),
    machine("cold", { status: "missing", snapshotState: "inactive" }),
  ]);
  await render();
  expect($('[data-testid="agent-works-on"]')!.textContent).toContain("Nina");
  const nina = card("nina")!;
  expect(nina.querySelector('[data-testid="computer-status"]')!.textContent).toBe("Running");
  expect(nina.querySelector('[data-testid="computer-default"]')).toBeTruthy();
  expect(nina.textContent).toContain("10 min ago");
  expect(nina.textContent).toContain("2 h 5 min");
  expect(button("Make Nina the default")).toBeNull();
  expect(button("Stop Nina")).toBeTruthy();
  const lab = card("lab")!;
  expect(lab.querySelector('[data-testid="computer-default"]')).toBeNull();
  expect(lab.querySelector('[data-testid="computer-egress"]')!.textContent).toBe("via home proxy");
  expect(button("Make Lab the default")).toBeTruthy();
  expect(card("cold")).toBeNull();
});

test("Make default PATCHes the agent and moves the badge", async () => {
  setup({ name: "sitoinchat", defaultComputer: "nina", computers: ["nina", "lab"] }, [HOST, machine("nina"), machine("lab")]);
  await render();
  await click(button("Make Lab the default"));
  expect(patches()).toEqual([{ defaultComputer: "lab", computers: ["nina", "lab"], publish: false }]);
  expect(card("lab")!.querySelector('[data-testid="computer-default"]')).toBeTruthy();
  expect(card("nina")!.querySelector('[data-testid="computer-default"]')).toBeNull();
  // the computers' agent lists are reloaded from the cached state
  expect(server.calls.at(-1)!.path).toBe("/computers?live=0");
});

test("its browser: the headed switch PATCHes browserHeaded; a Daytona default computer shows its live view", async () => {
  setup({ name: "sitoinchat", defaultComputer: "nina", computers: ["nina"] }, [HOST, machine("nina", { status: "running", providerApi: "v2" })]);
  await render();
  expect($('[data-testid="agent-browser-card"]')!.textContent).toMatch(/opens a real window on Nina's desktop/);
  expect($('[data-testid="computer-live"]')).toBeTruthy();
  expect(server.calls.some((c) => c.path === "/computers/nina/desktop?viewer=1")).toBe(true);
  // unset on a remote computer: headed by default (real Google Chrome on its desktop)
  expect($('[data-testid="agent-browser-card"]')!.textContent).toMatch(/real Google Chrome.*Headed by default on a remote computer/);
  const sw = $<HTMLButtonElement>('button[aria-label="Headed browser"]')!;
  expect(sw.getAttribute("aria-checked")).toBe("true");
  await click(sw);
  expect(patches()).toEqual([{ browserHeaded: false, publish: false }]);
  expect($<HTMLButtonElement>('button[aria-label="Headed browser"]')!.getAttribute("aria-checked")).toBe("false");
});

test("its browser on this server: headless unless browserHeaded is true", async () => {
  setup({ name: "sitoinchat" }, [HOST, machine("nina")]);
  await render();
  expect($('[data-testid="agent-browser-card"]')!.textContent).toMatch(/Headless by default on this server/);
  const sw = $<HTMLButtonElement>('button[aria-label="Headed browser"]')!;
  expect(sw.getAttribute("aria-checked")).toBe("false");
  await click(sw);
  expect(patches()).toEqual([{ browserHeaded: true, publish: false }]);
});

test("the default-computer picker lives here", async () => {
  setup({ name: "sitoinchat" }, [HOST, machine("nina")]);
  await render();
  const select = $<HTMLSelectElement>('select[aria-label="Default computer"]')!;
  expect([...select.options].map((o) => o.value)).toEqual(["host", "nina"]);
  expect(select.value).toBe("host");
  await act(async () => {
    select.value = "nina";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click(byText("Save default"));
  expect(patches()).toEqual([{ defaultComputer: "nina", computers: ["nina"], publish: false }]);
  expect(card("nina")).toBeTruthy();
});

test("add an existing computer (made default while the agent is on this server)", async () => {
  setup({ name: "sitoinchat" }, [HOST, machine("box"), machine("other")]);
  await render();
  const select = $<HTMLSelectElement>('select[aria-label="Existing computer"]')!;
  await act(async () => {
    select.value = "other";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect($<HTMLInputElement>('input[aria-label="Make it the default computer"]')!.checked).toBe(true);
  await click(byText("Add"));
  expect(patches()).toEqual([{ defaultComputer: "other", computers: ["other"], publish: false }]);
  expect(card("other")!.querySelector('[data-testid="computer-default"]')).toBeTruthy();
  // now that it has a default, the next one is added without changing it (unchecked by default)
  expect($<HTMLInputElement>('input[aria-label="Make it the default computer"]')!.checked).toBe(false);
  await click(byText("Add"));
  expect(patches()[1]).toEqual({ defaultComputer: "other", computers: ["other", "box"], publish: false });
  expect(card("box")!.querySelector('[data-testid="computer-default"]')).toBeNull();
});

test("create a new computer for the agent: prefilled, then assigned and made default", async () => {
  setup({ name: "sitoinchat", identity: { displayName: "Sito" } }, [HOST]);
  await render();
  await click(byText("Create its computer"));
  const inputs = [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input:not([type="checkbox"])')];
  expect(inputs[0]!.value).toBe("sitoinchat");
  expect(inputs[1]!.value).toBe("Sito");
  expect($<HTMLInputElement>('[role="dialog"] input[aria-label="Make it the default computer"]')!.checked).toBe(true);
  await click(inDialog("Create"));
  const post = server.calls.find((c) => c.method === "POST" && c.path === "/computers")!;
  expect(post.body).toEqual({ id: "sitoinchat", name: "Sito", kind: "daytona", lifecycle: { idleStopMinutes: 15 } });
  expect(patches()).toEqual([{ defaultComputer: "sitoinchat", computers: ["sitoinchat"], publish: false }]);
  expect($('[role="dialog"]')).toBeNull();
  expect(card("sitoinchat")!.querySelector('[data-testid="computer-default"]')).toBeTruthy();
  expect($('[data-testid="agent-computer-empty"]')).toBeNull();
});

test("remove from this agent: removing the default puts it back on this server", async () => {
  setup({ name: "sitoinchat", defaultComputer: "nina", computers: ["nina", "lab"] }, [HOST, machine("nina"), machine("lab")]);
  await render();
  await click(button("Remove Lab from this agent"));
  expect(patches()[0]).toEqual({ defaultComputer: "nina", computers: ["nina"], publish: false });
  expect(card("lab")).toBeNull();
  await click(button("Remove Nina from this agent"));
  expect(patches()[1]).toEqual({ defaultComputer: "", computers: [], publish: false });
  expect($('[data-testid="agent-computer-empty"]')).toBeTruthy();
  expect($('[data-testid="agent-works-on"]')!.textContent).toContain("This server (host)");
});

test("lifecycle actions: reset asks first; computer:changed refreshes the status", async () => {
  setup({ name: "sitoinchat", defaultComputer: "nina" }, [HOST, machine("nina")]);
  await render();
  await click(button("Start Nina"));
  expect(card("nina")!.querySelector('[data-testid="computer-status"]')!.textContent).toBe("Running");
  await click(button("Reset Nina"));
  expect($('[role="dialog"]')!.textContent).toMatch(/everything on its disk/);
  expect(server.calls.some((c) => c.path === "/computers/nina/reset")).toBe(false);
  await click(inDialog("Reset"));
  expect(server.calls.find((c) => c.path === "/computers/nina/reset")!.body).toEqual({ confirm: true });

  server.computers = [HOST, machine("nina", { status: "stopping" })];
  await act(async () => { sse.push("computer:changed", { id: "nina", action: "status", status: "stopping" }); });
  await flush();
  expect(card("nina")!.querySelector('[data-testid="computer-status"]')!.textContent).toBe("Stopping");
});
