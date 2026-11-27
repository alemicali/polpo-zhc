/**
 * Computers: persistent machines agents work on (settings.computers), for the dashboard, Polpo
 * and API clients. Mounted under the authenticated API (/api/v1/computers).
 *
 *   GET    /computers                 list, with live status (?live=0: the last known status; the providers' answers are
 *                                     reused for 15 s, ?fresh=1 asks again) and the agents using each. Status "deleted":
 *                                     its machine (and snapshots) were deleted at the provider, outside Polpo
 *   POST   /computers                 create { id, name, kind, image?, snapshot?, template?, resources?, lifecycle?, network?, egress?, volumes?, start? }
 *   GET    /computers/:id             one computer (?detail=1: also its snapshots, activity, harness sessions, recent
 *                                     task runs on it and their cost, the image and region a new machine gets)
 *   PATCH  /computers/:id             change name, description, image/snapshot/template, resources, lifecycle, network, egress, volumes (id and kind stay)
 *   DELETE /computers/:id             { confirm: true }: deletes the machine and its disk (Daytona v2: and its snapshots), and the computer
 *   POST   /computers/:id/start       start, resume, or wake it from its snapshot (Daytona v2); created if it has no machine yet
 *   POST   /computers/:id/stop        stop (Daytona v0 container), pause (E2B, Daytona v0 VM) or hibernate (Daytona v2:
 *                                     memory and disk snapshot, then the VM is deleted); never loses the machine
 *   POST   /computers/:id/restart
 *   POST   /computers/:id/reset       { confirm: true }: delete the machine (and its snapshots) and create a new one (its disk is lost)
 *   GET    /computers/:id/egress      a remote computer's egress through Tailscale: tailnet up/down, node, path (direct/DERP),
 *                                     proxy reachable, where its browser goes out now (looks inside only a running machine)
 *   GET    /computers/:id/desktop     its live view (desktop.ts: display, VNC, websockify; never starts it) and who holds it;
 *                                     ?viewer=1 also this person's VNC password (full control only while they hold it)
 *   POST   /computers/:id/desktop/start   start the live view (starts or wakes the computer); /desktop/stop stops it
 *   GET    /computers/:id/control     who holds its desktop (agent, or a person since when) and its agents' takeover requests
 *   POST   /computers/:id/takeover    { force? }: the signed-in person takes control (the agent's browser waits)
 *   POST   /computers/:id/release     { note?, force? }: give control back to the agent, with a note it reads
 *   WS     /computers/:id/desktop/vnc the live view itself (computer-desktop-ws.ts), authorized like the terminal
 *
 * "host" (this server) is listed as a built-in computer; it cannot be changed, started or stopped.
 * Machines are created on first use (an agent's chat or task) or on start, never on every call.
 */
import { Hono, type Context } from "hono";
import {
  ComputerConfigError, HOST_COMPUTER, HOST_COMPUTER_ID, agentEgressName, computerEgressProblem, computerUsers, isRemoteComputer, parseComputer,
  type AgentConfig, type ComputerConfig, type EffectiveSandbox, type PolpoEventMap, type PolpoSettings, type Task,
} from "@polpo-ai/core";
import { daytonaV2HibernateSettings, type DaytonaV2HibernateSettings } from "@polpo-ai/core/sandbox";
import type { HarnessSessionView } from "../../harness/control.js";
import { ComputerDeletedError, ComputerResetIncompleteError, computerEgressStatus, type ComputerLive, type ComputerManager } from "../../sandbox/computers.js";
import { computerChangeNote, computerNetworkProblem } from "../../sandbox/manager.js";
import { SandboxNetworkConfigError } from "../../sandbox/remote-adapters.js";
import { desktopUnsupported, type ComputerDesktops, type DesktopStatus } from "../../sandbox/desktop.js";
import { ComputerControlError, type ComputerControlView } from "../../sandbox/computer-control.js";
import type { ComputerTakeoverService } from "../../core/computer-takeover.js";

