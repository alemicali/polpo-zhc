import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { nanoid } from "nanoid";
import { WhatsAppBridge, WhatsAppChannel } from "../../notifications/channels/whatsapp.js";

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

export function whatsappRoutes(getDeps: () => {
  polpoDir: string;
  reloadConfig?: () => Promise<boolean>;
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
