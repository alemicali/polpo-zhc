/**
 * Peer identity & presence routes.
 *
 * GET    /peers             — list known peers
 * GET    /peers/presence    — get current presence (online peers)
 * GET    /peers/allowlist   — get allowlist
 * POST   /peers/allowlist   — add to allowlist
 * DELETE /peers/allowlist/:peerId — remove from allowlist
 * POST   /peers/pair        — approve a pairing code
 * GET    /peers/pairings    — list pending pairing requests
 * POST   /peers/pairings/:code/reject — dismiss a pending pairing request
 * POST   /peers/invites?channel=NAME — create a one-time invite link (/start <token>)
 * GET    /peers/invites/:token?channel=NAME — poll an invite until it is redeemed
 * POST   /peers/telegram/verify?channel=NAME — check a Telegram bot token (getMe)
 * POST   /peers/telegram/detect-chat — wait for a message to a not-yet-running bot and report its chat
 *
 * `channel` selects a Telegram channel by name (dedicated-agent bots); omitted = primary bot.
 * POST   /peers/link        — link two peer identities
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { isRedactedValue } from "@polpo-ai/core/secret-redaction";

/* ── Shared error schema ───────────────────────────────────────────── */
const ErrorResponse = z.object({ ok: z.boolean(), error: z.string() });
const SuccessResponse = z.object({ ok: z.boolean(), data: z.any() });

/* ── Route definitions ─────────────────────────────────────────────── */

const listPeersRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Peers"],
  summary: "List known peers",
  request: {
    query: z.object({ channel: z.string().optional() }),
  },
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Peer list" },
    404: { content: { "application/json": { schema: ErrorResponse } }, description: "Gateway not configured" },
  },
});

const getPresenceRoute = createRoute({
  method: "get",
  path: "/presence",
  tags: ["Peers"],
  summary: "Get presence",
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Presence list" },
    404: { content: { "application/json": { schema: ErrorResponse } }, description: "Gateway not configured" },
  },
});

const getAllowlistRoute = createRoute({
  method: "get",
  path: "/allowlist",
  tags: ["Peers"],
  summary: "Get allowlist",
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Allowlist" },
    404: { content: { "application/json": { schema: ErrorResponse } }, description: "Gateway not configured" },
  },
});

const addToAllowlistRoute = createRoute({
  method: "post",
  path: "/allowlist",
  tags: ["Peers"],
  summary: "Allow peer",
  request: {
    body: { content: { "application/json": { schema: z.object({ peerId: z.string() }) } } },
  },
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Peer added" },
    400: { content: { "application/json": { schema: ErrorResponse } }, description: "Missing peerId" },
    404: { content: { "application/json": { schema: ErrorResponse } }, description: "Gateway not configured" },
  },
});

const removeFromAllowlistRoute = createRoute({
  method: "delete",
  path: "/allowlist/{peerId}",
  tags: ["Peers"],
  summary: "Remove peer",
  request: {
    params: z.object({ peerId: z.string() }),
  },
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Peer removed" },
    404: { content: { "application/json": { schema: ErrorResponse } }, description: "Gateway not configured" },
  },
});

const approvePairingRoute = createRoute({
  method: "post",
  path: "/pair",
  tags: ["Peers"],
  summary: "Approve pairing",
  request: {
    body: { content: { "application/json": { schema: z.object({ code: z.string() }) } } },
  },
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Pairing approved" },
    400: { content: { "application/json": { schema: ErrorResponse } }, description: "Missing code" },
    404: { content: { "application/json": { schema: ErrorResponse } }, description: "Invalid/expired code or gateway not configured" },
  },
});

const linkPeersRoute = createRoute({
  method: "post",
  path: "/link",
  tags: ["Peers"],
  summary: "Link peers",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ peerId: z.string(), linkedTo: z.string() }),
        },
      },
    },
  },
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Peers linked" },
    400: { content: { "application/json": { schema: ErrorResponse } }, description: "Missing fields" },
    404: { content: { "application/json": { schema: ErrorResponse } }, description: "Gateway not configured" },
  },
});

const listPairingsRoute = createRoute({
  method: "get",
  path: "/pairings",
  tags: ["Peers"],
  summary: "List pending pairing requests",
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Pending pairing requests" },
    404: { content: { "application/json": { schema: ErrorResponse } }, description: "Gateway not configured" },
  },
});

