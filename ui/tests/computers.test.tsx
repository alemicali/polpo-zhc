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
    // sitoinchat runs on Claude Code (its mark next to it on its computer)
    useAgents: () => ({ agents: [{ name: "sitoinchat", engine: { harness: "claude-code" } }, { name: "dev" }] }),
  };
});

// ── noVNC mock: records how the live view connects (never opens a socket) ────
const vnc = vi.hoisted(() => ({ clients: [] as Array<{ url: string; options: { credentials?: { password?: string } }; viewOnly: boolean; disconnected?: boolean }> }));
vi.mock("@novnc/novnc", () => ({
  default: class {
    viewOnly = false; scaleViewport = false; resizeSession = false; focusOnClick = false; showDotCursor = false; qualityLevel = 0; compressionLevel = 0; background = "";
    constructor(_el: HTMLElement, url: string, options: { credentials?: { password?: string } }) { vnc.clients.push(Object.assign(this, { url, options }) as never); }
    addEventListener() {}
    sendCredentials() {}
    disconnect() {}
    focus() {}
  },
}));

import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ComputersPage } from "../src/pages/computers";
import { ComputerDetailPage } from "../src/pages/computer-detail";
import {
  EMPTY_COMPUTER_FORM, availableActions, computerInput, formFromComputer, formatLastUsed, formatSnapshot, formatSnapshotSummary, formatUptime, kindLabel,
  matchesComputer, sortComputers, stopLabel, validateComputerForm,
  type Computer, type ComputerDetail,
} from "../src/lib/computers-api";

// ── Fake server ─────────────────────────────────────────────────────────────
const HOST: Computer = { id: "host", name: "This server", kind: "host", status: "running", uptimeMinutes: 0, builtin: true, agents: [{ name: "dev", isDefault: true }] };
const nina = (extra: Partial<Computer> = {}): Computer => ({
  id: "nina", name: "Nina", kind: "daytona", status: "stopped", uptimeMinutes: 125, lastUsedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  lifecycle: { idleStopMinutes: 15 }, agents: [{ name: "sitoinchat", isDefault: true }], ...extra,
});
const box = (extra: Partial<Computer> = {}): Computer => ({
  id: "box", name: "Box", kind: "e2b", status: "running", uptimeMinutes: 5, lastUsedAt: new Date(Date.now() - 60_000).toISOString(), agents: [], ...extra,
});

type FakeRequest = { id: string; computerId: string; agent: string; reason: string; url?: string; whatToDo?: string; createdAt: string; expiresAt: string; status: string; takenBy?: string; note?: string };
let server: {
  computers: Computer[]; calls: Array<{ method: string; path: string; body?: unknown }>; detail: Partial<ComputerDetail>;
  desktop: { state: string; holder: "agent" | "person"; person?: string; requests: FakeRequest[] };
};

function ok(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify({ ok: true, data }), { status }));
}

