/**
 * Take control of a computer's desktop, on the server: the one place that changes who holds it.
 *
 * - takeover / release (a person, from the dashboard, the REST API, MCP or Polpo's chat tools):
 *   the control state (computer-control.ts) and a `computer:takeover` event. Nothing restarts: the
 *   server's RFB proxy (rfb-proxy.ts) lets input through only for the person holding it, deciding
 *   per message, so open viewers switch at once;
 * - request (an agent's request_computer_takeover, from a chat in this process or a task run over
 *   the notification socket): recorded on the computer, announced, its live view started (so the
 *   person finds it ready), and the person notified: on the
 *   agent's own notification channels when it has them (notifyChannels + send_notification), else
 *   through the instance's notification router (its rules on computer:takeover, or its channels).
 *
 * The agent and the task come from the run, never from the request (task runs: handleTakeoverWire).
 *
 * Levels: a soft request (optional help) just ends when its wait does. A hard one (blocking: a
 * CAPTCHA, a phone or app verification, a login wall) of a task is parked instead when nobody took
 * it in time: the run asks (op "park"), the task is paused ("waiting for takeover", step 1's pause),
 * the request stays open and the person is told again. When the person completes the takeover
 * (gives control back) the task is resumed and its agent continues, told what happened; resuming
 * or stopping the task otherwise cancels the request.
 */
import {
  agentHasNotifyTool, computerUsers, isRemoteComputer,
  type AgentConfig, type ComputerConfig, type PolpoEventMap, type Task,
} from "@polpo-ai/core";
import {
  ComputerControlError, computerControlStore,
  type ComputerControl, type ComputerControlStore, type ComputerControlView, type ComputerTakeoverRequest,
} from "../sandbox/computer-control.js";
import type { AgentNotifier } from "../notifications/agent-notify.js";
import type { ComputerTakeoverAccess, ComputerTakeoverAsk } from "../tools/computer-takeover-tools.js";
import type { TakeoverLevel } from "../sandbox/computer-control.js";
import type { RunRecord } from "./run-store.js";
import { requestOverSocket } from "./notification.js";

type TakeoverEvent = PolpoEventMap["computer:takeover"];

/** What the notification part needs from the instance's router. */
export interface TakeoverNotifyRouter {
  getChannelIds(): string[];
  getRules?(): Array<{ events: string[]; enabled?: boolean }>;
  sendDirect(opts: { channel: string; title: string; body: string; severity?: "info" | "warning" | "critical"; ruleName?: string }): Promise<unknown>;
}

export interface ComputerTakeoverDeps {
  polpoDir: string;
  computers: () => readonly ComputerConfig[];
  emit: (payload: TakeoverEvent) => void;
  /** Start the computer's live view (desktop.ts), idempotent: an agent asked for a person. */
  startDesktop?: (computer: ComputerConfig) => Promise<unknown>;
  notifier?: () => AgentNotifier | undefined;
  router?: () => TakeoverNotifyRouter | undefined;
  /** Where the person opens the computer (a link in the notification). */
  pageUrl?: (computerId: string) => string | undefined;
  log?: (level: "info" | "warn", message: string) => void;
  store?: ComputerControlStore;
  /** Pause a task (a hard request nobody took in time): the orchestrator's pauseTask. */
  pauseTask?: (taskId: string, o: { reason: string; by: string; takeover: { requestId: string; computerId: string } }) => Promise<unknown>;
  /** An agent's config by name (to notify on its own channels when its task is paused). */
  agent?: (name: string) => Promise<AgentConfig | undefined>;
  /** Resume a task (the person completed the takeover its paused agent asked for). */
  resumeTask?: (taskId: string, o: { by?: string; message: string }) => Promise<unknown>;
}

/** The reason a hard request's task is paused with. */
export const TAKEOVER_PAUSE_REASON = "waiting for takeover";

/** What the agent of a parked request is told when the person completed the takeover. */
export function takeoverCompletedMessage(r: Pick<ComputerTakeoverRequest, "reason" | "computerId" | "takenBy" | "note">, person?: string): string {
  const who = person ?? r.takenBy ?? "A person";
  return `${who} completed the takeover you asked for on computer ${r.computerId} ("${r.reason}") after your task was paused waiting for it.`
    + (r.note ? ` Their note: ${r.note}` : " They left no note.")
    + " Look at the page again (browser_snapshot) before going on: it may have changed.";
}

