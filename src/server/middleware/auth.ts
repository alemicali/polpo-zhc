import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * API key authentication middleware.
 * Checks X-API-Key header against configured keys.
 * If no keys configured, skips auth (local dev mode).
 */
export function authMiddleware(apiKeys: string[]): MiddlewareHandler {
  return async (c, next) => {
    if (apiKeys.length === 0) {
      return next();
    }

    const key = c.req.header("x-api-key") || c.req.query("apiKey");
    if (!key || !apiKeys.some(k => safeCompare(k, key))) {
      return c.json(
        { ok: false, error: "API key required", code: "AUTH_REQUIRED" },
        401
      );
    }

    return next();
  };
}
