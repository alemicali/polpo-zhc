/**
 * Tool call arguments checked against each tool's schema before anything runs.
 *
 * Models (local ones especially) sometimes call a tool with arguments that do not match its
 * parameters — e.g. create_mission with the mission name inside `data` instead of `name`.
 * Unchecked, an interactive tool showed a broken preview and a regular tool ran with missing
 * values. A call that does not match is neither run nor previewed: the model gets the reason
 * as the tool result and can call it again in the same turn.
 */

/** Validates one call against its tool (pi-ai's validateToolArguments): returns the arguments, coerced, or throws. */
export type ToolArgumentsValidator = (tool: any, call: { id: string; name: string; arguments: Record<string, any> }) => unknown;

/**
 * Checks every call. Valid arguments are replaced by their coerced form (e.g. "3" -> 3).
 * Returns the error result to give the model for each invalid call, by call id.
 * Calls to unknown tools are left to the executor, which reports them.
 */
export function checkToolCalls(
  tools: Array<{ name: string; parameters?: unknown }>,
  calls: Array<{ id: string; name: string; arguments: Record<string, any> }>,
  validate: ToolArgumentsValidator | undefined,
): Map<string, string> {
  const invalid = new Map<string, string>();
  if (!validate) return invalid;
  for (const call of calls) {
    const tool = tools.find((t) => t.name === call.name);
    if (!tool) continue;
    call.arguments = parseJsonStringArguments(tool, call.arguments);
    try {
      const args = validate(tool, call);
      if (args && typeof args === "object") call.arguments = args as Record<string, any>;
    } catch (err) {
      invalid.set(call.id, invalidArgumentsResult(call.name, err));
    }
  }
  return invalid;
}

/**
 * Models often pass an object or array parameter as a JSON string (e.g. create_mission's `data`), which
 * the tools have always accepted: parse it when the schema asks for an object or an array, so the
 * check does not refuse what works today.
 */
function parseJsonStringArguments(tool: { parameters?: unknown }, args: Record<string, any>): Record<string, any> {
  const properties = (tool.parameters as { properties?: Record<string, { type?: unknown }> } | undefined)?.properties;
  if (!properties || !args || typeof args !== "object") return args;
  let out = args;
  for (const [key, schema] of Object.entries(properties)) {
    const value = args[key];
    if (typeof value !== "string" || (schema?.type !== "object" && schema?.type !== "array")) continue;
    try {
      const parsed = JSON.parse(value);
      const matches = schema.type === "array" ? Array.isArray(parsed) : parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
      if (matches) out = { ...out, [key]: parsed };
    } catch { /* not JSON: the check reports it */ }
  }
  return out;
}

export function invalidArgumentsResult(toolName: string, err: unknown): string {
  // pi-ai appends the received arguments: the model has them already (a whole mission can be thousands of tokens).
  const reason = (err instanceof Error ? err.message : String(err)).split("\n\nReceived arguments:")[0];
  return `Error: the arguments of ${toolName} do not match its parameters, so it was not run.\n${reason}\n`
    + `Call ${toolName} again with each parameter at the top level of the arguments, with the type its schema asks for.`;
}