/** Channels the fallback notification goes to at most. */
const FALLBACK_CHANNELS = 3;

const matches = (pattern: string, event: string) =>
  pattern === "*" || pattern === event || (pattern.endsWith("*") && event.startsWith(pattern.slice(0, -1)));

export class ComputerTakeoverService {
  readonly store: ComputerControlStore;

  constructor(private readonly deps: ComputerTakeoverDeps) {
    this.store = deps.store ?? computerControlStore(deps.polpoDir);
  }

  private computer(id: string): ComputerConfig {
    const c = this.deps.computers().find((x) => x.id === id);
    if (!c) throw new ComputerControlError(`There is no computer "${id}"`, "NOT_FOUND");
    if (!isRemoteComputer(c)) throw new ComputerControlError(`"${id}" runs on this server: take control of its browser from Browser Live`, "INVALID");
    return c;
  }

  get(id: string): ComputerControlView {
    return this.store.get(id);
  }

  /** Every open request of every computer (pending, or a person in control for it). */
  pending(): ComputerTakeoverRequest[] {
    return this.store.list().flatMap((v) => v.open).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  private announce(e: Omit<TakeoverEvent, "holder"> & { holder?: TakeoverEvent["holder"] }, control: ComputerControl): void {
    try { this.deps.emit({ ...e, holder: e.holder ?? control.holder } as TakeoverEvent); } catch { /* listeners never change the operation */ }
  }

  async takeover(id: string, person: string | undefined, o: { force?: boolean } = {}): Promise<ComputerControlView> {
    this.computer(id);
    const r = await this.store.takeover(id, person ?? "someone", o);
    for (const req of r.requests) {
      this.announce({ id, action: "taken", person: r.control.person, requestId: req.id, agent: req.agent, ...(req.taskId ? { taskId: req.taskId } : {}) }, r.control);
    }
    if (!r.requests.length) this.announce({ id, action: "taken", person: r.control.person }, r.control);
    return this.store.get(id);
  }

  async release(id: string, person: string | undefined, note?: string, o: { force?: boolean } = {}): Promise<ComputerControlView> {
    this.computer(id);
    const before = this.store.get(id).person;
    const r = await this.store.release(id, person ?? "someone", note, o);
    const who = before ?? person;
    for (const req of r.requests) {
      this.announce({ id, action: "released", ...(who ? { person: who } : {}), requestId: req.id, agent: req.agent, ...(req.note ? { note: req.note } : {}), ...(req.taskId ? { taskId: req.taskId } : {}), ...(req.level ? { level: req.level } : {}) }, r.control);
    }
    if (!r.requests.length) this.announce({ id, action: "released", ...(who ? { person: who } : {}), ...(r.control.lastNote ? { note: r.control.lastNote } : {}) }, r.control);
    // a parked request completed: its paused task resumes, its agent told what happened
    for (const req of r.requests) {
      if (!req.parkedAt || !req.taskId || !this.deps.resumeTask) continue;
      try {
        await this.deps.resumeTask(req.taskId, { ...(who ? { by: who } : {}), message: takeoverCompletedMessage(req, who) });
      } catch (err) {
        this.deps.log?.("warn", `Computer "${id}": task ${req.taskId} could not be resumed after the takeover: ${(err as Error).message}`);
      }
    }
    return this.store.get(id);
  }

  /** An agent's request (as `agent`, on a computer it may use): recorded, announced, the person notified. */
  async request(agent: AgentConfig, computerId: string, ask: ComputerTakeoverAsk, origin: { taskId?: string; runId?: string; sessionId?: string; missionId?: string } = {}): Promise<ComputerTakeoverRequest> {
    const c = this.computer(computerId);
    if (!computerUsers(c.id, [agent]).length) throw new ComputerControlError(`Agent "${agent.name}" does not use computer "${c.id}"`, "INVALID");
    const r = await this.store.open({
      computerId: c.id, agent: agent.name, reason: ask.reason,
      ...(ask.url ? { url: ask.url } : {}), ...(ask.whatToDo ? { whatToDo: ask.whatToDo } : {}),
      ...(ask.timeoutMinutes !== undefined ? { timeoutMinutes: ask.timeoutMinutes } : {}),
      ...(ask.level ? { level: ask.level } : {}),
      ...(origin.taskId ? { taskId: origin.taskId } : {}), ...(origin.runId ? { runId: origin.runId } : {}), ...(origin.sessionId ? { sessionId: origin.sessionId } : {}),
    });
    const control = this.store.get(c.id);
    this.announce({
      id: c.id, action: "requested", requestId: r.id, agent: agent.name, reason: r.reason, ...(r.url ? { url: r.url } : {}),
      ...(r.taskId ? { taskId: r.taskId } : {}), ...(r.sessionId ? { sessionId: r.sessionId } : {}),
      level: r.level ?? "soft", expiresAt: r.expiresAt,
    }, control);
    this.desktopStarting = this.startDesktop(c);
    void this.notify(agent, c, r, origin).catch((err) => this.deps.log?.("warn", `Computer "${c.id}": the takeover request could not be notified: ${(err as Error).message}`));
    return r;
  }

  /** The last automatic start of a live view (tests wait on it). */
  desktopStarting: Promise<void> = Promise.resolve();

  /** The live view, ready when the person opens the computer (in the background: the agent waits anyway). */
  private async startDesktop(c: ComputerConfig): Promise<void> {
    if (!this.deps.startDesktop) return;
    try {
      await this.deps.startDesktop(c);
      this.announce({ id: c.id, action: "desktop-started" }, this.store.get(c.id));
    } catch (err) {
      this.deps.log?.("warn", `Computer "${c.id}": its live view could not be started for the takeover request: ${(err as Error).message}`);
    }
  }

  /**
   * The agent stopped waiting. A parked request is left open (its run was stopped by the pause),
   * unless `parked`: its task was resumed or stopped by someone, so nobody waits for it any more.
   */
  async close(requestId: string, status: "timeout" | "cancelled", o: { parked?: boolean } = {}): Promise<ComputerTakeoverRequest | undefined> {
    const before = this.store.request(requestId);
    const r = await this.store.close(requestId, status, o);
    if (r && before && (before.status === "pending" || before.status === "in_control") && r.status === status) {
      this.announce({ id: r.computerId, action: status, requestId: r.id, agent: r.agent, ...(r.taskId ? { taskId: r.taskId } : {}), ...(r.level ? { level: r.level } : {}) }, this.store.get(r.computerId));
    }
    return r;
  }

  /**
   * A hard request's wait ended and nobody took over: the request stays open and its task is paused
   * ("waiting for takeover"); the person is told again. Returns the parked request (undefined when
   * it was not open any more, or not a hard request of a task).
   */
  async park(requestId: string): Promise<ComputerTakeoverRequest | undefined> {
    const before = this.store.request(requestId);
    if (!before || before.level !== "hard" || !before.taskId) return undefined;
    const r = await this.store.park(requestId);
    if (!r?.parkedAt) return undefined;
    this.announce({ id: r.computerId, action: "parked", requestId: r.id, agent: r.agent, reason: r.reason, taskId: r.taskId!, level: "hard" }, this.store.get(r.computerId));
    if (this.deps.pauseTask) {
      try {
        await this.deps.pauseTask(r.taskId!, { reason: TAKEOVER_PAUSE_REASON, by: r.agent, takeover: { requestId: r.id, computerId: r.computerId } });
      } catch (err) {
        this.deps.log?.("warn", `Computer "${r.computerId}": task ${r.taskId} could not be paused for its takeover: ${(err as Error).message}`);
      }
    }
    const c = this.deps.computers().find((x) => x.id === r.computerId);
    if (c) {
      const agent = (await this.deps.agent?.(r.agent).catch(() => undefined)) ?? { name: r.agent };
      void this.notify(agent, c, r, { taskId: r.taskId! }, "parked").catch((err) => this.deps.log?.("warn", `Computer "${c.id}": the paused task could not be notified: ${(err as Error).message}`));
    }
    return r;
  }

  /** The tool's access for a run of `agent` on `computerId` in this process (chats, agent tests). */
  accessFor(agent: AgentConfig, computerId: string, origin: { taskId?: string; runId?: string; sessionId?: string; missionId?: string } = {}): ComputerTakeoverAccess {
    return {
      request: (ask) => this.request(agent, computerId, ask, origin),
      get: (id) => this.store.request(id),
      close: (id, status) => this.close(id, status),
      // a chat has no task to pause: its hard requests end like soft ones
      ...(origin.taskId ? { park: (id: string) => this.park(id) } : {}),
    };
  }

  /** The person hears about it: the agent's own channels, else the instance's router. */
  private async notify(agent: Pick<AgentConfig, "name" | "identity" | "notifyChannels" | "allowedTools">, c: ComputerConfig, r: ComputerTakeoverRequest, origin: { taskId?: string; runId?: string; sessionId?: string; missionId?: string }, phase: "requested" | "parked" = "requested"): Promise<void> {
    const name = agent.identity?.displayName || agent.name;
    const hard = r.level === "hard";
    const title = phase === "parked"
      ? `${name}'s task is paused: it needs you on computer ${c.name || c.id}`
      : `${name} needs you on computer ${c.name || c.id}${hard ? " (blocking)" : ""}`;
    const link = this.deps.pageUrl?.(c.id);
    const wait = phase === "parked"
      ? `Nobody took over in time, so ${name}'s task is paused until you do: completing the takeover resumes it.`
      : hard
        ? `Blocking: ${name} cannot go on without it. If nobody takes over by ${r.expiresAt}, the task pauses until you do.`
        : `Optional: ${name} waits until ${r.expiresAt}, then goes on without it.`;
    const body = [
      r.reason,
      r.url ? `Page: ${r.url}` : "",
      r.whatToDo ? `What to do: ${r.whatToDo}` : "",
      wait,
      `Open ${link ?? `Computers → ${c.name || c.id}`}, click Take control, do it in the live view, then Give back (with a note if useful). `
        + "Never send passwords or codes in a message: type them in the live view.",
    ].filter(Boolean).join("\n");
    const notifier = this.deps.notifier?.();
    const router = this.deps.router?.();
    if (notifier && agentHasNotifyTool(agent as AgentConfig)) {
      const allow = agent.notifyChannels!;
      const channels = allow === "*" ? (router?.getChannelIds() ?? []).slice(0, 1) : allow.map((e) => e.channel);
      let sent = 0;
      for (const channel of channels) {
        try {
          await notifier.send(agent as AgentConfig, { channel, title, body, severity: hard ? "critical" : "warning" }, { ...origin });
          sent++;
        } catch (err) {
          this.deps.log?.("warn", `Computer "${c.id}": notifying on "${channel}" failed: ${(err as Error).message}`);
        }
      }
      if (sent) return;
    }
    if (!router) return;
    // the instance's rules on computer:takeover dispatch the event themselves
    const ruled = (router.getRules?.() ?? []).some((rule) => rule.enabled !== false && rule.events.some((p) => matches(p, "computer:takeover")));
    if (ruled) return;
    for (const channel of router.getChannelIds().slice(0, FALLBACK_CHANNELS)) {
      await router.sendDirect({ channel, title, body, severity: hard ? "critical" : "warning", ruleName: "computer-takeover" })
        .catch((err) => this.deps.log?.("warn", `Computer "${c.id}": notifying on "${channel}" failed: ${(err as Error).message}`));
    }
  }
}

const services = new Map<string, ComputerTakeoverService>();

/** The server's takeover service for a .polpo directory (none in a task runner). */
export function registerComputerTakeover(polpoDir: string, service: ComputerTakeoverService): () => void {
  services.set(polpoDir, service);
  return () => { if (services.get(polpoDir) === service) services.delete(polpoDir); };
}

export function computerTakeoverFor(polpoDir: string | undefined): ComputerTakeoverService | undefined {
  return polpoDir ? services.get(polpoDir) : undefined;
}

// ── Task runs: over the notification socket ─────────────────────────

export interface ComputerTakeoverWireRequest {
  type: "computer_takeover";
  /** park: a hard request's wait ended with nobody done (its task pauses, the request stays open). */
  op: "request" | "close" | "park";
  runId: string;
  computerId?: string;
  reason?: string;
  url?: string;
  whatToDo?: string;
  timeoutMinutes?: number;
  level?: TakeoverLevel;
  requestId?: string;
  status?: "timeout" | "cancelled";
}

export type ComputerTakeoverWireReply = { ok: true; request?: ComputerTakeoverRequest } | { ok: false; error: string };

const WIRE_TIMEOUT_MS = 60_000;

/** Runner side: the tool's access over the socket; waiting reads the shared control file. */
export function socketComputerTakeover(socketPath: string, runId: string, computerId: string, store: Pick<ComputerControlStore, "request">): ComputerTakeoverAccess {
  return {
    request: async (ask) => {
      const reply = await requestOverSocket(socketPath, {
        type: "computer_takeover", op: "request", runId, computerId, reason: ask.reason,
        ...(ask.url ? { url: ask.url } : {}), ...(ask.whatToDo ? { whatToDo: ask.whatToDo } : {}),
        ...(ask.timeoutMinutes !== undefined ? { timeoutMinutes: ask.timeoutMinutes } : {}),
        ...(ask.level ? { level: ask.level } : {}),
      }, WIRE_TIMEOUT_MS);
      if (!reply.ok) throw new Error(reply.error);
      if (!reply.request) throw new Error("Polpo did not record the request");
      return reply.request;
    },
    park: async (id) => {
      const reply = await requestOverSocket(socketPath, { type: "computer_takeover", op: "park", runId, requestId: id }, WIRE_TIMEOUT_MS);
      if (!reply.ok) throw new Error(reply.error);
      return reply.request;
    },
    get: (id) => store.request(id),
    close: async (id, status) => {
      const reply = await requestOverSocket(socketPath, { type: "computer_takeover", op: "close", runId, requestId: id, status }, WIRE_TIMEOUT_MS);
      if (!reply.ok) throw new Error(reply.error);
    },
  };
}

/** Server side: one request of a task run, as the run's agent. */
export async function handleTakeoverWire(
  msg: ComputerTakeoverWireRequest,
  deps: {
    service: ComputerTakeoverService | undefined;
    run(runId: string): Promise<Pick<RunRecord, "agentName" | "taskId" | "status" | "config"> | undefined>;
    task(taskId: string): Promise<Task | undefined>;
    agentFor(run: Pick<RunRecord, "agentName" | "config">, task: Task | undefined): Promise<AgentConfig | undefined>;
  },
): Promise<ComputerTakeoverWireReply> {
  if (!deps.service) return { ok: false, error: "Take control is not available on this server" };
  const run = typeof msg.runId === "string" ? await deps.run(msg.runId) : undefined;
  if (!run || run.status !== "running") return { ok: false, error: "this run is not running" };
  try {
    if (msg.op === "close" || msg.op === "park") {
      const r = typeof msg.requestId === "string" ? deps.service.store.request(msg.requestId) : undefined;
      if (!r || r.runId !== msg.runId) return { ok: false, error: "no such request of this run" };
      if (msg.op === "park") {
        const parked = await deps.service.park(r.id);
        return parked ? { ok: true, request: parked } : { ok: false, error: "the request is not open, or not a blocking request of a task" };
      }
      return { ok: true, request: await deps.service.close(r.id, msg.status === "timeout" ? "timeout" : "cancelled") };
    }
    const task = await deps.task(run.taskId).catch(() => undefined);
    const agent = await deps.agentFor(run, task);
    if (!agent || agent.name !== run.agentName) return { ok: false, error: `agent "${run.agentName}" not found` };
    const request = await deps.service.request(agent, String(msg.computerId ?? ""), {
      reason: String(msg.reason ?? ""),
      ...(typeof msg.url === "string" ? { url: msg.url } : {}),
      ...(typeof msg.whatToDo === "string" ? { whatToDo: msg.whatToDo } : {}),
      ...(typeof msg.timeoutMinutes === "number" ? { timeoutMinutes: msg.timeoutMinutes } : {}),
      ...(msg.level === "hard" || msg.level === "soft" ? { level: msg.level } : {}),
    }, { taskId: run.taskId, runId: msg.runId, ...(task?.missionId ? { missionId: task.missionId } : {}) });
    return { ok: true, request };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
