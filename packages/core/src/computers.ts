/**
 * Computers: a persistent machine an agent works on (settings.computers in polpo.json).
 *
 * A sandbox is per run (created, reused for a while, deleted); a computer stays: the same remote
 * VM every time, found again by its provider label, started when it is stopped, stopped (never
 * deleted) when nobody used it for a while, its working directory kept between runs. "host" is
 * the implicit computer every agent has: this server, with the sandbox cascade as before.
 *
 * Which machine a run uses (resolveSandbox applies it, see computerSelection):
 *   1. A task or mission that asks for an ephemeral sandbox gets one: `sandbox.computer:
 *      "ephemeral"`, an explicit `sandbox.provider`, or `sandbox.isolation: "fresh"`.
 *   2. A task or mission may name one of the agent's computers (`sandbox.computer: "<id>"`).
 *   3. Otherwise the agent's defaultComputer, for its chats and its tasks alike.
 *   4. No default (or "host"): the sandbox cascade instance → agent → mission → task, as before.
 * A computer's network is fixed when it is created: a task or mission asking for a stricter
 * network than the computer has gets an ephemeral sandbox with that network instead.
 */
import type { SandboxNetwork, SandboxResources, SandboxVolumeSelection } from "./sandbox.js";
import { normalizeSandboxSettings } from "./sandbox.js";
import { remoteEgressProblem } from "./tailnet.js";

export * from "./tailnet.js";

export type ComputerKind = "host" | "daytona" | "e2b";
export const COMPUTER_KINDS: readonly ComputerKind[] = ["host", "daytona", "e2b"];

/**
 * Live state. Daytona containers stop (disk kept) and archive after a while stopped (disk moved
 * to object storage: slower to start, not billed); E2B and Daytona VM-class sandboxes pause
 * (memory kept). Daytona v2 computers hibernate: their VM is saved as a memory and disk snapshot
 * and deleted ("hibernated"); the next use makes a VM from the snapshot (a few seconds).
 * "missing": not created yet (it is created on first use or on start).
 * "deleted": it had a machine, but the provider has neither it nor (Daytona v2) a snapshot to wake
 *   from: it was deleted outside Polpo (the provider's dashboard, API, or its own clean-up). Its
 *   next use or start makes a new machine from the image (its files are lost); or remove it.
 * "unknown": the provider cannot be asked (no API key).
 */
export type ComputerStatus =
  | "running" | "stopped" | "paused" | "hibernated" | "archived" | "creating" | "starting" | "stopping" | "error" | "missing" | "deleted" | "unknown";

export interface ComputerLifecycle {
  /** Stop (Daytona v0 container), pause (E2B, Daytona v0 VM) or hibernate (Daytona v2: snapshot, VM deleted) after this many minutes without use. Default 15. */
  idleStopMinutes?: number;
  /** Daytona v0: archive after this many days stopped (disk kept in object storage, not billed). Default: Daytona's (7). Ignored on v2. */
  autoArchiveDays?: number;
}

export interface ComputerConfig {
  /** Slug: lowercase letters, digits and -, e.g. "nina". "host" is reserved (this server). */
  id: string;
  /** Display name. */
  name: string;
  kind: ComputerKind;
  description?: string;
  /** Daytona: a Docker image (sized by `resources`); otherwise the instance's snapshot. */
  image?: string;
  /** Daytona snapshot (its size and class — container or linux-vm — come with it). */
  snapshot?: string;
  /** E2B template. */
  template?: string;
  /** CPU, memory, disk (Daytona with an image; E2B and snapshots have a fixed size). */
  resources?: Pick<SandboxResources, "cpus" | "memoryMb" | "diskMb">;
  lifecycle?: ComputerLifecycle;
  /** Network rule, fixed when the remote machine is created (default: the agent's/instance's). */
  network?: SandboxNetwork;
  /**
   * Egress proxy name (settings.egressProxies): the browser of agents on this computer goes out
   * through it. A remote computer (Daytona, E2B) reaches it through Tailscale inside its VM: that
   * needs settings.tailscale and a SOCKS5 proxy on a tailnet address (computerEgressProblem).
   */
  egress?: string;
  /** Volumes attached to runs on this computer (names granted to the agent on their storage entry). */
  volumes?: SandboxVolumeSelection[];
}