export interface ComputerRouteDeps {
  computers: () => ComputerConfig[];
  settings: () => PolpoSettings | undefined;
  agents: () => Promise<AgentConfig[]>;
  manager: () => ComputerManager;
  /** Write settings.computers to polpo.json and reload the configuration. */
  save: (computers: ComputerConfig[]) => Promise<void>;
  /** The sandbox a computer's machine is created with, or why it cannot be (no API key). */
  sandboxFor: (computer: ComputerConfig) => EffectiveSandbox | { error: string };
  emit: (payload: PolpoEventMap["computer:changed"]) => void;
  /** The live view started or stopped (computer:takeover). */
  emitTakeover?: (payload: PolpoEventMap["computer:takeover"]) => void;
  /** The instance's name (the project): part of the computers' node names in the tailnet. */
  instance?: () => string | undefined;
  /** Tasks (the detail's recent runs on a computer). */
  tasks?: () => Promise<Task[]>;
  /** The agent harness sessions (Claude Code, Codex, OpenCode) bound to a computer. */
  harnessSessions?: (computerId: string) => HarnessSessionView[];
  /** The computers' live views (desktop.ts). */
  desktops?: () => ComputerDesktops;
  /** Who holds each computer's desktop, and agents' requests for a person (computer-takeover.ts). */
  takeover?: () => ComputerTakeoverService | undefined;
  /** The signed-in person (member email), when members sign in. */
  member?: (c: Context) => string | undefined;
}

/** GET /computers/:id/desktop: the live view, who holds it, and (viewer=1) this viewer's VNC password. */
export interface ComputerDesktopView {
  desktop: DesktopStatus;
  control: ComputerControlView;
  /** viewer=1, while the live view runs: the password for this person (full control only when they hold it). */
  viewer?: { mode: "control" | "view"; password: string; path: string };
}

/** Runs listed in a computer's detail (newest first). */
const DETAIL_RUNS = 50;

