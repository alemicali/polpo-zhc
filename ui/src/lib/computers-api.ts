/**
 * Computers (persistent machines agents work on) — thin client for /api/v1/computers plus the
 * pure helpers the Computers page and the agent's Computer tab share (status labels and tones,
 * uptime, the create/edit form and its validation).
 *
 * Same envelope ({ ok, data } / { ok, error }) and auth as the other page clients.
 */
import { apiUrl, config } from "@/lib/config";
import type { HarnessSession } from "@/lib/harnesses-api";
import type { ComputerWebhookEvent, ComputerWebhookEventPage, ComputerWebhookOutcome, ComputerWebhookStatus } from "@polpo-ai/react";

// ── Types (mirror @polpo-ai/core computers.ts and src/server/routes/computers.ts) ──

export type ComputerKind = "host" | "daytona" | "e2b";
export type ComputerStatus =
  | "running" | "stopped" | "paused" | "hibernated" | "archived" | "creating" | "starting" | "stopping" | "error" | "missing" | "deleted" | "unknown";

export interface ComputerNetwork {
  mode: "deny" | "allowlist" | "open" | "unrestricted";
  allow?: string[];
}

export interface Computer {
  id: string;
  name: string;
  kind: ComputerKind;
  description?: string;
  image?: string;
  snapshot?: string;
  template?: string;
  resources?: { cpus?: number; memoryMb?: number; diskMb?: number };
  lifecycle?: { idleStopMinutes?: number; autoArchiveDays?: number };
  network?: ComputerNetwork;
  egress?: string;
  volumes?: Array<string | { name: string; access?: string }>;
  /** Live. */
  status: ComputerStatus;
  remoteId?: string;
  lastUsedAt?: string;
  uptimeMinutes: number;
  createdAt?: string;
  lastError?: string;
  /** Daytona: the snapshot a new machine comes from is not active ("inactive": activated on the next start). */
  snapshotState?: string;
  /** Daytona v2: the newest memory and disk snapshot of its VM (what a hibernated computer wakes from). */
  lastSnapshot?: { at: string; diskBytes?: number; memoryBytes?: number };
  /** Daytona v2: how many snapshots of it are kept (snapshot storage is billed). */
  snapshotCount?: number;
  /** Status "deleted": when Polpo found its machine deleted at the provider. */
  deletedAtProvider?: string;
  /** Daytona: the service its machines run on ("v2": Linux VMs that hibernate). */
  providerApi?: "v0" | "v2";
  /** Something worth knowing that is not an error (e.g. its VM vanished and was restored from the snapshot). */
  notice?: string;
  /** "host": this server, always there. */
  builtin?: boolean;
  agents: Array<{ name: string; isDefault: boolean }>;
  /** After an update: fields that apply to a new machine only. */
  note?: string;
}

/** A task run on a computer (its page's run list). */
export interface ComputerRun {
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  mission?: string;
  runId: string;
  agent?: string;
  engine: string;
  model?: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  costUsd?: number;
  tokens?: number;
  remoteId?: string;
}

export interface ComputerActivity {
  at: string;
  kind: "status" | "notice";
  status?: ComputerStatus;
  from?: ComputerStatus;
  level?: "info" | "warn";
  message?: string;
  remoteId?: string;
}

export interface ComputerSnapshotInfo { id: string; name: string; at: string; status: string; diskBytes?: number; memoryBytes?: number }

/** GET /computers/:id?detail=1: the computer and what its page shows. */
export interface ComputerDetail extends Computer {
  snapshots: ComputerSnapshotInfo[];
  activity: ComputerActivity[];
  updatedAt?: string;
  runningSince?: string;
  /** Daytona v2: when the VM's wall clock deletes it (it is rotated before). */
  timeoutAt?: string;
  /** When it stops or hibernates by itself if nobody uses it (running). */
  idleStopAt?: string;
  hibernate?: { keepSnapshots: number; safetySnapshotHours: number; rotateBeforeMinutes: number };
  machine?: { image?: string; snapshot?: string; template?: string; region?: string; resources?: { cpus?: number; memoryMb?: number; diskMb?: number } };
  sessions: HarnessSession[];
  runs: ComputerRun[];
  cost: { runsUsd: number; chatSessionsUsd: number; totalUsd: number };
}

