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
      this.announce({ id, action: "released", ...(who ? { person: who } : {}), requestId: req.id, agent: req.agent, ...(req.note ? { note: req.note } : {}), ...(req.taskId ? { taskId: req.taskId } : {}) }, r.control);
    }
    if (!r.requests.length) this.announce({ id, action: "released", ...(who ? { person: who } : {}), ...(r.control.lastNote ? { note: r.control.lastNote } : {}) }, r.control);
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
      ...(origin.taskId ? { taskId: origin.taskId } : {}), ...(origin.runId ? { runId: origin.runId } : {}), ...(origin.sessionId ? { sessionId: origin.sessionId } : {}),
    });
    const control = this.store.get(c.id);
    this.announce({
      id: c.id, action: "requested", requestId: r.id, agent: agent.name, reason: r.reason, ...(r.url ? { url: r.url } : {}),
      ...(r.taskId ? { taskId: r.taskId } : {}), ...(r.sessionId ? { sessionId: r.sessionId } : {}),
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

  /** The agent stopped waiting. */
  async close(requestId: string, status: "timeout" | "cancelled"): Promise<ComputerTakeoverRequest | undefined> {
    const before = this.store.request(requestId);
    const r = await this.store.close(requestId, status);
    if (r && before && (before.status === "pending" || before.status === "in_control")) {
      this.announce({ id: r.computerId, action: status, requestId: r.id, agent: r.agent, ...(r.taskId ? { taskId: r.taskId } : {}) }, this.store.get(r.computerId));
    }
    return r;
  }

  /** The tool's access for a run of `agent` on `computerId` in this process (chats, agent tests). */
  accessFor(agent: AgentConfig, computerId: string, origin: { taskId?: string; runId?: string; sessionId?: string; missionId?: string } = {}): ComputerTakeoverAccess {
    return {
      request: (ask) => this.request(agent, computerId, ask, origin),
      get: (id) => this.store.request(id),
      close: (id, status) => this.close(id, status),
    };
  }

  /** The person hears about it: the agent's own channels, else the instance's router. */
  private async notify(agent: AgentConfig, c: ComputerConfig, r: ComputerTakeoverRequest, origin: { taskId?: string; runId?: string; sessionId?: string; missionId?: string }): Promise<void> {
    const name = agent.identity?.displayName || agent.name;
    const title = `${name} needs you on computer ${c.name || c.id}`;
    const link = this.deps.pageUrl?.(c.id);
    const body = [
      r.reason,
      r.url ? `Page: ${r.url}` : "",
      r.whatToDo ? `What to do: ${r.whatToDo}` : "",
      `Open ${link ?? `Computers → ${c.name || c.id}`}, click Take control, do it in the live view, then Give back (with a note if useful). `
        + `${name} waits until ${r.expiresAt}. Never send passwords or codes in a message: type them in the live view.`,
    ].filter(Boolean).join("\n");
    const notifier = this.deps.notifier?.();
    const router = this.deps.router?.();
    if (notifier && agentHasNotifyTool(agent)) {
      const allow = agent.notifyChannels!;
      const channels = allow === "*" ? (router?.getChannelIds() ?? []).slice(0, 1) : allow.map((e) => e.channel);
      let sent = 0;
      for (const channel of channels) {
        try {
          await notifier.send(agent, { channel, title, body, severity: "warning" }, { ...origin });
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
      await router.sendDirect({ channel, title, body, severity: "warning", ruleName: "computer-takeover" })
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
  op: "request" | "close";
  runId: string;
  computerId?: string;
  reason?: string;
  url?: string;
  whatToDo?: string;
  timeoutMinutes?: number;
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
      }, WIRE_TIMEOUT_MS);
      if (!reply.ok) throw new Error(reply.error);
      if (!reply.request) throw new Error("Polpo did not record the request");
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
    if (msg.op === "close") {
      const r = typeof msg.requestId === "string" ? deps.service.store.request(msg.requestId) : undefined;
      if (!r || r.runId !== msg.runId) return { ok: false, error: "no such request of this run" };
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
    }, { taskId: run.taskId, runId: msg.runId, ...(task?.missionId ? { missionId: task.missionId } : {}) });
    return { ok: true, request };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
