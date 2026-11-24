/**
 * Hosted MCP servers in the dashboard: helpers shared by the list, the create dialog and the editor.
 */
import type { McpServerSpec, McpServerTool } from "@polpo-ai/react";

export function blankSpec(name: string): McpServerSpec {
  return { name, allowedDomains: [], secrets: {}, auth: { type: "none" }, tools: [] };
}

export function blankTool(kind: "http" | "code", taken: string[]): McpServerTool {
  let n = 1;
  while (taken.includes(`tool_${n}`)) n++;
  const name = `tool_${n}`;
  return kind === "http"
    ? { name, description: "", kind, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true }, http: { method: "GET", url: "/" } }
    : { name, description: "", kind, inputSchema: { type: "object", properties: {} }, code: { source: "export async function handler(input, ctx) {\n  // ctx.fetch(url, init) reaches only the allowed domains; ctx.secrets.<name>; ctx.log(...)\n  return { ok: true };\n}\n" } };
}

export function isSensitive(tool: Pick<McpServerTool, "requiresApproval" | "annotations">): boolean {
  return !!tool.requiresApproval || !!tool.annotations?.destructiveHint;
}

/** The parameters a tool takes, for the schema preview. */
export function schemaParams(schema: Record<string, unknown>): Array<{ name: string; type: string; required: boolean; description?: string }> {
  const props = (schema.properties ?? {}) as Record<string, { type?: string | string[]; description?: string; enum?: unknown[] }>;
  const required = Array.isArray(schema.required) ? schema.required as string[] : [];
  return Object.entries(props).map(([name, p]) => ({
    name,
    type: p.enum ? p.enum.map((e) => JSON.stringify(e)).join(" | ") : Array.isArray(p.type) ? p.type.join(" | ") : p.type ?? "any",
    required: required.includes(name),
    ...(p.description ? { description: p.description } : {}),
  }));
}

/** A sample input from a schema (for the Test section). */
export function sampleInput(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of schemaParams(schema)) {
    if (!p.required) continue;
    out[p.name] = p.type.includes("integer") || p.type.includes("number") ? 0 : p.type === "boolean" ? false : p.type === "array" ? [] : p.type === "object" ? {} : "";
  }
  return out;
}

/** Parse a JSON text field: the value, or the error to show. */
export function parseJson<T = unknown>(text: string): { ok: true; value: T } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, value: undefined as T };
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const pretty = (v: unknown) => (v === undefined ? "" : JSON.stringify(v, null, 2));

/** "Hosted by Polpo · v1.2.0" */
export function hostedLabel(product: string, version?: string): string {
  return `Hosted by ${product}${version ? ` · v${version}` : ""}`;
}
