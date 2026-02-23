/**
 * In-memory sliding-window rate limiter middleware.
 *
 * Tracks requests per IP using x-forwarded-for header (or "unknown").
 * Returns 429 Too Many Requests with Retry-After header when limit exceeded.
 * Expired entries are cleaned up periodically.
 */

import type { MiddlewareHandler } from "hono";

interface WindowEntry {
  count: number;
  windowStart: number;
}

const DEFAULT_MAX_REQS = 200;
const DEFAULT_WINDOW_MS = 60_000; // 1 minute
const CLEANUP_INTERVAL_MS = 60_000; // 1 minute

/**
 * Rate limiting middleware.
 *
 * @param maxReqs - Maximum requests per window (default: 200)
 * @param windowMs - Window duration in ms (default: 60000)
 */
export function rateLimitMiddleware(
  maxReqs: number = DEFAULT_MAX_REQS,
  windowMs: number = DEFAULT_WINDOW_MS,
): MiddlewareHandler {
  const windows = new Map<string, WindowEntry>();

  // Periodic cleanup of expired entries
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of windows) {
      if (now - entry.windowStart > windowMs) {
        windows.delete(ip);
      }
    }
  }, CLEANUP_INTERVAL_MS);

  // Don't keep the process alive just for cleanup
  if (cleanup.unref) cleanup.unref();

  return async (c, next) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const now = Date.now();

    let entry = windows.get(ip);
    if (!entry || now - entry.windowStart > windowMs) {
      // New window
      entry = { count: 1, windowStart: now };
      windows.set(ip, entry);
    } else {
      entry.count++;
    }

    if (entry.count > maxReqs) {
      const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);
      c.header("Retry-After", String(retryAfter));
      return c.json(
        { ok: false, error: "Too many requests", code: "RATE_LIMITED" },
        429 as any,
      );
    }

    return next();
  };
}
