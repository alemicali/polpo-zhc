import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  AUTH_COOKIE_NAME,
  addAllowedEmail,
  clearSession,
  consumeMagicLink,
  createInitialInstanceAuth,
  createMagicLink,
  isInstanceAuthEnabled,
  listAllowedEmails,
  loadInstanceAuth,
  normalizeEmail,
  removeAllowedEmail,
  validateSession,
} from "../auth/instance-auth.js";

const statusRoute = createRoute({
  method: "get",
  path: "/status",
  tags: ["Auth"],
  summary: "Get instance auth status",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            data: z.object({
              enabled: z.boolean(),
              configured: z.boolean(),
              authenticated: z.boolean(),
              email: z.string().optional(),
            }),
          }),
        },
      },
      description: "Auth status",
    },
  },
});

const magicLinkRoute = createRoute({
  method: "post",
  path: "/magic-link",
  tags: ["Auth"],
  summary: "Request a magic login link",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ email: z.string().email() }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ sent: z.boolean() }) }) } },
      description: "Magic link request accepted",
    },
    500: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Magic link failed",
    },
  },
});

const setupRoute = createRoute({
  method: "post",
  path: "/setup",
  tags: ["Auth"],
  summary: "Configure the first instance auth admin",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ email: z.string().email() }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ configured: z.boolean() }) }) } },
      description: "Instance auth configured",
    },
    400: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Instance auth is disabled",
    },
    409: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Instance auth is already configured",
    },
  },
});

const callbackRoute = createRoute({
  method: "get",
  path: "/callback",
  tags: ["Auth"],
  summary: "Consume magic login token",
  request: {
    query: z.object({ token: z.string().min(1) }),
  },
  responses: {
    302: { description: "Redirect after login" },
    400: { description: "Invalid token" },
  },
});

const logoutRoute = createRoute({
  method: "post",
  path: "/logout",
  tags: ["Auth"],
  summary: "Logout",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.object({ loggedOut: z.boolean() }) }) } },
      description: "Logged out",
    },
  },
});

const membersRoute = createRoute({
  method: "get",
  path: "/members",
  tags: ["Auth"],
  summary: "List allowed instance members",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            data: z.object({
              enabled: z.boolean(),
              members: z.array(z.object({ email: z.string() })),
            }),
          }),
        },
      },
      description: "Allowed members",
    },
    401: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Login required",
    },
  },
});

const addMemberRoute = createRoute({
  method: "post",
  path: "/members",
  tags: ["Auth"],
  summary: "Add an allowed instance member",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            email: z.string().email(),
            sendInvite: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            data: z.object({
              members: z.array(z.object({ email: z.string() })),
              invited: z.boolean().optional(),
              inviteError: z.string().optional(),
            }),
          }),
        },
      },
      description: "Member added",
    },
    401: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Login required",
    },
  },
});

const removeMemberRoute = createRoute({
  method: "delete",
  path: "/members/{email}",
  tags: ["Auth"],
  summary: "Remove an allowed instance member",
  request: {
    params: z.object({ email: z.string().min(1) }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            data: z.object({ members: z.array(z.object({ email: z.string() })) }),
          }),
        },
      },
      description: "Member removed",
    },
    400: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Cannot remove member",
    },
    401: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Login required",
    },
  },
});

type PolpoDirRef = string | (() => string);

function resolvePolpoDir(ref: PolpoDirRef): string {
  return typeof ref === "function" ? ref() : ref;
}

