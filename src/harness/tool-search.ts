/**
 * Claude Code's tool search for Polpo's host tools, shared by the harness engine (sdk.ts) and the
 * CLI engine (no AI SDK import here: the CLI engine never loads it).
 */

/** Up to this many host tools, Claude Code gets every one of them with the first request. */
export const HOST_TOOLS_EAGER_LIMIT = 40;

/**
 * Claude Code's tool search (ENABLE_TOOL_SEARCH) for the host tools: off ("false": every tool in
 * the first request, no ToolSearch lookup the model can skip) for up to HOST_TOOLS_EAGER_LIMIT
 * tools; "auto" above (deferred only when their definitions take a large share of the context).
 */
export function claudeCodeToolSearch(hostTools: number): "false" | "auto" {
  return hostTools <= HOST_TOOLS_EAGER_LIMIT ? "false" : "auto";
}
