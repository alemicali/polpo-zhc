/**
 * Hosted MCP servers in the dashboard: helpers shared by the list, the create dialog and the editor.
 */
import type { McpServerInstallResult, McpServerSpec, McpServerSummary, McpServerTemplateInfo, McpServerTool } from "@polpo-ai/react";

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

/** A status pill of the hosted servers, in the connectors' tones (see HostedStatusPill). */
export interface HostedPill {
  tone: "success" | "warning" | "destructive" | "muted";
  kind: "installed" | "update" | "unfinished" | "available" | "draft" | "off";
  label: string;
}

/** A template card's pill: "Installed v1.1.0", "Update available", "Install not finished", "Available". */
export function templatePill(t: Pick<McpServerTemplateInfo, "status" | "installs">): HostedPill {
  const i = t.installs.find((x) => x.status === t.status) ?? t.installs[0];
  switch (t.status) {
    case "installed": return { tone: "success", kind: "installed", label: i?.production ? `Installed v${i.production}` : "Installed" };
    case "update_available": return { tone: "warning", kind: "update", label: "Update available" };
    case "draft": return { tone: "warning", kind: "unfinished", label: "Install not finished" };
    default: return { tone: "muted", kind: "available", label: "Available" };
  }
}

/** A hosted server row's pill: switched off, live (the production version) or a draft. */
export function serverPill(s: Pick<McpServerSummary, "disabled" | "production">): HostedPill {
  if (s.disabled) return { tone: "muted", kind: "off", label: "Switched off" };
  if (s.production) return { tone: "success", kind: "installed", label: `Live v${s.production}` };
  return { tone: "muted", kind: "draft", label: "Draft" };
}

/** What the install answered, for the dialog. */
export function installOutcome(r: McpServerInstallResult): { tone: "ok" | "warn"; title: string; lines: string[] } {
  switch (r.status) {
    case "installed": return { tone: "ok", title: `Installed: ${r.id} v${r.version}`, lines: [`Read-only tests: ${r.tests?.passed ?? 0} passed${r.tests?.skipped ? `, ${r.tests.skipped} skipped` : ""}.`] };
    case "needs_secrets": return { tone: "warn", title: "A secret is missing", lines: [`Paste ${r.missingSecrets?.join(", ")} and install again: nothing was published.`] };
    case "tests_failed": return {
      tone: "warn", title: "A read-only test failed — nothing was published",
      lines: (r.tests?.results ?? []).filter((x) => x.passed === false).map((x) => `${x.tool}: ${x.error ?? x.text}`),
    };
    case "upgrade_draft": return {
      tone: "ok", title: `Revision ${r.revision} is now the draft of ${r.id}`,
      lines: [(r.diff?.changes ?? []).map((c) => `${c.kind} ${c.field}`).join(", ") || "No changes to the tools", "Review it and publish it from the Versions tab."],
    };
    case "up_to_date": return { tone: "ok", title: `${r.id} is up to date (v${r.version})`, lines: ["Settings and access saved."] };
    default: return { tone: "ok", title: "Checks passed", lines: ["Kept as a draft."] };
  }
}

/** Values to send: empty ones left out (null clears a stored value when `clear` lists it). */
export function settingsPayload(values: Record<string, string | number | boolean | undefined>, stored: Record<string, unknown> = {}): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === "") { if (stored[k] !== undefined) out[k] = null; continue; }
    out[k] = v;
  }
  return out;
}
