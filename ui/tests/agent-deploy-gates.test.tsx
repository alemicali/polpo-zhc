/**
 * Deploy gates in the dashboard (agent suites phase 3): the Versions tab shows the required suites,
 * a deploy being verified ("in verifica": progress, each suite, cancel, deploy anyway), each
 * version's gate (✓ passed, ✗ blocked, verifying), the history's blocked deploys and overrides with
 * what failed, and the override dialog that needs a reason. A blocked deploy opens it.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const PENDING = {
  id: "g-pending", agent: "shop", version: "1.3.0", from: "1.1.0", trigger: "deploy", status: "running", requestedBy: "person:ada@example.com",
  requestedAt: "2026-11-25T10:00:00.000Z", progress: { done: 2, total: 5 }, notes: [],
  suites: [
    { suiteId: "shipping", suiteName: "Shipping rates", suiteRevision: 2, runId: "sr-1", status: "running", reasons: [], failedCases: [], thresholds: { minPassRate: 1 }, progress: { done: 2, total: 3 } },
    { suiteId: "tone", suiteName: "Tone", suiteRevision: 1, status: "queued", reasons: [], failedCases: [], thresholds: { minPassRate: 1 }, progress: { done: 0, total: 2 } },
  ],
};
const BLOCKED_REF = {
  id: "g-blocked", status: "blocked", trigger: "deploy",
  failed: ["Shipping rates: pass rate 50% < 100% (1/2 passed)"],
  suites: [{ suiteId: "shipping", suiteName: "Shipping rates", status: "failed", runId: "sr-0", passRate: 0.5 }],
};
const VERSIONS = [
  { agent: "shop", version: "1.3.0", author: "person:ada@example.com", createdAt: "2026-11-25T09:00:00.000Z", bump: "minor", changes: [], changedFields: ["allowedTools"], gate: { gateId: "g-pending", status: "running", trigger: "deploy", at: "2026-11-25T10:00:00.000Z", failed: [], progress: { done: 2, total: 5 } } },
  { agent: "shop", version: "1.2.0", author: "person:ada@example.com", createdAt: "2026-11-24T09:00:00.000Z", bump: "patch", changes: [], changedFields: ["systemPrompt"], gate: { gateId: "g-blocked", status: "blocked", trigger: "deploy", at: "2026-11-24T10:00:00.000Z", failed: BLOCKED_REF.failed } },
  { agent: "shop", version: "1.1.0", author: "person:ada@example.com", createdAt: "2026-11-23T09:00:00.000Z", bump: "patch", changes: [], changedFields: ["role"], gate: { gateId: "g-ok", status: "passed", trigger: "publish", at: "2026-11-23T10:00:00.000Z", failed: [] } },
];
const DEPLOYS = [
  { id: "g-blocked", agent: "shop", pointer: "production", from: "1.1.0", to: "1.2.0", action: "blocked", actor: "person:ada@example.com", note: "Blocked by suites: …", at: "2026-11-24T10:00:00.000Z", gate: BLOCKED_REF },
  { id: "d-ovr", agent: "shop", pointer: "production", from: "1.0.0", to: "1.1.0", action: "deploy", actor: "person:bob@example.com", at: "2026-11-23T11:00:00.000Z",
    gate: { id: "g-old", status: "override", trigger: "deploy", failed: ["Tone: score 0.40 < 0.6"], suites: [{ suiteId: "tone", suiteName: "Tone", status: "failed" }], override: { by: "person:bob@example.com", at: "2026-11-23T11:00:00.000Z", reason: "Hotfix for the outage", failed: ["Tone: score 0.40 < 0.6"] } } },
];
const state = { pending: true, blockOnDeploy: false };
const gatesApi = {
  cancel: vi.fn(async () => ({ ...PENDING, status: "cancelled" })),
  override: vi.fn(async () => ({ status: "deployed", to: "1.2.0" })),
  get: vi.fn(),
};
const deploysApi = {
  deploy: vi.fn(async (v: string): Promise<unknown> => {
    if (state.blockOnDeploy) {
      throw Object.assign(new Error("Blocked by suites: Shipping rates: pass rate 50% < 100%. Production stays on 1.1.0."), {
        code: "GATE_BLOCKED",
        details: { status: "blocked", gate: { ...PENDING, id: "g-new", version: v, status: "blocked", suites: [{ ...PENDING.suites[0], status: "failed", reasons: ["pass rate 50% < 100%"] }] } },
      });
    }
    return { status: "pending", gate: { ...PENDING, version: v } };
  }),
  rollback: vi.fn(async () => ({ ...DEPLOYS[1], action: "rollback" })),
  get: vi.fn(async (id: string) => ({ ...DEPLOYS.find((d) => d.id === id)!, diff: { agent: "shop", from: "1.1.0", to: "1.2.0", changes: [], unified: "" } })),
};
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));

vi.mock("@polpo-ai/react", () => ({
  useAgentVersions: () => ({
    data: {
      state: {
        agent: "shop", production: "1.1.0", latest: "1.3.0", pointers: { production: "1.1.0" }, versions: 3,
        draft: { exists: false, hasChanges: false, stale: false, changes: [] },
        gate: { requiredSuites: [{ id: "shipping", name: "Shipping rates", onPublish: true, allowRealTools: false }, { id: "tone", name: "Tone", onPublish: false, allowRealTools: false }] },
      },
      versions: VERSIONS,
    },
    isLoading: false, error: null, refetch: async () => undefined,
    diff: vi.fn(async () => ({ agent: "shop", from: "1.1.0", to: "1.2.0", changes: [], unified: "" })), get: vi.fn(), publish: vi.fn(), discardDraft: vi.fn(), rebaseDraft: vi.fn(),
  }),
  useAgentDeploys: () => ({ data: DEPLOYS, isLoading: false, error: null, refetch: async () => undefined, ...deploysApi }),
  useAgentDeployGates: () => ({
    data: state.pending ? [PENDING] : [], pending: state.pending ? PENDING : undefined, isLoading: false, error: null, refetch: async () => undefined, ...gatesApi,
  }),
}));
vi.mock("../src/components/agents/agent-detail-context", () => ({
  useAgentDetail: () => ({ meta: { agentName: "shop" }, actions: { refetch: async () => undefined } }),
}));
vi.mock("sonner", () => ({ toast }));

import { AgentVersionsTab } from "../src/components/agents/agent-versions-tab";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  for (const f of [...Object.values(gatesApi), ...Object.values(deploysApi), ...Object.values(toast)]) f.mockClear();
  state.pending = true;
  state.blockOnDeploy = false;
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
const type = async (el: HTMLElement | null, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
};

async function render() {
  await act(async () => root.render(<AgentVersionsTab />));
  await flush();
}

test("a deploy in verifica: progress, each suite, cancel; deploy anyway needs a reason", async () => {
  await render();
  const pending = q('[data-testid="pending-gate"]')!;
  expect(pending.textContent).toContain("Verifying 1.3.0");
  expect(pending.textContent).toContain("2 required suites · 2/5 cases · production stays on 1.1.0");
  expect(pending.querySelector('[aria-label="40% of the cases done"]')).not.toBeNull();
  expect(pending.textContent).toContain("Shipping rates");
  expect(pending.textContent).toContain("2/3 cases");

  await click(q('[data-testid="gate-cancel"]'));
  expect(gatesApi.cancel).toHaveBeenCalledWith("g-pending");

  await click(q('[data-testid="gate-override-pending"]'));
  const dialog = q('[data-testid="override-dialog"]')!;
  expect(dialog.textContent).toContain("Deploy 1.3.0 anyway?");
  const confirm = q('[data-testid="override-confirm"]') as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  await type(q('[data-testid="override-reason"]'), "Customers are waiting");
  expect((q('[data-testid="override-confirm"]') as HTMLButtonElement).disabled).toBe(false);
  await click(q('[data-testid="override-confirm"]'));
  expect(gatesApi.override).toHaveBeenCalledWith("g-pending", "Customers are waiting");
});

test("versions and the deploy history show each gate: verifying, blocked with what failed, passed, override with its reason", async () => {
  state.pending = false;
  await render();
  expect(q('[data-testid="required-suites"]')!.textContent).toContain("Deploys are verified first by Shipping rates, Tone");
  const badges = qa('[data-testid="version-row"]').map((r) => r.querySelector('[data-testid="gate-badge"]')?.getAttribute("data-gate-status"));
  expect(badges).toEqual(["running", "blocked", "passed"]);
  expect(qa('[data-testid="version-row"]')[0]!.textContent).toContain("Verifying 2/5");

  const rows = qa('[data-testid="deploy-row"]');
  expect(rows.map((r) => r.getAttribute("data-action"))).toEqual(["blocked", "deploy"]);
  expect(rows[0]!.textContent).toContain("Blocked by suites");
  expect(rows[1]!.textContent).toContain("Override");
  expect(rows[1]!.textContent).toContain("override: “Hotfix for the outage”");

  // a blocked deploy opens what failed and the run, and offers the override
  await click(rows[0]!.querySelector("button"));
  const details = rows[0]!.querySelector('[data-testid="gate-details"]')!;
  expect(details.textContent).toContain("Shipping rates");
  expect(details.textContent).toContain("pass rate 50%");
  expect((details.querySelector("a") as HTMLAnchorElement).getAttribute("href")).toBe("?tab=suites&run=sr-0");
  await click(q('[data-testid="gate-override"]'));
  expect(q('[data-testid="override-dialog"]')!.textContent).toContain("Shipping rates: pass rate 50% < 100% (1/2 passed)");
});

test("deploying through the gate: the confirmation names the required suites; pending says so; blocked opens the override", async () => {
  state.pending = false;
  await render();
  await click(q('[aria-label="Deploy version 1.3.0"]'));
  expect(document.body.textContent).toContain("First the required suites run against it (Shipping rates, Tone)");
  await click(byText("Verify and deploy", '[role="dialog"] button'));
  expect(deploysApi.deploy).toHaveBeenCalledWith("1.3.0");
  expect(toast.info).toHaveBeenCalledWith("Verifying 1.3.0: production moves when the required suites pass");

  state.blockOnDeploy = true;
  await click(q('[aria-label="Deploy version 1.2.0"]'));
  await click(byText("Verify and deploy", '[role="dialog"] button'));
  expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Blocked by suites"));
  const dialog = q('[data-testid="override-dialog"]')!;
  expect(dialog.textContent).toContain("Deploy 1.2.0 anyway?");
  expect(dialog.textContent).toContain("Shipping rates: pass rate 50% < 100%");
});
