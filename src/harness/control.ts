/**
 * Harness sessions as people and Polpo see and control them (REST, MCP, dashboard): the status
 * records, whether each is live (held by a process now), and stop / reset.
 *
 * - stop: the runtime stops (its bridge process exits); the conversation stays resumable (the next
 *   turn starts a new bridge that resumes it).
 * - reset: stop, then forget the session (resume state and status): the next run starts a new
 *   conversation.
 * A session a task run holds right now is not stopped from here: kill the task instead.
 */
import { harnessesSettingsOf, isRemoteComputer, parseComputers, type PolpoSettings, type VaultStore } from "@polpo-ai/core";
import { liveHarnessSessions } from "./live-sessions.js";
import { HarnessSessionStore, processAlive, type HarnessSessionStatus } from "./session-store.js";
import { readVaultCodexAuth } from "./codex-chatgpt.js";

/** Codex's ChatGPT sign-in as people see it: signed in or not, and when it was last refreshed (never the content). */
export async function codexChatgptStatus(vault: VaultStore | undefined, ref: { owner: string; service: string }): Promise<{ signedIn: boolean; lastRefresh?: string }> {
  const f = await readVaultCodexAuth(vault, ref).catch(() => undefined);
  return { signedIn: !!f, ...(f?.freshness ? { lastRefresh: new Date(f.freshness).toISOString() } : {}) };
}

export interface HarnessSessionView extends HarnessSessionStatus {
  /** Held by a process right now (this server or a task runner). */
  live: boolean;
  /** Held by this server process (a chat). */
  liveHere: boolean;
}

export function harnessSessionViews(polpoDir: string, filter: { agent?: string; computer?: string; key?: string } = {}): HarnessSessionView[] {
  const store = new HarnessSessionStore(polpoDir);
  const here = new Set(liveHarnessSessions.list().map((s) => s.key));
  return store.list()
    .filter((s) => (!filter.agent || s.agent === filter.agent) && (!filter.computer || s.computerId === filter.computer) && (!filter.key || s.key === filter.key))
    .map((s) => ({ ...s, liveHere: here.has(s.key), live: here.has(s.key) || (!!s.pid && processAlive(s.pid)) }));
}

/**
 * A shell command that ends a parked session's bridge in the VM: the process with its
 * BRIDGE_WS_PORT and, when the session id is known, that session's id on its command line (its
 * bridge state directory) — a stopped session's port may belong to another run's live bridge by
 * now. A bridge started in its own process group (sandbox-session.ts) ends with its group (the
 * runtime and its commands); any other process is never signalled.
 */
export function killBridgeCommand(port: number, sessionId?: string): string {
  const id = sessionId && /^[A-Za-z0-9_-]+$/.test(sessionId) ? sessionId : undefined;
  const ofSession = id ? ` && tr '\\0' ' ' < "$p/cmdline" 2>/dev/null | grep -qF -- '${id}'` : "";
  return `for p in /proc/[0-9]*; do tr '\\0' '\\n' < "$p/environ" 2>/dev/null | grep -qx 'BRIDGE_WS_PORT=${port}'${ofSession} || continue; `
    + `pid=\${p#/proc/}; g=$(awk '{print $5}' "$p/stat" 2>/dev/null); `
    + `if [ -n "$g" ] && [ "$g" = "$pid" ]; then kill -- "-$g" 2>/dev/null; else kill "$pid" 2>/dev/null; fi; done; true`;
}

export type HarnessControlResult =
  | { ok: true; message: string; session?: HarnessSessionView }
  | { ok: false; status: 404 | 409; error: string };

export async function controlHarnessSession(o: {
  polpoDir: string;
  vault?: VaultStore;
  settings?: PolpoSettings;
  key: string;
  action: "stop" | "reset";
  /** Runs a command on a computer when it is running (never starts it). Tests inject one. */
  onComputer?: (computerId: string, command: string) => Promise<boolean>;
}): Promise<HarnessControlResult> {
  const store = new HarnessSessionStore(o.polpoDir, o.vault);
  const cur = store.get(o.key);
  if (!cur) return { ok: false, status: 404, error: `There is no harness session "${o.key}"` };
  const live = liveHarnessSessions.list().find((s) => s.key === o.key);
  if (!live && cur.pid && cur.pid !== process.pid && processAlive(cur.pid)) {
    return { ok: false, status: 409, error: `Harness session ${o.key} is running in a task run right now: kill the task (polpo_task_kill) to stop it` };
  }
  let note = "";
  if (live) {
    await live.suspend("disk", o.action);
  } else if (cur.bridgePort && cur.computerId !== "host" && o.onComputer) {
    // a parked session: its bridge may still run in the VM (a detached session keeps it alive)
    const ran = await o.onComputer(cur.computerId, killBridgeCommand(cur.bridgePort, cur.sessionId)).catch(() => false);
    note = ran ? " Its bridge in the computer was ended." : " Its computer is not running: nothing runs there.";
  }
  if (o.action === "reset") {
    await store.forgetResumeState(o.key);
    await store.update(o.key, () => null);
    return { ok: true, message: `Reset harness session ${o.key}: its next run starts a new conversation.${note}` };
  }
  const next = await store.update(o.key, (s) => (s ? { ...s, state: "stopped", pid: undefined } : null));
  return {
    ok: true,
    message: `Stopped harness session ${o.key}${cur.resumable ? " (its conversation resumes on the next turn)" : ""}.${note}`,
    ...(next ? { session: { ...next, live: false, liveHere: false } } : {}),
  };
}

