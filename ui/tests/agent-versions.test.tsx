/**
 * Agent versions in the dashboard: the Versions tab (draft with its diff, publish dialog with the
 * suggested bump, discard), the published versions (view read-only, diff two, deploy with a
 * confirmation), the deploys (production pointer, rollback with a confirmation, history whose rows
 * open their diff, unified or split) and the header badges.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const DRAFT_DIFF = {
  agent: "writer", from: "1.1.0", to: "draft", suggestedBump: "minor",
  changes: [{ field: "allowedTools", kind: "changed" }],
  unified: "--- a/writer@1.1.0.yaml\n+++ b/writer@draft.yaml\n@@ -1,2 +1,3 @@\n allowedTools:\n   - read\n+  - bash\n",
};
const DEPLOY_DIFF = {
  agent: "writer", from: "1.0.0", to: "1.1.0",
  changes: [{ field: "systemPrompt", kind: "changed" }],
  unified: "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n systemPrompt: |\n-  Be concise.\n+  Be brief.\n",
};
const VERSIONS = [
  { agent: "writer", version: "1.1.0", author: "person:ada@example.com", createdAt: "2026-11-20T10:00:00.000Z", note: "Tone", bump: "minor", changes: [], changedFields: ["systemPrompt"] },
  { agent: "writer", version: "1.0.0", author: "system:migration", createdAt: "2026-11-18T10:00:00.000Z", note: "Initial version", bump: "initial", changes: [], changedFields: ["role"] },
];
const DEPLOYS = [
  { id: "d2", agent: "writer", pointer: "production", from: "1.0.0", to: "1.1.0", action: "deploy", actor: "person:ada@example.com", note: "ship", at: "2026-11-20T11:00:00.000Z" },
  { id: "d1", agent: "writer", pointer: "production", to: "1.0.0", action: "initial", actor: "system:migration", at: "2026-11-18T10:00:00.000Z" },
];
const versionsApi = {
  diff: vi.fn(async (o?: { from?: string; to?: string }) => (o?.to === "draft" ? DRAFT_DIFF : DEPLOY_DIFF)),
  get: vi.fn(async (v: string) => ({ ...VERSIONS.find((x) => x.version === v)!, config: { role: "Writes", systemPrompt: "Be brief." }, skillVersions: { style: 3 } })),
  publish: vi.fn(async (req: { deploy?: boolean }) => ({ version: { ...VERSIONS[0], version: "1.2.0" }, ...(req.deploy ? { deploy: DEPLOYS[0] } : {}) })),
  discardDraft: vi.fn(async () => undefined),
  rebaseDraft: vi.fn(async () => ({ from: "1.1.0", to: "1.0.0", dropped: false })),
};
const draftState = { stale: false };
const deploysApi = {
  deploy: vi.fn(async (v: string) => ({ ...DEPLOYS[0], from: "1.1.0", to: v })),
  rollback: vi.fn(async () => ({ ...DEPLOYS[0], action: "rollback", from: "1.1.0", to: "1.0.0" })),
  get: vi.fn(async (id: string) => ({ ...DEPLOYS.find((d) => d.id === id)!, diff: DEPLOY_DIFF })),
};

vi.mock("@polpo-ai/react", () => ({
  useAgentVersions: () => ({
    data: {
      state: {
        agent: "writer", production: "1.1.0", latest: "1.1.0", pointers: { production: "1.1.0" }, versions: 2,
        draft: { exists: true, hasChanges: true, changes: DRAFT_DIFF.changes, suggestedBump: "minor", nextVersion: "1.2.0", updatedAt: "2026-11-21T10:00:00.000Z", updatedBy: "person:ada@example.com",
          baseVersion: draftState.stale ? "1.2.0" : "1.1.0", stale: draftState.stale },
      },
      versions: VERSIONS,
    },
    isLoading: false, error: null, refetch: async () => undefined, ...versionsApi,
  }),
  useAgentDeploys: () => ({ data: DEPLOYS, isLoading: false, error: null, refetch: async () => undefined, ...deploysApi }),
  // no required suites: no deploy gates (ui/tests/agent-deploy-gates.test.tsx has them)
  useAgentDeployGates: () => ({ data: [], pending: undefined, isLoading: false, error: null, refetch: async () => undefined, get: vi.fn(), cancel: vi.fn(), override: vi.fn() }),
}));
vi.mock("../src/components/agents/agent-detail-context", () => ({
  useAgentDetail: () => ({ meta: { agentName: "writer" }, actions: { refetch: async () => undefined } }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { AgentVersionsTab, AgentVersionBadges } from "../src/components/agents/agent-versions-tab";
import { actorLabel } from "../src/lib/agent-versions";
import { AgentVersioningSetting } from "../src/components/config/agent-versioning-setting";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  for (const f of [...Object.values(versionsApi), ...Object.values(deploysApi)]) f.mockClear();
  draftState.stale = false;
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => [...document.body.querySelectorAll(sel)] as HTMLElement[];
const byText = (text: string | RegExp, sel = "button") => [...document.body.querySelectorAll(sel)].find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? ""))) as HTMLElement | undefined;
const click = async (el: HTMLElement | null | undefined) => { await act(async () => { el!.click(); }); await flush(); };

async function render() {
  await act(async () => root.render(<AgentVersionsTab />));
  await flush();
}

test("draft: unpublished changes with their diff; publish dialog suggests the bump and can deploy", async () => {
  await render();
  expect(q('[aria-label="Draft"]')!.textContent).toContain("unpublished changes");
  expect(q('[aria-label="Draft"]')!.textContent).toContain("next 1.2.0 (minor)");
  // the draft's diff, coloured lines
  const added = qa('[data-testid="unified-diff"] [data-line="add"]');
  expect(added.map((l) => l.textContent)).toEqual(["+  - bash"]);
  expect(added[0]!.className).toContain("text-success");

  await click(q('[data-testid="open-publish"]'));
  expect(q('[data-testid="publish-dialog"]')!.textContent).toContain("Publish version 1.2.0");
  expect(byText(/minor · +suggested/)?.getAttribute("data-state")).toBe("on");
  await click(byText(/major/));
  expect(q('[data-testid="publish-dialog"]')!.textContent).toContain("Publish version 2.0.0");
  await click(byText("Publish and deploy"));
  expect(versionsApi.publish).toHaveBeenCalledWith({ bump: "major", deploy: true });
});

test("versions: production marked, view read-only, two selected show their diff (unified or split)", async () => {
  await render();
  const rows = qa('[data-testid="version-row"]');
  expect(rows.map((r) => r.querySelector(".font-mono")?.textContent)).toEqual(["1.1.0", "1.0.0"]);
  expect(rows[0]!.textContent).toContain("Production");
  expect(rows[0]!.textContent).toContain("ada@example.com");
  expect(q('[aria-label="Deploy version 1.1.0"]')).toBeNull();

  await click(q('[aria-label="View version 1.1.0"]'));
  expect(q('[data-testid="version-view"]')!.textContent).toContain("Be brief.");
  expect(q('[data-testid="version-view"]')!.textContent).toContain("style v3");
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  await flush();

  await click(q('[aria-label="Compare version 1.0.0"]'));
  await click(q('[aria-label="Compare version 1.1.0"]'));
  expect(versionsApi.diff).toHaveBeenCalledWith({ from: "1.0.0", to: "1.1.0" });
  const diffs = qa('[data-testid="agent-version-diff"]');
  const pair = diffs.at(-1)!;
  expect(pair.textContent).toContain("1.0.0 → 1.1.0");
  await click([...pair.querySelectorAll("button")].find((b) => b.textContent === "Split") as HTMLElement);
  const split = pair.querySelector('[data-testid="split-diff"]')!;
  expect(split.textContent).toContain("−   Be concise.");
  expect(split.textContent).toContain("+   Be brief.");
});

test("deploy and rollback ask first; the history rows open their diff; discard asks first", async () => {
  await render();
  expect(q('[data-testid="production-version"]')!.textContent).toBe("v1.1.0");
  const history = qa('[data-testid="deploy-row"]');
  expect(history.map((r) => r.getAttribute("data-action"))).toEqual(["deploy", "initial"]);
  expect(history[0]!.textContent).toContain("1.0.0 → 1.1.0");
  expect(history[0]!.textContent).toContain("“ship”");

  await click(history[0]!.querySelector("button"));
  expect(deploysApi.get).toHaveBeenCalledWith("d2");
  expect(history[0]!.querySelector('[data-testid="agent-version-diff"]')!.textContent).toContain("systemPrompt");

  await click(q('[aria-label="Deploy version 1.0.0"]'));
  expect(document.body.textContent).toContain("Deploy 1.0.0 to production?");
  expect(deploysApi.deploy).not.toHaveBeenCalled();
  await click(byText("Deploy", "[role=\"dialog\"] button"));
  expect(deploysApi.deploy).toHaveBeenCalledWith("1.0.0");

  await click(q('[data-testid="rollback"]'));
  expect(document.body.textContent).toContain("Roll production back to 1.0.0?");
  await click(byText("Roll back", "[role=\"dialog\"] button"));
  expect(deploysApi.rollback).toHaveBeenCalledWith({ to: "1.0.0" });

  await click(q('[aria-label="Discard the draft"]'));
  expect(versionsApi.discardDraft).not.toHaveBeenCalled();
  await click(byText("Discard", "[role=\"dialog\"] button"));
  expect(versionsApi.discardDraft).toHaveBeenCalled();
});

test("header badges: production version and draft has changes", async () => {
  await act(async () => root.render(<AgentVersionBadges agent={{ name: "writer", versioning: { production: "1.1.0", pointers: {}, versions: 2, draft: { exists: true, hasChanges: true, changedFields: ["role"] } } }} />));
  expect(q('[data-testid="agent-version-badges"]')!.textContent).toBe("v1.1.0Draft has changes");
  expect(actorLabel("person:ada@example.com")).toBe("ada@example.com");
  expect(actorLabel("system:migration")).toBe("migration");
  expect(actorLabel("mcp:Claude")).toBe("MCP Claude");
});

test("settings: API/MCP updates published and deployed at once, switchable", async () => {
  const calls: Array<{ url: string; method?: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const onSaved = vi.fn();
  await act(async () => root.render(<AgentVersioningSetting autoDeploy onSaved={onSaved} />));
  const sw = q('[aria-label="Publish and deploy API and MCP agent updates at once"]')!;
  expect(sw.getAttribute("data-state")).toBe("checked");
  await click(sw);
  expect(calls.at(-1)).toMatchObject({ method: "PATCH", body: { agents: { versioning: { autoDeployApiUpdates: false } } } });
  expect(calls.at(-1)!.url).toContain("/api/v1/config/settings");
  expect(onSaved).toHaveBeenCalled();
  vi.unstubAllGlobals();
});

test("a stale draft (production moved by a rollback): warning, rebase or discard, no publish", async () => {
  draftState.stale = true;
  await render();
  const warning = q('[data-testid="draft-stale"]')!;
  expect(warning.textContent).toContain("The draft is based on 1.2.0, production is now 1.1.0");
  expect((q('[data-testid="open-publish"]') as HTMLButtonElement).disabled).toBe(true);
  await click(q('[data-testid="rebase-draft"]'));
  expect(versionsApi.rebaseDraft).toHaveBeenCalled();
  await act(async () => root.render(<AgentVersionBadges agent={{ name: "writer", versioning: { production: "1.0.0", pointers: {}, versions: 2, draft: { exists: true, hasChanges: true, changedFields: ["role"], stale: true, warning: "writer's draft is based on 1.1.0, production is now 1.0.0" } } }} />));
  expect(q('[data-testid="agent-version-badges"]')!.textContent).toBe("v1.0.0Draft out of date");
});
