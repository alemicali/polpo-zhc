/**
 * The rest of Configuration → Channels, so a connector can set a channel up end to end: who answers
 * on each channel (routes), Telegram (check a bot, invites, pairings, the allowlist of
 * people who may write) and WhatsApp (sign in with a QR code, wait for it, sign out).
 *
 * In the settings toolset: changes need polpo:admin, and so do the reads that name people (peers,
 * pairings). Secrets (bot tokens…) never pass through: the person enters them in the dashboard.
 */
import QRCode from "qrcode";
import { z } from "zod";
import {
  DESTRUCTIVE, MAX_WAIT_SECONDS, READ, UPDATE, apiError, apiGet, apiSend, confirmParam, dashboardLink, enc, fail, looseObject, ok, orchestratorLabel, progress, qs, sleep,
  type CallToolResult, type McpDeps, type Register,
} from "./kit.js";
import { setupHandoff } from "./setup.js";

type Gateway = Record<string, unknown> & { agent?: string; replyTo?: { channel: string; chatId?: string; echoInbound?: boolean } };
type Channel = Record<string, unknown> & { type?: string; gateway?: Gateway };

async function channelsNow(deps: McpDeps): Promise<{ ok: true; channels: Record<string, Channel> } | { ok: false; res: CallToolResult }> {
  const r = await apiGet(deps, "/config");
  if (!r.ok) return { ok: false, res: apiError(r, "Reading the channels") };
  return { ok: true, channels: ((r.data as { settings?: { notifications?: { channels?: Record<string, Channel> } } })?.settings?.notifications?.channels ?? {}) };
}

/** A channel's route: who answers there and how (no secrets). */
function routeView(name: string, c: Channel): Record<string, unknown> {
  const g = c.gateway ?? {};
  return {
    channel: name, type: c.type ?? "unknown", inbound: g.enableInbound === true, agent: g.agent ?? null,
    ...(g.replyTo ? { reply_to: g.replyTo } : {}),
    ...(g.groupReplies ? { group_replies: g.groupReplies } : {}), ...(g.intentThreshold !== undefined ? { intent_threshold: g.intentThreshold } : {}),
    ...(g.sessionMode ? { session_mode: g.sessionMode } : {}), ...(g.sessionIdleMinutes !== undefined ? { session_idle_minutes: g.sessionIdleMinutes } : {}),
    ...(g.agentSessions ? { agent_sessions: g.agentSessions } : {}),
    ...(g.dmPolicy ? { dm_policy: g.dmPolicy } : {}),
  };
}

type WaSession = { id: string; profileDir: string; status: string; qr?: string; error?: string; expiresAt?: string };

/** A WhatsApp login as a result: the status in text, and the QR code as a PNG to scan when there is one. */
export async function loginResult(s: WaSession, text: string): Promise<CallToolResult> {
  const structured = { session_id: s.id, profile: s.profileDir, status: s.status, ...(s.error ? { error: s.error } : {}), ...(s.expiresAt ? { expires_at: s.expiresAt } : {}), has_qr: !!s.qr };
  const content: CallToolResult["content"] = [{ type: "text", text }];
  if (s.status === "qr" && s.qr) {
    const png = await QRCode.toBuffer(s.qr, { type: "png", margin: 2, width: 320 });
    content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
  }
  return { content, structuredContent: structured };
}

const loginText = (s: WaSession) => s.status === "qr"
  ? `Scan this QR code with WhatsApp on the phone (Settings → Linked devices → Link a device), then call polpo_whatsapp_login_wait with session_id ${s.id}. It expires at ${s.expiresAt ?? "in about two minutes"}.`
  : s.status === "connected" ? `WhatsApp profile ${s.profileDir} is signed in.`
    : s.status === "starting" ? `Starting WhatsApp for ${s.profileDir}: call polpo_whatsapp_login_wait with session_id ${s.id} to get the QR code.`
      : `The WhatsApp login ${s.status}${s.error ? `: ${s.error}` : ""}. Start a new one with polpo_whatsapp_login.`;