/** GET /computers/:id/egress (a remote computer with an egress proxy). */
export interface ComputerEgress {
  computerId: string;
  proxy?: string;
  egress?: null;
  tailnet?: string | null;
  node?: string;
  path?: string;
  relay?: string;
  proxyReachable?: boolean;
  effective?: string;
  machine?: string;
  checkedAt?: string;
  error?: string;
  note?: string;
}

export type ComputerInput = Partial<Pick<Computer, "id" | "name" | "kind" | "description" | "image" | "snapshot" | "template" | "resources" | "lifecycle" | "network" | "egress">> & { start?: boolean };

/** "recreate": a reset of a computer whose machine was deleted at the provider (a new one from the image). */
export type ComputerAction = "start" | "stop" | "restart" | "reset" | "recreate";

export class ComputerRequestError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) { super(message); this.name = "ComputerRequestError"; this.code = code; }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  if (config.apiKey) headers.set("authorization", `Bearer ${config.apiKey}`);
  let response: Response;
  try {
    response = await fetch(apiUrl(`/api/v1${path}`), { ...init, headers, credentials: "include" });
  } catch {
    throw new Error("Could not reach the Polpo server");
  }
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: unknown; error?: unknown; code?: unknown } | null;
  if (!response.ok || !body?.ok) {
    const error = typeof body?.error === "string" ? body.error : (body?.error as { message?: string } | undefined)?.message;
    throw new ComputerRequestError(error || `Computers request failed (${response.status})`, typeof body?.code === "string" ? body.code : undefined);
  }
  return body.data as T;
}

const at = (id: string) => `/computers/${encodeURIComponent(id)}`;
const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const computersApi = {
  /** live: ask the providers (their answers are reused for a few seconds; fresh: ask again now). */
  list: (live = true, fresh = false) => request<{ computers: Computer[] }>(`/computers${!live ? "?live=0" : fresh ? "?fresh=1" : ""}`).then((d) => d.computers),
  get: (id: string) => request<Computer>(at(id)),
  /** The computer with its snapshots, activity, harness sessions, task runs and cost (its page). */
  detail: (id: string, fresh = false) => request<ComputerDetail>(`${at(id)}?detail=1${fresh ? "&fresh=1" : ""}`),
  egress: (id: string) => request<ComputerEgress>(`${at(id)}/egress`),
  create: (input: ComputerInput) => request<Computer>("/computers", json("POST", input)),
  update: (id: string, patch: Record<string, unknown>) => request<Computer>(at(id), json("PATCH", patch)),
  remove: (id: string) => request<{ deleted: string }>(at(id), json("DELETE", { confirm: true })),
  control: (id: string, action: ComputerAction) => {
    // Recreate is a reset: its machine (and snapshots) are gone already, a new one comes from the image
    const op = action === "recreate" ? "reset" : action;
    return request<Computer>(`${at(id)}/${op}`, json("POST", op === "reset" ? { confirm: true } : undefined));
  },
  /** An agent's default computer ("host" or "" for this server) and the computers it may use. */
  assign: (agent: string, defaultComputer: string, computers?: string[]) =>
    request<unknown>(`/agents/${encodeURIComponent(agent)}`, json("PATCH", { defaultComputer: defaultComputer === "host" ? "" : defaultComputer, ...(computers ? { computers } : {}) })),
};

// ── Presentation ──────────────────────────────────────────────────────────

export const KIND_LABELS: Record<ComputerKind, string> = { host: "This server", daytona: "Daytona", e2b: "E2B" };

/** "Daytona v2", "Daytona", "E2B", "This server". */
export function kindLabel(c: Pick<Computer, "kind" | "providerApi">): string {
  return c.kind === "daytona" && c.providerApi === "v2" ? "Daytona v2" : KIND_LABELS[c.kind];
}

export const STATUS_LABELS: Record<ComputerStatus, string> = {
  running: "Running", stopped: "Stopped", paused: "Paused", hibernated: "Hibernated (resumes in a few seconds)", archived: "Archived", creating: "Creating", starting: "Starting",
  stopping: "Stopping", error: "Error", missing: "Not created yet", deleted: "Deleted at provider", unknown: "Unknown",
};

