import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { ConversationCheck, ConversationCheckStore, NewConversationCheck } from "@polpo-ai/core";

function atomicWrite(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${nanoid(6)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
}

/** One JSON file per check in .polpo/conversation-checks/. */
export class FileConversationCheckStore implements ConversationCheckStore {
  private readonly dir: string;

  constructor(polpoDir: string) {
    this.dir = join(polpoDir, "conversation-checks");
    mkdirSync(this.dir, { recursive: true });
  }

  private path(id: string): string {
    return join(this.dir, `${encodeURIComponent(id)}.json`);
  }

  private readAll(): ConversationCheck[] {
    const checks: ConversationCheck[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        checks.push(JSON.parse(readFileSync(join(this.dir, name), "utf-8")) as ConversationCheck);
      } catch { /* a half-written or foreign file */ }
    }
    return checks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async createCheck(input: NewConversationCheck): Promise<ConversationCheck> {
    const now = new Date();
    const { firstRunAt, proposed, ...fields } = input;
    const check: ConversationCheck = {
      ...fields,
      id: `chk_${nanoid(12)}`,
      state: proposed ? "proposed" : "active",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: firstRunAt ?? new Date(now.getTime() + input.everyMinutes * 60_000).toISOString(),
      runs: 0,
    };
    atomicWrite(this.path(check.id), check);
    return check;
  }

  async getCheck(id: string): Promise<ConversationCheck | undefined> {
    try {
      return JSON.parse(readFileSync(this.path(id), "utf-8")) as ConversationCheck;
    } catch {
      return undefined;
    }
  }

  async listChecks(filter: Parameters<ConversationCheckStore["listChecks"]>[0] = {}): Promise<ConversationCheck[]> {
    return this.readAll().filter((c) => (!filter.sessionId || c.sessionId === filter.sessionId)
      && (filter.agent === undefined || c.agent === filter.agent)
      && (!filter.states || filter.states.includes(c.state)));
  }

  async dueChecks(now: string): Promise<ConversationCheck[]> {
    return this.readAll().filter((c) => c.state === "active" && c.nextRunAt <= now)
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
  }

  async updateCheck(id: string, patch: Partial<Omit<ConversationCheck, "id" | "createdAt">>): Promise<ConversationCheck | undefined> {
    const current = await this.getCheck(id);
    if (!current) return undefined;
    const next: ConversationCheck = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
    atomicWrite(this.path(id), next);
    return next;
  }
}
