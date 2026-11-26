/**
 * Triggers in the dashboard: status tones, the curl example, a read-only YAML view of a schema,
 * and the dedupe / mapping helpers the editors share.
 */
import type { Trigger, TriggerAction, TriggerActionInput, TriggerActionKind, TriggerActionRefs, TriggerActionsStatus, TriggerDeliveryStatus } from "@polpo-ai/react";

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

// ── Actions ──

export const ACTION_KINDS: Array<{ id: TriggerActionKind; label: string; hint: string }> = [
  { id: "playbook", label: "Run a playbook", hint: "Its parameters from the mapped values" },
  { id: "mission", label: "Start a mission", hint: "An existing mission; variables run a copy" },
  { id: "task", label: "Create a task", hint: "For an agent" },
  { id: "agent", label: "Agent turn", hint: "An agent (or Polpo) works on the delivery, optionally replying in a chat" },
  { id: "notify", label: "Send a notification", hint: "Through a notification channel (Telegram, Slack, email…)" },
];
export const ACTION_KIND_LABEL: Record<TriggerActionKind, string> = Object.fromEntries(ACTION_KINDS.map((k) => [k.id, k.label])) as Record<TriggerActionKind, string>;

export const ACTION_STATUS_LABEL: Record<TriggerActionsStatus, string> = {
  queued: "Queued", running: "Running", done: "Done", failed: "Failed", skipped: "Skipped", partial: "Partly failed",
};
/** Badge classes per action status (tokens only). */
export const ACTION_STATUS_CLASS: Record<TriggerActionsStatus, string> = {
  queued: "border-border bg-muted/40 text-muted-foreground",
  running: "border-info/30 bg-info/10 text-info",
  done: "border-success/30 bg-success/10 text-success",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
  skipped: "border-border bg-muted/40 text-muted-foreground",
  partial: "border-warning/30 bg-warning/10 text-warning",
};

/** What an action created, as links into the dashboard. */
export function actionRefLinks(r: TriggerActionRefs | undefined): Array<{ label: string; to?: string }> {
  if (!r) return [];
  const out: Array<{ label: string; to?: string }> = [];
  if (r.missionId) out.push({ label: `Mission ${r.missionName ?? r.missionId}${r.copyOf ? " (a copy)" : ""}`, to: `/missions/${encodeURIComponent(r.missionId)}` });
  if (r.taskId) out.push({ label: `Task ${r.taskId}`, to: `/tasks/${encodeURIComponent(r.taskId)}` });
  if (r.sessionId) out.push({ label: `Chat${r.agent ? ` with ${r.agent}` : ""}`, to: `/chat?session=${encodeURIComponent(r.sessionId)}` });
  if (r.notificationId) out.push({ label: `Notification on ${r.channel ?? "a channel"}` });
  else if (r.channel) out.push({ label: `Reply sent on ${r.channel}` });
  return out;
}

/** The dashboard link to a delivery (from a task, a mission, a chat that a trigger started). */
export const deliveryHref = (triggerId: string, deliveryId: string) => `/triggers?trigger=${encodeURIComponent(triggerId)}&delivery=${encodeURIComponent(deliveryId)}`;

/** An editable action (the editor's rows; params / variables as name → template rows). */
export interface ActionDraft {
  id?: string;
  kind: TriggerActionKind;
  enabled: boolean;
  name: string;
  retries: string;
  continueOnError: boolean;
  waitSeconds: string;
  playbook: string;
  mission: string;
  params: MappingRow[];
  title: string;
  description: string;
  assignTo: string;
  agent: string;
  instructions: string;
  data: "" | "mapped" | "body" | "both";
  allowedTools: string;
  restrictTools: boolean;
  maxSteps: string;
  deliverChannel: string;
  deliverChatId: string;
  deliverThreadId: string;
  channel: string;
  body: string;
  severity: "" | "info" | "warning" | "critical";
}