/** Short labels for the list's status column and filter. */
export const STATUS_SHORT_LABELS: Record<ComputerStatus, string> = { ...STATUS_LABELS, hibernated: "Hibernated" };

export type StatusTone = "ok" | "idle" | "busy" | "bad";

export function statusTone(status: ComputerStatus): StatusTone {
  switch (status) {
    case "running": return "ok";
    case "creating": case "starting": case "stopping": return "busy";
    case "error": case "unknown": case "deleted": return "bad";
    default: return "idle";
  }
}

/** Which buttons make sense for a status (host has none). */
export function availableActions(c: Pick<Computer, "status" | "builtin" | "kind">): ComputerAction[] {
  if (c.builtin || c.kind === "host") return [];
  switch (c.status) {
    case "running": return ["stop", "restart", "reset"];
    case "creating": case "starting": case "stopping": return [];
    case "missing": return ["start"];
    // its machine is gone: a new one from the image (Remove from Polpo is the other way out)
    case "deleted": return ["recreate"];
    default: return ["start", "reset"];
  }
}

/** What Stop does on this computer: Daytona v2 hibernates (a snapshot, the VM deleted), E2B pauses. */
export function stopLabel(c: Pick<Computer, "kind" | "providerApi">): string {
  return c.kind === "daytona" && c.providerApi === "v2" ? "Hibernate" : c.kind === "e2b" ? "Pause" : "Stop";
}

/** Status order for sorting: what needs attention first, then running, then the resting ones. */
export const STATUS_ORDER: ComputerStatus[] = [
  "deleted", "error", "unknown", "creating", "starting", "stopping", "running", "paused", "hibernated", "stopped", "archived", "missing",
];

export type ComputerSortKey = "name" | "status" | "lastUsed" | "uptime";

