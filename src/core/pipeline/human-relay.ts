/**
 * Runner side of pipeline `human` steps: ask the orchestrator to create an
 * approval request over the notification socket, then poll it until a person
 * approves or rejects it (or the run is cancelled).
 */

import { nanoid } from "nanoid";
import { askPipelineHuman } from "../notification.js";
import type { HumanDecision, HumanRequest } from "./executor.js";

export interface HumanRelayOptions {
  socketPath: string;
  runId: string;
  taskId: string;
  agentName: string;
  /** Delay between status polls. Default 3s. */
  pollMs?: number;
  /** Attempts to create the request before giving up. Default 10. */
  requestAttempts?: number;
  log?: (message: string) => void;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export function createHumanRelay(opts: HumanRelayOptions): (req: HumanRequest) => Promise<HumanDecision> {
  const pollMs = opts.pollMs ?? 3000;
  const requestAttempts = opts.requestAttempts ?? 10;

  return async (req) => {
    const requestId = nanoid();
    const message = {
      type: "pipeline_human_request" as const,
      requestId,
      runId: opts.runId,
      taskId: opts.taskId,
      agentName: opts.agentName,
      step: req.name,
      notify: req.step.notify,
      context: req.context,
    };

    // Create the request. The id is ours, so a retry after a lost reply is harmless.
    let created = false;
    let lastError = "";
    for (let attempt = 1; attempt <= requestAttempts && !req.signal.aborted; attempt++) {
      try {
        const reply = await askPipelineHuman(opts.socketPath, message);
        if (reply.ok) { created = true; break; }
        lastError = reply.error ?? "request refused";
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await sleep(pollMs, req.signal);
    }
    if (req.signal.aborted) return { approved: false, note: "cancelled" };
    if (!created) throw new Error(`Could not request approval for "${req.name}": ${lastError}`);
    opts.log?.(`Waiting for a human decision on "${req.name}" (approval ${requestId})`);
    req.onRequested?.(requestId);

    // Poll until resolved. An unreachable orchestrator (restart) is retried.
    while (!req.signal.aborted) {
      await sleep(pollMs, req.signal);
      if (req.signal.aborted) break;
      try {
        const reply = await askPipelineHuman(opts.socketPath, { type: "pipeline_human_status", requestId });
        if (!reply.ok) throw new Error(reply.error ?? "status refused");
        if (reply.status === "approved") return { approved: true, note: reply.note };
        if (reply.status === "rejected") return { approved: false, note: reply.note };
        if (reply.status === "timeout") return { approved: false, note: reply.note ?? "timed out" };
      } catch (err) {
        opts.log?.(`Approval status check failed (will retry): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Nobody needs this decision anymore: close the request instead of leaving it pending.
    askPipelineHuman(opts.socketPath, { type: "pipeline_human_cancel", requestId }).catch(() => { /* best effort */ });
    return { approved: false, note: "cancelled" };
  };
}
