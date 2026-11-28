/**
 * The agents' `request_computer_takeover` tool: ask a person to take control of the computer's
 * desktop for something only they can do (a login with their password, a 2FA code, a CAPTCHA),
 * then wait until they give it back.
 *
 * Offered to agents running on a remote computer whose browser is headed (the default there with
 * browser tools, or agent.browserHeaded: true: the person sees the window) or that have the tool in
 * allowedTools. The request is recorded on the
 * computer (its page shows a banner, REST/MCP list it) and the person is notified; the tool then
 * waits (polling the control state, abortable by the run) until the person took control and gave
 * it back, or the wait ends (timeout_minutes). The result is the person's note, never what they
 * typed: they type in the live view (VNC), not in Polpo. Every engine gets it (Polpo's; harnesses
 * and CLIs as a host tool).
 *
 * The agent picks a level: soft (default: optional help, 30 min) — when nobody took over the agent
 * goes on without it and says what it could not do; hard (blocking: CAPTCHA, phone or app
 * verification, a login wall, 15 min) — in a task, when nobody took over the request is parked: the
 * task is paused ("waiting for takeover"), the request stays open, and completing the takeover
 * resumes the task (its agent continues, told what happened). While it waits the tool reports
 * progress, so the run is not taken for stale.
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { allowedToolsInclude, isRemoteComputer, type AgentConfig, type ComputerConfig } from "@polpo-ai/core";
import {
  TAKEOVER_DEFAULT_MINUTES, TAKEOVER_HARD_DEFAULT_MINUTES, TAKEOVER_MAX_MINUTES, type ComputerTakeoverRequest, type TakeoverLevel,
} from "../sandbox/computer-control.js";

export const COMPUTER_TAKEOVER_TOOL = "request_computer_takeover";
export const COMPUTER_TAKEOVER_TOOL_NAMES = [COMPUTER_TAKEOVER_TOOL] as const;

/** What the agent asks for. */
export interface ComputerTakeoverAsk {
  reason: string;
  url?: string;
  whatToDo?: string;
  timeoutMinutes?: number;
  /** soft (default) or hard (blocking). */
  level?: TakeoverLevel;
}

/**
 * How a run asks: in the server process (chats) directly, from a task run over the notification
 * socket (the server records it as the run's agent and notifies); both read the state from the
 * shared control file while waiting.
 */
export interface ComputerTakeoverAccess {
  request(ask: ComputerTakeoverAsk): Promise<ComputerTakeoverRequest>;
  get(requestId: string): ComputerTakeoverRequest | undefined | Promise<ComputerTakeoverRequest | undefined>;
  /** The agent stops waiting (timeout, or its run was stopped). */
  close(requestId: string, status: "timeout" | "cancelled"): Promise<unknown>;
  /**
   * A hard request's wait ended with nobody done (task runs only): the request stays open and the
   * task is paused. Returns the parked request (undefined: it could not be parked).
   */
  park?(requestId: string): Promise<ComputerTakeoverRequest | undefined>;
}

/** Whether the run's agent gets the tool on this computer. */
export function wantsComputerTakeoverTool(agent: Pick<AgentConfig, "browserHeaded" | "allowedTools">, computer: ComputerConfig | undefined): boolean {
  if (!computer || !isRemoteComputer(computer)) return false;
  if (allowedToolsInclude(agent.allowedTools, COMPUTER_TAKEOVER_TOOL) || agent.browserHeaded === true) return true;
  // headed by default on a remote computer: an agent with a browser gets it unless browserHeaded is false
  return agent.browserHeaded !== false && allowedToolsInclude(agent.allowedTools, "browser_navigate");
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); }
  signal?.addEventListener("abort", done, { once: true });
});

type Params = { reason: string; url?: string; what_to_do?: string; timeout_minutes?: number; level?: TakeoverLevel };

/** How often the waiting tool reports progress (keeps the run from being taken for stale). */
const HEARTBEAT_MS = 60_000;

/**
 * Wait for the request to end: released (the person's note), timeout, cancelled, or the run
 * stopped (the request is closed as cancelled). With `keepOpenOnTimeout` (a hard request that will
 * be parked) the request is not closed when the wait ends. `onWaiting` is called every
 * `heartbeatMs` while waiting. Exported for tests.
 */
