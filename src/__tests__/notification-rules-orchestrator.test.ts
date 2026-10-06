import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../core/orchestrator.js";
import { InMemoryTaskStore, InMemoryRunStore, InMemoryTaskControlStore, createTestAgent } from "./fixtures.js";
import type { Mission, NotificationRule } from "../core/types.js";
import type { NotificationChannel, Notification } from "../notifications/types.js";

class MockChannel implements NotificationChannel {
  readonly type = "mock";
  sent: Notification[] = [];
  async send(notification: Notification): Promise<void> {
    this.sent.push(notification);
  }
  async test(): Promise<boolean> { return true; }
}

describe("Orchestrator notification rules wiring", () => {
  let dir: string;
  let store: InMemoryTaskStore;
  let orchestrator: Orchestrator;

  const globalRule: NotificationRule = {
    id: "global-rule",
    name: "Global",
    events: ["mission:executed"],
    channels: ["global"],
  };

  const writeConfig = (rules: NotificationRule[]) => writeFileSync(
    join(dir, ".polpo", "polpo.json"),
    JSON.stringify({
      project: "p",
      settings: {
        maxRetries: 1, workDir: ".", logLevel: "quiet", storage: "file",
        notifications: { channels: {}, rules },
      },
    }, null, 2),
  );

  async function start(rules: NotificationRule[]) {
    writeConfig(rules);
    store = new InMemoryTaskStore();
    orchestrator = new Orchestrator({
      workDir: dir,
      store,
      runStore: new InMemoryRunStore(),
      taskControlStore: new InMemoryTaskControlStore(),
      assessFn: async () => ({ passed: true, checks: [], metrics: [], timestamp: new Date().toISOString() }),
    });
    await orchestrator.initInteractive("p", { name: "t", agents: [createTestAgent({ name: "a" })] });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polpo-notif-rules-"));
    mkdirSync(join(dir, ".polpo"), { recursive: true });
  });

  afterEach(async () => {
    await orchestrator?.gracefulStop?.(0).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses mission-scoped rules instead of global rules for events of that mission", async () => {
    await start([globalRule]);

    const mission = {
      id: "m1",
      name: "m1",
      data: "{}",
      status: "active",
      notifications: {
        rules: [{ id: "mission-rule", name: "Mission", events: ["mission:executed"], channels: ["mission"] }],
      },
    } as unknown as Mission;
    (store as unknown as { getMission: (id: string) => Promise<Mission | undefined> }).getMission =
      async (id: string) => (id === "m1" ? mission : undefined);

    const router = orchestrator.getNotificationRouter()!;
    const globalCh = new MockChannel();
    const missionCh = new MockChannel();
    router.registerChannel("global", globalCh);
    router.registerChannel("mission", missionCh);

    orchestrator.emit("mission:executed", { missionId: "m1", group: "m1", taskCount: 0 });

    await vi.waitFor(() => expect(missionCh.sent.length + globalCh.sent.length).toBeGreaterThan(0));
    expect(missionCh.sent).toHaveLength(1);
    expect(globalCh.sent).toHaveLength(0);
  });

});