/** The list's order (host always first). */
export function sortComputers(list: Computer[], key: ComputerSortKey): Computer[] {
  const by: Record<ComputerSortKey, (a: Computer, b: Computer) => number> = {
    name: (a, b) => a.name.localeCompare(b.name),
    status: (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.name.localeCompare(b.name),
    lastUsed: (a, b) => (Date.parse(b.lastUsedAt ?? "") || 0) - (Date.parse(a.lastUsedAt ?? "") || 0) || a.name.localeCompare(b.name),
    uptime: (a, b) => b.uptimeMinutes - a.uptimeMinutes || a.name.localeCompare(b.name),
  };
  return [...list].sort((a, b) => Number(!!b.builtin) - Number(!!a.builtin) || by[key](a, b));
}

/** Whether a computer matches the search (name, id, kind, image, agents, egress). */
export function matchesComputer(c: Computer, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [c.name, c.id, kindLabel(c), c.image, c.snapshot, c.template, c.egress, c.description, ...c.agents.map((a) => a.name)]
    .some((v) => v?.toLowerCase().includes(q));
}

/** "2 snapshots · 1.7 GB" (memory + disk of the newest), "—". */
export function formatSnapshotSummary(c: Pick<Computer, "lastSnapshot" | "snapshotCount">): string {
  if (!c.lastSnapshot) return "—";
  const bytes = (c.lastSnapshot.memoryBytes ?? 0) + (c.lastSnapshot.diskBytes ?? 0);
  const count = c.snapshotCount ?? 1;
  return `${count} snapshot${count === 1 ? "" : "s"}${bytes ? ` · ${formatBytes(bytes)}` : ""}`;
}

/** "3 h 20 min", "45 min", "—". */
export function formatUptime(minutes: number | undefined): string {
  if (!minutes) return "—";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "1.4 GB", "230 MB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** A snapshot as the card shows it: "5 min ago · 224 MB memory + 1.4 GB disk". */
export function formatSnapshot(s: NonNullable<Computer["lastSnapshot"]>, now = Date.now()): string {
  const sizes = [s.memoryBytes !== undefined ? `${formatBytes(s.memoryBytes)} memory` : "", s.diskBytes !== undefined ? `${formatBytes(s.diskBytes)} disk` : ""].filter(Boolean).join(" + ");
  return `${formatLastUsed(s.at, now)}${sizes ? ` · ${sizes}` : ""}`;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", "never". */
export function formatLastUsed(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / (24 * 60))} d ago`;
}

// ── Create / edit form ───────────────────────────────────────────────────

export interface ComputerForm {
  id: string;
  name: string;
  kind: ComputerKind;
  /** Daytona snapshot, Daytona image or E2B template, by kind ("" = the instance's default). */
  image: string;
  imageKind: "snapshot" | "image";
  idleStopMinutes: string;
  autoArchiveDays: string;
  egress: string;
  /** "" = the agent's or the instance's rule. */
  networkMode: "" | ComputerNetwork["mode"];
  /** Allowlist: host names, one per line or comma separated. */
  networkAllow: string;
  /** Daytona with an image ("" = the provider's default). */
  cpus: string;
  memoryGb: string;
  diskGb: string;
  start: boolean;
}

export const EMPTY_COMPUTER_FORM: ComputerForm = {
  id: "", name: "", kind: "daytona", image: "", imageKind: "snapshot", idleStopMinutes: "15", autoArchiveDays: "", egress: "",
  networkMode: "", networkAllow: "", cpus: "", memoryGb: "", diskGb: "", start: false,
};

const gbOf = (mb: number | undefined) => (mb ? String(Math.round((mb / 1024) * 100) / 100) : "");

export function formFromComputer(c: Computer): ComputerForm {
  return {
    id: c.id, name: c.name, kind: c.kind,
    image: c.snapshot ?? c.image ?? c.template ?? "",
    imageKind: c.image ? "image" : "snapshot",
    idleStopMinutes: c.lifecycle?.idleStopMinutes ? String(c.lifecycle.idleStopMinutes) : "15",
    autoArchiveDays: c.lifecycle?.autoArchiveDays ? String(c.lifecycle.autoArchiveDays) : "",
    egress: c.egress ?? "",
    networkMode: c.network?.mode ?? "", networkAllow: (c.network?.allow ?? []).join("\n"),
    cpus: c.resources?.cpus ? String(c.resources.cpus) : "", memoryGb: gbOf(c.resources?.memoryMb), diskGb: gbOf(c.resources?.diskMb),
    start: false,
  };
}

/** Allowlist entries from the form's text (lines or commas). */
export function allowEntries(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];
}

const RESERVED_COMPUTER_IDS = ["host", "ephemeral", "webhooks"];

/** A free computer id from an agent's name ("Nina Bot" → "nina-bot", "nina-bot-2" if taken). */
export function suggestComputerId(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "computer";
  let id = base;
  for (let i = 2; taken.includes(id) || RESERVED_COMPUTER_IDS.includes(id); i++) id = `${base}-${i}`;
  return id;
}

export function validateComputerForm(form: ComputerForm, existingIds: string[] = [], editing = false): Partial<Record<keyof ComputerForm, string>> {
  const errors: Partial<Record<keyof ComputerForm, string>> = {};
  if (!editing) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(form.id)) errors.id = "Lowercase letters, digits and -, e.g. nina";
    else if (RESERVED_COMPUTER_IDS.includes(form.id)) errors.id = "This id is reserved";
    else if (existingIds.includes(form.id)) errors.id = "A computer with this id exists";
  }
  if (form.kind !== "host") {
    const idle = Number(form.idleStopMinutes);
    if (!Number.isInteger(idle) || idle < 1 || idle > 1440) errors.idleStopMinutes = "Whole minutes, 1 to 1440";
    if (form.kind === "daytona" && form.autoArchiveDays !== "") {
      const days = Number(form.autoArchiveDays);
      if (!Number.isInteger(days) || days < 1 || days > 30) errors.autoArchiveDays = "Whole days, 1 to 30";
    }
    if (form.networkMode === "allowlist" && allowEntries(form.networkAllow).length === 0) errors.networkAllow = "Add at least one host (e.g. github.com)";
    for (const key of ["cpus", "memoryGb", "diskGb"] as const) {
      if (form[key] !== "" && !(Number(form[key]) > 0)) errors[key] = "A positive number";
    }
  }
  return errors;
}

/** The API body for a form (create: everything; edit: the changeable fields, null clears). */
export function computerInput(form: ComputerForm, editing = false): Record<string, unknown> {
  const out: Record<string, unknown> = { name: form.name.trim() || form.id };
  if (!editing) { out.id = form.id; out.kind = form.kind; }
  const image = form.image.trim();
  if (form.kind === "daytona") {
    out.snapshot = form.imageKind === "snapshot" && image ? image : editing ? null : undefined;
    out.image = form.imageKind === "image" && image ? image : editing ? null : undefined;
  }
  if (form.kind === "e2b") out.template = image || (editing ? null : undefined);
  // remote computers reach their egress proxy through Tailscale in their VM (settings.tailscale)
  out.egress = form.egress.trim() || (editing ? null : undefined);
  if (form.kind !== "host") {
    const lifecycle: Record<string, number> = { idleStopMinutes: Number(form.idleStopMinutes) };
    if (form.kind === "daytona" && form.autoArchiveDays !== "") lifecycle.autoArchiveDays = Number(form.autoArchiveDays);
    out.lifecycle = lifecycle;
    const network = form.networkMode
      ? { mode: form.networkMode, ...(form.networkMode === "allowlist" ? { allow: allowEntries(form.networkAllow) } : {}) }
      : undefined;
    out.network = network ?? (editing ? null : undefined);
    const resources = Object.fromEntries(Object.entries({
      cpus: form.cpus !== "" ? Number(form.cpus) : undefined,
      memoryMb: form.memoryGb !== "" ? Math.round(Number(form.memoryGb) * 1024) : undefined,
      diskMb: form.diskGb !== "" ? Math.round(Number(form.diskGb) * 1024) : undefined,
    }).filter(([, v]) => v !== undefined));
    out.resources = Object.keys(resources).length ? resources : editing ? null : undefined;
  }
  if (!editing && form.start && form.kind !== "host") out.start = true;
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

// ── Provider webhooks (Settings → Computers) ─────────────────────────────

export type {
  ComputerWebhookStatus, ComputerWebhookOutcome, ComputerWebhookEvent, ComputerWebhookEventSummary, ComputerWebhookEventPage,
} from "@polpo-ai/react";

export const COMPUTER_WEBHOOK_OUTCOMES: ComputerWebhookOutcome[] = ["accepted", "ignored", "rejected", "error"];

export const computerWebhooksApi = {
  /** A provider's event log, newest first (no payloads); `outcome`: only these. */
  events: (provider: string, o: { limit?: number; cursor?: string; outcome?: ComputerWebhookOutcome[] } = {}) => {
    const q = new URLSearchParams();
    if (o.limit) q.set("limit", String(o.limit));
    if (o.cursor) q.set("cursor", o.cursor);
    if (o.outcome?.length) q.set("outcome", o.outcome.join(","));
    const qs = q.toString();
    return request<ComputerWebhookEventPage>(`/computer-webhooks/${encodeURIComponent(provider)}/events${qs ? `?${qs}` : ""}`);
  },
  /** One delivery with its redacted payload and safe headers. */
  event: (provider: string, id: string) => request<ComputerWebhookEvent>(`/computer-webhooks/${encodeURIComponent(provider)}/events/${encodeURIComponent(id)}`),
  status: () => request<{ providers: ComputerWebhookStatus[]; note: string; reconcileOnly: string[] }>("/computer-webhooks"),
  setSecret: (provider: string, secret: string) => request<ComputerWebhookStatus>(`/computer-webhooks/${encodeURIComponent(provider)}/secret`, json("PUT", { secret })),
  removeSecret: (provider: string) => request<ComputerWebhookStatus>(`/computer-webhooks/${encodeURIComponent(provider)}/secret`, json("DELETE")),
  registerE2b: () => request<ComputerWebhookStatus>("/computer-webhooks/e2b/register", json("POST")),
  unregisterE2b: () => request<ComputerWebhookStatus>("/computer-webhooks/e2b/register", json("DELETE")),
};
