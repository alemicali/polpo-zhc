import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { agentCardText, buildAgentCard, type AgentCardInput } from "../server/mcp-agent-card.js";

const now = new Date("2026-10-25T23:30:00.000Z"); // 00:30 on the 26th in Rome (UTC+1: summer time ended that night)
const base = (over: Partial<AgentCardInput> = {}): AgentCardInput => ({
  agent: { name: "coach", role: "Health coach", identity: { displayName: "Coach Ada", timezone: "Europe/Rome" }, drive: { enabled: true, goals: ["Help Alessio eat well"] } },
  tasks: [],
  now,
  key: { createdAt: 1, seq: 1 },
  ...over,
});

describe("agent card", () => {
  it("is idle with nothing to do, and falls back to the configured goal", () => {
    const card = buildAgentCard(base());
    expect(card).toMatchObject({ status: "idle", today: { done: 0, failed: 0, waiting: 0 }, goal: { title: "Help Alessio eat well" }, drive: true });
    expect(card.current).toBeUndefined();
    expect(card.next).toBeUndefined();
    expect(agentCardText(card)).toBe("Coach Ada (coach) — Health coach: idle.\nToday: 0 done, 0 failed, 0 waiting for a person.\nMain goal: Help Alessio eat well.");
  });

  it("counts today in the agent's timezone and shows the task at hand", () => {
    const card = buildAgentCard(base({
      tasks: [
        { id: "a", title: "Yesterday in Rome", status: "done", assignTo: "coach", updatedAt: "2026-10-25T22:50:00.000Z" },
        { id: "b", title: "Today in Rome", status: "done", assignTo: "coach", updatedAt: "2026-10-25T23:10:00.000Z" },
        { id: "c", title: "Failed today", status: "failed", assignTo: "coach", updatedAt: "2026-10-25T23:20:00.000Z" },
        { id: "d", title: "Running", status: "in_progress", assignTo: "coach", updatedAt: "2026-10-25T20:00:00.000Z" },
        { id: "e", title: "Someone else's", status: "done", assignTo: "other", updatedAt: "2026-10-25T22:15:00.000Z" },
      ],
    }));
    expect(card.today).toEqual({ done: 1, failed: 1, waiting: 0 });
    expect(card.current).toMatchObject({ id: "d", active: true });
    expect(card.status).toBe("working");
    expect(card.tasks.map((t) => t.id)).toEqual(["c", "b", "a", "d"]);
  });

  it("waits for a person on approvals and proposals; the next item is the earliest", () => {
    const card = buildAgentCard(base({
      tasks: [{ id: "x", title: "Send the plan", status: "awaiting_approval", assignTo: "coach", updatedAt: "2026-10-25T22:00:00.000Z" }],
      drive: {
        intentions: [
          { id: "late", prompt: "weekly review", state: "active", nextRunAt: "2026-10-27T08:00:00.000Z", cron: "0 9 * * 1" },
          { id: "soon", prompt: "wish Grazia a happy birthday", why: "Grazia's birthday was yesterday", state: "proposed", nextRunAt: "2026-10-26T07:30:00.000Z" },
          { id: "gone", prompt: "old", state: "cancelled", nextRunAt: "2026-10-26T06:00:00.000Z" },
        ],
      },
    }));
    expect(card.status).toBe("waiting");
    expect(card.today.waiting).toBe(2);
    expect(card.next).toMatchObject({ id: "soon", text: "Grazia's birthday was yesterday", proposed: true, recurring: false });
    expect(card.routine.map((r) => r.id)).toEqual(["soon", "late"]);
    expect(card.routine[1]).toMatchObject({ recurring: true, cron: "0 9 * * 1" });
  });

  it("the main goal is the broadest open goal of its plan", () => {
    const card = buildAgentCard(base({
      drive: {
        plan: [
          { id: "w", title: "This week: 5 vegetable days", horizon: "week", parentId: "m", status: "doing", progress: 60 },
          { id: "m", title: "A month of balanced meals", horizon: "month", status: "doing", progress: 30, measure: "20 of 30 days" },
          { id: "l", title: "Lose 5 kg", horizon: "long", status: "done" },
          { id: "s", title: "A step, not a goal", status: "todo" },
        ],
      },
    }));
    expect(card.goal).toEqual({ title: "A month of balanced meals", progress: 30, horizon: "month", measure: "20 of 30 days" });
    expect(card.goals.map((g) => g.id)).toEqual(["l", "m", "w"]);
  });
});

describe("agent card widget", () => {
  const root = join(__dirname, "..", "..");
  it("the generated HTML is up to date with widgets/ (pnpm run build:widgets)", () => {
    expect(() => execFileSync(process.execPath, [join(root, "widgets", "build.mjs"), "--check"], { cwd: root, stdio: "pipe" })).not.toThrow();
  }, 30_000);

  it("the widget's TypeScript checks", () => {
    expect(() => execFileSync(join(root, "node_modules", ".bin", "tsc"), ["-p", join(root, "widgets", "tsconfig.json")], { cwd: root, stdio: "pipe" })).not.toThrow();
  }, 60_000);
});