export function emptyAction(kind: TriggerActionKind): ActionDraft {
  return {
    kind, enabled: true, name: "", retries: "", continueOnError: false, waitSeconds: "", playbook: "", mission: "", params: [], title: "", description: "", assignTo: "",
    agent: "", instructions: "", data: "", allowedTools: "", restrictTools: false, maxSteps: "", deliverChannel: "", deliverChatId: "", deliverThreadId: "",
    channel: "", body: "", severity: "",
  };
}

export function actionDraft(a: TriggerAction): ActionDraft {
  const d = emptyAction(a.kind);
  const base = { ...d, id: a.id, enabled: a.enabled, name: a.name ?? "", retries: a.retries !== undefined ? String(a.retries) : "", continueOnError: !!a.continueOnError };
  switch (a.kind) {
    case "playbook": return { ...base, playbook: a.playbook, params: mappingRows(a.params), waitSeconds: a.waitSeconds ? String(a.waitSeconds) : "" };
    case "mission": return { ...base, mission: a.mission, params: mappingRows(a.variables), waitSeconds: a.waitSeconds ? String(a.waitSeconds) : "" };
    case "task": return { ...base, title: a.title, description: a.description, assignTo: a.assignTo, waitSeconds: a.waitSeconds ? String(a.waitSeconds) : "" };
    case "agent": return {
      ...base, agent: a.agent ?? "", instructions: a.instructions, data: a.data ?? "", restrictTools: !!a.allowedTools, allowedTools: (a.allowedTools ?? []).join(", "),
      maxSteps: a.maxSteps ? String(a.maxSteps) : "", deliverChannel: a.deliverTo?.channel ?? "", deliverChatId: a.deliverTo?.chatId ?? "",
      deliverThreadId: a.deliverTo?.threadId !== undefined ? String(a.deliverTo.threadId) : "",
    };
    case "notify": return { ...base, channel: a.channel, title: a.title ?? "", body: a.body, severity: a.severity ?? "" };
  }
}

const num = (s: string) => (s.trim() && Number.isFinite(Number(s)) ? Number(s) : undefined);

/** The draft as create / update take it. */
export function actionInput(d: ActionDraft): TriggerActionInput {
  const common = {
    ...(d.id ? { id: d.id } : {}), enabled: d.enabled, ...(d.name.trim() ? { name: d.name.trim() } : {}),
    ...(num(d.retries) !== undefined ? { retries: num(d.retries) } : {}),
    ...(d.continueOnError ? { continueOnError: true } : {}),
  };
  const wait = num(d.waitSeconds) ? { waitSeconds: num(d.waitSeconds) } : {};
  const rows = mappingObject(d.params) ?? undefined;
  switch (d.kind) {
    case "playbook": return { ...common, kind: "playbook", playbook: d.playbook, ...(rows ? { params: rows } : {}), ...wait };
    case "mission": return { ...common, kind: "mission", mission: d.mission, ...(rows ? { variables: rows } : {}), ...wait };
    case "task": return { ...common, kind: "task", title: d.title, description: d.description, assignTo: d.assignTo, ...wait };
    case "agent": return {
      ...common, kind: "agent", ...(d.agent ? { agent: d.agent } : {}), instructions: d.instructions, ...(d.data ? { data: d.data } : {}),
      ...(d.restrictTools ? { allowedTools: d.allowedTools.split(",").map((t) => t.trim()).filter(Boolean) } : {}),
      ...(num(d.maxSteps) ? { maxSteps: num(d.maxSteps) } : {}),
      ...(d.deliverChannel && d.deliverChatId.trim() ? { deliverTo: { channel: d.deliverChannel, chatId: d.deliverChatId.trim(), ...(num(d.deliverThreadId) !== undefined ? { threadId: num(d.deliverThreadId) } : {}) } } : {}),
    };
    case "notify": return { ...common, kind: "notify", channel: d.channel, ...(d.title.trim() ? { title: d.title } : {}), body: d.body, ...(d.severity ? { severity: d.severity } : {}) };
  }
}

export const formatBytes =(n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
