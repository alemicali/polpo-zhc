/**
 * Per-process wiring of hosted servers: the code worker pool and, in the server process, the hook
 * that turns a queued call into an Approvals request. Task runner processes have no hook: their
 * queued calls are picked up by the server process (McpServerService.syncPendingApprovals).
 */
import type { VaultStore } from "@polpo-ai/core";
import type { CodeRunner, HostedRuntimeDeps } from "./runtime.js";
import { BwrapCodeRunner } from "./code-worker.js";

type ApprovalHook = NonNullable<HostedRuntimeDeps["requestApproval"]>;

const approvalHooks = new Map<string, ApprovalHook>();
let codeRunner: CodeRunner | undefined;
/** Default: the bubblewrap worker pool (Linux with bwrap); elsewhere code tools are unavailable. */
let codeRunnerFactory: (() => CodeRunner) | undefined = () => new BwrapCodeRunner();

let defaults: Partial<HostedRuntimeDeps> = {};

/** Tests: the network every hosted call in this process uses (fetch, DNS). */
export function setHostedDefaults(next: Partial<HostedRuntimeDeps>): void {
  defaults = next;
}

export function setHostedApprovalHook(polpoDir: string, hook: ApprovalHook | undefined): void {
  if (hook) approvalHooks.set(polpoDir, hook);
  else approvalHooks.delete(polpoDir);
}

/** Install the code runner factory (code-worker.ts registers the bubblewrap pool). */
export function setCodeRunnerFactory(factory: (() => CodeRunner) | undefined): void {
  codeRunnerFactory = factory;
  codeRunner = undefined;
}

export function sharedCodeRunner(): CodeRunner | undefined {
  if (!codeRunner && codeRunnerFactory) codeRunner = codeRunnerFactory();
  return codeRunner;
}

/** The runtime dependencies for a .polpo dir in this process. */
export function hostedDeps(polpoDir: string, vault: VaultStore | undefined, extra: Partial<HostedRuntimeDeps> = {}): HostedRuntimeDeps {
  const runner = sharedCodeRunner();
  const hook = approvalHooks.get(polpoDir);
  return {
    ...defaults, polpoDir, ...(vault ? { vault } : {}), ...(runner ? { codeRunner: runner } : {}), ...(hook ? { requestApproval: hook } : {}), ...extra,
  };
}