export function registerChannelSetupTools(tool: Register, deps: McpDeps): void {
  const setup = dashboardLink(deps, "/config?section=channels");

  // ── Routes: who answers on each channel ──

  tool("settings", "polpo_channel_routes_list", {
    title: "List channel routes",
    description: "Who answers on each channel: inbound on or off, the agent the channel is dedicated to (none: Polpo, with /agent to switch), "
      + "where replies go (reply_to), group replies (mentions or intent), session modes and per-agent session overrides, DM policy.",
    inputSchema: {},
    outputSchema: { routes: z.array(looseObject) },
    annotations: READ,
  }, async () => {
    const c = await channelsNow(deps);
    if (!c.ok) return c.res;
    const routes = Object.entries(c.channels).map(([name, ch]) => routeView(name, ch));
    const polpo = await orchestratorLabel(deps);
    return ok(routes.map((r) => `- ${String(r.channel)} (${String(r.type)}): ${r.inbound ? `inbound on, answered by ${r.agent ?? polpo}` : "inbound off"}`
      + `${r.reply_to ? `, replies via ${(r.reply_to as { channel: string }).channel}` : ""}${r.group_replies ? `, groups: ${String(r.group_replies)}` : ""}`).join("\n") || "No channels.",
    { routes });
  });

  tool("settings", "polpo_channel_route_set", {
    title: "Set a channel's route",
    description: "Choose who answers on a channel and how: dedicate it to an agent (null: Polpo, with /agent), send replies through another "
      + "channel, answer in groups on mentions or by intent, session mode and idle time, per-agent session overrides (null removes one). "
      + "Only the fields given change; inbound turns on unless set. Needs the admin scope.",
    inputSchema: {
      channel: z.string().min(1).describe("The channel's name (polpo_channel_routes_list)"),
      inbound: z.boolean().optional().describe("Accept messages on this channel (default: on when anything else is set)"),
      agent: z.string().min(1).nullable().optional().describe("The agent that answers every message here; null: Polpo"),
      reply_to: z.object({
        channel: z.string().min(1).describe("Another channel"), chat_id: z.string().optional().describe("Its chat"), echo_inbound: z.boolean().optional().describe("Echo the incoming message there too"),
      }).nullable().optional().describe("Deliver replies through another channel; null: reply here"),
      group_replies: z.enum(["mentions", "intent"]).optional().describe("In groups: mentions, replies and commands only, or also what a classifier judges is for this agent"),
      intent_threshold: z.number().min(0).max(1).optional().describe("group_replies intent: how sure the classifier must be"),
      session_mode: z.enum(["per-peer", "shared"]).optional().describe("Each person their own session, or the web UI's latest"),
      session_idle_minutes: z.number().int().min(0).optional().describe("Minutes of quiet before a new session (0: never)"),
      agent_sessions: z.record(z.string(), z.object({
        sessionMode: z.enum(["per-peer", "shared"]).optional(), sessionIdleMinutes: z.number().int().min(0).optional(),
      }).strict().nullable()).optional().describe("Per-agent overrides by agent name; null removes one"),
    },
    outputSchema: { route: looseObject, changed: z.array(z.string()) },
    annotations: UPDATE,
  }, async (a) => {
    const c = await channelsNow(deps);
    if (!c.ok) return c.res;
    const current = c.channels[a.channel];
    if (!current) return fail(`There is no channel "${a.channel}". List them with polpo_channel_routes_list; create one with polpo_channel_save.`);
    if (a.reply_to && !c.channels[a.reply_to.channel]) return fail(`There is no channel "${a.reply_to.channel}" (reply_to.channel).`);
    if (a.agent) {
      const agents = await apiGet(deps, "/agents");
      if (agents.ok && !((agents.data as Array<{ name: string }>) ?? []).some((x) => x.name === a.agent)) return fail(`There is no agent "${a.agent}". List them with polpo_agents_list.`);
    }
    const before = current.gateway ?? {};
    const g: Gateway = { ...before };
    const touched = Object.entries(a).some(([k, v]) => k !== "channel" && v !== undefined);
    if (!touched) return fail("Nothing to change: give inbound, agent, reply_to, group_replies, intent_threshold, session_mode, session_idle_minutes or agent_sessions.");
    g.enableInbound = a.inbound ?? true;
    if (a.agent === null) delete g.agent; else if (a.agent !== undefined) g.agent = a.agent;
    if (a.reply_to === null) delete g.replyTo;
    else if (a.reply_to) g.replyTo = { channel: a.reply_to.channel, ...(a.reply_to.chat_id ? { chatId: a.reply_to.chat_id } : {}), ...(a.reply_to.echo_inbound !== undefined ? { echoInbound: a.reply_to.echo_inbound } : {}) };
    if (a.group_replies !== undefined) g.groupReplies = a.group_replies;
    if (a.intent_threshold !== undefined) g.intentThreshold = a.intent_threshold;
    if (a.session_mode !== undefined) g.sessionMode = a.session_mode;
    if (a.session_idle_minutes !== undefined) g.sessionIdleMinutes = a.session_idle_minutes;
    if (a.agent_sessions) {
      const sessions = { ...((g.agentSessions as Record<string, unknown> | undefined) ?? {}) };
      for (const [agent, v] of Object.entries(a.agent_sessions)) { if (v === null) delete sessions[agent]; else sessions[agent] = v; }
      if (Object.keys(sessions).length) g.agentSessions = sessions; else delete g.agentSessions;
    }
    // the stored channel comes back with its secrets masked: the server restores them
    const r = await apiSend(deps, "PUT", `/config/channels/${enc(a.channel)}`, { ...current, gateway: g });
    if (!r.ok) return apiError(r, `Saving the route of ${a.channel}`);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(g)])].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(g[k]));
    const route = routeView(a.channel, { ...current, gateway: g });
    return ok(changed.length ? `Route of ${a.channel}: ${route.inbound ? `answered by ${route.agent ?? await orchestratorLabel(deps)}` : "inbound off"} (changed ${changed.join(", ")}).` : "Nothing changed (the values were the same).",
      { route, changed });
  });

  // ── Telegram ──

  tool("settings", "polpo_telegram_verify", {
    title: "Check a Telegram bot",
    description: "Check a saved Telegram channel's bot answers (its token stays on the server): returns the bot's username and name. "
      + "A new bot's token is entered in the dashboard (setup_url), never here.",
    inputSchema: {
      channel: z.string().min(1).describe("A saved Telegram channel"),
    },
    outputSchema: { bot: looseObject },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ channel }) => {
    const r = await apiSend(deps, "POST", `/peers/telegram/verify${qs({ channel })}`, {});
    if (!r.ok) return fail(`Telegram did not accept ${channel}'s bot: ${r.error}. ${setupHandoff(deps, { kind: "channel", item: channel, field: "botToken" }, "bot token from @BotFather").next_step}`);
    const bot = r.data as { username?: string; first_name?: string; id?: number };
    return ok(`The bot works: @${bot.username ?? "?"}${bot.first_name ? ` (${bot.first_name})` : ""}.`, { bot: { username: bot.username, name: bot.first_name, id: bot.id } });
  });

  tool("settings", "polpo_channel_invite", {
    title: "Invite a person to a channel",
    description: "Create an invite for a channel whose inbound is on (a Telegram link like t.me/<bot>?start=<token>, or the /start command), "
      + "or with `token`, check whether it was used (and by whom). The person opens the link and is paired and allowed. Needs the admin scope.",
    inputSchema: {
      channel: z.string().min(1).describe("The channel (inbound on)"),
      token: z.string().min(1).optional().describe("An invite's token: check its status instead of creating one"),
    },
    outputSchema: { invite: looseObject },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ channel, token }) => {
    const r = token
      ? await apiGet(deps, `/peers/invites/${enc(token)}${qs({ channel })}`)
      : await apiSend(deps, "POST", `/peers/invites${qs({ channel })}`);
    if (!r.ok) return apiError(r, token ? "Reading the invite" : `Creating an invite for ${channel}`, r.status === 404 && !token ? `Turn inbound on first (polpo_channel_route_set { channel: "${channel}", inbound: true }).` : undefined);
    const inv = r.data as { token: string; status: string; link?: string; command?: string; expiresAt?: string; displayName?: string };
    return ok(token
      ? `Invite ${inv.token}: ${inv.status}${inv.displayName ? ` (by ${inv.displayName})` : ""}.`
      : `Send the person ${inv.link ?? `the command ${inv.command}`} (expires ${inv.expiresAt ?? "soon"}). Check it with token ${inv.token}.`, { invite: inv });
  });

  tool("settings", "polpo_channel_peers", {
    title: "List channel peers and pairings",
    description: "The people the channels know (peers, with their channel and external id), the allowlist of who may write, and the pairing "
      + "requests waiting for approval (codes). Needs the admin scope (it names people).",
    inputSchema: { channel: z.enum(["telegram", "whatsapp", "slack", "discord", "webchat"]).optional().describe("Only this channel's peers") },
    outputSchema: { peers: z.array(looseObject), allowlist: z.array(z.unknown()), pairings: z.array(looseObject) },
    annotations: READ,
    scope: "polpo:admin",
  }, async ({ channel }) => {
    const [p, a, q] = await Promise.all([apiGet(deps, `/peers${qs({ channel })}`), apiGet(deps, "/peers/allowlist"), apiGet(deps, "/peers/pairings")]);
    if (!p.ok && p.status !== 404) return apiError(p, "Listing peers");
    const peers = p.ok && Array.isArray(p.data) ? p.data as Array<Record<string, unknown>> : [];
    const allowlist = a.ok && Array.isArray(a.data) ? a.data : [];
    const pairings = q.ok && Array.isArray(q.data) ? q.data as Array<Record<string, unknown>> : [];
    return ok([
      `peers: ${peers.map((x) => `${String(x.id)} (${String(x.channel ?? "")}${x.displayName ? `, ${String(x.displayName)}` : ""})`).join("; ") || "none"}`,
      `allowlist: ${allowlist.map(String).join(", ") || "none"}`,
      `pairing requests: ${pairings.map((x) => `${String(x.code)} from ${String(x.displayName ?? x.peerId ?? "?")}`).join("; ") || "none"}`,
      ...(p.ok ? [] : ["(the channel gateway is not running: turn inbound on for a channel)"]),
    ].join("\n"), { peers, allowlist, pairings });
  });

  tool("settings", "polpo_channel_allowlist", {
    title: "Change who may write",
    description: "Add a peer (polpo_channel_peers; e.g. telegram:12345) to the allowlist of people who may write to the channels, or remove one "
      + "(remove needs confirm: true). Needs the admin scope.",
    inputSchema: {
      action: z.enum(["add", "remove"]).describe("add or remove"),
      peer_id: z.string().min(1).describe("The peer's id"),
      confirm: confirmParam("remove the peer"),
    },
    outputSchema: { peer_id: z.string(), action: z.string(), allowlist: z.array(z.unknown()) },
    annotations: DESTRUCTIVE,
  }, async ({ action, peer_id, confirm }) => {
    if (action === "remove" && confirm !== true) return fail(`Removing ${peer_id} stops them from writing: ask the person, then call again with confirm: true.`);
    const r = action === "add"
      ? await apiSend(deps, "POST", "/peers/allowlist", { peerId: peer_id })
      : await apiSend(deps, "DELETE", `/peers/allowlist/${enc(peer_id)}`);
    if (!r.ok) return apiError(r, `${action === "add" ? "Adding" : "Removing"} ${peer_id}`, r.status === 404 ? "The channel gateway is not running: turn inbound on for a channel first." : undefined);
    const list = await apiGet(deps, "/peers/allowlist");
    const allowlist = list.ok && Array.isArray(list.data) ? list.data : [];
    return ok(`${action === "add" ? "Allowed" : "Removed"} ${peer_id}.`, { peer_id, action, allowlist });
  });

  tool("settings", "polpo_channel_pairing", {
    title: "Approve or reject a pairing",
    description: "Answer a pairing request (polpo_channel_peers): approve its code (the person may write from now on) or reject it. Needs the admin scope.",
    inputSchema: {
      code: z.string().min(1).describe("The pairing code"),
      approve: z.boolean().describe("true: approve; false: reject"),
    },
    outputSchema: { code: z.string(), approved: z.boolean(), request: z.unknown().optional() },
    annotations: UPDATE,
  }, async ({ code, approve }) => {
    const r = approve ? await apiSend(deps, "POST", "/peers/pair", { code }) : await apiSend(deps, "POST", `/peers/pairings/${enc(code)}/reject`);
    if (!r.ok) return r.status === 404 ? fail(`No pending pairing "${code}" (it may have expired). List them with polpo_channel_peers.`) : apiError(r, `Answering pairing ${code}`);
    return ok(approve ? `Approved ${code}: they can write now.` : `Rejected ${code}.`, { code, approved: approve, ...(approve ? { request: r.data } : {}) });
  });

  // ── WhatsApp ──

  tool("settings", "polpo_whatsapp_login", {
    title: "Sign in to WhatsApp",
    description: "Start signing a WhatsApp profile in (as in the dashboard): returns a QR code image to scan with the phone (Linked devices) "
      + "and a session_id; follow it with polpo_whatsapp_login_wait. `cancel` with session_id stops a login. Needs the admin scope.",
    inputSchema: {
      profile: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "letters, digits, - and _").optional().describe("The profile (default: default)"),
      cancel: z.boolean().optional().describe("true with session_id: stop that login"),
      session_id: z.string().min(1).optional().describe("A login to cancel"),
    },
    outputSchema: { session_id: z.string(), profile: z.string(), status: z.string(), has_qr: z.boolean(), error: z.string().optional(), expires_at: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ profile, cancel, session_id }) => {
    if (cancel) {
      if (!session_id) return fail("Give session_id to cancel a login.");
      const r = await apiSend(deps, "POST", `/whatsapp/login/${enc(session_id)}/cancel`);
      if (!r.ok) return apiError(r, "Cancelling the login");
      const s = (r.data as { session: WaSession }).session;
      return loginResult(s, `Cancelled the WhatsApp login for ${s.profileDir}.`);
    }
    const r = await apiSend(deps, "POST", "/whatsapp/login/start", { profileDir: profile ?? "default" });
    if (!r.ok) return apiError(r, "Starting the WhatsApp login");
    let s = (r.data as { session: WaSession }).session;
    // the QR comes a moment later: wait a little for it
    for (let i = 0; i < 20 && s.status === "starting"; i++) {
      await sleep(deps.pollIntervalMs ?? 500);
      const g = await apiGet(deps, `/whatsapp/login/${enc(s.id)}`);
      if (g.ok) s = (g.data as { session: WaSession }).session;
    }
    return loginResult(s, loginText(s));
  });

  tool("settings", "polpo_whatsapp_login_wait", {
    title: "Wait for the WhatsApp sign-in",
    description: "Wait until a WhatsApp login (polpo_whatsapp_login) is scanned and connected, fails or expires (at most timeout_seconds). "
      + "Returns a fresh QR code when WhatsApp changed it.",
    inputSchema: {
      session_id: z.string().min(1).describe("The login's session_id"),
      timeout_seconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).optional().describe(`How long to wait (default 30, at most ${MAX_WAIT_SECONDS})`),
    },
    outputSchema: { session_id: z.string(), profile: z.string(), status: z.string(), has_qr: z.boolean(), error: z.string().optional(), expires_at: z.string().optional() },
    annotations: READ,
    // the QR code links a WhatsApp account: admin only, like starting the login
    scope: "polpo:admin",
  }, async ({ session_id, timeout_seconds }, extra) => {
    const until = Date.now() + (timeout_seconds ?? 30) * 1000;
    let first: string | undefined;
    for (;;) {
      const g = await apiGet(deps, `/whatsapp/login/${enc(session_id)}`);
      if (!g.ok) return g.status === 404 ? fail(`No WhatsApp login ${session_id} (it ended). Start a new one with polpo_whatsapp_login.`) : apiError(g, "Reading the login");
      const s = (g.data as { session: WaSession }).session;
      first ??= s.qr;
      const changedQr = s.status === "qr" && s.qr !== first;
      if (s.status !== "qr" && s.status !== "starting") return loginResult(s, loginText(s));
      if (changedQr) return loginResult(s, `WhatsApp gave a new QR code: scan this one. ${loginText(s)}`);
      if (Date.now() >= until || extra?.signal?.aborted) return loginResult({ ...s, qr: undefined }, `Not scanned yet (${s.status}). Call again to keep waiting.`);
      await progress(extra, 0, undefined, `waiting for the scan (${s.status})`);
      await sleep(deps.pollIntervalMs ?? 1000, extra?.signal);
    }
  });

  tool("settings", "polpo_whatsapp_logout", {
    title: "Sign out of WhatsApp",
    description: "Sign a WhatsApp profile out and delete its session on this server (channels using it stop until it signs in again). Needs confirm: true.",
    inputSchema: {
      profile: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional().describe("The profile (default: default)"),
      confirm: confirmParam("sign it out"),
    },
    outputSchema: { profile: z.string(), removed: z.boolean() },
    annotations: DESTRUCTIVE,
  }, async ({ profile, confirm }) => {
    const p = profile ?? "default";
    if (confirm !== true) return fail(`Signing ${p} out stops WhatsApp until it is scanned again: ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "POST", "/whatsapp/logout", { profileDir: p });
    if (!r.ok) return apiError(r, `Signing ${p} out`);
    return ok(`Signed ${p} out of WhatsApp. To sign in again: polpo_whatsapp_login or ${setup}.`, { profile: p, removed: true });
  });
}
