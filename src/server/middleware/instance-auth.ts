import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { AUTH_COOKIE_NAME, isInstanceAuthEnabled, validateSession } from "../auth/instance-auth.js";

export function instanceAuthMiddleware(polpoDir: string, apiKeys: string[] = []): MiddlewareHandler {
  return async (c, next) => {
    if (!isInstanceAuthEnabled()) return next();
    if (hasValidApiKey(c.req.raw, apiKeys)) return next();
    const session = validateSession(polpoDir, getCookie(c, AUTH_COOKIE_NAME));
    if (!session) {
      return c.json({ ok: false, error: "Login required", code: "AUTH_REQUIRED" }, 401);
    }
    return next();
  };
}

function hasValidApiKey(req: Request, apiKeys: string[]): boolean {
  if (apiKeys.length === 0) return false;
  const xApiKey = req.headers.get("x-api-key");
  const auth = req.headers.get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : undefined;
  const key = xApiKey ?? bearer;
  return !!key && apiKeys.some((expected) => safeCompare(expected, key));
}

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