const SESSION = { key: "task:t1", agent: "sitoinchat", harness: "claude-code", computerId: "nina", scope: "task", taskId: "t1abcdef99", state: "idle", live: true, resumable: true, turns: 2, costUsd: 0.0723, updatedAt: new Date().toISOString() };

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
    if (path === "/harnesses/sessions") return ok({ sessions: [SESSION] });
    const [, , id, action] = path.split("/");
    const current = server.computers.find((c) => c.id === id);
    if (!current) return Promise.resolve(new Response(JSON.stringify({ ok: false, error: `There is no computer "${id}"`, code: "NOT_FOUND" }), { status: 404 }));
    const save = (next: Computer) => { server.computers = server.computers.map((c) => (c.id === id ? next : c)); return next; };
    if (!action && method === "GET") {
      return ok(url.searchParams.get("detail") === "1"
        ? { snapshots: [], activity: [], sessions: [], runs: [], cost: { runsUsd: 0, chatSessionsUsd: 0, totalUsd: 0 }, ...server.detail, ...current }
        : current);
    }
    if (action === "desktop" || action === "takeover" || action === "release" || action === "control") {
      const d = server.desktop;
      const sub = path.split("/")[4];
      if (action === "desktop" && sub === "start") d.state = "running";
      if (action === "desktop" && sub === "stop") d.state = "stopped";
      if (action === "takeover") { d.holder = "person"; d.person = "ale@x.it"; d.requests = d.requests.map((r) => ({ ...r, status: "in_control", takenBy: "ale@x.it" })); }
      if (action === "release") { d.holder = "agent"; d.person = undefined; d.requests = d.requests.map((r) => ({ ...r, status: "released", ...(body?.note ? { note: body.note } : {}) })); }
      const open = d.requests.filter((r) => r.status === "pending" || r.status === "in_control");
      const control = { computerId: id, holder: d.holder, ...(d.person ? { person: d.person, since: new Date().toISOString() } : {}), requests: d.requests, open };
      const mode = d.holder === "person" ? "control" : "view";
      const viewer = d.state === "running" && (url.searchParams.get("viewer") === "1" || method === "POST")
        ? { viewer: { mode, path: `/api/v1/computers/${id}/desktop/vnc` } } : {};
      return ok({ desktop: { computerId: id, state: d.state, display: ":99" }, control, ...viewer });
    }
    if (action === "egress") return ok({ computerId: id, proxy: current.egress, tailnet: "up", node: "polpo-nina", path: "direct", proxyReachable: true, effective: `via ${current.egress}`, machine: "running" });
    if (!action && method === "PATCH") return ok(save({ ...current, ...body }));
    if (!action && method === "DELETE") { server.computers = server.computers.filter((c) => c.id !== id); return ok({ deleted: id }); }
    if (action === "start" || action === "restart" || action === "reset") return ok(save({ ...current, status: "running", notice: undefined }));
    if (action === "stop") return ok(save({ ...current, status: current.providerApi === "v2" ? "hibernated" : "stopped" }));
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
  server = { computers: [HOST, nina()], calls: [], detail: {}, desktop: { state: "stopped", holder: "agent", requests: [] } };
  vnc.clients.length = 0;
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); });
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const button = (label: string) => $<HTMLButtonElement>(`button[aria-label="${label}"]`);
const byText = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.trim() === text);
/** A button of the dialog opened last (a confirmation over a page). */
const inDialog = (text: string) => {
  const dialogs = [...document.querySelectorAll('[role="dialog"]')];
  return [...(dialogs.at(-1)?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((el) => el.textContent?.trim() === text);
};
const click = (el: Element | null | undefined) => act(async () => { (el as HTMLElement).click(); });
const row = (id: string) => $(`[data-testid="computer-row-${id}"]`)!;
const status = (el: Element) => el.querySelector('[data-testid="computer-status"]')!.textContent;
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function select(el: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function Where() {
  const loc = useLocation();
  return <span data-testid="where">{loc.pathname}</span>;
}
async function render(path = "/computers") {
  await act(async () => root.render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/computers" element={<ComputersPage />} />
        <Route path="/computers/:id" element={<ComputerDetailPage />} />
      </Routes>
      <Where />
    </MemoryRouter>,
  ));
  await flush();
}

// ── Helpers ─────────────────────────────────────────────────────────────────
test("actions by status, labels, sort and search, form validation and body", () => {
  expect(availableActions({ status: "running", kind: "daytona" })).toEqual(["stop", "restart", "reset"]);
  expect(availableActions({ status: "missing", kind: "e2b" })).toEqual(["start"]);
  expect(availableActions({ status: "creating", kind: "e2b" })).toEqual([]);
  expect(availableActions({ status: "deleted", kind: "daytona" })).toEqual(["recreate"]);
  expect(availableActions({ status: "running", kind: "host", builtin: true })).toEqual([]);
  expect(kindLabel({ kind: "daytona", providerApi: "v2" })).toBe("Daytona v2");
  expect(kindLabel({ kind: "daytona", providerApi: "v0" })).toBe("Daytona");
  expect(stopLabel({ kind: "daytona", providerApi: "v2" })).toBe("Hibernate");
  expect(stopLabel({ kind: "e2b" })).toBe("Pause");
  expect(stopLabel({ kind: "daytona" })).toBe("Stop");
  expect(formatUptime(125)).toBe("2 h 5 min");
  expect(formatUptime(0)).toBe("—");
  expect(formatLastUsed(undefined)).toBe("never");
  expect(formatLastUsed(new Date(Date.now() - 3 * 3600_000).toISOString())).toBe("3 h ago");
  expect(formatSnapshotSummary({ lastSnapshot: { at: new Date().toISOString(), memoryBytes: 1024 ** 3, diskBytes: 1024 ** 3 / 2 }, snapshotCount: 2 })).toBe("2 snapshots · 1.5 GB");
  expect(formatSnapshotSummary({})).toBe("—");
  // host first; then what needs attention (deleted), running, resting
  const list = [nina(), box(), nina({ id: "old", name: "Old", status: "deleted", lastUsedAt: new Date(Date.now() - 60 * 60_000).toISOString() }), HOST];
  expect(sortComputers(list, "status").map((c) => c.id)).toEqual(["host", "old", "box", "nina"]);
  expect(sortComputers(list, "name").map((c) => c.id)).toEqual(["host", "box", "nina", "old"]);
  expect(sortComputers(list, "lastUsed").map((c) => c.id)).toEqual(["host", "box", "nina", "old"]);
  expect(matchesComputer(nina(), "sitoin")).toBe(true);
  expect(matchesComputer(nina(), "e2b")).toBe(false);
  expect(validateComputerForm({ ...EMPTY_COMPUTER_FORM, id: "host" })).toMatchObject({ id: "This id is reserved" });
  expect(validateComputerForm({ ...EMPTY_COMPUTER_FORM, id: "nina" }, ["nina"])).toMatchObject({ id: expect.stringMatching(/exists/) });
  expect(validateComputerForm({ ...EMPTY_COMPUTER_FORM, id: "x", idleStopMinutes: "0" })).toHaveProperty("idleStopMinutes");
  expect(validateComputerForm({ ...EMPTY_COMPUTER_FORM, id: "x", networkMode: "allowlist" })).toHaveProperty("networkAllow");
  expect(validateComputerForm({ ...EMPTY_COMPUTER_FORM, id: "x", cpus: "-1" })).toHaveProperty("cpus");
  expect(computerInput({ ...EMPTY_COMPUTER_FORM, id: "nina", name: "Nina", image: "polpo-runner-1", autoArchiveDays: "7", start: true }))
    .toEqual({ id: "nina", name: "Nina", kind: "daytona", snapshot: "polpo-runner-1", lifecycle: { idleStopMinutes: 15, autoArchiveDays: 7 }, start: true });
  // editing clears what was emptied
  expect(computerInput({ ...EMPTY_COMPUTER_FORM, id: "nina", name: "Nina" }, true))
    .toEqual({ name: "Nina", snapshot: null, image: null, egress: null, lifecycle: { idleStopMinutes: 15 }, network: null, resources: null, desktop: null });
  // network and size
  expect(computerInput({ ...EMPTY_COMPUTER_FORM, id: "nina", name: "Nina", networkMode: "allowlist", networkAllow: "github.com\n*.npmjs.org, github.com", cpus: "2", memoryGb: "4" }, true))
    .toMatchObject({ network: { mode: "allowlist", allow: ["github.com", "*.npmjs.org"] }, resources: { cpus: 2, memoryMb: 4096 } });
  // a remote computer may go out through an egress proxy (Tailscale in its VM)
  expect(computerInput({ ...EMPTY_COMPUTER_FORM, id: "nina", name: "Nina", egress: " home " }, true)).toMatchObject({ egress: "home" });
  // the desktop's size: WIDTHxHEIGHT in range, a remote computer's only
  expect(computerInput({ ...EMPTY_COMPUTER_FORM, id: "nina", name: "Nina", desktopSize: " 1600X900 " })).toMatchObject({ desktop: { size: "1600x900" } });
  expect(computerInput({ ...EMPTY_COMPUTER_FORM, id: "nina", name: "Nina" })).not.toHaveProperty("desktop");
  expect(computerInput({ ...EMPTY_COMPUTER_FORM, id: "srv", name: "Srv", kind: "host", desktopSize: "1600x900" })).not.toHaveProperty("desktop");
  expect(validateComputerForm({ ...EMPTY_COMPUTER_FORM, id: "x", desktopSize: "640x480" })).toHaveProperty("desktopSize");
  expect(validateComputerForm({ ...EMPTY_COMPUTER_FORM, id: "x", desktopSize: "1920x1080" })).not.toHaveProperty("desktopSize");
  expect(formFromComputer(nina({ desktop: { size: "1440x900" } })).desktopSize).toBe("1440x900");
});

// ── List ────────────────────────────────────────────────────────────────────
test("a table like the other pages: provider, kind, status, agents with their engine, harness sessions, last use; host has no lifecycle buttons", async () => {
  installFetch();
  await render();
  expect($('[data-testid="computers-table"]')).not.toBeNull();
  expect(document.querySelector('[data-testid^="computer-card-"]')).toBeNull();
  const n = row("nina");
  expect(n.querySelector('[data-testid="computer-kind"]')!.textContent).toMatch(/^Daytona · nina/);
  expect(status(n)).toBe("Stopped");
  expect(n.querySelector('[data-testid="computer-agents"]')!.textContent).toBe("sitoinchat");
  // the agent on a harness shows its mark; the harness sessions on the computer show theirs
  expect(n.querySelector('[data-testid="computer-agents"] [data-testid="engine-badge"]')?.getAttribute("data-engine")).toBe("claude-code");
  const sessions = n.querySelector('[data-testid="computer-harness-sessions"]')!;
  expect(sessions.querySelector('[data-brand="claude-code"]')).not.toBeNull();
  expect(sessions.textContent).toMatch(/1.*1 live/);
  // a Daytona computer shows Daytona's mark
  expect(n.querySelector('[data-brand="daytona"]')).not.toBeNull();
  expect(n.querySelector('[data-testid="computer-last-used"]')!.textContent).toBe("10 min ago");
  expect(button("Start This server")).toBeNull();
  expect(button("Open This server")).not.toBeNull();
  expect($('[data-testid="computers-count"]')!.textContent).toBe("2 computers");
  // the first load asks the providers (live); the refresh button skips their short cache
  expect(server.calls[0]!.path).toBe("/computers");
  await click(button("Refresh status"));
  await flush();
  expect(server.calls.some((c) => c.path === "/computers?fresh=1")).toBe(true);
});

test("the main action is in the row: start, then stop (Hibernate on Daytona v2)", async () => {
  installFetch();
  server.computers = [HOST, nina(), box({ id: "v2", name: "Vee", kind: "daytona", providerApi: "v2" })];
  await render();
  await click(button("Start Nina"));
  await flush();
  expect(status(row("nina"))).toBe("Running");
  // running: a pulsing dot next to the status
  expect(row("nina").querySelector('[data-testid="computer-status"] span.animate-pulse')).not.toBeNull();
  await click(button("Stop Nina"));
  await flush();
  expect(server.calls.some((c) => c.method === "POST" && c.path === "/computers/nina/stop")).toBe(true);
  expect(row("v2").querySelector('[data-testid="computer-kind"]')!.textContent).toMatch(/^Daytona v2/);
  await click(button("Hibernate Vee"));
  await flush();
  expect(status(row("v2"))).toBe("Hibernated");
});

test("search narrows the rows; the count says how many match", async () => {
  installFetch();
  server.computers = [HOST, nina(), box()];
  await render();
  await type($<HTMLInputElement>('input[aria-label="Search computers"]')!, "e2b");
  expect($('[data-testid="computer-row-box"]')).not.toBeNull();
  expect($('[data-testid="computer-row-nina"]')).toBeNull();
  expect($('[data-testid="computers-count"]')!.textContent).toBe("1/3 computers");
  await type($<HTMLInputElement>('input[aria-label="Search computers"]')!, "nothing-like-this");
  expect(document.body.textContent).toContain("No computer matches.");
});

test("create a computer from the dialog", async () => {
  installFetch();
  server.computers = [HOST];
  await render();
  await click(byText("New computer"));
  const inputs = [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input')];
  await type(inputs[0]!, "box");
  await type(inputs[1]!, "Box");
  await click(byText("Create"));
  await flush();
  const post = server.calls.find((c) => c.method === "POST" && c.path === "/computers")!;
  expect(post.body).toEqual({ id: "box", name: "Box", kind: "daytona", lifecycle: { idleStopMinutes: 15 } });
  expect(row("box")).toBeTruthy();
});

test("live: computer:changed refreshes from the cached state", async () => {
  installFetch();
  await render();
  server.computers = [HOST, nina({ status: "creating" })];
  await act(async () => { sse.push("computer:changed", { id: "nina", action: "status", status: "creating" }); });
  await flush();
  expect(server.calls.at(-1)!.path).toBe("/computers?live=0");
  expect(status(row("nina"))).toBe("Creating");
});

test("a hibernated computer (Daytona v2): its kind, short status (long one as a tooltip), snapshots; Start wakes it", async () => {
  installFetch();
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  server.computers = [HOST, nina({ status: "hibernated", providerApi: "v2", lastSnapshot: { at, memoryBytes: 224 * 1024 ** 2, diskBytes: 1.5 * 1024 ** 3 }, snapshotCount: 1 })];
  expect(availableActions({ status: "hibernated", kind: "daytona" })).toEqual(["start", "reset"]);
  expect(formatSnapshot({ at, memoryBytes: 224 * 1024 ** 2, diskBytes: 1.5 * 1024 ** 3 })).toBe("5 min ago · 224 MB memory + 1.5 GB disk");
  await render();
  const n = row("nina");
  expect(status(n)).toBe("Hibernated");
  expect(n.querySelector('[data-testid="computer-status"]')!.getAttribute("title")).toBe("Hibernated (resumes in a few seconds)");
  expect(n.querySelector('[data-testid="computer-snapshots"]')!.textContent).toBe("1 snapshot · 1.7 GB");
  await click(button("Start Nina"));
  await flush();
  expect(server.calls.some((c) => c.method === "POST" && c.path === "/computers/nina/start")).toBe(true);
  expect(status(row("nina"))).toBe("Running");
});

test("deleted at the provider: a banner, the row says so, Recreate asks first then resets it", async () => {
  installFetch();
  server.computers = [HOST, nina({ status: "deleted", deletedAtProvider: new Date().toISOString(), notice: "Its machine was deleted at the provider" }), box()];
  await render();
  expect($('[data-testid="computers-deleted-banner"]')!.textContent).toMatch(/deleted at the provider, outside Polpo/);
  expect(status(row("nina"))).toBe("Deleted at provider");
  // the banner's Show filters to them
  await click(byText("Show"));
  expect($('[data-testid="computer-row-box"]')).toBeNull();
  expect($('[data-testid="computers-count"]')!.textContent).toBe("1/3 computers");
  await click(button("Recreate Nina"));
  expect(document.querySelector('[role="dialog"]')!.textContent).toMatch(/Recreate Nina\?.*lost and does not come back/);
  expect(server.calls.some((c) => c.path === "/computers/nina/reset")).toBe(false);
  await click(inDialog("Recreate"));
  await flush();
  expect(server.calls.find((c) => c.path === "/computers/nina/reset")!.body).toEqual({ confirm: true });
  // it has a machine again: no longer among the deleted ones (the filter still shows only those)
  expect($('[data-testid="computer-row-nina"]')).toBeNull();
  expect($('[data-testid="computers-deleted-banner"]')).toBeNull();
  await click(byText("Clear"));
  expect(status(row("nina"))).toBe("Running");
});

test("a row opens the computer's page; old #computer-<id> links too", async () => {
  installFetch();
  await render();
  await click(row("nina"));
  await flush();
  expect($('[data-testid="where"]')!.textContent).toBe("/computers/nina");
  expect(server.calls.some((c) => c.path === "/computers/nina?detail=1")).toBe(true);
  expect($('[data-testid="computer-page"]')).not.toBeNull();
  await act(async () => root.unmount());
  root = createRoot(container);
  await render("/computers#computer-nina");
  expect($('[data-testid="where"]')!.textContent).toBe("/computers/nina");
});

// ── Page ────────────────────────────────────────────────────────────────────
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

test("the computer's page: header, tiles, sessions, runs, activity, agents, lifecycle, snapshots, machine, network and egress", async () => {
  installFetch();
  server.computers = [HOST, nina({ status: "running", providerApi: "v2", egress: "home", remoteId: "sbx_9", createdAt: ago(600), network: { mode: "allowlist", allow: ["github.com"] }, agents: [{ name: "sitoinchat", isDefault: true }, { name: "dev", isDefault: false }] })];
  server.detail = {
    idleStopAt: new Date(Date.now() + 12 * 60_000).toISOString(),
    runningSince: ago(30),
    hibernate: { keepSnapshots: 1, safetySnapshotHours: 6, rotateBeforeMinutes: 60 },
    machine: { snapshot: "polpo-runner-0.4.0", region: "eu", resources: { cpus: 2, memoryMb: 4096 } },
    snapshots: [{ id: "s1", name: "polpo-computer-x-nina-1", at: ago(90), status: "ready", memoryBytes: 2 * 1024 ** 3, diskBytes: 1024 ** 3 }],
    sessions: [{ ...SESSION, createdAt: ago(20), tokens: { input: 1000, output: 500, cacheRead: 300, cacheWrite: 200 } } as never],
    runs: [{ taskId: "t1abcdef99", taskTitle: "Fix the build", taskStatus: "done", runId: "r1", agent: "sitoinchat", engine: "claude-code", model: "claude-sonnet-4-5", status: "done", startedAt: ago(25), durationMs: 120_000, costUsd: 0.5, tokens: 1200 }],
    activity: [
      { at: ago(30), kind: "status", status: "running", from: "starting", remoteId: "sbx_9" },
      { at: ago(31), kind: "notice", level: "warn", message: "Its VM was gone: restored from the snapshot" },
    ],
    cost: { runsUsd: 0.5, chatSessionsUsd: 0.1, totalUsd: 0.6 },
  };
  await render("/computers/nina");
  expect($("h1")!.textContent).toMatch(/Nina.*Running/);
  expect($('[data-testid="computer-kind"]')!.textContent).toBe("Daytona v2 · nina");
  const stats = $('[data-testid="computer-stats"]')!.textContent!;
  expect(stats).toMatch(/Hibernates when idle\s*in 12 min/);
  expect(stats).toMatch(/Spent on it\$0\.60task runs \$0\.50 · chats \$0\.10/);
  const sessions = $('[data-testid="computer-sessions"]')!;
  expect(sessions.querySelector('[data-brand="claude-code"]')).not.toBeNull();
  expect(sessions.textContent).toMatch(/Claude Code.*sitoinchat.*task t1abcdef.*running.*2 turns.*2\.0k tok.*\$0\.07/);
  expect(sessions.querySelector('a[href="/tasks/t1abcdef99"]')).not.toBeNull();
  const runs = $('[data-testid="computer-runs"]')!;
  expect(runs.querySelector('a[href="/tasks/t1abcdef99"]')!.textContent).toBe("Fix the build");
  expect(runs.textContent).toMatch(/Sonnet 4\.5.*done.*2\.0 min|Sonnet 4\.5.*done/);
  expect(runs.textContent).toContain("$0.50");
  expect($('[data-testid="computer-activity"]')!.textContent).toMatch(/Starting → Running.*Its VM was gone/);
  expect($('[data-testid="computer-agents"]')!.textContent).toMatch(/sitoinchat\s*default.*dev\s*may use/);
  expect($('[data-testid="computer-lifecycle"]')!.textContent).toMatch(/Hibernates after 15 min without use/);
  expect($('[data-testid="computer-snapshots"]')!.textContent).toMatch(/1 · keeps 1 · 3\.0 GB.*2\.0 GB memory \+ 1\.0 GB disk.*ready/);
  const machine = $('[data-testid="computer-machine"]')!.textContent!;
  expect(machine).toMatch(/snapshot polpo-runner-0\.4\.0/);
  expect(machine).toMatch(/Regioneu/);
  expect(machine).toMatch(/2 CPU · 4 GB memory/);
  expect(machine).toContain("sbx_9");
  const network = $('[data-testid="computer-network"]')!.textContent!;
  expect(network).toMatch(/Allowlist: github\.com/);
  expect(network).toMatch(/Through the home proxy, via Tailscale in its VM/);
  expect(network).toMatch(/Nowvia home/);
  expect(network).toMatch(/Tailnetup as polpo-nina, path direct/);
});

test("the page's actions: Hibernate, Reset asks first, Edit saves the network and size, Delete goes back to the list", async () => {
  installFetch();
  server.computers = [HOST, nina({ status: "running", providerApi: "v2" })];
  await render("/computers/nina");
  await click(button("Hibernate Nina"));
  await flush();
  expect(server.calls.some((c) => c.method === "POST" && c.path === "/computers/nina/stop")).toBe(true);
  expect($("h1")!.textContent).toMatch(/Hibernated/);

  await click(button("Reset Nina"));
  expect(document.querySelector('[role="dialog"]')!.textContent).toMatch(/everything on its disk/);
  await click(inDialog("Reset"));
  await flush();
  expect(server.calls.find((c) => c.path === "/computers/nina/reset")!.body).toEqual({ confirm: true });

  await click(document.querySelector('[data-testid="computer-network"] button[aria-label="Edit Nina"]'));
  await select($<HTMLSelectElement>('[role="dialog"] select[aria-label="Network"]')!, "allowlist");
  await type($<HTMLTextAreaElement>('[role="dialog"] textarea[aria-label="Allowed hosts"]')!, "github.com\nnpmjs.org");
  await type($<HTMLInputElement>('[role="dialog"] input[aria-label="CPU"]')!, "2");
  await click(inDialog("Save"));
  await flush();
  const patch = server.calls.find((c) => c.method === "PATCH")!;
  expect(patch.body).toMatchObject({ network: { mode: "allowlist", allow: ["github.com", "npmjs.org"] }, resources: { cpus: 2 } });
  expect($('[data-testid="computer-network"]')!.textContent).toMatch(/Allowlist: github\.com, npmjs\.org/);

  await click(button("Delete Nina"));
  await click(inDialog("Delete"));
  await flush();
  expect(server.calls.find((c) => c.method === "DELETE")!.body).toEqual({ confirm: true });
  expect($('[data-testid="where"]')!.textContent).toBe("/computers");
});

test("a computer deleted at the provider: its page says so, offers Recreate and Remove from Polpo", async () => {
  installFetch();
  server.computers = [HOST, nina({ status: "deleted", deletedAtProvider: ago(3) })];
  await render("/computers/nina");
  expect($('[data-testid="computer-deleted"]')!.textContent).toMatch(/deleted at the provider \(found 3 min ago\)/);
  expect(button("Start Nina")).toBeNull();
  await click(button("Remove Nina from Polpo"));
  expect(document.querySelector('[role="dialog"]')!.textContent).toMatch(/Remove Nina from Polpo\?.*already gone/);
  await click(inDialog("Cancel"));
  await click(button("Recreate Nina"));
  await click(inDialog("Recreate"));
  await flush();
  expect(server.calls.find((c) => c.path === "/computers/nina/reset")!.body).toEqual({ confirm: true });
});

test("the computer's live view: start it, view-only while the agent holds it, take control (full access, same connection), give back with a note", async () => {
  installFetch();
  server.computers = [HOST, nina({ status: "running", providerApi: "v2" })];
  server.desktop.requests = [{
    id: "tko_1", computerId: "nina", agent: "sitoinchat", reason: "LinkedIn asks for a 2FA code", url: "https://linkedin.com/checkpoint", whatToDo: "Sign in and stop at the feed",
    createdAt: ago(1), expiresAt: new Date(Date.now() + 29 * 60_000).toISOString(), status: "pending",
  }];
  await render("/computers/nina");
  const live = $('[data-testid="computer-live-section"]')!;
  expect(live).toBeTruthy();
  // the agent waiting for a person, as a banner
  expect($('[data-testid="takeover-requests"]')!.textContent).toMatch(/sitoinchat needs you to take control.*LinkedIn asks for a 2FA code.*Page: https:\/\/linkedin.com\/checkpoint.*To do: Sign in and stop at the feed/);
  expect(vnc.clients).toHaveLength(0);
  await click(byText("Start live view"));
  await flush();
  expect(server.calls.some((c) => c.method === "POST" && c.path === "/computers/nina/desktop/start")).toBe(true);
  // view-only, without any password (the server authenticates to the VM), on the authorized WebSocket path
  expect(vnc.clients).toHaveLength(1);
  expect(vnc.clients.at(-1)).toMatchObject({ viewOnly: true, options: { shared: true } });
  expect(vnc.clients.at(-1)!.options.credentials).toBeUndefined();
  expect(vnc.clients.at(-1)!.url).toMatch(/\/api\/v1\/computers\/nina\/desktop\/vnc$/);
  expect($('[data-testid="computer-control-holder"]')!.textContent).toMatch(/The agent has control/);
  await click(byText("Take control"));
  await flush();
  expect(server.calls.some((c) => c.method === "POST" && c.path === "/computers/nina/takeover")).toBe(true);
  // the same connection becomes interactive: no reconnect
  expect(vnc.clients).toHaveLength(1);
  expect(vnc.clients.at(-1)).toMatchObject({ viewOnly: false });
  expect($('[data-testid="computer-control-holder"]')!.textContent).toMatch(/You have control/);
  await type($<HTMLInputElement>('input[aria-label="Note for the agent"]')!, "Signed in, you are on the feed");
  await click(byText("Give back"));
  await flush();
  expect(server.calls.find((c) => c.path === "/computers/nina/release")!.body).toEqual({ note: "Signed in, you are on the feed" });
  expect(vnc.clients).toHaveLength(1);
  expect(vnc.clients.at(-1)).toMatchObject({ viewOnly: true });
  expect($('[data-testid="takeover-requests"]')).toBeNull();
});

test("an E2B computer's page has no live view", async () => {
  installFetch();
  server.computers = [HOST, box()];
  await render("/computers/box");
  expect($('[data-testid="computer-live-section"]')).toBeNull();
});

test("an unknown computer's page says so", async () => {
  installFetch();
  await render("/computers/ghost");
  expect(document.body.textContent).toContain('There is no computer "ghost"');
});