/** The implicit computer every agent has: this server. */
export const HOST_COMPUTER_ID = "host";
/** `sandbox.computer` value with which a task or mission asks for an ephemeral sandbox. */
export const EPHEMERAL_COMPUTER = "ephemeral";
export const COMPUTER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const DEFAULT_COMPUTER_IDLE_STOP_MINUTES = 15;
export const MAX_COMPUTER_IDLE_STOP_MINUTES = 24 * 60;
export const MAX_COMPUTER_ARCHIVE_DAYS = 30;
/** Provider label (Daytona) / metadata (E2B) that finds a computer's machine: `<instance>:<id>`. */
export const COMPUTER_LABEL = "polpo-computer";

export const HOST_COMPUTER: ComputerConfig = Object.freeze({ id: HOST_COMPUTER_ID, name: "This server", kind: "host" }) as ComputerConfig;

export class ComputerConfigError extends Error {
  constructor(message: string) { super(message); this.name = "ComputerConfigError"; }
}

export function isRemoteComputer(c: Pick<ComputerConfig, "kind"> | undefined): c is ComputerConfig & { kind: "daytona" | "e2b" } {
  return c?.kind === "daytona" || c?.kind === "e2b";
}

export function computerIdleStopMinutes(c: Pick<ComputerConfig, "lifecycle">): number {
  return c.lifecycle?.idleStopMinutes ?? DEFAULT_COMPUTER_IDLE_STOP_MINUTES;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * One computer from raw input (config file or API), or an error naming the field. `where`
 * prefixes messages ("settings.computers[2]").
 */
export function parseComputer(raw: unknown, where = "computer"): ComputerConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ComputerConfigError(`${where} must be an object`);
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id || !COMPUTER_ID_PATTERN.test(id)) throw new ComputerConfigError(`${where}.id must be a slug of lowercase letters, digits and - (up to 40), e.g. "nina"`);
  if (id === HOST_COMPUTER_ID || id === EPHEMERAL_COMPUTER || id === "webhooks") throw new ComputerConfigError(`${where}.id "${id}" is reserved`);
  const kind = r.kind;
  if (typeof kind !== "string" || !(COMPUTER_KINDS as string[]).includes(kind)) throw new ComputerConfigError(`${where}.kind must be one of ${COMPUTER_KINDS.join(", ")}`);
  const out: ComputerConfig = { id, name: str(r.name) ?? id, kind: kind as ComputerKind };
  const description = str(r.description);
  if (description) out.description = description.slice(0, 500);
  for (const key of ["image", "snapshot", "template"] as const) {
    if (r[key] === undefined || r[key] === null || r[key] === "") continue;
    const v = str(r[key]);
    if (!v) throw new ComputerConfigError(`${where}.${key} must be a string`);
    out[key] = v;
  }
  if (out.kind !== "daytona" && (out.image || out.snapshot)) throw new ComputerConfigError(`${where}: image and snapshot are Daytona options`);
  if (out.kind !== "e2b" && out.template) throw new ComputerConfigError(`${where}: template is an E2B option`);
  if (out.image && out.snapshot) throw new ComputerConfigError(`${where}: give an image or a snapshot, not both`);
  if (r.resources !== undefined && r.resources !== null) {
    if (typeof r.resources !== "object") throw new ComputerConfigError(`${where}.resources must be an object`);
    const res: Record<string, number> = {};
    for (const key of ["cpus", "memoryMb", "diskMb"] as const) {
      const v = (r.resources as Record<string, unknown>)[key];
      if (v === undefined || v === null) continue;
      if (typeof v !== "number" || !(v > 0)) throw new ComputerConfigError(`${where}.resources.${key} must be a positive number`);
      res[key] = v;
    }
    if (Object.keys(res).length) out.resources = res;
  }
  if (r.lifecycle !== undefined && r.lifecycle !== null) {
    if (typeof r.lifecycle !== "object") throw new ComputerConfigError(`${where}.lifecycle must be an object`);
    const l = r.lifecycle as Record<string, unknown>;
    const lifecycle: ComputerLifecycle = {};
    if (l.idleStopMinutes !== undefined && l.idleStopMinutes !== null) {
      const v = l.idleStopMinutes;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_COMPUTER_IDLE_STOP_MINUTES) {
        throw new ComputerConfigError(`${where}.lifecycle.idleStopMinutes must be a whole number of minutes from 1 to ${MAX_COMPUTER_IDLE_STOP_MINUTES}`);
      }
      lifecycle.idleStopMinutes = v;
    }
    if (l.autoArchiveDays !== undefined && l.autoArchiveDays !== null) {
      const v = l.autoArchiveDays;
      if (out.kind !== "daytona") throw new ComputerConfigError(`${where}.lifecycle.autoArchiveDays is a Daytona option`);
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_COMPUTER_ARCHIVE_DAYS) {
        throw new ComputerConfigError(`${where}.lifecycle.autoArchiveDays must be a whole number of days from 1 to ${MAX_COMPUTER_ARCHIVE_DAYS}`);
      }
      lifecycle.autoArchiveDays = v;
    }
    if (Object.keys(lifecycle).length) out.lifecycle = lifecycle;
  }
  if (r.network !== undefined && r.network !== null) {
    const network = normalizeSandboxSettings({ network: r.network })?.network;
    if (!network) throw new ComputerConfigError(`${where}.network must be { mode: "deny" | "allowlist" | "open" | "unrestricted", allow?: [hosts] }`);
    out.network = network;
  }
  if (r.egress !== undefined && r.egress !== null && r.egress !== "") {
    const egress = str(r.egress);
    if (!egress || !/^[A-Za-z0-9_-]+$/.test(egress)) throw new ComputerConfigError(`${where}.egress must be the name of a proxy in settings.egressProxies`);
    out.egress = egress;
  }
  if (r.volumes !== undefined && r.volumes !== null) {
    const volumes = normalizeSandboxSettings({ volumes: r.volumes })?.volumes;
    if (!volumes) throw new ComputerConfigError(`${where}.volumes must be a list of volume names (or { name, access })`);
    out.volumes = volumes;
  }
  if (out.kind === "host" && (out.resources || out.volumes || out.lifecycle)) {
    throw new ComputerConfigError(`${where}: a computer on this server ("host") has no size, lifecycle or volumes of its own (the agent's sandbox settings apply)`);
  }
  return out;
}

