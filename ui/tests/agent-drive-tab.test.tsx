import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@polpo-ai/react", () => ({ useEvents: () => ({ events: [] }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../src/components/agents/agent-detail-context", () => ({
  useAgentDetail: () => ({ actions: { refetch: vi.fn(async () => {}) }, meta: { agentName: "coach" } }),
}));

import { AgentDriveTab } from "../src/components/agents/agent-drive-tab";

const data = {
  drive: { enabled: true, purpose: "Be Alessio's health coach", goals: ["Three workouts a week"], autonomy: "balanced" },
  self: "I am Coach: warm, direct, a bit ironic.",
  selfHistory: [],
  plan: [
    { id: "pln_long", title: "Alessio is fit by spring", horizon: "long", owner: "Alessio", measure: "-6 kg", status: "todo", createdAt: "", updatedAt: "" },
    { id: "pln_week", title: "Three workouts this week", horizon: "week", parentId: "pln_long", progress: 66, status: "doing", createdAt: "", updatedAt: "" },
    { id: "pln_step", title: "Write a nutrition skill", parentId: "pln_long", status: "todo", createdAt: "", updatedAt: "" },
    { id: "pln_old", title: "Set up the plan", status: "done", createdAt: "", updatedAt: "" },
  ],
  intentions: [
    { id: "chk_1", state: "proposed", prompt: "", message: "Happy birthday Grazia! 🎉", why: "Grazia's birthday", everyMinutes: 0, nextRunAt: "2026-10-14T07:00:00Z", runs: 0, target: { chatId: "-100", name: "Family" } },
    { id: "chk_2", state: "active", prompt: "Ask Alessio how the workout went", everyMinutes: 0, cron: "0 20 * * 1,3,5", timezone: "Europe/Rome", nextRunAt: "2026-10-14T18:00:00Z", runs: 2, target: { chatId: "42", name: "Alessio" } },
  ],
  journal: [{ id: "ref_1", at: "2026-10-13T08:00:00Z", trigger: "daily", reviews: ["day", "week"], messages: 3, summary: "Planned wishes for Grazia.", actions: ["proposed chk_1 → Family"] }],
  lastReflectionAt: "2026-10-13T08:00:00Z",
};

let root: Root;
let container: HTMLDivElement;
let calls: Array<[string, string]>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push([init?.method ?? "GET", String(url)]);
    return new Response(JSON.stringify({ ok: true, data: init?.method ? {} : data }), { status: 200, headers: { "content-type": "application/json" } });
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

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

test("shows purpose, self-portrait, intentions to approve and reflections; approving calls the API", async () => {
  await act(async () => root.render(<AgentDriveTab />));
  await settle();
  const text = container.textContent ?? "";
  expect(text).toContain("Purpose and goals");
  expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Be Alessio's health coach");
  expect(text).toContain("I am Coach: warm, direct, a bit ironic.");
  expect(text).toContain("Waiting for your yes");
  expect(text).toContain("Happy birthday Grazia! 🎉");
  expect(text).toContain("Why: Grazia's birthday");
  expect(text).toContain("cron 0 20 * * 1,3,5 (Europe/Rome) → Alessio");
  expect(text).toContain("Planned wishes for Grazia.");
  expect(text).toContain("(daily, weekly review)");
  // goals by horizon, the week goal under the long one, closed ones apart
  expect(text).toContain("6–12 monthsAlessio is fit by springfor Alessio");
  expect(text).toContain("Measure: -6 kg");
  expect(text).toContain("WeekThree workouts this weekIn progress");
  expect(text).toContain("Done recently");
  const done = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Done") && b.closest("div[style]")?.textContent?.includes("Write a nutrition skill"))!;
  await act(async () => done.click());
  await settle();
  expect(calls).toContainEqual(["PATCH", expect.stringContaining("/api/v1/drive/coach/plan/pln_step")]);

  const approve = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Approve"))!;
  await act(async () => approve.click());
  await settle();
  expect(calls).toContainEqual(["POST", expect.stringContaining("/api/v1/drive/coach/intentions/chk_1/confirm")]);
});
