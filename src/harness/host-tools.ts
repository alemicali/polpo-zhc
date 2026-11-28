/**
 * The agent's Polpo tools as harness host tools: the runtime (Claude Code, Codex, OpenCode) calls them, Polpo
 * runs them here with the agent's permissions, exactly as its own engine would (vault, connectors,
 * email, data, artifacts, storage, outcomes…).
 *
 * Left out: the coding tools the runtime has natively and runs in the VM itself (read, write, edit,
 * bash, glob, grep, ls). The runtime's own shell cannot read the vault: commands get secrets with
 * run_with_vault (Polpo's bash with env_from_vault, on the run's computer), and vault_get is offered
 * only in its valueless form (key names and non-secret fields: buildAgentToolset harnessHost).
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { SIDE_EFFECT_GATED_TOOLS } from "./tool-policy.js";
import { isValuelessVaultGet } from "../tools/vault-tools.js";
import type { HarnessHostTool } from "./types.js";

/** Native to the runtimes: never offered twice. */
export const HARNESS_NATIVE_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit", "multi_edit", "bash", "glob", "grep", "ls"]);

/** vault_get reaches a harness only built never to return values: a value would land in the runtime's context. */
function offeredToHarness(t: AgentTool<any>): boolean {
  if (HARNESS_NATIVE_TOOLS.has(t.name)) return false;
  return t.name !== "vault_get" || isValuelessVaultGet(t);
}

/** Tool names start with a letter; Claude Code (MCP) takes letters, digits, _ and - up to 64. */
const VALID_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Read-only by name (they change nothing): the runtime may run them in parallel. */
function readOnlyByName(name: string): boolean {
  return /^(list|get|read|search|find|describe|vault_list|tools_search)|_(list|get|read|search|info|status)$/.test(name);
}

export interface HostToolResult { toolName: string; toolCallId: string; details?: Record<string, unknown>; isError: boolean; text: string }

/**
 * Host tools from the agent's resolved tools. `interactive`: a person answers approvals (chats):
 * side-effect tools (email_send, whatsapp_send…) pause the turn for one. In tasks they run, as
 * with Polpo's engine. `onResult` sees every result (outcomes, files, activity).
 */
export function toHarnessHostTools(
  tools: readonly AgentTool<any>[],
  opts: { interactive?: boolean; onResult?: (r: HostToolResult) => void } = {},
): HarnessHostTool[] {
  const out: HarnessHostTool[] = [];
  const seen = new Set<string>();
  for (const t of tools) {
    if (!offeredToHarness(t) || seen.has(t.name) || !VALID_NAME.test(t.name)) continue;
    seen.add(t.name);
    const schema = (t.parameters && typeof t.parameters === "object" ? JSON.parse(JSON.stringify(t.parameters)) : { type: "object", properties: {} }) as Record<string, unknown>;
    if (schema.type !== "object") schema.type = "object";
    out.push({
      name: t.name,
      description: String(t.description ?? t.label ?? t.name).slice(0, 4000),
      inputSchema: schema,
      ...(readOnlyByName(t.name) ? { readOnly: true } : {}),
      ...(opts.interactive && SIDE_EFFECT_GATED_TOOLS.has(t.name) ? { approval: "user-approval" as const } : {}),
      execute: async (input, x) => {
        try {
          const r = await t.execute(x.toolCallId, (input ?? {}) as any, x.abortSignal);
          const text = (r?.content ?? []).map((c: any) => (c?.type === "text" ? c.text : c?.type === "image" ? `[image ${c.mimeType ?? ""}]` : "")).join("") || "ok";
          opts.onResult?.({ toolName: t.name, toolCallId: x.toolCallId, details: (r as any)?.details, isError: false, text });
          return text;
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          opts.onResult?.({ toolName: t.name, toolCallId: x.toolCallId, isError: true, text });
          // the runtime sees the failure as the tool's output and can react to it
          return `Error: ${text}`;
        }
      },
    });
  }
  return out;
}