export async function waitForTakeover(
  access: Pick<ComputerTakeoverAccess, "get" | "close">, r: ComputerTakeoverRequest,
  o: { signal?: AbortSignal; pollMs?: number; now?: () => number; keepOpenOnTimeout?: boolean; onWaiting?: (cur: ComputerTakeoverRequest) => void; heartbeatMs?: number } = {},
): Promise<{ outcome: "released" | "timeout" | "cancelled" | "aborted"; request: ComputerTakeoverRequest }> {
  const now = o.now ?? Date.now;
  const until = Date.parse(r.expiresAt);
  let cur = r;
  let beat = now();
  for (;;) {
    if (o.signal?.aborted) {
      await access.close(r.id, "cancelled").catch(() => undefined);
      return { outcome: "aborted", request: cur };
    }
    const next = await Promise.resolve(access.get(r.id)).catch(() => undefined);
    if (next) cur = next;
    if (cur.status === "released") return { outcome: "released", request: cur };
    if (cur.status === "cancelled") return { outcome: "cancelled", request: cur };
    if (cur.status === "timeout" || now() >= until) {
      if (o.keepOpenOnTimeout && cur.status !== "timeout") return { outcome: "timeout", request: cur };
      await access.close(r.id, "timeout").catch(() => undefined);
      return { outcome: "timeout", request: { ...cur, status: "timeout" } };
    }
    if (o.onWaiting && now() - beat >= (o.heartbeatMs ?? HEARTBEAT_MS)) {
      beat = now();
      try { o.onWaiting(cur); } catch { /* progress is informational */ }
    }
    await sleep(o.pollMs ?? 2000, o.signal);
  }
}

/** What the agent is told when nobody took over, per level (and whether its task was paused). */
export function takeoverTimeoutText(r: Pick<ComputerTakeoverRequest, "reason" | "expiresAt" | "status" | "takenBy">, level: TakeoverLevel, parked: boolean): string {
  const nobody = `Nobody ${r.status === "in_control" || r.takenBy ? "gave control back" : "took control"} within the wait (until ${r.expiresAt}).`;
  if (level === "soft") {
    return `${nobody} The request is closed. It was optional help: go on and finish the task with what you can do without it. `
      + `In your final result, say clearly what you could not do because nobody took over ("${r.reason}"), so a person can do it later.`;
  }
  if (parked) {
    return `${nobody} This step is blocking, so your task is now PAUSED ("waiting for takeover") and the request stays open for the person. `
      + "Stop here: do not call any more tools and do not finish or summarise the task. When the person completes the takeover (or someone resumes "
      + "the task), you continue from this point and are told what happened.";
  }
  return `${nobody} The request is closed. This step was blocking and nobody did it: do not pretend it was done. `
    + `Stop and report clearly what is blocked ("${r.reason}") and what a person has to do, then ask again later if useful.`;
}