const rejectPairingRoute = createRoute({
  method: "post",
  path: "/pairings/{code}/reject",
  tags: ["Peers"],
  summary: "Reject pairing",
  request: {
    params: z.object({ code: z.string() }),
  },
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Pairing rejected" },
    404: { content: { "application/json": { schema: ErrorResponse } }, description: "Unknown code or gateway not configured" },
  },
});

const createInviteRoute = createRoute({
  method: "post",
  path: "/invites",
  tags: ["Peers"],
  summary: "Create invite link",
  request: {
    query: z.object({ channel: z.string().optional() }),
  },
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Invite created" },
    404: { content: { "application/json": { schema: ErrorResponse } }, description: "Gateway not running" },
  },
});

const getInviteRoute = createRoute({
  method: "get",
  path: "/invites/{token}",
  tags: ["Peers"],
  summary: "Get invite status",
  request: {
    params: z.object({ token: z.string() }),
    query: z.object({ channel: z.string().optional() }),
  },
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Invite status" },
    404: { content: { "application/json": { schema: ErrorResponse } }, description: "Unknown invite or gateway not running" },
  },
});

const verifyTelegramRoute = createRoute({
  method: "post",
  path: "/telegram/verify",
  tags: ["Peers"],
  summary: "Verify Telegram bot token",
  request: {
    query: z.object({ channel: z.string().optional() }),
    body: { content: { "application/json": { schema: z.object({ botToken: z.string().optional() }) } } },
  },
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Bot identity" },
    400: { content: { "application/json": { schema: ErrorResponse } }, description: "Missing or rejected token" },
  },
});

const detectChatRoute = createRoute({
  method: "post",
  path: "/telegram/detect-chat",
  tags: ["Peers"],
  summary: "Detect Telegram chat",
  description: "Long-polls getUpdates (up to `timeout` seconds) on a bot that is not configured yet and returns the chats that wrote to it. Call again with `offset` to keep waiting.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            botToken: z.string().min(1),
            offset: z.number().int().optional(),
            timeout: z.number().int().min(0).max(50).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Chats seen and the next offset" },
    400: { content: { "application/json": { schema: ErrorResponse } }, description: "Telegram error" },
    409: { content: { "application/json": { schema: ErrorResponse } }, description: "Bot already polled by a configured channel" },
  },
});

/* ── Route handlers ────────────────────────────────────────────────── */

/** Invite surface of the channel gateway (present only while inbound routing runs). */
export interface PeerInvite {
  token: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "paired" | "expired";
  peerId?: string;
  externalId?: string;
  chatId?: string;
  displayName?: string;
}

export interface PeerInviteGateway {
  createInvite(): PeerInvite;
  getInvite(token: string): PeerInvite | undefined;
}

export interface PeerRouteDeps {
  peerStore?: any;
  /** Gateway of the named channel, or the primary one when omitted. */
  getGateway?: (channel?: string) => PeerInviteGateway | undefined;
  /** Bot token of the named Telegram channel (or the primary one), for getMe and deep links. */
  getTelegramBotToken?: (channel?: string) => string | undefined;
  /** Tokens of every configured Telegram channel: their pollers own getUpdates. */
  getConfiguredTelegramTokens?: () => string[];
  fetch?: typeof fetch;
}

interface TelegramBot {
  id: number;
  username: string;
  name: string;
  /** False while privacy mode is on: in groups the bot only sees commands and replies to it. */
  canReadAllGroupMessages?: boolean;
}

/** A chat that wrote to the bot, as reported by detect-chat. */
export interface DetectedChat {
  chatId: string;
  type: string;
  name: string;
  username?: string;
  /** Sender's user id (the peer to authorize); equals chatId in private chats. */
  fromId?: string;
  text?: string;
}

