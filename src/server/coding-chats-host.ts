/**
 * The instance's coding chat manager (src/coding/chat-manager.ts), one per orchestrator and .polpo
 * directory: the settings and sign-in mode it checks accounts against, the worktree check (the
 * same roots as the Coding app's terminals), and the bus (coding:chat).
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Orchestrator } from "../core/orchestrator.js";
import { CodingChatManager } from "../coding/chat-manager.js";
import type { CliLauncher } from "../cli-engine/process.js";
import { getEffectiveAllowedRoots } from "./coding-config-store.js";
import { isInstanceAuthEnabled } from "./auth/instance-auth.js";

const managers = new WeakMap<Orchestrator, { dir: string; manager: CodingChatManager }>();

function inside(target: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** A worktree for a coding chat: inside the agent workspace or an allowed root, and an existing folder. */
export function checkCodingCwd(cwd: string, workDir: string, polpoDir: string): string {
  const target = resolve(workDir, cwd.trim() || ".");
  if (![workDir, ...getEffectiveAllowedRoots(polpoDir)].some((root) => inside(target, root))) {
    throw new Error("The worktree must be inside the agent workspace or a whitelisted root (Coding → Settings)");
  }
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`No such folder: ${target}`);
  return target;
}

export function codingChatManagerFor(o: Orchestrator, opts: { launch?: CliLauncher } = {}): CodingChatManager {
  const dir = o.getPolpoDir();
  const cur = managers.get(o);
  if (cur && cur.dir === dir) return cur.manager;
  const manager = new CodingChatManager({
    polpoDir: dir,
    settings: () => o.getConfig()?.settings,
    instanceAuth: () => isInstanceAuthEnabled(),
    checkCwd: (cwd) => checkCodingCwd(cwd, o.getAgentWorkDir(), o.getPolpoDir()),
    ...(opts.launch ? { launch: opts.launch } : {}),
    emit: (e) => o.emit("coding:chat", e),
  });
  managers.set(o, { dir, manager });
  return manager;
}
