/**
 * Decision branches on the mission and playbook graphs and the mission's task list: the branch a
 * decision took is highlighted (edge with the answer and confidence, its tasks), the others are
 * dashed and muted "Not reached" (never green / done), pending decisions leave branches neutral, an
 * uncertain one waits for you; counts keep not-reached tasks out of done. Legacy skipped tasks
 * (result text only) are recognised too.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ReactFlowProvider, type Edge, type Node } from "@xyflow/react";
import type { Task } from "@polpo-ai/react";
import { MemoryRouter } from "react-router-dom";
import { buildGraphLayout, DecisionNodeComponent, TaskNodeComponent, TaskStepCard } from "../src/pages/mission-detail";
import { branchEdgeState, countTaskOutcomes, decisionBranchView, displayTaskStatus, notReachedOf } from "../src/lib/task-not-reached";
import type { MissionDecisionDef, MissionTaskDef } from "../src/lib/mission-data";

const taskDefs: MissionTaskDef[] = [
  { title: "Triage", description: "Read it" },
  { title: "Refund", description: "Refund it", dependsOn: ["Triage"] },
  { title: "Reply", description: "Answer it", dependsOn: ["Triage"] },
  { title: "Follow up", description: "Check back", dependsOn: ["Reply"] },
] as MissionTaskDef[];

const route: MissionDecisionDef = {
  name: "route", afterTasks: ["Triage"],
  question: { type: "choice", instructions: "Which team?", choices: [{ value: "billing" }, { value: "support" }] },
  branches: { billing: ["Refund"], support: ["Reply"] },
} as MissionDecisionDef;

const skip = (branch: string) => ({ reason: "decision" as const, node: "route", branch, answer: `decision: ${branch} (0.81)`, confidence: 0.81 });
const task = (title: string, over: Partial<Task> = {}): Task => ({
  id: `t-${title}`, title, description: "", assignTo: "a", dependsOn: [], status: "pending", expectations: [], metrics: [], retries: 0, maxRetries: 2,
  createdAt: "2026-11-26T10:00:00Z", updatedAt: "2026-11-26T10:00:00Z", ...over,
} as Task);
const skipped = (title: string, branch = "billing") => task(title, {
  status: "done", result: { exitCode: 0, stdout: `Skipped: the decision "route" took the branch "${branch}" (decision: ${branch} (0.81))`, stderr: "", duration: 0, skipped: skip(branch) },
});

const edgeTo = (edges: Edge[], target: string) => edges.find((e) => e.source === "decision-0" && e.target === target)!;
const nodeOf = (nodes: Node[], id: string) => nodes.find((n) => n.id === id)!;

describe("the graph's decision branches", () => {
  test("decided (the run ended: from the skipped tasks' markers): the chosen edge is highlighted with the answer and confidence, the other dashed and Not reached", () => {
    const live: Record<string, Task> = {
      Triage: task("Triage", { status: "done" }),
      Reply: task("Reply", { status: "done" }),
      Refund: skipped("Refund", "support"),
      "Follow up": task("Follow up", { status: "done" }),
    };
    const { nodes, edges } = buildGraphLayout(taskDefs, (t) => live[t], [], undefined, undefined, [], undefined, undefined, [route], new Map());
    const chosen = edgeTo(edges, "task-2"); // Reply
    const other = edgeTo(edges, "task-1"); // Refund
    expect((chosen.data as { branchState: string }).branchState).toBe("taken");
    expect(chosen.label).toBe("support ✓ 0.81");
    expect(chosen.style?.stroke).toBe("var(--primary)");
    expect(chosen.style?.strokeDasharray).toBeUndefined();
    expect((other.data as { branchState: string }).branchState).toBe("not_reached");
    expect(other.label).toBe("billing · Not reached");
    expect(other.style?.strokeDasharray).toBe("4 4");
    expect(other.style?.stroke).not.toContain("success");
    // the decision node says what it chose; the chosen branch's task is marked on its node
    expect((nodeOf(nodes, "decision-0").data as { view: { status: string; branch: string } }).view).toMatchObject({ status: "decided", branch: "support" });
    expect((nodeOf(nodes, "task-2").data as { chosenBranch?: string }).chosenBranch).toBe("route → support");
    expect((nodeOf(nodes, "task-1").data as { chosenBranch?: string }).chosenBranch).toBeUndefined();
  });

  test("pending: branches neutral; deciding: animated; uncertain: waiting for you", () => {
    const pending = buildGraphLayout(taskDefs, () => undefined, [], undefined, undefined, [], undefined, undefined, [route], new Map());
    for (const t of ["task-1", "task-2"]) {
      const e = edgeTo(pending.edges, t);
      expect((e.data as { branchState: string }).branchState).toBe("pending");
      expect(e.style?.strokeDasharray).toBeUndefined();
      expect(e.label).toMatch(/^(billing|support)$/);
    }
    const awaiting = buildGraphLayout(taskDefs, () => undefined, [], undefined, undefined, [], undefined, undefined, [route],
      new Map([["route", { status: "awaiting" as const, suggested: "billing" }]]));
    expect((edgeTo(awaiting.edges, "task-1").data as { branchState: string }).branchState).toBe("awaiting");
    const deciding = buildGraphLayout(taskDefs, () => undefined, [], undefined, undefined, [], undefined, undefined, [route],
      new Map([["route", { status: "deciding" as const }]]));
    expect(edgeTo(deciding.edges, "task-2").animated).toBe(true);
  });

  test("live state wins while the run goes on", () => {
    const view = decisionBranchView(route, { status: "decided", branch: "billing", answer: "decision: billing", confidence: 0.9 }, () => undefined);
    expect(view).toMatchObject({ status: "decided", branch: "billing", confidence: 0.9 });
    expect(branchEdgeState(view, ["billing"])).toBe("taken");
    expect(branchEdgeState(view, ["support"])).toBe("not_reached");
  });

  test("a task after a not-reached one: its incoming edge is dashed, not the done colour", () => {
    const live: Record<string, Task> = { Triage: task("Triage", { status: "done" }), Reply: skipped("Reply", "billing"), "Follow up": skipped("Follow up", "billing"), Refund: task("Refund", { status: "done" }) };
    const { edges } = buildGraphLayout(taskDefs, (t) => live[t], [], undefined, undefined, [], undefined, undefined, [route], new Map());
    const dep = edges.find((e) => e.source === "task-2" && e.target === "task-3")!;
    expect(dep.style?.strokeDasharray).toBe("4 4");
    expect(dep.style?.stroke).not.toContain("success");
  });
});

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = async (node: React.ReactNode) => { await act(async () => root.render(<MemoryRouter><ReactFlowProvider>{node}</ReactFlowProvider></MemoryRouter>)); };
// React Flow passes more props; the components read data and selected only
const nodeProps = (data: Record<string, unknown>) => ({ data, selected: false }) as unknown as Parameters<typeof TaskNodeComponent>[0];

describe("graph nodes and the mission's task list", () => {
  test("a not-reached task node is dashed and muted, labelled Not reached with the decision in its tooltip", async () => {
    await render(<TaskNodeComponent {...nodeProps({ taskDef: taskDefs[1], liveTask: skipped("Refund", "support"), index: 1 })} />);
    const node = container.querySelector<HTMLElement>("[data-testid=mission-task-node]")!;
    expect(node.dataset.notReached).toBe("true");
    expect(node.className).toContain("border-dashed");
    expect(node.className).not.toContain("bg-success");
    expect(node.getAttribute("title")).toBe("Decision route chose support");
    expect(node.textContent).toContain("Not reached");
    expect(node.textContent).not.toContain("Done");
  });

  test("a task on the chosen branch is highlighted with its branch", async () => {
    await render(<TaskNodeComponent {...nodeProps({ taskDef: taskDefs[2], liveTask: task("Reply", { status: "in_progress" }), index: 2, chosenBranch: "route → support" })} />);
    const node = container.querySelector<HTMLElement>("[data-testid=mission-task-node]")!;
    expect(node.dataset.chosenBranch).toBe("true");
    expect(node.className).toContain("ring-primary/40");
    expect(node.textContent).toContain("support");
  });

  test("the decision node: chose a branch with confidence; uncertain waits for you; pending is neutral", async () => {
    await render(<DecisionNodeComponent {...(nodeProps({ decision: route, view: { status: "decided", branch: "support", confidence: 0.81 } }) as unknown as Parameters<typeof DecisionNodeComponent>[0])} />);
    expect(container.querySelector("[data-testid=decision-node]")!.textContent).toContain("Chose support · 0.81");
    await render(<DecisionNodeComponent {...(nodeProps({ decision: route, view: { status: "awaiting", suggested: "billing" } }) as unknown as Parameters<typeof DecisionNodeComponent>[0])} />);
    expect(container.querySelector("[data-testid=decision-node]")!.textContent).toContain("Waiting for you");
    await render(<DecisionNodeComponent {...(nodeProps({ decision: route, view: { status: "pending" } }) as unknown as Parameters<typeof DecisionNodeComponent>[0])} />);
    const pending = container.querySelector<HTMLElement>("[data-testid=decision-node]")!;
    expect(pending.dataset.state).toBe("pending");
    expect(pending.className).toContain("border-border");
  });

  test("the task list: a not-reached step is dashed, labelled Not reached, not done", async () => {
    await render(<TaskStepCard taskDef={taskDefs[1]} index={1} isLast liveTask={skipped("Refund", "support")} navigate={() => {}} />);
    const step = container.querySelector<HTMLElement>("[data-testid=mission-task-step]")!;
    expect(step.dataset.notReached).toBe("true");
    expect(step.className).toContain("border-dashed");
    expect(step.className).not.toContain("border-success");
    expect(step.textContent).toContain("Not reached");
    expect(step.textContent).toContain("Decision route chose support");
  });
});

describe("counts and legacy tasks", () => {
  test("not-reached tasks are counted apart from done", () => {
    const tasks = [task("Triage", { status: "done" }), skipped("Refund", "support"), task("Reply", { status: "done" }), task("Follow up", { status: "failed" })];
    expect(countTaskOutcomes(tasks)).toEqual({ total: 4, done: 2, failed: 1, notReached: 1, active: 0 });
    expect(tasks.map(displayTaskStatus)).toEqual(["done", "not_reached", "done", "failed"]);
  });

  test("a task skipped before the marker existed (result text only) is not reached; a done task that ran is not", () => {
    const legacy = task("Refund", { status: "done", result: { exitCode: 0, stdout: 'Skipped: the decision "route" took the branch "support" (decision: support (0.81))', stderr: "", duration: 0 } });
    expect(notReachedOf(legacy)).toMatchObject({ node: "route", branch: "support", confidence: 0.81 });
    expect(notReachedOf(task("Reply", { status: "done", result: { exitCode: 0, stdout: "Refunded.", stderr: "", duration: 1 } }))).toBeUndefined();
    // the API's top-level marker is read too (slim lists)
    expect(notReachedOf({ status: "done", notReached: skip("billing") } as unknown as Task)).toMatchObject({ branch: "billing" });
  });
});
