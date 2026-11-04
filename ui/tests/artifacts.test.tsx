import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@polpo-ai/react", () => ({ useEvents: () => ({ events: [] }) }));

import { ARTIFACT_CHANNEL, ARTIFACT_CSP, artifactFrameDoc } from "../src/lib/artifact-frame-doc";
import { artifactDownload, artifactIdOf, artifactLabel } from "../src/lib/artifacts-api";
import { ArtifactFrame } from "../src/components/artifacts/artifact-frame";

test("the frame document puts the policy and the bridge before anything of the page", () => {
  const withDoctype = artifactFrameDoc("<!DOCTYPE html><html><head><script>evil()</script></head><body>x</body></html>", "dark");
  expect(withDoctype.startsWith("<!DOCTYPE html><meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
  expect(withDoctype.indexOf("window.polpo=")).toBeLessThan(withDoctype.indexOf("evil()"));
  expect(withDoctype).toContain('theme:"dark"');
  const bare = artifactFrameDoc("<h1>Hi</h1>", "light");
  expect(bare.startsWith("<!doctype html><meta http-equiv")).toBe(true);
  expect(bare.endsWith("<h1>Hi</h1>")).toBe(true);
  // no network but the bridge; a few CDNs for libraries
  expect(ARTIFACT_CSP).toContain("connect-src 'none'");
  expect(ARTIFACT_CSP).toContain("default-src 'none'");
  expect(ARTIFACT_CSP).toMatch(/script-src [^;]*https:\/\/cdn\.jsdelivr\.net/);
});

test("labels, downloads and the artifact id in a tool result", () => {
  expect(artifactLabel({ type: "html", kind: "dashboard" })).toBe("Dashboard");
  expect(artifactLabel({ type: "mermaid" })).toBe("Diagram");
  expect(artifactDownload({ title: "Q4 Sales / EU", type: "html" })).toEqual({ filename: "q4-sales-eu.html", mime: "text/html" });
  expect(artifactDownload({ title: "Plan", type: "doc" }).filename).toBe("plan.md");
  expect(artifactIdOf('Created artifact art_Ab-12 (html/dashboard): "Sales". Open: /artifacts/art_Ab-12')).toBe("art_Ab-12");
  expect(artifactIdOf("Error: nope")).toBeUndefined();
});

let root: Root;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const data = body.method === "sources" ? [{ id: "sales", name: "Sales" }] : null;
    return new Response(JSON.stringify(data ? { ok: true, data } : { ok: false, error: "Access denied to Sales" }), { status: data ? 200 : 403 });
  });
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

test("the frame answers the page's data calls, only from its own window", async () => {
  await act(async () => root.render(<ArtifactFrame artifactId="art_1" html="<h1>x</h1>" title="Sales" />));
  const iframe = container.querySelector("iframe")!;
  expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-popups allow-modals");
  const win = iframe.contentWindow!;
  type Posted = { channel: string; type: string; id?: number; ok?: boolean; data?: unknown; error?: string };
  const posted: Posted[] = [];
  vi.spyOn(win, "postMessage").mockImplementation(((m: Posted) => { posted.push(m); }) as never);

  const send = async (data: unknown, source: unknown = win) => {
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", { data, source: source as Window }));
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  await send({ channel: ARTIFACT_CHANNEL, type: "call", id: 1, method: "sources" });
  await send({ channel: ARTIFACT_CHANNEL, type: "call", id: 2, method: "query", params: { sourceId: "sales", dataset: "secret" } });
  await send({ channel: ARTIFACT_CHANNEL, type: "call", id: 3, method: "mutate" });
  // from another window: ignored
  await send({ channel: ARTIFACT_CHANNEL, type: "call", id: 4, method: "sources" }, window);

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/v1/artifacts/art_1/data");
  const results = posted.filter((m) => m.type === "result");
  expect(results).toEqual(expect.arrayContaining([
    { channel: ARTIFACT_CHANNEL, type: "result", id: 1, ok: true, data: [{ id: "sales", name: "Sales" }] },
    { channel: ARTIFACT_CHANNEL, type: "result", id: 2, ok: false, error: "Access denied to Sales" },
    { channel: ARTIFACT_CHANNEL, type: "result", id: 3, ok: false, error: "Unknown method mutate" },
  ]));
  expect(results.find((m) => m.id === 4)).toBeUndefined();
});

test("the bridge script itself: calls go to the parent, results and refreshes come back", async () => {
  const { bridgeScript } = await import("../src/lib/artifact-frame-doc");
  const listeners: Array<(e: { source: unknown; data: unknown }) => void> = [];
  const sent: unknown[] = [];
  const parent = { postMessage: (m: unknown) => sent.push(m) };
  const attrs: Record<string, string> = {};
  type Polpo = {
    theme: string;
    query(q: unknown): Promise<unknown>;
    sql(id: string, sql: string): Promise<unknown>;
    onRefresh(fn: () => void): void;
    onTheme(fn: (theme: string) => void): void;
  };
  const fakeWindow: { polpo?: Polpo; addEventListener: (type: string, fn: (e: { source: unknown; data: unknown }) => void) => void } = {
    addEventListener: (_type, fn) => { listeners.push(fn); },
  };
  const fakeDocument = { readyState: "complete", documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; } }, addEventListener: () => {} };
  new Function("window", "parent", "document", bridgeScript("light"))(fakeWindow, parent, fakeDocument);
  const polpo = fakeWindow.polpo!;
  expect(polpo.theme).toBe("light");
  expect(attrs["data-theme"]).toBe("light");

  const answer = polpo.query({ sourceId: "sales", dataset: "orders" });
  expect(sent[0]).toEqual({ channel: ARTIFACT_CHANNEL, type: "call", id: 1, method: "query", params: { sourceId: "sales", dataset: "orders" } });
  // a message from elsewhere is ignored; the parent's answer resolves the call
  listeners.forEach((fn) => fn({ source: {}, data: { channel: ARTIFACT_CHANNEL, type: "result", id: 1, ok: true, data: "fake" } }));
  listeners.forEach((fn) => fn({ source: parent, data: { channel: ARTIFACT_CHANNEL, type: "result", id: 1, ok: true, data: { rows: [{ n: 1 }] } } }));
  await expect(answer).resolves.toEqual({ rows: [{ n: 1 }] });

  const failing = polpo.sql("sales", "delete from orders");
  listeners.forEach((fn) => fn({ source: parent, data: { channel: ARTIFACT_CHANNEL, type: "result", id: 2, ok: false, error: "read-only" } }));
  await expect(failing).rejects.toThrow("read-only");

  const refreshed = vi.fn();
  polpo.onRefresh(refreshed);
  await new Promise((r) => setTimeout(r, 0)); // runs once when ready
  listeners.forEach((fn) => fn({ source: parent, data: { channel: ARTIFACT_CHANNEL, type: "refresh" } }));
  expect(refreshed).toHaveBeenCalledTimes(2);

  const themed = vi.fn();
  polpo.onTheme(themed);
  listeners.forEach((fn) => fn({ source: parent, data: { channel: ARTIFACT_CHANNEL, type: "theme", theme: "dark" } }));
  expect(themed).toHaveBeenCalledWith("dark");
  expect(polpo.theme).toBe("dark");
  expect(attrs["data-theme"]).toBe("dark");
});
