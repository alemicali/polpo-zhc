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

// ── noVNC mock: every client the panel makes, with what it was given ─────────
const vnc = vi.hoisted(() => ({ clients: [] as Array<Record<string, unknown> & { url: string; options: Record<string, unknown>; disconnected: boolean }> }));
vi.mock("@novnc/novnc", () => ({
  default: class FakeRFB extends EventTarget {
    url: string;
    options: Record<string, unknown>;
    disconnected = false;
    constructor(_screen: HTMLElement, url: string, options: Record<string, unknown>) {
      super();
      this.url = url;
      this.options = options;
      vnc.clients.push(this as never);
    }
    disconnect() { this.disconnected = true; }
    focus() {}
    sendCredentials() { throw new Error("the browser never has a VNC password"); }
  },
}));

import { ComputerLivePanel, LIVE_QUALITY } from "../src/components/computers/computer-live-panel";

// ── Fake server ─────────────────────────────────────────────────────────────
let server: { state: "running" | "stopped"; holder: "agent" | "person"; calls: string[] };
const view = () => ({
  desktop: { computerId: "nina", state: server.state, display: ":99" },
  control: { computerId: "nina", holder: server.holder, ...(server.holder === "person" ? { person: "ale@x.it", since: new Date().toISOString() } : {}), requests: [], open: [] },
  ...(server.state === "running" ? { viewer: { mode: server.holder === "person" ? "control" : "view", path: "/api/v1/computers/nina/desktop/vnc" } } : {}),
});
function installFetch() {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/api/v1", "");
    server.calls.push(`${method} ${path}${url.search}`);
    if (path === "/computers/nina/takeover") server.holder = "person";
    if (path === "/computers/nina/release") server.holder = "agent";
    if (path === "/computers/nina/desktop/start") server.state = "running";
    return Promise.resolve(new Response(JSON.stringify({ ok: true, data: view() }), { status: 200 }));
  }));
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  sse.events = [];
  vnc.clients = [];
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); });
const byText = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.trim() === text);
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); };
async function render() {
  await act(async () => root.render(<ComputerLivePanel computerId="nina" />));
  await flush();
}

test("connects without a password, view-only and light; take control and give back flip the same connection", async () => {
  server = { state: "running", holder: "agent", calls: [] };
  installFetch();
  await render();
  expect(vnc.clients).toHaveLength(1);
  const rfb = vnc.clients[0]!;
  expect(rfb.url).toMatch(/\/api\/v1\/computers\/nina\/desktop\/vnc$/);
  expect(rfb.options).toEqual({ shared: true });
  expect(rfb).toMatchObject({ viewOnly: true, qualityLevel: LIVE_QUALITY.view.quality, compressionLevel: LIVE_QUALITY.view.compression, showDotCursor: false });

  await click(byText("Take control"));
  expect(server.calls).toContain("POST /computers/nina/takeover");
  expect(vnc.clients).toHaveLength(1);
  expect(rfb.disconnected).toBe(false);
  expect(rfb).toMatchObject({ viewOnly: false, focusOnClick: true, qualityLevel: LIVE_QUALITY.control.quality, compressionLevel: LIVE_QUALITY.control.compression, showDotCursor: true });

  await click(byText("Give back"));
  expect(vnc.clients).toHaveLength(1);
  expect(rfb).toMatchObject({ viewOnly: true, qualityLevel: LIVE_QUALITY.view.quality });
  expect(LIVE_QUALITY.control.quality).toBeGreaterThan(LIVE_QUALITY.view.quality);
  expect(LIVE_QUALITY.control.compression).toBeLessThan(LIVE_QUALITY.view.compression);
});

test("connects by itself as soon as the desktop runs (an agent's takeover request started it)", async () => {
  server = { state: "stopped", holder: "agent", calls: [] };
  installFetch();
  await render();
  expect(vnc.clients).toHaveLength(0);
  expect(byText("Start live view")).toBeTruthy();
  server.state = "running";
  await act(async () => sse.push("computer:takeover", { id: "nina", action: "desktop-started", holder: "agent" }));
  await flush();
  expect(vnc.clients).toHaveLength(1);
  expect(server.calls.filter((c) => c.startsWith("POST"))).toEqual([]);
});
