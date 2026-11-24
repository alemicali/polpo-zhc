/**
 * Harness sessions on disk, shared by the server and the task runners:
 *
 * - status (no secrets): .polpo/harness-sessions.json — which agent, computer, runtime, whether
 *   its bootstrap ran, when it last detached and resumed, what it cost. The dashboard and the MCP
 *   tools read it.
 * - resume state (a bridge private key): in the vault, system namespace "$harness" (encrypted at
 *   rest like every vault entry; never visible to agents).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CliId, HarnessId, VaultStore } from "@polpo-ai/core";
import { acquireFileLock } from "../sandbox/file-lock.js";
import type { HarnessResumeState } from "./types.js";

/** Vault namespace of resume states (reserved: "$" owners are never agents). */
export const HARNESS_VAULT_OWNER = "$harness";

export type HarnessSessionState = "starting" | "running" | "idle" | "detached" | "stopped" | "error";

export interface HarnessSessionStatus {
  key: string;
  agent: string;
  harness: HarnessId;
  /** "cli": the CLI engine (the official program signed in with a person's account), else the harness engine. */
  engine?: "harness" | "cli";
  /** CLI engine: which program and which account. */
  cli?: CliId;
  account?: string;
  /** "host" or a computer id. */
  computerId: string;
  scope: "task" | "chat";
  taskId?: string;
  chatSessionId?: string;
  /** The harness session id (stable across detach/resume). */
  sessionId?: string;
  /** The runtime's own conversation id (Claude Code session, Codex thread). */
  runtimeSessionId?: string;
  state: HarnessSessionState;
  /** The process that holds it live (server or task runner), while live. */
  pid?: number;
  /** The VM it last ran on. */
  remoteId?: string;
  bridgePort?: number;
  /** When the runtime's bootstrap (install in the VM) last completed. */
  bootstrappedAt?: string;
  bootstrapMs?: number;
  lastDetachAt?: string;
  lastResumeAt?: string;
  /** A resume state is stored (in the vault). */
  resumable: boolean;
  turns: number;
  costUsd: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export function harnessSessionKey(o: { scope: "task"; taskId: string } | { scope: "chat"; agent: string; chatSessionId: string }): string {
  return o.scope === "task" ? `task:${o.taskId}` : `chat:${o.agent}:${o.chatSessionId}`;
}

export class HarnessSessionStore {
  private readonly file: string;
  private readonly lock: string;

  constructor(readonly polpoDir: string, private readonly vault?: VaultStore) {
    this.file = join(polpoDir, "harness-sessions.json");
    this.lock = join(polpoDir, ".locks", "harness-sessions.lock");
  }

  list(): HarnessSessionStatus[] {
    return Object.values(this.readAll()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(key: string): HarnessSessionStatus | undefined {
    return this.readAll()[key];
  }

  private readAll(): Record<string, HarnessSessionStatus> {
    if (!existsSync(this.file)) return {};
    try { return JSON.parse(readFileSync(this.file, "utf8")) as Record<string, HarnessSessionStatus>; } catch { return {}; }
  }

  /** Read-modify-write under the shared lock (server and runners). fn → null deletes. */
  async update(key: string, fn: (cur: HarnessSessionStatus | undefined) => HarnessSessionStatus | null): Promise<HarnessSessionStatus | undefined> {
    const release = await acquireFileLock(this.lock, { waitMs: 10_000 });
    try {
      const all = this.readAll();
      const next = fn(all[key]);
      if (next) all[key] = { ...next, updatedAt: new Date().toISOString() };
      else delete all[key];
      mkdirSync(this.polpoDir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
      return next ?? undefined;
    } finally {
      release();
    }
  }

  async saveResumeState(key: string, state: HarnessResumeState): Promise<void> {
    if (!this.vault) throw new Error("No vault: a harness resume state cannot be stored");
    await this.vault.set(HARNESS_VAULT_OWNER, key, {
      type: "custom",
      label: `Harness session ${key} (resume state, contains a bridge key)`,
      credentials: { state: JSON.stringify(state) },
    });
  }

  async loadResumeState(key: string): Promise<HarnessResumeState | undefined> {
    const entry = await this.vault?.get(HARNESS_VAULT_OWNER, key).catch(() => undefined);
    const raw = entry?.credentials?.state;
    if (!raw) return undefined;
    try { return JSON.parse(raw) as HarnessResumeState; } catch { return undefined; }
  }

  async forgetResumeState(key: string): Promise<void> {
    await this.vault?.remove(HARNESS_VAULT_OWNER, key).catch(() => false);
  }
}

/** Whether a process id is alive on this machine (a status's holder). */
export function processAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}
