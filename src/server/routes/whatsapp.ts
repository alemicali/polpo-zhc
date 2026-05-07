import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve as resolvePath } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { nanoid } from "nanoid";
import { WhatsAppBridge, WhatsAppChannel } from "../../notifications/channels/whatsapp.js";
import { resolveAllowedPaths, assertPathAllowed } from "../../tools/path-sandbox.js";
import type { Orchestrator } from "../../core/orchestrator.js";

type LoginStatus = "starting" | "qr" | "connected" | "error" | "expired" | "cancelled";

interface LoginSession {
  id: string;
  profileDir: string;
  status: LoginStatus;
  qr?: string;
  error?: string;
  startedAt: number;
  updatedAt: number;
  expiresAt: number;
  bridge: WhatsAppBridge;
  timeout: ReturnType<typeof setTimeout>;
}

const ProfileSchema = z.object({
  profileDir: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
});

const sessions = new Map<string, LoginSession>();

function profilePath(polpoDir: string, profileDir: string): string {
  return join(polpoDir, "whatsapp-profiles", profileDir);
}

function serializeSession(session: LoginSession) {
  return {
    id: session.id,
    profileDir: session.profileDir,
    status: session.status,
    qr: session.qr,
    error: session.error,
    startedAt: new Date(session.startedAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

function finishSession(session: LoginSession, status: LoginStatus, error?: string): void {
  if (session.status === "connected" || session.status === "expired" || session.status === "cancelled") return;
  session.status = status;
  session.error = error;
  session.updatedAt = Date.now();
  clearTimeout(session.timeout);
  if (status !== "connected") session.bridge.stop();
  setTimeout(() => sessions.delete(session.id), 300_000);
}

function listProfiles(polpoDir: string) {
  const profilesDir = join(polpoDir, "whatsapp-profiles");
  if (!existsSync(profilesDir)) return [];
  return readdirSync(profilesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = profilePath(polpoDir, entry.name);
      const authenticated = existsSync(join(dir, "creds.json"));
      const activeSession = [...sessions.values()].find((session) =>
        session.profileDir === entry.name
        && ["starting", "qr"].includes(session.status),
      );
      return {
        profileDir: entry.name,
        authenticated,
        status: activeSession ? activeSession.status : authenticated ? "authenticated" : "no_credentials",
        path: dir,
      };
    });
}

/** Resolve a free-form recipient (phone, contact name, or already-JID)
 *  to a JID, mirroring the same logic used by the agent tools. */
function resolveJid(input: string, store: { resolveContact: (s: string) => { jid: string } | undefined }): string {
  if (input.includes("@")) return input;
  const contact = store.resolveContact(input);
  if (contact) return contact.jid;
  const clean = input.replace(/[+\s-]/g, "");
  return `${clean}@s.whatsapp.net`;
}

const SendTextSchema = z.object({
  to: z.string().min(1, "Recipient required"),
  message: z.string().min(1, "Message required"),
});

const SendFileSchema = z.object({
  to: z.string().min(1, "Recipient required"),
  path: z.string().min(1, "File path required"),
  caption: z.string().optional(),
  mediaKind: z.enum(["auto", "image", "video", "audio", "document"]).optional(),
  mimeType: z.string().optional(),
  fileName: z.string().optional(),
  viewOnce: z.boolean().optional(),
});

export function whatsappRoutes(getDeps: () => {
  polpoDir: string;
  reloadConfig?: () => Promise<boolean>;
  /** Optional — supplied by createApp so the chat approval-gate REST
   *  endpoints can invoke the live WhatsAppBridge. Login/logout flows
   *  don't need it. */
  orchestrator?: Orchestrator;
}): OpenAPIHono {
  const app = new OpenAPIHono();

  app.get("/profiles", (c) => {
    const { polpoDir } = getDeps();
    return c.json({ ok: true, data: { profiles: listProfiles(polpoDir) } });
  });

  app.post("/login/start", async (c) => {
    const parsed = ProfileSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ ok: false, error: "Invalid WhatsApp profile name. Use letters, numbers, dashes, or underscores." }, 400);
    }

    const { polpoDir, reloadConfig } = getDeps();
    const { profileDir } = parsed.data;
    const existing = [...sessions.values()].find((session) =>
      session.profileDir === profileDir
      && ["starting", "qr"].includes(session.status),
    );
    if (existing) {
      return c.json({ ok: true, data: { session: serializeSession(existing) } });
    }

    mkdirSync(profilePath(polpoDir, profileDir), { recursive: true });
    const channel = new WhatsAppChannel({ type: "whatsapp", chatId: "0", profileDir }, polpoDir);
    const bridge = new WhatsAppBridge(channel);
    const now = Date.now();
    const session: LoginSession = {
      id: nanoid(),
      profileDir,
      status: "starting",
      startedAt: now,
      updatedAt: now,
      expiresAt: now + 120_000,
      bridge,
      timeout: setTimeout(() => {
        finishSession(session, "expired", "WhatsApp login timed out. Start a new pairing session.");
      }, 120_000),
    };
    sessions.set(session.id, session);

    bridge.connectInteractive((qr) => {
      session.status = "qr";
      session.qr = qr;
      session.updatedAt = Date.now();
    }).then(async () => {
      session.status = "connected";
      session.error = undefined;
      session.updatedAt = Date.now();
      clearTimeout(session.timeout);
      setTimeout(() => sessions.delete(session.id), 300_000);
      try { await reloadConfig?.(); } catch { /* best effort */ }
    }).catch((err) => {
      if (session.status === "expired" || session.status === "cancelled") return;
      finishSession(session, "error", err instanceof Error ? err.message : String(err));
    });

    return c.json({ ok: true, data: { session: serializeSession(session) } });
  });

  app.get("/login/:sessionId", (c) => {
    const session = sessions.get(c.req.param("sessionId"));
    if (!session) return c.json({ ok: false, error: "WhatsApp login session not found" }, 404);
    return c.json({ ok: true, data: { session: serializeSession(session) } });
  });

  app.post("/login/:sessionId/cancel", (c) => {
    const session = sessions.get(c.req.param("sessionId"));
    if (!session) return c.json({ ok: false, error: "WhatsApp login session not found" }, 404);
    finishSession(session, "cancelled", "WhatsApp login was cancelled.");
    return c.json({ ok: true, data: { session: serializeSession(session) } });
  });

  // ── Approval-gate endpoints ─────────────────────────────────────────
  // POST /send and /send-file are invoked by the chat UI after the user
  // confirms a `whatsapp_preview` shown by the LLM. They call the live
  // bridge directly — same code path as the agent tools, just with
  // human approval upstream.

  app.post("/send", async (c) => {
    const parsed = SendTextSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ ok: false, error: parsed.error.issues.map(i => i.message).join("; ") }, 400);
    }
    const { orchestrator } = getDeps();
    const bridge = orchestrator?.getWhatsAppBridge?.();
    const store = orchestrator?.getWhatsAppStore?.();
    if (!bridge || !store) {
      return c.json({ ok: false, error: "WhatsApp is not connected on this instance." }, 503);
    }
    try {
      const jid = resolveJid(parsed.data.to, store);
      const id = await bridge.sendMessage(jid, parsed.data.message);
      // Mirror the agent tool: persist the outbound message so the user
      // sees it in subsequent whatsapp_read calls.
      if (id) {
        store.appendMessage({
          id, chatJid: jid, senderJid: "me",
          text: parsed.data.message, fromMe: true,
          timestamp: Math.floor(Date.now() / 1000),
        });
      }
      return c.json({ ok: true, data: { id, jid } });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/send-file", async (c) => {
    const parsed = SendFileSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ ok: false, error: parsed.error.issues.map(i => i.message).join("; ") }, 400);
    }
    const { orchestrator } = getDeps();
    const bridge = orchestrator?.getWhatsAppBridge?.();
    const store = orchestrator?.getWhatsAppStore?.();
    if (!orchestrator || !bridge || !store) {
      return c.json({ ok: false, error: "WhatsApp is not connected on this instance." }, 503);
    }
    try {
      const cwd = orchestrator.getAgentWorkDir();
      const sandbox = resolveAllowedPaths(cwd, undefined);
      const filePath = resolvePath(cwd, parsed.data.path);
      assertPathAllowed(filePath, sandbox, "whatsapp_send_file");
      const stat = statSync(filePath);
      if (!stat.isFile()) {
        return c.json({ ok: false, error: "Path is not a file" }, 400);
      }
      const jid = resolveJid(parsed.data.to, store);
      const id = await bridge.sendMediaMessage(jid, {
        path: filePath,
        caption: parsed.data.caption,
        mimeType: parsed.data.mimeType,
        fileName: parsed.data.fileName ?? basename(filePath),
        mediaKind: parsed.data.mediaKind ?? "auto",
        viewOnce: parsed.data.viewOnce,
      });
      return c.json({ ok: true, data: { id, jid } });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/logout", async (c) => {
    const parsed = ProfileSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ ok: false, error: "Invalid WhatsApp profile name" }, 400);
    }
    const { polpoDir, reloadConfig } = getDeps();
    const { profileDir } = parsed.data;
    for (const session of sessions.values()) {
      if (session.profileDir === profileDir && ["starting", "qr"].includes(session.status)) {
        finishSession(session, "cancelled", "WhatsApp profile was removed.");
      }
    }
    rmSync(profilePath(polpoDir, profileDir), { recursive: true, force: true });
    try { await reloadConfig?.(); } catch { /* best effort */ }
    return c.json({ ok: true, data: { profileDir, removed: true, profiles: listProfiles(polpoDir) } });
  });

  return app;
}
