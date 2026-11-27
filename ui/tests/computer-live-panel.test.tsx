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
    pasted: string[] = [];
    disconnect() { this.disconnected = true; }
    focus() {}
    clipboardPasteFrom(text: string) { this.pasted.push(text); }
    sendCredentials() { throw new Error("the browser never has a VNC password"); }
  },
}));

import { ComputerLivePanel, LIVE_QUALITY } from "../src/components/computers/computer-live-panel";
import { desktopAspect } from "../src/lib/desktop-aspect";

// ── Fake server ─────────────────────────────────────────────────────────────
let server: { state: "running" | "stopped"; holder: "agent" | "person"; calls: string[]; size?: string };
const view = () => ({
  desktop: { computerId: "nina", state: server.state, display: ":99", ...(server.size ? { size: server.size } : {}) },
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

test("full screen: the viewer goes full screen (Esc exits), noVNC fits it, the keyboard stays on the desktop in control", async () => {
  server = { state: "running", holder: "person", calls: [] };
  installFetch();
  // jsdom has no Fullscreen API: a stand-in that behaves like the browser's
  let fullscreenElement: Element | null = null;
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement });
  const change = () => document.dispatchEvent(new Event("fullscreenchange"));
  const request = vi.fn(function (this: Element) {
    // the element the browser makes full screen is the one requestFullscreen is called on
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    fullscreenElement = this; change(); return Promise.resolve();
  });
  const exit = vi.fn(() => { fullscreenElement = null; change(); return Promise.resolve(); });
  Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: request });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
  try {
    await render();
    const rfb = vnc.clients[0]! as unknown as { focus: () => void; scaleViewport: boolean };
    const focus = vi.spyOn(rfb, "focus");
    expect(rfb.scaleViewport).toBe(true);
    const viewer = document.querySelector<HTMLElement>('[role="application"]')!;
    expect(viewer.dataset.fullscreen).toBeUndefined();

    await click(byText("Full screen"));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.contexts[0]).toBe(viewer);
    expect(viewer.dataset.fullscreen).toBe("true");
    expect(viewer.className).not.toMatch(/aspect-/);
    // you hold control: the keyboard goes to the desktop in full screen
    expect(focus).toHaveBeenCalled();

    // the exit button inside the full-screen viewer (Esc does the same in a browser)
    await click(byText("Exit full screen"));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(viewer.dataset.fullscreen).toBeUndefined();
    expect(byText("Exit full screen")).toBeUndefined();

    // Esc: the browser leaves full screen by itself, the panel follows
    await click(byText("Full screen"));
    fullscreenElement = null;
    await act(async () => change());
    expect(viewer.dataset.fullscreen).toBeUndefined();
  } finally {
    delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
    delete (document as { exitFullscreen?: unknown }).exitFullscreen;
    delete (document as { fullscreenElement?: unknown }).fullscreenElement;
  }
});

test("full screen without the Fullscreen API: a clear error, nothing else changes", async () => {
  server = { state: "running", holder: "agent", calls: [] };
  installFetch();
  await render();
  await click(byText("Full screen"));
  expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/Full screen is not available in this browser/);
  expect(vnc.clients).toHaveLength(1);
});

/** Type into a React-controlled textarea. */
async function typeInto(el: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("clipboard: what is copied on the desktop shows for every viewer; text goes to the desktop only in control", async () => {
  server = { state: "running", holder: "agent", calls: [] };
  installFetch();
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  try {
    await render();
    const rfb = vnc.clients[0]! as unknown as EventTarget & { pasted: string[] };
    expect(document.querySelector('[data-testid="computer-clipboard"]')).toBeNull();
    await click(byText("Clipboard"));
    expect(document.querySelector('[data-testid="computer-clipboard"]')).toBeTruthy();
    // ServerCutText: noVNC's clipboard event
    await act(async () => { rfb.dispatchEvent(new CustomEvent("clipboard", { detail: { text: "codice 1234" } })); });
    const from = document.querySelector<HTMLTextAreaElement>('[data-testid="clipboard-from-desktop"]')!;
    expect(from.value).toBe("codice 1234");
    await click(byText("Copy"));
    expect(writeText).toHaveBeenCalledWith("codice 1234");
    // view-only: nothing can be sent
    const to = document.querySelector<HTMLTextAreaElement>('[data-testid="clipboard-to-desktop"]')!;
    expect(to.disabled).toBe(true);
    expect(byText("Send")?.disabled).toBe(true);

    await click(byText("Take control"));
    await act(async () => { rfb.dispatchEvent(new Event("connect")); });
    await flush();
    expect(to.disabled).toBe(false);
    await typeInto(to, "https://example.com/login");
    await click(byText("Send"));
    expect(rfb.pasted).toEqual(["https://example.com/login"]);
  } finally {
    delete (navigator as { clipboard?: unknown }).clipboard;
  }
});

test("the viewer keeps the desktop's proportions (its size)", async () => {
  expect(desktopAspect("1600x900")).toBe("1600 / 900");
  expect(desktopAspect(undefined)).toBeUndefined();
  expect(desktopAspect("big")).toBeUndefined();
  server = { state: "running", holder: "agent", calls: [], size: "1600x900" };
  installFetch();
  await render();
  const viewer = document.querySelector<HTMLElement>('[role="application"]')!;
  expect(viewer.style.aspectRatio).toBe("1600 / 900");
  expect(viewer.dataset.size).toBe("1600x900");
  expect(viewer.className).not.toMatch(/aspect-\[16\/10\]/);
});