/** The tool, when the agent gets it here and there is a way to ask. */
export function createComputerTakeoverTools(
  agent: Pick<AgentConfig, "name" | "browserHeaded" | "allowedTools">, computer: ComputerConfig | undefined, access: ComputerTakeoverAccess | undefined,
  o: { pollMs?: number; now?: () => number } = {},
): AgentTool<any>[] {
  if (!access || !computer || !wantsComputerTakeoverTool(agent, computer)) return [];
  const where = computer.name ? `"${computer.name}" (${computer.id})` : `"${computer.id}"`;
  const tool: AgentTool<any> = {
    name: COMPUTER_TAKEOVER_TOOL,
    label: "Request Computer Takeover",
    description: `Ask a person to take control of your computer ${where}'s desktop and do something only they can: sign in with their password, enter a 2FA code, solve a CAPTCHA, `
      + "approve a consent. Never ask for passwords or codes in chat: use this. The person watches the desktop live, clicks Take control, does it in your browser window and gives "
      + "control back with an optional note; you never see what they type. This call waits until then (or the timeout) and returns their note. While a person has control, "
      + "your browser tools wait. Afterwards look at the page again (browser_snapshot) and continue. "
      + `Choose the level: "hard" when you cannot go on without it — a CAPTCHA, a phone or app verification (SMS, email or authenticator code, approve on phone), a login `
      + `or sign-up wall: if nobody takes over in time your task is paused (not failed) until a person does it, then you continue from here (default wait ${TAKEOVER_HARD_DEFAULT_MINUTES} min). `
      + `"soft" (default) for optional help you can do without: if nobody takes over in time you go on and finish, saying what you could not do (default wait ${TAKEOVER_DEFAULT_MINUTES} min).`,
    parameters: Type.Object({
      reason: Type.String({ minLength: 1, maxLength: 2000, description: "Why, for the person: e.g. \"LinkedIn asks for a sign-in with 2FA\"" }),
      level: Type.Optional(Type.Union([Type.Literal("soft"), Type.Literal("hard")], {
        description: "hard: blocking (CAPTCHA, phone/app verification, login or sign-up wall): your task pauses until a person does it. soft (default): optional help, you go on without it",
      })),
      url: Type.Optional(Type.String({ maxLength: 2048, description: "The page your browser is on" })),
      what_to_do: Type.Optional(Type.String({ maxLength: 2000, description: "What the person should do before giving control back: e.g. \"Sign in as the company account and stop at the feed\"" })),
      timeout_minutes: Type.Optional(Type.Number({ minimum: 1, maximum: TAKEOVER_MAX_MINUTES, description: `How long to wait for the person (default ${TAKEOVER_HARD_DEFAULT_MINUTES} for hard, ${TAKEOVER_DEFAULT_MINUTES} for soft)` })),
    }),
    async execute(_id: string, params: Params, signal?: AbortSignal, onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }) => void) {
      const fail = (text: string) => ({ content: [{ type: "text" as const, text: `Error: ${text}` }], details: { error: true } });
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";
      if (!reason) return fail("Say why a person should take over (reason)");
      const level: TakeoverLevel = params.level === "hard" ? "hard" : "soft";
      let r: ComputerTakeoverRequest;
      try {
        r = await access.request({
          reason, level,
          ...(typeof params.url === "string" && params.url.trim() ? { url: params.url.trim() } : {}),
          ...(typeof params.what_to_do === "string" && params.what_to_do.trim() ? { whatToDo: params.what_to_do.trim() } : {}),
          ...(typeof params.timeout_minutes === "number" && Number.isFinite(params.timeout_minutes) ? { timeoutMinutes: params.timeout_minutes } : {}),
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      // a hard request of a task is parked when the wait ends (its task pauses): not closed
      const parkable = level === "hard" && !!access.park;
      const end = await waitForTakeover(access, r, {
        ...(signal ? { signal } : {}), ...(o.pollMs ? { pollMs: o.pollMs } : {}), ...(o.now ? { now: o.now } : {}),
        keepOpenOnTimeout: parkable,
        // progress while waiting: the run stays alive (not stale) for as long as the person may take
        ...(onUpdate ? { onWaiting: (cur: ComputerTakeoverRequest) => onUpdate({
          content: [{ type: "text", text: `Still waiting for a person (${cur.status === "in_control" ? `${cur.takenBy ?? "someone"} has control` : "nobody has taken control yet"}; until ${r.expiresAt})` }],
          details: { requestId: r.id, status: cur.status, level },
        }) } : {}),
      });
      let req = end.request;
      let outcome: string = end.outcome;
      if (end.outcome === "timeout" && parkable) {
        const parked = await access.park!(r.id).catch(() => undefined);
        if (parked?.parkedAt) {
          req = parked;
          outcome = "parked";
        } else {
          // could not park: the request ends as for a soft one, the agent told it was blocking
          await access.close(r.id, "timeout").catch(() => undefined);
        }
      }
      const details = { requestId: r.id, computerId: computer.id, level, outcome, ...(req.takenBy ? { by: req.takenBy } : {}), ...(req.note ? { note: req.note } : {}) };
      const text = outcome === "released"
        ? `${req.takenBy ?? "A person"} took control of the computer and gave it back.${req.note ? ` Their note: ${req.note}` : " They left no note."} `
          + "Look at the page again (browser_snapshot) before going on: it may have changed."
        : outcome === "parked" || outcome === "timeout"
          ? takeoverTimeoutText({ ...req, expiresAt: r.expiresAt }, level, outcome === "parked")
          : outcome === "cancelled"
            ? "The request was cancelled before a person handled it."
            : "Stopped while waiting for a person.";
      return { content: [{ type: "text" as const, text }], details };
    },
  };
  return [tool];
}