/**
 * Why a computer's egress cannot work with these settings (null: it can, or it has none): the
 * proxy must exist; a remote computer reaches it through Tailscale in its VM (settings.tailscale,
 * a SOCKS5 proxy on a tailnet address, and a network that lets the VM out).
 */
export function computerEgressProblem(
  computer: Pick<ComputerConfig, "id" | "kind" | "egress" | "network">,
  settings: { egressProxies?: Record<string, string>; tailscale?: unknown } | undefined,
): string | null {
  if (!computer.egress) return null;
  const url = settings?.egressProxies?.[computer.egress];
  const proxies = Object.keys(settings?.egressProxies ?? {});
  if (!url) return `There is no egress proxy "${computer.egress}" (settings.egressProxies${proxies.length ? `: ${proxies.join(", ")}` : " is empty"})`;
  if (!isRemoteComputer(computer)) return null;
  const problem = remoteEgressProblem(computer.egress, url, settings);
  if (problem) return `Computer "${computer.id}": ${problem}`;
  if (computer.network?.mode === "deny") {
    return `Computer "${computer.id}" has no network (network.mode "deny"): Tailscale in its VM cannot reach the tailnet, so it cannot go out through "${computer.egress}"`;
  }
  return null;
}

/** settings.computers from raw input: valid computers with unique ids, or an error. */
export function parseComputers(raw: unknown): ComputerConfig[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ComputerConfigError("settings.computers must be a list of computers");
  const out: ComputerConfig[] = [];
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    const c = parseComputer(item, `settings.computers[${i}]`);
    if (seen.has(c.id)) throw new ComputerConfigError(`settings.computers: "${c.id}" appears twice`);
    seen.add(c.id);
    out.push(c);
  });
  return out;
}