/** A task run on a computer, as its page lists it. */
export interface ComputerRunView {
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

/** What GET /computers/:id?detail=1 adds to the computer. */
export interface ComputerDetailView {
  snapshots: Array<{ id: string; name: string; at: string; status: string; diskBytes?: number; memoryBytes?: number }>;
  activity: Array<{ at: string; kind: "status" | "notice"; status?: string; from?: string; level?: string; message?: string; remoteId?: string }>;
  updatedAt?: string;
  runningSince?: string;
  /** Daytona v2: when the current VM's wall clock deletes it (it is rotated before). */
  timeoutAt?: string;
  /** When it hibernates or stops by itself if nobody uses it (running only). */
  idleStopAt?: string;
  /** Daytona v2 hibernation settings (keepSnapshots…). */
  hibernate?: DaytonaV2HibernateSettings;
  /** What a new machine is made from, and where (the instance's defaults when the computer names none). */
  machine?: { image?: string; snapshot?: string; template?: string; region?: string; resources?: { cpus?: number; memoryMb?: number; diskMb?: number } };
  sessions: HarnessSessionView[];
  runs: ComputerRunView[];
  /** Spend on it: task runs (harness or model cost) plus chat harness sessions (task sessions are in their runs). */
  cost: { runsUsd: number; chatSessionsUsd: number; totalUsd: number };
}

const LIVE_TIMEOUT_MS = 8_000;

type View = ComputerConfig & ComputerLive & {
  builtin?: boolean;
  agents: { name: string; isDefault: boolean }[];
  /** Daytona: the service its machines run on ("v2": Linux VMs that hibernate). */
  providerApi?: "v0" | "v2";
};

function fail(c: Context, status: 400 | 404 | 409 | 500 | 502, error: string, code?: string) {
  return c.json({ ok: false, error, ...(code ? { code } : {}) }, status);
}

export function computerRoutes(deps: ComputerRouteDeps): Hono {
  const app = new Hono();

  const find = (id: string): ComputerConfig | undefined => id === HOST_COMPUTER_ID ? HOST_COMPUTER : deps.computers().find((c) => c.id === id);

  /** The Daytona snapshot a new machine of this computer comes from (to report an inactive one). */
  const snapshotOf = (computer: ComputerConfig): string | undefined => {
    if (computer.kind !== "daytona") return undefined;
    const s = deps.sandboxFor(computer);
    return "error" in s || typeof s.providerOptions.snapshot !== "string" ? undefined : s.providerOptions.snapshot;
  };

  /** Live status from the provider, or the last known one when it does not answer in time. */
  const liveOf = async (computer: ComputerConfig, live: boolean, fresh = false): Promise<ComputerLive> => {
    if (!isRemoteComputer(computer)) return { id: computer.id, status: "running", uptimeMinutes: 0 };
    const manager = deps.manager();
    if (!live) return manager.live(computer.id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<ComputerLive>((resolve) => { timer = setTimeout(() => resolve(manager.live(computer.id)), LIVE_TIMEOUT_MS); });
    try {
      return await Promise.race([manager.refresh(computer, snapshotOf(computer), { force: fresh }).catch((err) => ({ ...manager.live(computer.id), status: "unknown" as const, lastError: (err as Error).message })), late]);
    } finally {
      clearTimeout(timer);
    }
  };

  const view = async (computer: ComputerConfig, live = true, agents?: AgentConfig[], fresh = false): Promise<View> => {
    const all = agents ?? await deps.agents();
    const users = computer.id === HOST_COMPUTER_ID
      ? all.filter((a) => !a.defaultComputer || a.defaultComputer === HOST_COMPUTER_ID).map((a) => ({ name: a.name, isDefault: true }))
      : computerUsers(computer.id, all);
    const api = computer.kind === "daytona" ? (deps.settings()?.sandbox?.providers?.daytona?.api === "v2" ? "v2" : "v0") : undefined;
    return {
      ...computer, ...(await liveOf(computer, live, fresh)), ...(computer.id === HOST_COMPUTER_ID ? { builtin: true } : {}),
      ...(api ? { providerApi: api } : {}), agents: users,
    } as View;
  };

  /** The sandbox to create/start a machine with, or an error response. */
  const sandbox = (c: Context, computer: ComputerConfig): EffectiveSandbox | Response => {
    const s = deps.sandboxFor(computer);
    return "error" in s ? fail(c, 409, s.error, "PROVIDER_UNAVAILABLE") : s;
  };


  const operationError = (c: Context, what: string, err: unknown) => {
    const message = `${what} failed: ${err instanceof Error ? err.message : String(err)}`;
    // a rule the provider refuses is the computer's settings, not a server failure
    if (err instanceof SandboxNetworkConfigError) return fail(c, 400, `${message}. Fix the computer's network rule`, "VALIDATION_ERROR");
    if (err instanceof ComputerDeletedError) return fail(c, 409, message, "DELETED");
    return fail(c, 502, message, "PROVIDER_ERROR");
  };

  app.get("/", async (c) => {
    const live = c.req.query("live") !== "0";
    const fresh = c.req.query("fresh") === "1";
    const agents = await deps.agents();
    const computers = await Promise.all([HOST_COMPUTER, ...deps.computers()].map((computer) => view(computer, live, agents, fresh)));
    return c.json({ ok: true, data: { computers } });
  });

  /** Snapshots, activity, sessions, runs and cost of one computer (its page). */
  const detail = async (computer: ComputerConfig, base: View): Promise<ComputerDetailView> => {
    const remote = isRemoteComputer(computer);
    const d = remote ? deps.manager().detail(computer.id) : { snapshots: [], activity: [] };
    const sessions = [...(deps.harnessSessions?.(computer.id) ?? [])].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const tasks = await deps.tasks?.().catch(() => [] as Task[]) ?? [];
    const runs: ComputerRunView[] = [];
    for (const t of tasks) {
      for (const r of t.runs ?? []) {
        if (r.computer?.id !== computer.id) continue;
        const cost = r.cost?.harnessUsd ?? r.cost?.modelUsd;
        runs.push({
          taskId: t.id, taskTitle: t.title, taskStatus: t.status, ...(t.group ? { mission: t.group } : {}),
          runId: r.runId, ...(r.agent ? { agent: r.agent } : {}), engine: r.engine, ...(r.model ? { model: r.model } : {}),
          status: r.status, startedAt: r.startedAt, ...(r.endedAt ? { endedAt: r.endedAt } : {}),
          ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}), ...(cost !== undefined ? { costUsd: cost } : {}),
          ...(r.cost?.tokens !== undefined ? { tokens: r.cost.tokens } : {}), ...(r.computer.remoteId ? { remoteId: r.computer.remoteId } : {}),
        });
      }
    }
    runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    const runsUsd = runs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
    const chatSessionsUsd = sessions.filter((s) => s.scope === "chat").reduce((s, x) => s + (x.costUsd ?? 0), 0);
    const round = (v: number) => Math.round(v * 10_000) / 10_000;
    const settings = deps.settings();
    const sb = remote ? deps.sandboxFor(computer) : undefined;
    const opts = sb && !("error" in sb) ? sb.providerOptions : undefined;
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const machine = remote ? Object.fromEntries(Object.entries({
      image: computer.image ?? str(opts?.image), snapshot: computer.snapshot ?? str(opts?.snapshot), template: computer.template ?? str(opts?.template),
      region: str(opts?.region) ?? str((settings?.sandbox?.providers?.[computer.kind as "daytona"] as Record<string, unknown> | undefined)?.region),
      resources: computer.resources ?? (sb && !("error" in sb) && Object.keys(sb.resources ?? {}).length ? sb.resources : undefined),
    }).filter(([, v]) => v !== undefined)) : undefined;
    const idleStopAt = base.status === "running" && base.lastUsedAt
      ? new Date(Date.parse(base.lastUsedAt) + (computer.lifecycle?.idleStopMinutes ?? 15) * 60_000).toISOString() : undefined;
    return {
      ...d,
      ...(idleStopAt ? { idleStopAt } : {}),
      ...(base.providerApi === "v2" ? { hibernate: daytonaV2HibernateSettings(settings?.sandbox?.providers?.daytona as Record<string, unknown> | undefined) } : {}),
      ...(machine && Object.keys(machine).length ? { machine } : {}),
      sessions, runs: runs.slice(0, DETAIL_RUNS),
      cost: { runsUsd: round(runsUsd), chatSessionsUsd: round(chatSessionsUsd), totalUsd: round(runsUsd + chatSessionsUsd) },
    };
  };

