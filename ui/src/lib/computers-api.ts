/**
 * Computers (persistent machines agents work on) — thin client for /api/v1/computers plus the
 * pure helpers the Computers page and the agent's Computer tab share (status labels and tones,
 * uptime, the create/edit form and its validation).
 *
 * Same envelope ({ ok, data } / { ok, error }) and auth as the other page clients.
 */
import { apiUrl, config } from "@/lib/config";

// ── Types (mirror @polpo-ai/core computers.ts and src/server/routes/computers.ts) ──

export type ComputerKind = "host" | "daytona" | "e2b";
export type ComputerStatus =
  | "running" | "stopped" | "paused" | "archived" | "creating" | "starting" | "stopping" | "error" | "missing" | "unknown";

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
  /** "host": this server, always there. */
  builtin?: boolean;
  agents: Array<{ name: string; isDefault: boolean }>;
  /** After an update: fields that apply to a new machine only. */
  note?: string;
}

export type ComputerInput = Partial<Pick<Computer, "id" | "name" | "kind" | "description" | "image" | "snapshot" | "template" | "resources" | "lifecycle" | "network" | "egress">> & { start?: boolean };

export type ComputerAction = "start" | "stop" | "restart" | "reset";

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
  list: (live = true) => request<{ computers: Computer[] }>(`/computers${live ? "" : "?live=0"}`).then((d) => d.computers),
  get: (id: string) => request<Computer>(at(id)),
  create: (input: ComputerInput) => request<Computer>("/computers", json("POST", input)),
  update: (id: string, patch: Record<string, unknown>) => request<Computer>(at(id), json("PATCH", patch)),
  remove: (id: string) => request<{ deleted: string }>(at(id), json("DELETE", { confirm: true })),
  control: (id: string, action: ComputerAction) => request<Computer>(`${at(id)}/${action}`, json("POST", action === "reset" ? { confirm: true } : undefined)),
  /** An agent's default computer ("host" or "" for this server) and the computers it may use. */
  assign: (agent: string, defaultComputer: string, computers?: string[]) =>
    request<unknown>(`/agents/${encodeURIComponent(agent)}`, json("PATCH", { defaultComputer: defaultComputer === "host" ? "" : defaultComputer, ...(computers ? { computers } : {}) })),
};

// ── Presentation ──────────────────────────────────────────────────────────

export const KIND_LABELS: Record<ComputerKind, string> = { host: "This server", daytona: "Daytona", e2b: "E2B" };

export const STATUS_LABELS: Record<ComputerStatus, string> = {
  running: "Running", stopped: "Stopped", paused: "Paused", archived: "Archived", creating: "Creating", starting: "Starting",
  stopping: "Stopping", error: "Error", missing: "Not created yet", unknown: "Unknown",
};

export type StatusTone = "ok" | "idle" | "busy" | "bad";

export function statusTone(status: ComputerStatus): StatusTone {
  switch (status) {
    case "running": return "ok";
    case "creating": case "starting": case "stopping": return "busy";
    case "error": case "unknown": return "bad";
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
    default: return ["start", "reset"];
  }
}

/** "3 h 20 min", "45 min", "—". */
export function formatUptime(minutes: number | undefined): string {
  if (!minutes) return "—";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
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
  start: boolean;
}

export const EMPTY_COMPUTER_FORM: ComputerForm = {
  id: "", name: "", kind: "daytona", image: "", imageKind: "snapshot", idleStopMinutes: "15", autoArchiveDays: "", egress: "", start: false,
};

export function formFromComputer(c: Computer): ComputerForm {
  return {
    id: c.id, name: c.name, kind: c.kind,
    image: c.snapshot ?? c.image ?? c.template ?? "",
    imageKind: c.image ? "image" : "snapshot",
    idleStopMinutes: c.lifecycle?.idleStopMinutes ? String(c.lifecycle.idleStopMinutes) : "15",
    autoArchiveDays: c.lifecycle?.autoArchiveDays ? String(c.lifecycle.autoArchiveDays) : "",
    egress: c.egress ?? "", start: false,
  };
}

const RESERVED_COMPUTER_IDS = ["host", "ephemeral"];

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
  }
  if (!editing && form.start && form.kind !== "host") out.start = true;
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}
