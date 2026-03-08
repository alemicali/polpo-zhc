/**
 * Peer identity & presence routes.
 *
 * GET    /peers             — list known peers
 * GET    /peers/presence    — get current presence (online peers)
 * GET    /peers/allowlist   — get allowlist
 * POST   /peers/allowlist   — add to allowlist
 * DELETE /peers/allowlist/:peerId — remove from allowlist
 * POST   /peers/pair        — approve a pairing code
 * POST   /peers/link        — link two peer identities
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ServerEnv } from "../app.js";

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

/* ── Route handlers ────────────────────────────────────────────────── */

export function peerRoutes(): OpenAPIHono<ServerEnv> {
  const app = new OpenAPIHono<ServerEnv>();

  // ── List known peers ──
  app.openapi(listPeersRoute, async (c) => {
    const orch = c.get("orchestrator");
    const peerStore = orch.getPeerStore();
    if (!peerStore) return c.json({ ok: false, error: "Channel gateway not configured" }, 404);

    const channel = c.req.query("channel") as "telegram" | "whatsapp" | "slack" | "discord" | "webchat" | undefined;
    return c.json({ ok: true, data: await peerStore.listPeers(channel) }, 200);
  });

  // ── Get presence ──
  app.openapi(getPresenceRoute, async (c) => {
    const orch = c.get("orchestrator");
    const peerStore = orch.getPeerStore();
    if (!peerStore) return c.json({ ok: false, error: "Channel gateway not configured" }, 404);

    return c.json({ ok: true, data: await peerStore.getPresence() }, 200);
  });

  // ── Get allowlist ──
  app.openapi(getAllowlistRoute, async (c) => {
    const orch = c.get("orchestrator");
    const peerStore = orch.getPeerStore();
    if (!peerStore) return c.json({ ok: false, error: "Channel gateway not configured" }, 404);

    return c.json({ ok: true, data: await peerStore.getAllowlist() }, 200);
  });

  // ── Add to allowlist ──
  app.openapi(addToAllowlistRoute, async (c) => {
    const orch = c.get("orchestrator");
    const peerStore = orch.getPeerStore();
    if (!peerStore) return c.json({ ok: false, error: "Channel gateway not configured" }, 404);

    const { peerId } = c.req.valid("json");
    if (!peerId) return c.json({ ok: false, error: "peerId is required" }, 400);

    await peerStore.addToAllowlist(peerId);
    return c.json({ ok: true, data: { peerId } }, 200);
  });

  // ── Remove from allowlist ──
  app.openapi(removeFromAllowlistRoute, async (c) => {
    const orch = c.get("orchestrator");
    const peerStore = orch.getPeerStore();
    if (!peerStore) return c.json({ ok: false, error: "Channel gateway not configured" }, 404);

    const { peerId } = c.req.valid("param");
    await peerStore.removeFromAllowlist(peerId);
    return c.json({ ok: true, data: { peerId } }, 200);
  });

  // ── Approve pairing code ──
  app.openapi(approvePairingRoute, async (c) => {
    const orch = c.get("orchestrator");
    const peerStore = orch.getPeerStore();
    if (!peerStore) return c.json({ ok: false, error: "Channel gateway not configured" }, 404);

    const { code } = c.req.valid("json");
    if (!code) return c.json({ ok: false, error: "code is required" }, 400);

    const request = await peerStore.resolvePairing(code);
    if (!request) return c.json({ ok: false, error: "Invalid or expired pairing code" }, 404);

    return c.json({ ok: true, data: request }, 200);
  });

  // ── Link peer identities ──
  app.openapi(linkPeersRoute, async (c) => {
    const orch = c.get("orchestrator");
    const peerStore = orch.getPeerStore();
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
