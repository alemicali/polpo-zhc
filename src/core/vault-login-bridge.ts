/**
 * vault_create_login from a task run (runner.ts, any engine: Polpo's, a harness, a CLI): the tool
 * asks the orchestrator over the notification socket, and the orchestrator writes the login into
 * the vault of the run's agent (from the run record, never from the request), with the task and
 * run as its provenance. The server process owns the vault: a runner never writes it itself (the
 * file store keeps its own copy in memory).
 *
 * The reply carries the stored credentials back to the runner (a local socket, as the runner
 * already reads the agent's vault): the run's masker and its resolved vault need the value. The
 * tool never shows it to the model.
 */
import type { AgentConfig, Task, VaultLoginRequest, VaultLoginResult } from "@polpo-ai/core";
import { generateVaultLogin } from "@polpo-ai/core";
import type { VaultStore } from "@polpo-ai/core/vault-store";
import type { RunRecord } from "./run-store.js";
import { requestOverSocket } from "./notification.js";
import { agentHasVaultLoginTool, type VaultLoginAccess } from "../tools/vault-tools.js";

const WIRE_TIMEOUT_MS = 30_000;

export interface VaultLoginWireRequest extends VaultLoginRequest {
  type: "vault_login";
  runId: string;
}

export type VaultLoginWireReply = VaultLoginResult;

/** Runner side: vault_create_login's access, over the notification socket. */
export function socketVaultLogin(socketPath: string, runId: string): VaultLoginAccess {
  return {
    create: async (req) => {
      const reply = await requestOverSocket(socketPath, { ...req, type: "vault_login", runId }, WIRE_TIMEOUT_MS);
      // an unreachable server or a timeout comes back as { ok: false, error } without a code
      return reply.ok ? reply : { ok: false, code: reply.code ?? "invalid", error: reply.error };
    },
  };
}

/** Server side: one login of a task run, in the vault of the run's agent. */
export async function handleVaultLoginWire(
  msg: VaultLoginWireRequest,
  deps: {
    vaultStore: Pick<VaultStore, "get" | "set"> | undefined;
    run(runId: string): Promise<Pick<RunRecord, "agentName" | "taskId" | "status" | "config"> | undefined>;
    task(taskId: string): Promise<Task | undefined>;
    /** The agent config the run uses (its version and the task's tool scope). */
    agentFor(run: Pick<RunRecord, "agentName" | "config">, task: Task | undefined): Promise<AgentConfig | undefined>;
  },
): Promise<VaultLoginWireReply> {
  if (!deps.vaultStore) return { ok: false, code: "invalid", error: "The vault is not available on this server" };
  const run = typeof msg.runId === "string" ? await deps.run(msg.runId) : undefined;
  if (!run || run.status !== "running") return { ok: false, code: "invalid", error: "this run is not running" };
  const task = await deps.task(run.taskId).catch(() => undefined);
  const agent = await deps.agentFor(run, task);
  if (!agent || agent.name !== run.agentName) return { ok: false, code: "invalid", error: `agent "${run.agentName}" not found` };
  if (!agentHasVaultLoginTool(agent)) return { ok: false, code: "invalid", error: "vault_create_login is not among this agent's tools" };
  const req: VaultLoginRequest = {
    service: typeof msg.service === "string" ? msg.service : "",
    ...(typeof msg.username === "string" ? { username: msg.username } : {}),
    ...(typeof msg.email === "string" ? { email: msg.email } : {}),
    ...(typeof msg.url === "string" ? { url: msg.url } : {}),
    ...(typeof msg.label === "string" ? { label: msg.label } : {}),
    ...(typeof msg.length === "number" ? { length: msg.length } : {}),
    ...(typeof msg.symbols === "boolean" ? { symbols: msg.symbols } : {}),
    ...(msg.rotate === true ? { rotate: true } : {}),
  };
  return generateVaultLogin(deps.vaultStore, run.agentName, req, {
    kind: "agent", agent: run.agentName, taskId: run.taskId, runId: msg.runId,
  }, { ...(agent.identity?.displayName ? { ownerDisplayName: agent.identity.displayName } : {}) });
}