/** A computer by id ("host" is always there). */
export function findComputer(computers: readonly ComputerConfig[] | undefined, id: string | undefined): ComputerConfig | undefined {
  if (!id) return undefined;
  if (id === HOST_COMPUTER_ID) return HOST_COMPUTER;
  return computers?.find((c) => c.id === id);
}

/** The computers an agent may use: its list plus its default ("host" always). */
export function agentComputerIds(agent: { computers?: string[]; defaultComputer?: string }): string[] {
  const ids = new Set<string>([HOST_COMPUTER_ID, ...(agent.computers ?? [])]);
  if (agent.defaultComputer) ids.add(agent.defaultComputer);
  return [...ids];
}

/**
 * What resolveSandbox needs to pick a computer: the instance's computers and the agent's choice.
 * Build it with computerContext(agent, settings).
 */
export interface ComputerContext {
  computers: readonly ComputerConfig[];
  defaultComputer?: string;
  allowed: string[];
}

export function computerContext(
  agent: { computers?: string[]; defaultComputer?: string } | undefined,
  settings: { computers?: unknown } | undefined,
): ComputerContext | undefined {
  if (!agent) return undefined;
  let computers: ComputerConfig[];
  try { computers = parseComputers(settings?.computers); } catch { computers = []; }
  return { computers, defaultComputer: agent.defaultComputer, allowed: agentComputerIds(agent) };
}

/**
 * The egress proxy name for an agent's browser on this server: its own browserEgress, else the
 * egress of its default computer when that computer runs on this server. (A remote computer's
 * egress goes through Tailscale in its VM: tailnetEgressFor.)
 */
export function agentEgressName(
  agent: { browserEgress?: string; defaultComputer?: string },
  settings: { computers?: unknown } | undefined,
): string | undefined {
  if (agent.browserEgress) return agent.browserEgress;
  if (!agent.defaultComputer || agent.defaultComputer === HOST_COMPUTER_ID) return undefined;
  let computers: ComputerConfig[];
  try { computers = parseComputers(settings?.computers); } catch { return undefined; }
  const c = computers.find((x) => x.id === agent.defaultComputer);
  return c?.kind === "host" ? c.egress : undefined;
}

/**
 * An error for an agent's computers / defaultComputer naming computers the instance does not have
 * (`known`: the settings' computer ids; "host" is always there), else null. Used by the agents API
 * and by Polpo's add_agent / update_agent.
 */
export function unknownComputersProblem(known: readonly string[], body: { computers?: readonly string[] | null; defaultComputer?: string | null }): string | null {
  if (!body.computers && !body.defaultComputer) return null;
  const ids = new Set([HOST_COMPUTER_ID, ...known]);
  const unknown = [...(body.computers ?? []), ...(body.defaultComputer ? [body.defaultComputer] : [])].filter((id) => !ids.has(id));
  return unknown.length ? `Unknown computer${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} (create ${unknown.length > 1 ? "them" : "it"} first)` : null;
}

/** The agents that use a computer (as default or in their list). */
export function computerUsers(id: string, agents: ReadonlyArray<{ name: string; computers?: string[]; defaultComputer?: string }>): { name: string; isDefault: boolean }[] {
  return agents
    .filter((a) => a.defaultComputer === id || a.computers?.includes(id))
    .map((a) => ({ name: a.name, isDefault: a.defaultComputer === id }));
}
