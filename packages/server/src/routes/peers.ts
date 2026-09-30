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
 * POST   /peers/invites     — create a one-time invite link (/start <token>)
 * GET    /peers/invites/:token — poll an invite until it is redeemed
 * POST   /peers/telegram/verify — check a Telegram bot token (getMe)
 * POST   /peers/link        — link two peer identities
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

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
    body: { content: { "application/json": { schema: z.object({ botToken: z.string().optional() }) } } },
  },
  responses: {
    200: { content: { "application/json": { schema: SuccessResponse } }, description: "Bot identity" },
    400: { content: { "application/json": { schema: ErrorResponse } }, description: "Missing or rejected token" },
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
  gateway?: PeerInviteGateway;
  /** Bot token of the configured Telegram channel, used for getMe and deep links. */
  telegramBotToken?: string;
  fetch?: typeof fetch;
}

interface TelegramBot { id: number; username: string; name: string }

async function telegramGetMe(botToken: string, fetchImpl: typeof fetch): Promise<TelegramBot | { error: string }> {
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/getMe`);
    const body = await res.json().catch(() => null) as any;
    if (!body?.ok) return { error: body?.description ?? `Telegram rejected the token (${res.status})` };
    return { id: body.result.id, username: body.result.username, name: body.result.first_name };
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
    const { gateway, telegramBotToken, fetch: fetchImpl = fetch } = getDeps();
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
    const { gateway } = getDeps();
    if (!gateway) return c.json({ ok: false, error: "Channel gateway is not running" }, 404);
    const invite = gateway.getInvite(c.req.valid("param").token);
    if (!invite) return c.json({ ok: false, error: "Unknown invite" }, 404);
    return c.json({ ok: true, data: invite }, 200);
  });

  // ── Verify Telegram bot token ──
  app.openapi(verifyTelegramRoute, async (c) => {
    const { telegramBotToken, fetch: fetchImpl = fetch } = getDeps();
    const botToken = c.req.valid("json").botToken?.trim() || telegramBotToken;
    if (!botToken) return c.json({ ok: false, error: "botToken is required" }, 400);
    const me = await telegramGetMe(botToken, fetchImpl);
    if ("error" in me) return c.json({ ok: false, error: me.error }, 400);
    return c.json({ ok: true, data: me }, 200);
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
