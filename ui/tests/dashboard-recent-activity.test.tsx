/**
 * Dashboard → Recent Activity: every task row is a link to its task page (keyboard reachable),
 * and the assignee's name carries a small inline avatar (identity.avatar, else initials).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Task } from "@polpo-ai/react";

vi.mock("@polpo-ai/react", () => ({
  useTasks: () => ({ tasks: [], isLoading: false }),
  useMissions: () => ({ missions: [] }),
  useProcesses: () => ({ processes: [] }),
  useAgents: () => ({ agents: [] }),
}));
vi.mock("@/hooks/use-token-usage", () => ({ useTokenUsage: () => ({ usage: null, isLoading: false }) }));

import { RecentTasks } from "../src/pages/dashboard";

afterEach(cleanup);

function task(over: Partial<Task>): Task {
  return {
    id: "t1",
    title: "Write the report",
    description: "",
    assignTo: "claudio",
    status: "done",
    retries: 0,
    maxRetries: 2,
    createdAt: "2026-11-28T09:00:00.000Z",
    updatedAt: "2026-11-28T10:00:00.000Z",
    ...over,
  } as Task;
}

function TaskPage() {
  const { taskId } = useParams();
  return <p data-testid="task-page">{taskId}</p>;
}

function renderList(tasks: Task[], agents = [{ name: "claudio", identity: { displayName: "Claudio", avatar: "agents/claudio.png" } }]) {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<RecentTasks tasks={tasks} agents={agents} />} />
          <Route path="/tasks/:taskId" element={<TaskPage />} />
        </Routes>
      </MemoryRouter>
    </TooltipProvider>,
  );
}

describe("Recent Activity", () => {
  test("each task row links to its task detail page", () => {
    renderList([task({ id: "t1", title: "Write the report" }), task({ id: "a b/2", title: "Ship it", assignTo: "marta" })]);
    const first = screen.getByTestId("recent-task-t1");
    expect(first.tagName).toBe("A");
    expect(first.getAttribute("href")).toBe("/tasks/t1");
    expect(within(first).getByText("Write the report")).toBeTruthy();
    const second = screen.getByTestId("recent-task-a b/2");
    expect(second.getAttribute("href")).toBe(`/tasks/${encodeURIComponent("a b/2")}`);
    // a native link: focusable with the keyboard, no tabindex tricks
    expect(second.getAttribute("tabindex")).toBeNull();
    fireEvent.click(first);
    expect(screen.getByTestId("task-page").textContent).toBe("t1");
  });

  test("the agent's avatar shows small, inline next to its name", () => {
    renderList([task({ id: "t1" })]);
    const line = screen.getByTestId("recent-task-agent");
    expect(line.textContent).toContain("claudio");
    const avatar = line.firstElementChild as HTMLElement;
    expect(avatar.className).toContain("size-4");
    expect(avatar.className).not.toMatch(/(^|\s)size-(5|6|8|10|14)(\s|$)/);
    expect(avatar.className).toContain("rounded-avatar");
  });

  test("without an avatar image, the initials stand in at the same small size", () => {
    renderList([task({ id: "t2", assignTo: "marta" })], []);
    const line = screen.getByTestId("recent-task-agent");
    const avatar = line.firstElementChild as HTMLElement;
    expect(avatar.textContent).toBe("MA");
    expect(avatar.className).toContain("size-4");
  });

  test("a task without an assignee shows no avatar", () => {
    renderList([task({ id: "t3", assignTo: "" })]);
    const line = screen.getByTestId("recent-task-agent");
    expect(line.children.length).toBe(1);
    expect(line.firstElementChild?.tagName).toBe("SPAN");
  });
});
