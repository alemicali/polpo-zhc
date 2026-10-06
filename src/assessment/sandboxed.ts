/**
 * Assessment commands (test and script expectations, metrics) run in the sandbox the task ran
 * in: same working directory, output directory, hidden .polpo and storage mounts. A task that
 * ran on this machine without a sandbox ("local", or none resolved) is assessed as before.
 */
import { join } from "node:path";
import type { RunnerConfig, Task } from "../core/types.js";
import type { RunRecord } from "../core/run-store.js";
import type { Workspace } from "@polpo-ai/core/sandbox";
import type { AssessFn } from "../core/orchestrator-context.js";
import { createWorkspace, WorkspaceShell } from "../sandbox/manager.js";
import { assessTask } from "./assessor.js";

export interface SandboxedAssessmentOptions {
  getRunByTaskId(taskId: string): Promise<RunRecord | undefined>;
  /**
   * Remote adapters (Daytona, E2B) can return the workspace the task ran in, or a new one with
   * the same files. When it returns nothing, commands run in a bubblewrap jail on this host.
   */
  workspaceForAssessment?: (taskId: string, run: RunRecord) => Promise<Workspace | undefined>;
  /** Host storage mounts, for the bwrap fallback of a remote sandbox. */
  hostMounts?: (agentName: string) => Promise<NonNullable<RunnerConfig["mounts"]>>;
}

/** Open the workspace a finished run's checks should run in, or undefined for "as today". */
export async function openAssessmentWorkspace(opts: SandboxedAssessmentOptions, task: Task): Promise<Workspace | undefined> {
  const run = await opts.getRunByTaskId(task.id).catch(() => undefined);
  const config = run?.config as RunnerConfig | undefined;
  const sandbox = config?.sandbox;
  if (!run || !config || !sandbox || sandbox.provider === "local") return undefined;

  const remote = sandbox.provider === "daytona" || sandbox.provider === "e2b";
  if (remote) {
    const hooked = await opts.workspaceForAssessment?.(task.id, run);
    if (hooked) return hooked;
  }
  const mounts = remote ? await opts.hostMounts?.(config.agent.name).catch(() => []) ?? [] : config.mounts ?? [];
  const hostMounts = mounts.filter((m) => m.hostPath);
  const allowed = config.agent.allowedPaths ?? [];
  return createWorkspace(sandbox, {
    root: config.cwd,
    writable: [...(config.outputDir ? [config.outputDir] : []), ...allowed.filter((p) => !hostMounts.some((m) => m.hostPath === p))],
    readable: [join(config.polpoDir, "skills"), join(config.polpoDir, "playbooks")],
    mounts: hostMounts,
    hide: [config.polpoDir],
  });
}

/** The default assessment function of the orchestrator: assessTask, with commands in the run's sandbox. */
export function sandboxedAssessFn(opts: SandboxedAssessmentOptions): AssessFn {
  return async (task, cwd, onProgress, context, reasoning, onCheckProgress) => {
    const workspace = await openAssessmentWorkspace(opts, task);
    if (!workspace) return assessTask(task, cwd, onProgress, context, reasoning, onCheckProgress);
    try {
      return await assessTask(task, cwd, onProgress, context, reasoning, onCheckProgress, { shell: new WorkspaceShell(workspace) });
    } finally {
      await workspace.dispose().catch(() => undefined);
    }
  };
}
