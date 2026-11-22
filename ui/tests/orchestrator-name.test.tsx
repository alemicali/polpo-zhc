/**
 * The orchestrator's display name (settings.orchestratorName): "Polpo" by default, never the
 * branding's product name; known from the first render (runtime-config.js, else the cached copy);
 * the chat labels and the group member directory (and so @mentions) use it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@polpo-ai/react", () => ({
  useAgents: () => ({ agents: [{ name: "giulia", identity: { displayName: "Giulia" } }], isLoading: false }),
}));

const UI = resolve(process.cwd(), process.cwd().endsWith("/ui") ? "." : "ui");
const setRc = (rc: Record<string, unknown> | undefined) => {
  (globalThis as { __POLPO_RUNTIME_CONFIG__?: unknown }).__POLPO_RUNTIME_CONFIG__ = rc;
};

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});
afterEach(() => {
  setRc(undefined);
  vi.unstubAllGlobals();
});

async function directoryNames(): Promise<string[]> {
  const { useMemberDirectory } = await import("@/components/groups/use-member-directory");
  function Probe() {
    return <ul>{useMemberDirectory().members.map((m) => <li key={m.id}>{m.name}</li>)}</ul>;
  }
  return [...renderToStaticMarkup(<Probe />).matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);
}

describe("the orchestrator's name", () => {
  it("is Polpo by default, even when the branding renames the product", async () => {
    setRc({ branding: { productName: "Lumea" } });
    const mod = await import("@/lib/orchestrator-name");
    expect(mod.getOrchestratorName()).toBe("Polpo");
    expect(await directoryNames()).toEqual(["Polpo", "Giulia"]);
  });

  it("comes from runtime-config.js on the first render, and names the orchestrator in the member directory", async () => {
    setRc({ branding: { productName: "Lumea" }, orchestratorName: "Ada" });
    const { useOrchestratorName } = await import("@/lib/orchestrator-name");
    function Label() { return <span>{`Message ${useOrchestratorName()}...`}</span>; }
    expect(renderToStaticMarkup(<Label />)).toContain("Message Ada...");
    expect(await directoryNames()).toEqual(["Ada", "Giulia"]);
  });

  it("falls back to the cached copy, and an invalid name to Polpo", async () => {
    localStorage.setItem(`polpo-orchestrator-name:${window.location.origin}`, "Cached Ada");
    let mod = await import("@/lib/orchestrator-name");
    expect(mod.getOrchestratorName()).toBe("Cached Ada");
    vi.resetModules();
    setRc({ orchestratorName: "x".repeat(41) });
    localStorage.clear();
    mod = await import("@/lib/orchestrator-name");
    expect(mod.getOrchestratorName()).toBe("Polpo");
    expect(mod.normalizeOrchestratorName("  Ada  ")).toBe("Ada");
    expect(mod.normalizeOrchestratorName("   ")).toBeUndefined();
    expect(mod.normalizeOrchestratorName("a\nb")).toBeUndefined();
  });

  it("updates mounted labels when it changes (a save, the API)", async () => {
    const mod = await import("@/lib/orchestrator-name");
    const el = document.createElement("div");
    const root = createRoot(el);
    function Label() { return <span>{mod.useOrchestratorName()}</span>; }
    await act(async () => { root.render(<Label />); });
    expect(el.textContent).toBe("Polpo");
    await act(async () => { mod.setOrchestratorName("Ada"); });
    expect(el.textContent).toBe("Ada");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { name: "Bea" } }))));
    await act(async () => { await mod.loadOrchestratorName(); });
    expect(el.textContent).toBe("Bea");
    await act(async () => { mod.setOrchestratorName(""); });
    expect(el.textContent).toBe("Polpo");
    await act(async () => { root.unmount(); });
  });

  it("is never derived from the branding in the chat or the member directory", () => {
    for (const file of ["src/pages/chat.tsx", "src/components/groups/use-member-directory.ts", "src/components/layout/header.tsx"]) {
      const source = readFileSync(resolve(UI, file), "utf8");
      expect(source, file).not.toMatch(/productName/);
      expect(source, file).toMatch(/useOrchestratorName/);
    }
  });
});