/** The harnesses as configured, with whether each credential entry exists (never its value). */
export async function harnessesOverview(settings: PolpoSettings | undefined, vault: VaultStore | undefined, agents: ReadonlyArray<{ name: string; engine?: unknown; defaultComputer?: string }>) {
  const { HARNESS_IDS, HARNESS_NAMES, agentHarness } = await import("@polpo-ai/core");
  const h = harnessesSettingsOf(settings);
  let computers: ReturnType<typeof parseComputers> = [];
  try { computers = parseComputers(settings?.computers); } catch { /* reported where they are edited */ }
  const { harnessCredentialRef } = await import("@polpo-ai/core");
  const exists = async (ref: { owner: string; service: string } | undefined) => (ref ? !!(await vault?.get(ref.owner, ref.service).catch(() => undefined)) : false);
  const items = await Promise.all(HARNESS_IDS.map(async (id) => {
    const s = h?.[id];
    const ref = harnessCredentialRef(s);
    const found = await exists(ref);
    // the gateway as configured: vault references and literal (non-secret) header values only
    const gateway = s?.gateway ? {
      ...s.gateway,
      ...(s.gateway.headers ? { headers: await Promise.all(s.gateway.headers.map(async (x) => ({ ...x, ...(x.credentialRef ? { credentialFound: await exists(x.credentialRef) } : {}) }))) } : {}),
    } : undefined;
    return {
      id, name: HARNESS_NAMES[id], enabled: !!h?.enabled.includes(id),
      ...(s ? { auth: s.auth, ...(ref ? { credentialRef: ref, credentialFound: found } : {}) } : {}),
      // the setting as saved (vault references only, never a secret): what the dashboard edits
      ...(s ? { settings: s } : {}),
      ...(gateway ? { gateway } : {}),
      // Codex signed in with ChatGPT: whether the vault entry holds a login (never its content)
      ...(id === "codex" && s?.auth === "chatgpt" && ref ? { chatgpt: await codexChatgptStatus(vault, ref) } : {}),
      // how the model credential reaches the model at run time (a ChatGPT login is not brokered: it is in the computer)
      ...(s && s.auth !== "chatgpt" ? { brokering: s.auth === "vertex" || (s.auth === "bedrock" && id !== "opencode") ? "not-brokered" as const : process.env.POLPO_PUBLIC_URL?.trim() ? "relay" as const : "in-vm" as const } : {}),
      ...(s?.model ? { model: s.model } : {}),
      ...(id === "claude-code" && h?.["claude-code"]?.bedrock ? { bedrock: h["claude-code"].bedrock } : {}),
      ...(id === "claude-code" && h?.["claude-code"]?.vertex ? { vertex: h["claude-code"].vertex } : {}),
      ...(id === "opencode" && h?.opencode?.bedrock ? { bedrock: h.opencode.bedrock } : {}),
      ...(id === "opencode" && h?.opencode?.provider ? { provider: h.opencode.provider } : {}),
      agents: agents.filter((a) => agentHarness(a)?.harness === id).map((a) => a.name),
    };
  }));
  const publicUrl = process.env.POLPO_PUBLIC_URL?.trim().replace(/\/+$/, "") || undefined;
  return {
    allowHost: !!h?.allowHost,
    harnesses: items,
    /**
     * Polpo's model relay (credential brokering for API keys and gateways): its public URL when
     * POLPO_PUBLIC_URL is set. Without it the model key goes into the computer (a warning).
     */
    relay: publicUrl
      ? { available: true, url: `${publicUrl}/api/v1/harness-relay/`, path: "/api/v1/harness-relay/" }
      : { available: false, path: "/api/v1/harness-relay/", warning: "POLPO_PUBLIC_URL is not set: computers cannot reach Polpo's model relay, so API keys and gateway keys go into the computer's VM. Set POLPO_PUBLIC_URL and expose <public URL>/api/v1/harness-relay/." },
    /** The CLI engine's accounts as saved (config directories, never tokens): kept when the dashboard saves these settings. */
    ...(h?.cli ? { cli: h.cli } : {}),
    /** Computers that can run a harness (Daytona; v2 checked at run time). */
    computers: computers.filter((c) => isRemoteComputer(c) && c.kind === "daytona").map((c) => c.id),
  };
}
