/**
 * What the official MCP client checks on every tool result (Client.callTool): a tool with an
 * outputSchema returns structuredContent (unless isError), and that content validates against
 * the schema with the SDK's own Ajv validator. The MCP tests run every call through it, so a tool
 * whose result breaks its schema (seen live: polpo_agent_show in Claude Code) fails here.
 */
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

const ajv = new AjvJsonSchemaValidator();

type ListedTool = { name: string; outputSchema?: Record<string, unknown> };

/** Tools as listed, per deps object (one tools/list per test instance). */
const listed = new WeakMap<object, Promise<ListedTool[]>>();

/**
 * Throw as the SDK client would when `result` (a tools/call result) does not match the
 * outputSchema `list()` gives for `name`.
 */
export async function expectValidOutput(
  key: object,
  list: () => Promise<ListedTool[]>,
  name: string,
  result: { structuredContent?: unknown; isError?: boolean } | undefined,
): Promise<void> {
  if (!result) return;
  let tools = listed.get(key);
  if (!tools) listed.set(key, (tools = list()));
  const tool = (await tools).find((t) => t.name === name);
  if (!tool?.outputSchema) return;
  if (!result.structuredContent) {
    if (!result.isError) throw new Error(`${name}: has an output schema but returned no structuredContent`);
    return;
  }
  const check = ajv.getValidator(tool.outputSchema as never);
  const verdict = check(result.structuredContent);
  if (!verdict.valid) throw new Error(`${name}: structuredContent does not match its outputSchema: ${verdict.errorMessage}`);
}
