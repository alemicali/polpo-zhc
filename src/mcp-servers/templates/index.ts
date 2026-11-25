/**
 * The catalog of ready-made hosted connectors ("Ready-made, hosted by Polpo"). Each template lives
 * in its own folder (templates/<id>/template.ts) with a revision number; src/__tests__ runs every
 * template's tools against mocked APIs. To add one, see docs/custom-mcp-servers.md ("How to add a
 * template").
 */
import { GELATO_TEMPLATE } from "./gelato/template.js";
import { PRINTFUL_TEMPLATE } from "./printful/template.js";
import { PRINTIFY_TEMPLATE } from "./printify/template.js";
import type { McpServerTemplate } from "./types.js";

export type { McpServerTemplate, McpServerTemplateSecret } from "./types.js";
export { GELATO_TEMPLATE, PRINTFUL_TEMPLATE, PRINTIFY_TEMPLATE };

export const MCP_SERVER_TEMPLATES: McpServerTemplate[] = [PRINTFUL_TEMPLATE, GELATO_TEMPLATE, PRINTIFY_TEMPLATE];

export function serverTemplate(id: string): McpServerTemplate | undefined {
  return MCP_SERVER_TEMPLATES.find((t) => t.id === id);
}