export function instanceAuthRoutes(polpoDir: PolpoDirRef): OpenAPIHono {
  const app = new OpenAPIHono();

  app.openapi(statusRoute, (c) => {
    const dir = resolvePolpoDir(polpoDir);
    const enabled = isInstanceAuthEnabled();
    const config = loadInstanceAuth(dir);
    const session = validateSession(dir, getCookie(c, AUTH_COOKIE_NAME));
    return c.json({
      ok: true,
      data: {
        enabled,
        configured: !!config?.enabled && config.allowedEmails.length > 0,
        authenticated: !enabled || !!session,
        email: session?.email,
      },
    }, 200);
  });

  app.openapi(magicLinkRoute, async (c) => {
    if (!isInstanceAuthEnabled()) {
      return c.json({ ok: true, data: { sent: false } }, 200);
    }

    const { email } = c.req.valid("json");
    const dir = resolvePolpoDir(polpoDir);
    const link = createMagicLink(dir, email);
    if (!link) {
      return c.json({ ok: true, data: { sent: true } }, 200);
    }

    const serverUrl = resolveServerPublicUrl(c.req.raw);
    const callbackUrl = `${serverUrl}/api/v1/auth/instance/callback?token=${encodeURIComponent(link.token)}`;
    try {
      await sendMagicLinkEmail(email, callbackUrl, link.expiresAt);
      return c.json({ ok: true, data: { sent: true } }, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to send magic link";
      return c.json({ ok: false, error: msg }, 500);
    }
  });

  app.openapi(setupRoute, async (c) => {
    if (!isInstanceAuthEnabled()) {
      return c.json({ ok: false, error: "Instance auth is disabled." }, 400);
    }

    const dir = resolvePolpoDir(polpoDir);
    const config = loadInstanceAuth(dir);
    if (config?.enabled && config.allowedEmails.length > 0) {
      return c.json({ ok: false, error: "Instance auth is already configured." }, 409);
    }

    const { email } = c.req.valid("json");
    createInitialInstanceAuth(dir, normalizeEmail(email));
    return c.json({ ok: true, data: { configured: true } }, 200);
  });

  app.openapi(callbackRoute, (c) => {
    const { token } = c.req.valid("query");
    const dir = resolvePolpoDir(polpoDir);
    const session = consumeMagicLink(dir, token);
    if (!session) {
      return c.text("Invalid or expired login link.", 400);
    }

    setCookie(c, AUTH_COOKIE_NAME, session.sessionToken, {
      httpOnly: true,
      secure: isSecureRequest(c.req.raw),
      sameSite: "Lax",
      path: "/",
      expires: new Date(session.expiresAt),
    });
    return c.redirect(resolveUiUrl(c.req.raw, "/chat"), 302);
  });

  app.openapi(logoutRoute, (c) => {
    clearSession(resolvePolpoDir(polpoDir), getCookie(c, AUTH_COOKIE_NAME));
    deleteCookie(c, AUTH_COOKIE_NAME, { path: "/" });
    return c.json({ ok: true, data: { loggedOut: true } }, 200);
  });

  app.openapi(membersRoute, (c) => {
    const dir = resolvePolpoDir(polpoDir);
    const auth = requireMemberManagementAuth(dir, getCookie(c, AUTH_COOKIE_NAME));
    if (auth) return c.json(auth, 401);
    return c.json({
      ok: true,
      data: {
        enabled: isInstanceAuthEnabled(),
        members: listAllowedEmails(dir).map((email) => ({ email })),
      },
    }, 200);
  });

  app.openapi(addMemberRoute, async (c) => {
    const dir = resolvePolpoDir(polpoDir);
    const auth = requireMemberManagementAuth(dir, getCookie(c, AUTH_COOKIE_NAME));
    if (auth) return c.json(auth, 401);
    const { email, sendInvite } = c.req.valid("json");
    const config = addAllowedEmail(dir, email);
    const normalizedEmail = normalizeEmail(email);
    let invited = false;
    let inviteError: string | undefined;

    if (sendInvite && isInstanceAuthEnabled()) {
      const link = createMagicLink(dir, normalizedEmail);
      if (link) {
        const callbackUrl = `${resolveServerPublicUrl(c.req.raw)}/api/v1/auth/instance/callback?token=${encodeURIComponent(link.token)}`;
        try {
          await sendMagicLinkEmail(normalizedEmail, callbackUrl, link.expiresAt);
          invited = true;
        } catch (err) {
          inviteError = err instanceof Error ? err.message : "Failed to send invite";
        }
      }
    }

    return c.json({
      ok: true,
      data: {
        members: config.allowedEmails.map((allowedEmail) => ({ email: allowedEmail })),
        invited,
        inviteError,
      },
    }, 200);
  });

  app.openapi(removeMemberRoute, (c) => {
    const dir = resolvePolpoDir(polpoDir);
    const auth = requireMemberManagementAuth(dir, getCookie(c, AUTH_COOKIE_NAME));
    if (auth) return c.json(auth, 401);
    const { email } = c.req.valid("param");
    const config = loadInstanceAuth(dir);
    if ((config?.allowedEmails.length ?? 0) <= 1) {
      return c.json({ ok: false, error: "At least one member must remain." }, 400);
    }
    const result = removeAllowedEmail(dir, decodeURIComponent(email));
    return c.json({
      ok: true,
      data: { members: (result?.config.allowedEmails ?? listAllowedEmails(dir)).map((allowedEmail) => ({ email: allowedEmail })) },
    }, 200);
  });

  return app;
}

function requireMemberManagementAuth(polpoDir: string, sessionToken: string | undefined): { ok: false; error: string } | null {
  if (!isInstanceAuthEnabled()) return null;
  const session = validateSession(polpoDir, sessionToken);
  return session ? null : { ok: false, error: "Login required" };
}

function resolveServerPublicUrl(req: Request): string {
  const configured = process.env.POLPO_PUBLIC_URL?.replace(/\/$/, "");
  if (configured) return configured;
  const url = new URL(req.url);
  const forwardedProto = req.headers.get("x-forwarded-proto");
  const forwardedHost = req.headers.get("x-forwarded-host");
  return `${forwardedProto ?? url.protocol.replace(":", "")}://${forwardedHost ?? url.host}`;
}

function resolveUiUrl(req: Request, path: string): string {
  const configured = process.env.POLPO_UI_PUBLIC_URL?.replace(/\/$/, "");
  if (configured) return `${configured}${path}`;
  return `${resolveServerPublicUrl(req)}${path}`;
}

function isSecureRequest(req: Request): boolean {
  const forwardedProto = req.headers.get("x-forwarded-proto");
  if (forwardedProto) return forwardedProto === "https";
  return new URL(req.url).protocol === "https:";
}

async function sendMagicLinkEmail(to: string, callbackUrl: string, expiresAt: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.AUTH_EMAIL_FROM ?? process.env.POLPO_AUTH_EMAIL_FROM;
  if (!apiKey) throw new Error("RESEND_API_KEY is required to send login links.");
  if (!from) throw new Error("AUTH_EMAIL_FROM is required to send login links.");

  const expires = new Date(expiresAt).toLocaleString();
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: "Your Polpo login link",
      text: `Open this link to access Polpo: ${callbackUrl}\n\nThis link expires at ${expires}.`,
      html: `<p>Open this link to access Polpo:</p><p><a href="${escapeHtml(callbackUrl)}">Log in to Polpo</a></p><p>This link expires at ${escapeHtml(expires)}.</p>`,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Resend failed (${response.status}): ${body || response.statusText}`);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
