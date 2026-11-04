import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { isTrustedApiCall, TRUSTED_API_CALL_HEADER } from "@polpo-ai/server";

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
 * If no keys configured, skips auth (local dev mode) with a one-time warning.
 *
 * NOTE: API key via query string (?apiKey=) has been removed to prevent
 * credential leakage in server logs, browser history, and referrer headers.
 */
let warnedNoKeys = false;

export function authMiddleware(apiKeys: string[]): MiddlewareHandler {
  return async (c, next) => {
    if (apiKeys.length === 0) {
      if (!warnedNoKeys) {
        warnedNoKeys = true;
        console.warn("[polpo] WARNING: No API keys configured — all requests are unauthenticated. Set apiKeys in polpo.json or POLPO_API_KEY env var.");
      }
      return next();
    }

    // calls the server makes for an authenticated MCP client
    if (isTrustedApiCall(c.req.header(TRUSTED_API_CALL_HEADER))) return next();
    const auth = c.req.header("authorization");
    const key = c.req.header("x-api-key") ?? (auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : undefined);
    if (!key || !apiKeys.some(k => safeCompare(k, key))) {
      return c.json(
        { ok: false, error: "API key required", code: "AUTH_REQUIRED" },
        401
      );
    }

    return next();
  };
}