async function telegramGetMe(botToken: string, fetchImpl: typeof fetch): Promise<TelegramBot | { error: string }> {
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/getMe`);
    const body = await res.json().catch(() => null) as any;
    if (!body?.ok) return { error: body?.description ?? `Telegram rejected the token (${res.status})` };
    return {
      id: body.result.id,
      username: body.result.username,
      name: body.result.first_name,
      canReadAllGroupMessages: body.result.can_read_all_group_messages,
    };
  } catch (err) {
    return { error: `Telegram unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function peerRoutes(getDeps: () => PeerRouteDeps): OpenAPIHono {
  const app = new OpenAPIHono();

  // ── List known peers ──
  app.openapi(listPeersRoute, async (c) => {
    const { peerStore } = getDeps();
    if (!peerStore) return c.json({ ok: false, error: "Channel gateway not configured" }, 404);

    const channel = c.req.query("channel") as "telegram" | "whatsapp" | "slack" | "discord" | "webchat" | undefined;
    return c.json({ ok: true, data: await peerStore.listPeers(channel) }, 200);
  });

  // ── Get presence ──
  app.openapi(getPresenceRoute, async (c) => {
    const { peerStore } = getDeps();
    if (!peerStore) return c.json({ ok: false, error: "Channel gateway not configured" }, 404);

    return c.json({ ok: true, data: await peerStore.getPresence() }, 200);
  });

  // ── Get allowlist ──
  app.openapi(getAllowlistRoute, async (c) => {
    const { peerStore } = getDeps();
    if (!peerStore) return c.json({ ok: false, error: "Channel gateway not configured" }, 404);

    return c.json({ ok: true, data: await peerStore.getAllowlist() }, 200);
  });

  // ── Add to allowlist ──
  app.openapi(addToAllowlistRoute, async (c) => {
    const { peerStore } = getDeps();
    if (!peerStore) return c.json({ ok: false, error: "Channel gateway not configured" }, 404);

    const { peerId } = c.req.valid("json");
    if (!peerId) return c.json({ ok: false, error: "peerId is required" }, 400);

    await peerStore.addToAllowlist(peerId);
    return c.json({ ok: true, data: { peerId } }, 200);
  });

  // ── Remove from allowlist ──
  app.openapi(removeFromAllowlistRoute, async (c) => {
    const { peerStore } = getDeps();
    if (!peerStore) return c.json({ ok: false, error: "Channel gateway not configured" }, 404);

    const { peerId } = c.req.valid("param");
    await peerStore.removeFromAllowlist(peerId);
    return c.json({ ok: true, data: { peerId } }, 200);
  });

  // ── Approve pairing code ──
  app.openapi(approvePairingRoute, async (c) => {
    const { peerStore } = getDeps();
    if (!peerStore) return c.json({ ok: false, error: "Channel gateway not configured" }, 404);

    const { code } = c.req.valid("json");
    if (!code) return c.json({ ok: false, error: "code is required" }, 400);

    const request = await peerStore.resolvePairing(code);
    if (!request) return c.json({ ok: false, error: "Invalid or expired pairing code" }, 404);

    return c.json({ ok: true, data: request }, 200);
  });

  // ── List pending pairing requests ──
  app.openapi(listPairingsRoute, async (c) => {
    const { peerStore } = getDeps();
    if (!peerStore) return c.json({ ok: false, error: "Channel gateway not configured" }, 404);
    return c.json({ ok: true, data: await peerStore.listPendingPairings() }, 200);
  });

  // ── Reject pairing request ──
  app.openapi(rejectPairingRoute, async (c) => {
    const { peerStore } = getDeps();
    if (!peerStore) return c.json({ ok: false, error: "Channel gateway not configured" }, 404);
    const { code } = c.req.valid("param");
    if (!await peerStore.rejectPairing(code)) return c.json({ ok: false, error: "Unknown or already resolved pairing code" }, 404);
    return c.json({ ok: true, data: { code } }, 200);
  });

  // ── Create invite link ──
  app.openapi(createInviteRoute, async (c) => {
    const { getGateway, getTelegramBotToken, fetch: fetchImpl = fetch } = getDeps();
    const channel = c.req.valid("query").channel;
    const gateway = getGateway?.(channel);
    const telegramBotToken = getTelegramBotToken?.(channel);
    if (!gateway) {
      return c.json({ ok: false, error: "Channel gateway is not running. Enable inbound messages and save the channel first." }, 404);
    }
    const invite = gateway.createInvite();
    let bot: TelegramBot | undefined;
    if (telegramBotToken) {
      const me = await telegramGetMe(telegramBotToken, fetchImpl);
      if (!("error" in me)) bot = me;
    }
    const link = bot ? `https://t.me/${bot.username}?start=${invite.token}` : undefined;
    return c.json({ ok: true, data: { ...invite, botUsername: bot?.username, link, command: `/start ${invite.token}` } }, 200);
  });

  // ── Invite status (polled by the UI) ──
  app.openapi(getInviteRoute, async (c) => {
    const gateway = getDeps().getGateway?.(c.req.valid("query").channel);
    if (!gateway) return c.json({ ok: false, error: "Channel gateway is not running" }, 404);
    const invite = gateway.getInvite(c.req.valid("param").token);
    if (!invite) return c.json({ ok: false, error: "Unknown invite" }, 404);
    return c.json({ ok: true, data: invite }, 200);
  });

  // ── Verify Telegram bot token ──
  app.openapi(verifyTelegramRoute, async (c) => {
    const { getTelegramBotToken, fetch: fetchImpl = fetch } = getDeps();
    // A redacted token ("••••1234", as returned by GET /config) means "the saved one".
    const bodyToken = c.req.valid("json").botToken?.trim();
    const botToken = (bodyToken && !isRedactedValue(bodyToken) ? bodyToken : undefined)
      || getTelegramBotToken?.(c.req.valid("query").channel);
    if (!botToken) return c.json({ ok: false, error: "botToken is required" }, 400);
    const me = await telegramGetMe(botToken, fetchImpl);
    if ("error" in me) return c.json({ ok: false, error: me.error }, 400);
    return c.json({ ok: true, data: me }, 200);
  });

  // ── Detect the chat of a not-yet-configured bot ──
  app.openapi(detectChatRoute, async (c) => {
    const { getConfiguredTelegramTokens, fetch: fetchImpl = fetch } = getDeps();
    const { botToken: rawToken, offset, timeout = 25 } = c.req.valid("json");
    const botToken = rawToken.trim();
    if (isRedactedValue(botToken)) {
      return c.json({ ok: false, error: "This bot is already active on a saved channel. Use \"Connect my Telegram\" on that channel instead." }, 409);
    }
    if (getConfiguredTelegramTokens?.().includes(botToken)) {
      return c.json({ ok: false, error: "This bot is already active on a saved channel. Use \"Connect my Telegram\" on that channel instead." }, 409);
    }

    let body: any;
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/getUpdates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offset, timeout, allowed_updates: ["message", "my_chat_member", "channel_post"] }),
      });
      body = await res.json().catch(() => null);
    } catch (err) {
      return c.json({ ok: false, error: `Telegram unreachable: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }
    if (!body?.ok) return c.json({ ok: false, error: body?.description ?? "Telegram rejected the request" }, 400);

    const updates: any[] = body.result ?? [];
    const chats = new Map<string, DetectedChat>();
    for (const update of updates) {
      const msg = update.message ?? update.channel_post ?? update.my_chat_member;
      const chat = msg?.chat;
      if (!chat) continue;
      const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username;
      chats.set(String(chat.id), {
        chatId: String(chat.id),
        type: chat.type,
        name: name || String(chat.id),
        username: chat.username,
        fromId: msg.from?.id !== undefined ? String(msg.from.id) : undefined,
        text: typeof msg.text === "string" ? msg.text.slice(0, 80) : undefined,
      });
    }
    const nextOffset = updates.length > 0 ? Math.max(...updates.map((u) => u.update_id)) + 1 : offset;
    return c.json({ ok: true, data: { chats: [...chats.values()], nextOffset } }, 200);
  });

  // ── Link peer identities ──
  app.openapi(linkPeersRoute, async (c) => {
    const { peerStore } = getDeps();
    if (!peerStore) return c.json({ ok: false, error: "Channel gateway not configured" }, 404);

    const { peerId, linkedTo } = c.req.valid("json");
    if (!peerId || !linkedTo) {
      return c.json({ ok: false, error: "peerId and linkedTo are required" }, 400);
    }

    await peerStore.linkPeers(peerId, linkedTo);
    return c.json({ ok: true, data: { peerId, linkedTo } }, 200);
  });

  return app;
}
