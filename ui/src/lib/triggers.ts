/**
 * Triggers in the dashboard: status tones, the curl example, a read-only YAML view of a schema,
 * and the dedupe / mapping helpers the editors share.
 */
import type { Trigger, TriggerDeliveryStatus } from "@polpo-ai/react";

export const DELIVERY_STATUSES: TriggerDeliveryStatus[] = ["accepted", "rejected", "filtered", "duplicate", "rate_limited"];

export const STATUS_LABEL: Record<TriggerDeliveryStatus, string> = {
  accepted: "Accepted", rejected: "Rejected", filtered: "Filtered", duplicate: "Duplicate", rate_limited: "Rate limited",
};

/** Badge classes per status (tokens only). */
export const STATUS_CLASS: Record<TriggerDeliveryStatus, string> = {
  accepted: "border-success/30 bg-success/10 text-success",
  rejected: "border-destructive/30 bg-destructive/10 text-destructive",
  filtered: "border-border bg-muted/40 text-muted-foreground",
  duplicate: "border-info/30 bg-info/10 text-info",
  rate_limited: "border-warning/30 bg-warning/10 text-warning",
};

export const CONTENT_TYPES = [
  { id: "json", label: "JSON", hint: "application/json" },
  { id: "form", label: "Form", hint: "application/x-www-form-urlencoded" },
  { id: "multipart", label: "Multipart", hint: "multipart/form-data (files: metadata kept)" },
  { id: "text", label: "Text", hint: "text/*" },
] as const;

/** A shell-quoted single-quoted string. */
const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** A curl that sends a JSON delivery to the trigger (placeholders for its secret / signature). */
export function curlExample(t: Pick<Trigger, "endpoint" | "auth">, body = '{"hello":"world"}'): string {
  const lines = [`curl -X POST ${sq(t.endpoint)}`, "  -H 'content-type: application/json'"];
  if (t.auth.secret) lines.push("  -H 'Authorization: Bearer <secret>'");
  if (t.auth.hmac) lines.push(`  -H ${sq(`${t.auth.hmac.header}: ${t.auth.hmac.prefix ?? ""}<${t.auth.hmac.algorithm} ${t.auth.hmac.encoding} HMAC of the body>`)}`);
  if (t.auth.hmac?.timestampHeader) lines.push(`  -H ${sq(`${t.auth.hmac.timestampHeader}: <unix seconds>`)}`);
  lines.push(`  -d ${sq(body)}`);
  return lines.join(" \\\n");
}

const PLAIN = /^[A-Za-z_][\w.-]*$/;
const scalar = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return PLAIN.test(v) && !["true", "false", "null", "yes", "no"].includes(v.toLowerCase()) ? v : JSON.stringify(v);
  return String(v);
};

/** A JSON value as YAML (read-only view: block style, strings quoted when needed). */
export function toYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]`;
    return value.map((v) => {
      if (v && typeof v === "object" && (Array.isArray(v) ? v.length : Object.keys(v).length)) {
        const inner = toYaml(v, indent + 1).replace(/^\s+/, "");
        return `${pad}- ${inner}`;
      }
      return `${pad}- ${v && typeof v === "object" ? (Array.isArray(v) ? "[]" : "{}") : scalar(v)}`;
    }).join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return `${pad}{}`;
    return entries.map(([k, v]) => {
      const key = PLAIN.test(k) ? k : JSON.stringify(k);
      if (v && typeof v === "object" && (Array.isArray(v) ? v.length : Object.keys(v).length)) return `${pad}${key}:\n${toYaml(v, indent + 1)}`;
      return `${pad}${key}: ${v && typeof v === "object" ? (Array.isArray(v) ? "[]" : "{}") : scalar(v)}`;
    }).join("\n");
  }
  return `${pad}${scalar(value)}`;
}

/** Parse a JSON text, or say what is wrong. */
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, value: undefined };
  try { return { ok: true, value: JSON.parse(text) }; } catch (e) { return { ok: false, error: (e as Error).message }; }
}

/** Mapping rows ⇄ the mapping object. */
export type MappingRow = { name: string; template: string };
export const mappingRows = (m: Record<string, string> | undefined): MappingRow[] => Object.entries(m ?? {}).map(([name, template]) => ({ name, template }));
export const mappingObject = (rows: MappingRow[]): Record<string, string> | null => {
  const kept = rows.filter((r) => r.name.trim() && r.template.trim());
  return kept.length ? Object.fromEntries(kept.map((r) => [r.name.trim(), r.template.trim()])) : null;
};

export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
