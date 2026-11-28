import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Task } from "@polpo-ai/react";
import { MemoryRouter } from "react-router-dom";
import { TaskPauseControl, TaskPausedBanner } from "../src/components/tasks/task-pause";
import { canPauseTask, canResumeTask, pauseSummary, pausedForTakeover } from "../src/lib/task-pause";
import { taskStatusStyles } from "../src/lib/status-tokens";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const paused = (pause: Task["pause"]): Pick<Task, "status" | "pause"> => ({ status: "paused", pause });

test("which tasks can be paused or resumed, and how a pause reads", () => {
  for (const s of ["pending", "assigned", "in_progress"] as const) expect(canPauseTask({ status: s })).toBe(true);
  for (const s of ["review", "done", "failed", "draft", "awaiting_approval", "paused"] as const) expect(canPauseTask({ status: s })).toBe(false);
  expect(canResumeTask({ status: "paused" })).toBe(true);
  expect(canResumeTask({ status: "pending" })).toBe(false);
  expect(pauseSummary(paused({ at: "2026-11-28T08:00:00Z", from: "in_progress", by: "anna@acme.com", reason: "waiting for the logo" }))).toBe("Paused by anna@acme.com · waiting for the logo");
  expect(pauseSummary({ status: "pending" })).toBeUndefined();
  expect(pausedForTakeover(paused({ at: "x", from: "in_progress", takeover: { requestId: "r1", computerId: "nina-01" } }))).toBe(true);
  // the paused status uses the look's warning token, never a fixed colour
  expect(taskStatusStyles.paused).toMatchObject({ tone: "warning", label: "Paused", color: "text-warning" });
});

test("the banner says who paused it, why, and that completing the takeover resumes it", () => {
  act(() => root.render(<MemoryRouter><TaskPausedBanner task={paused({ at: new Date().toISOString(), from: "in_progress", by: "nina", reason: "waiting for takeover", runId: "r1", takeover: { requestId: "r1", computerId: "nina-01" } })} /></MemoryRouter>));
  const banner = host.querySelector("[data-testid=task-paused-banner]")!;
  expect(banner.textContent).toContain("Paused by nina");
  expect(banner.textContent).toContain("waiting for takeover");
  expect(banner.textContent).toContain("completing the takeover resumes it");
  expect(banner.querySelector("a")!.getAttribute("href")).toBe("/computers/nina-01");
  act(() => root.render(<TaskPausedBanner task={{ status: "pending" }} />));
  expect(host.querySelector("[data-testid=task-paused-banner]")).toBeNull();
});

test("Pause asks for a reason, Resume for a message; nothing for a finished task", async () => {
  const onPause = vi.fn(async () => undefined);
  const onResume = vi.fn(async () => undefined);
  act(() => root.render(<TaskPauseControl task={{ status: "in_progress" }} onPause={onPause} onResume={onResume} />));
  act(() => (host.querySelector("[data-testid=task-pause]") as HTMLButtonElement).click());
  const area = document.querySelector("textarea")!;
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    set.call(area, "waiting for the client");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => (document.querySelector("[data-testid=task-pause-confirm]") as HTMLButtonElement).click());
  expect(onPause).toHaveBeenCalledWith("waiting for the client");

  act(() => root.render(<TaskPauseControl task={{ status: "paused" }} onPause={onPause} onResume={onResume} />));
  act(() => (host.querySelector("[data-testid=task-resume]") as HTMLButtonElement).click());
  await act(async () => (document.querySelector("[data-testid=task-resume-confirm]") as HTMLButtonElement).click());
  expect(onResume).toHaveBeenCalledWith(undefined);

  act(() => root.render(<TaskPauseControl task={{ status: "done" }} onPause={onPause} onResume={onResume} />));
  expect(host.querySelector("button")).toBeNull();
});
