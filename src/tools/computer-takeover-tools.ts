/**
 * The agents' `request_computer_takeover` tool: ask a person to take control of the computer's
 * desktop for something only they can do (a login with their password, a 2FA code, a CAPTCHA),
 * then wait until they give it back.
 *
 * Offered to agents running on a remote computer whose browser is headed (agent.browserHeaded:
 * the person sees the window) or that have the tool in allowedTools. The request is recorded on the
 * computer (its page shows a banner, REST/MCP list it) and the person is notified; the tool then
 * waits (polling the control state, abortable by the run) until the person took control and gave
 * it back, or the wait ends (timeout_minutes, default 30). The result is the person's note, never
 * what they typed: they type in the live view (VNC), not in Polpo. Every engine gets it (Polpo's;
 * harnesses and CLIs as a host tool).
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { allowedToolsInclude, isRemoteComputer, type AgentConfig, type ComputerConfig } from "@polpo-ai/core";
import { TAKEOVER_DEFAULT_MINUTES, TAKEOVER_MAX_MINUTES, type ComputerTakeoverRequest } from "../sandbox/computer-control.js";

export const COMPUTER_TAKEOVER_TOOL = "request_computer_takeover";
export const COMPUTER_TAKEOVER_TOOL_NAMES = [COMPUTER_TAKEOVER_TOOL] as const;

/** What the agent asks for. */
export interface ComputerTakeoverAsk {
  reason: string;
  url?: string;
  whatToDo?: string;
  timeoutMinutes?: number;
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
}

/** Whether the run's agent gets the tool on this computer. */
export function wantsComputerTakeoverTool(agent: Pick<AgentConfig, "browserHeaded" | "allowedTools">, computer: ComputerConfig | undefined): boolean {
  if (!computer || !isRemoteComputer(computer)) return false;
  return agent.browserHeaded === true || allowedToolsInclude(agent.allowedTools, COMPUTER_TAKEOVER_TOOL);
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); }
  signal?.addEventListener("abort", done, { once: true });
});

type Params = { reason: string; url?: string; what_to_do?: string; timeout_minutes?: number };

/**
 * Wait for the request to end: released (the person's note), timeout, cancelled, or the run
 * stopped (the request is closed as cancelled). Exported for tests.
 */
export async function waitForTakeover(
  access: Pick<ComputerTakeoverAccess, "get" | "close">, r: ComputerTakeoverRequest,
  o: { signal?: AbortSignal; pollMs?: number; now?: () => number } = {},
): Promise<{ outcome: "released" | "timeout" | "cancelled" | "aborted"; request: ComputerTakeoverRequest }> {
  const now = o.now ?? Date.now;
  const until = Date.parse(r.expiresAt);
  let cur = r;
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
      await access.close(r.id, "timeout").catch(() => undefined);
      return { outcome: "timeout", request: { ...cur, status: "timeout" } };
    }
    await sleep(o.pollMs ?? 2000, o.signal);
  }
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
      + "your browser tools wait. Afterwards look at the page again (browser_snapshot) and continue.",
    parameters: Type.Object({
      reason: Type.String({ minLength: 1, maxLength: 2000, description: "Why, for the person: e.g. \"LinkedIn asks for a sign-in with 2FA\"" }),
      url: Type.Optional(Type.String({ maxLength: 2048, description: "The page your browser is on" })),
      what_to_do: Type.Optional(Type.String({ maxLength: 2000, description: "What the person should do before giving control back: e.g. \"Sign in as the company account and stop at the feed\"" })),
      timeout_minutes: Type.Optional(Type.Number({ minimum: 1, maximum: TAKEOVER_MAX_MINUTES, description: `How long to wait for the person (default ${TAKEOVER_DEFAULT_MINUTES})` })),
    }),
    async execute(_id: string, params: Params, signal?: AbortSignal) {
      const fail = (text: string) => ({ content: [{ type: "text" as const, text: `Error: ${text}` }], details: { error: true } });
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";
      if (!reason) return fail("Say why a person should take over (reason)");
      let r: ComputerTakeoverRequest;
      try {
        r = await access.request({
          reason,
          ...(typeof params.url === "string" && params.url.trim() ? { url: params.url.trim() } : {}),
          ...(typeof params.what_to_do === "string" && params.what_to_do.trim() ? { whatToDo: params.what_to_do.trim() } : {}),
          ...(typeof params.timeout_minutes === "number" && Number.isFinite(params.timeout_minutes) ? { timeoutMinutes: params.timeout_minutes } : {}),
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      const end = await waitForTakeover(access, r, { ...(signal ? { signal } : {}), ...(o.pollMs ? { pollMs: o.pollMs } : {}), ...(o.now ? { now: o.now } : {}) });
      const req = end.request;
      const details = { requestId: r.id, computerId: computer.id, outcome: end.outcome, ...(req.takenBy ? { by: req.takenBy } : {}), ...(req.note ? { note: req.note } : {}) };
      const text = end.outcome === "released"
        ? `${req.takenBy ?? "A person"} took control of the computer and gave it back.${req.note ? ` Their note: ${req.note}` : " They left no note."} `
          + "Look at the page again (browser_snapshot) before going on: it may have changed."
        : end.outcome === "timeout"
          ? `Nobody ${req.status === "in_control" || req.takenBy ? "gave control back" : "took control"} within the wait (until ${r.expiresAt}). The request is closed: `
            + "go on without it, or ask again later (tell whoever you report to what is blocked)."
          : end.outcome === "cancelled"
            ? "The request was cancelled before a person handled it."
            : "Stopped while waiting for a person.";
      return { content: [{ type: "text" as const, text }], details };
    },
  };
  return [tool];
}