  app.get("/:id", async (c) => {
    const computer = find(c.req.param("id"));
    if (!computer) return fail(c, 404, `There is no computer "${c.req.param("id")}"`, "NOT_FOUND");
    const base = await view(computer, c.req.query("live") !== "0", undefined, c.req.query("fresh") === "1");
    if (c.req.query("detail") !== "1") return c.json({ ok: true, data: base });
    return c.json({ ok: true, data: { ...base, ...(await detail(computer, base)) } });
  });

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    let computer: ComputerConfig;
    try {
      computer = parseComputer(body);
    } catch (err) {
      return fail(c, 400, (err as Error).message, "VALIDATION_ERROR");
    }
    const existing = deps.computers();
    if (existing.some((x) => x.id === computer.id)) return fail(c, 409, `A computer "${computer.id}" already exists`, "CONFLICT");
    const egressError = checkEgress(computer, deps.settings()) ?? computerNetworkProblem(computer, deps.settings());
    if (egressError) return fail(c, 400, egressError, "VALIDATION_ERROR");
    // a computer created again with a deleted one's id gets machines again
    if (isRemoteComputer(computer)) await deps.manager().revive(computer.id);
    await deps.save([...existing, computer]);
    deps.emit({ id: computer.id, action: "created", status: isRemoteComputer(computer) ? "missing" : "running" });
    if (body.start === true && isRemoteComputer(computer)) {
      const s = sandbox(c, computer);
      if (s instanceof Response) return s;
      // the manager announces the status changes (computer:changed)
      try { await deps.manager().start(computer, s); }
      catch (err) { return operationError(c, `Starting computer "${computer.id}"`, err); }
    }
    return c.json({ ok: true, data: await view(computer, false) }, 201);
  });

  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    if (id === HOST_COMPUTER_ID) return fail(c, 400, "\"host\" is this server: it cannot be changed", "VALIDATION_ERROR");
    const existing = deps.computers();
    const current = existing.find((x) => x.id === id);
    if (!current) return fail(c, 404, `There is no computer "${id}"`, "NOT_FOUND");
    const patch = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (patch.id !== undefined && patch.id !== id) return fail(c, 400, "A computer's id cannot change (create a new one)", "VALIDATION_ERROR");
    if (patch.kind !== undefined && patch.kind !== current.kind) return fail(c, 400, "A computer's kind cannot change (create a new one)", "VALIDATION_ERROR");
    // null clears a field
    const merged: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || k === "kind") continue;
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    let next: ComputerConfig;
    try {
      next = parseComputer(merged);
    } catch (err) {
      return fail(c, 400, (err as Error).message, "VALIDATION_ERROR");
    }
    const egressError = checkEgress(next, deps.settings()) ?? computerNetworkProblem(next, deps.settings());
    if (egressError) return fail(c, 400, egressError, "VALIDATION_ERROR");
    await deps.save(existing.map((x) => (x.id === id ? next : x)));
    deps.emit({ id, action: "updated" });
    // image and size are fixed when the machine is created; the network too, except on Daytona
    // v2, where the rule is applied again whenever its VM starts or wakes
    const fixed = ["image", "snapshot", "template", "resources", "network"].filter((k) => JSON.stringify((current as unknown as Record<string, unknown>)[k]) !== JSON.stringify((next as unknown as Record<string, unknown>)[k]));
    const note = isRemoteComputer(next) && deps.manager().live(id).status !== "missing" ? computerChangeNote(next, fixed, deps.settings()) : undefined;
    return c.json({ ok: true, data: { ...(await view(next, false)), ...(note ? { note } : {}) } });
  });

  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    if (id === HOST_COMPUTER_ID) return fail(c, 400, "\"host\" is this server: it cannot be deleted", "VALIDATION_ERROR");
    const existing = deps.computers();
    const computer = existing.find((x) => x.id === id);
    if (!computer) return fail(c, 404, `There is no computer "${id}"`, "NOT_FOUND");
    const body = await c.req.json().catch(() => ({})) as { confirm?: unknown };
    if (body.confirm !== true && c.req.query("confirm") !== "true") {
      return fail(c, 400, `Deleting computer "${id}" deletes its machine and everything on its disk: send { "confirm": true }`, "CONFIRM_REQUIRED");
    }
    const users = computerUsers(id, await deps.agents()).filter((u) => u.isDefault);
    if (users.length) {
      return fail(c, 409, `Computer "${id}" is the default of ${users.map((u) => u.name).join(", ")}: choose another default for ${users.length > 1 ? "them" : "it"} first`, "IN_USE");
    }
    try {
      await deps.manager().delete(computer);
    } catch (err) {
      return operationError(c, `Deleting the machine of computer "${id}"`, err);
    }
    await deps.save(existing.filter((x) => x.id !== id));
    deps.emit({ id, action: "deleted" });
    return c.json({ ok: true, data: { deleted: id } });
  });

  const control = (op: "start" | "stop" | "restart" | "reset") => async (c: Context) => {
    const id = c.req.param("id")!;
    const computer = find(id);
    if (!computer) return fail(c, 404, `There is no computer "${id}"`, "NOT_FOUND");
    if (!isRemoteComputer(computer)) return fail(c, 400, `"${id}" runs on this server: there is no machine to ${op}`, "VALIDATION_ERROR");
    if (op === "reset") {
      const body = await c.req.json().catch(() => ({})) as { confirm?: unknown };
      if (body.confirm !== true && c.req.query("confirm") !== "true") {
        return fail(c, 400, `Resetting computer "${id}" deletes its machine and everything on its disk, then creates a new one: send { "confirm": true }`, "CONFIRM_REQUIRED");
      }
    }
    const manager = deps.manager();
    try {
      // the manager announces each status change (computer:changed)
      if (op === "stop") await manager.stop(computer);
      else {
        const s = sandbox(c, computer);
        if (s instanceof Response) return s;
        await (op === "start" ? manager.start(computer, s) : op === "restart" ? manager.restart(computer, s) : manager.reset(computer, s));
      }
      return c.json({ ok: true, data: await view(computer, false) });
    } catch (err) {
      // the wipe is done: the reset did what was asked, its new machine comes on the next use
      if (err instanceof ComputerResetIncompleteError) return c.json({ ok: true, data: { ...(await view(computer, false)), note: err.message } });
      return operationError(c, `${op[0]!.toUpperCase()}${op.slice(1)} of computer "${id}"`, err);
    }
  };
  app.post("/:id/start", control("start"));
  app.post("/:id/stop", control("stop"));
  app.post("/:id/restart", control("restart"));
  app.post("/:id/reset", control("reset"));

  // ── Live view and take control ────────────────────────────────────

  const takeoverService = () => deps.takeover?.();
  /** The person: their member email, or "someone" without member sign-in. */
  const personOf = (c: Context) => deps.member?.(c)?.toLowerCase() || "someone";
  const remoteOr = (c: Context, id: string): ComputerConfig | Response => {
    const computer = find(id);
    if (!computer) return fail(c, 404, `There is no computer "${id}"`, "NOT_FOUND");
    const why = desktopUnsupported(computer);
    if (why) return fail(c, 400, why, "VALIDATION_ERROR");
    return computer;
  };
  const controlError = (c: Context, err: unknown) => {
    if (err instanceof ComputerControlError) {
      const status = err.code === "NOT_FOUND" ? 404 : err.code === "CONFLICT" || err.code === "NOT_HELD" ? 409 : 400;
      return fail(c, status, err.message, err.code);
    }
    return fail(c, 500, err instanceof Error ? err.message : String(err));
  };
  const desktopView = async (c: Context, computer: ComputerConfig, viewer: boolean, status?: DesktopStatus): Promise<ComputerDesktopView> => {
    const desktops = deps.desktops?.();
    const desktop = status ?? (desktops ? await desktops.status(computer) : { computerId: computer.id, state: "unsupported" as const, display: ":99", note: "No live view on this server" });
    const control = takeoverService()?.get(computer.id) ?? { computerId: computer.id, holder: "agent" as const, requests: [], open: [] };
    const out: ComputerDesktopView = { desktop, control };
    if (viewer && desktops && desktop.state === "running") {
      const mode = control.holder === "person" && control.person === personOf(c) ? "control" : "view";
      const password = desktops.password(computer.id, mode);
      if (password) out.viewer = { mode, password, path: `/api/v1/computers/${encodeURIComponent(computer.id)}/desktop/vnc` };
    }
    return out;
  };

  app.get("/:id/desktop", async (c) => {
    const computer = remoteOr(c, c.req.param("id"));
    if (computer instanceof Response) return computer;
    return c.json({ ok: true, data: await desktopView(c, computer, c.req.query("viewer") === "1") });
  });

  app.post("/:id/desktop/start", async (c) => {
    const computer = remoteOr(c, c.req.param("id"));
    if (computer instanceof Response) return computer;
    const desktops = deps.desktops?.();
    if (!desktops) return fail(c, 409, "No live view on this server", "NOT_AVAILABLE");
    try {
      const status = await desktops.start(computer);
      deps.emitTakeover?.({ id: computer.id, action: "desktop-started", holder: takeoverService()?.get(computer.id).holder ?? "agent" });
      return c.json({ ok: true, data: await desktopView(c, computer, true, status) });
    } catch (err) {
      return operationError(c, `Starting the live view of computer "${computer.id}"`, err);
    }
  });

  app.post("/:id/desktop/stop", async (c) => {
    const computer = remoteOr(c, c.req.param("id"));
    if (computer instanceof Response) return computer;
    const desktops = deps.desktops?.();
    if (!desktops) return fail(c, 409, "No live view on this server", "NOT_AVAILABLE");
    const status = await desktops.stop(computer);
    deps.emitTakeover?.({ id: computer.id, action: "desktop-stopped", holder: takeoverService()?.get(computer.id).holder ?? "agent" });
    return c.json({ ok: true, data: await desktopView(c, computer, false, status) });
  });

  /** Who holds it and its agents' requests (open first). */
  app.get("/:id/control", async (c) => {
    const computer = remoteOr(c, c.req.param("id"));
    if (computer instanceof Response) return computer;
    return c.json({ ok: true, data: takeoverService()?.get(computer.id) ?? { computerId: computer.id, holder: "agent", requests: [], open: [] } });
  });

  app.post("/:id/takeover", async (c) => {
    const computer = remoteOr(c, c.req.param("id"));
    if (computer instanceof Response) return computer;
    const service = takeoverService();
    if (!service) return fail(c, 409, "Take control is not available on this server", "NOT_AVAILABLE");
    const body = await c.req.json().catch(() => ({})) as { force?: unknown };
    try {
      await service.takeover(computer.id, personOf(c), { force: body.force === true });
      return c.json({ ok: true, data: await desktopView(c, computer, true) });
    } catch (err) {
      return controlError(c, err);
    }
  });

  app.post("/:id/release", async (c) => {
    const computer = remoteOr(c, c.req.param("id"));
    if (computer instanceof Response) return computer;
    const service = takeoverService();
    if (!service) return fail(c, 409, "Take control is not available on this server", "NOT_AVAILABLE");
    const body = await c.req.json().catch(() => ({})) as { note?: unknown; force?: unknown };
    if (body.note !== undefined && typeof body.note !== "string") return fail(c, 400, "note must be text", "VALIDATION_ERROR");
    try {
      await service.release(computer.id, personOf(c), body.note as string | undefined, { force: body.force === true });
      return c.json({ ok: true, data: await desktopView(c, computer, true) });
    } catch (err) {
      return controlError(c, err);
    }
  });

  app.get("/:id/egress", async (c) => {
    const id = c.req.param("id");
    const computer = find(id);
    if (!computer) return fail(c, 404, `There is no computer "${id}"`, "NOT_FOUND");
    if (!computer.egress) return c.json({ ok: true, data: { computerId: id, egress: null } });
    if (!isRemoteComputer(computer)) {
      return c.json({ ok: true, data: { computerId: id, proxy: computer.egress, tailnet: null, note: "a computer on this server uses the proxy directly (egress_status)" } });
    }
    const status = await computerEgressStatus(deps.manager(), computer, deps.settings(), deps.instance?.());
    return c.json({ ok: true, data: status });
  });

  return app;
}

/**
 * An error when a computer's egress cannot work: an unknown proxy; for a remote computer, no
 * Tailscale settings, a proxy that is not SOCKS5 on a tailnet address, or no network.
 */
function checkEgress(computer: ComputerConfig, settings: PolpoSettings | undefined): string | null {
  return computerEgressProblem(computer, settings);
}

/** One egress proxy as the overview shows it (never its URL: it may carry a password). */
export interface EgressProxyView {
  name: string;
  /** A TCP connection to it opens from this server. */
  reachable: boolean;
  /** Agents whose browser runs on this server and goes out through it. */
  agents: string[];
  /** Computers on this server ("host" kind) with this egress. */
  hostComputers: string[];
}

export interface EgressOverview {
  proxies: EgressProxyView[];
  /** Agents naming a proxy that does not exist (their browser goes out directly). */
  unknown: Array<{ agent: string; proxy: string }>;
  /** Remote computers with an egress: what each sees from its VM (never started for this). */
  computers: Array<Awaited<ReturnType<typeof computerEgressStatus>> & { kind: string }>;
}

/**
 * GET /egress: every egress proxy (reachable from this server, the agents and host computers
 * using it) and every remote computer's egress through Tailscale. Read-only: looks inside only
 * running machines.
 */
export function egressRoutes(deps: ComputerRouteDeps & { reachable?: (url: string) => Promise<boolean> }): Hono {
  const app = new Hono();
  app.get("/", async (c) => {
    const settings = deps.settings();
    const proxies = settings?.egressProxies ?? {};
    const agents = await deps.agents();
    const computers = deps.computers();
    const reachable = deps.reachable ?? (async (url: string) => (await import("../../tools/browser-egress.js")).proxyReachable(url));
    const remoteDefault = (a: AgentConfig) => computers.some((x) => x.id === a.defaultComputer && isRemoteComputer(x));
    // agents whose browser runs on this server (a remote default computer's browser runs in its VM)
    const hostAgents = agents.filter((a) => !remoteDefault(a)).map((a) => ({ name: a.name, proxy: agentEgressName(a, settings) }));
    const view: EgressProxyView[] = await Promise.all(Object.entries(proxies).map(async ([name, url]) => ({
      name,
      reachable: await reachable(url).catch(() => false),
      agents: hostAgents.filter((a) => a.proxy === name).map((a) => a.name),
      hostComputers: computers.filter((x) => x.kind === "host" && x.egress === name).map((x) => x.id),
    })));
    const unknown = hostAgents.filter((a) => a.proxy && !proxies[a.proxy]).map((a) => ({ agent: a.name, proxy: a.proxy! }));
    const remote = await Promise.all(computers.filter((x) => isRemoteComputer(x) && x.egress).map(async (x) => {
      const status = await computerEgressStatus(deps.manager(), x, settings, deps.instance?.()).catch((err) => ({
        computerId: x.id, proxy: x.egress!, tailnet: "unknown" as const, proxyReachable: false, effective: `direct (${x.egress} could not be checked)`, machine: "unknown" as const, error: (err as Error).message,
      }));
      return status ? { ...status, kind: x.kind } : undefined;
    }));
    const data: EgressOverview = { proxies: view, unknown, computers: remote.filter((x): x is NonNullable<typeof x> => !!x) };
    return c.json({ ok: true, data });
  });
  return app;
}

export { ComputerConfigError };
