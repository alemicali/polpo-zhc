/**
 * Tiny ETag helper for list endpoints.
 *
 * Why: cold-load over Tailscale spends 100-300ms per request on TLS +
 * RTT baseline. Returning 304 Not Modified on unchanged lists turns the
 * heaviest payloads (tasks, missions, sessions, agents) into a sub-KB
 * conditional response. Bandwidth saving is significant on /tasks where
 * even the slim projection can be 50-80KB across hundreds of rows.
 *
 * Hash strategy: md5 over a stable short fingerprint. We let callers
 * compute the fingerprint themselves (count + max(updatedAt) is cheap
 * and avoids re-serializing the body twice); for arrays of objects with
 * `updatedAt`/`createdAt`, `quickFingerprint()` does this in one pass.
 *
 * Not for: streaming endpoints (SSE has no notion of If-None-Match for
 * the open stream itself), mutation endpoints, or detail endpoints that
 * are already cheap on a single record.
 */

import { createHash } from "node:crypto";
import type { Context } from "hono";

/** Compute a quick fingerprint for an array of records keyed by id + timestamp.
 *  Accepts loosely-typed records — typed entities (`Task`, `Mission`,
 *  `AgentConfig`) don't carry an index signature so we widen at the
 *  boundary rather than spreading `Record<string, unknown>` through the
 *  domain types. */
export function quickFingerprint(items: ReadonlyArray<unknown>): string {
  // Iterate once: capture count and the most recent updatedAt/createdAt.
  // Add a few stable per-row touches (id + status when present) so a row
  // status-flipping bumps the hash even if updatedAt didn't change.
  let maxTs = "";
  const parts: string[] = [String(items.length)];
  for (const item of items) {
    const it = item as Record<string, unknown>;
    const ts = (it.updatedAt as string | undefined) ?? (it.createdAt as string | undefined) ?? "";
    if (ts > maxTs) maxTs = ts;
    // status flip without updatedAt change is rare but possible — fold a
    // tiny per-row digest in so the hash still moves.
    const id = (it.id as string | undefined) ?? (it.name as string | undefined) ?? "";
    const status = (it.status as string | undefined) ?? "";
    if (id || status) parts.push(`${id}:${status}`);
  }
  parts.push(maxTs);
  return createHash("md5").update(parts.join("|")).digest("hex").slice(0, 16);
}

/** Build an ETag string in the standard quoted-hex form. */
export function buildETag(hash: string): string {
  return `"${hash}"`;
}

/**
 * Conditional GET helper.
 *
 * Returns `true` if the response was already shortcut to 304 — the caller
 * should `return c.body(null, 304)` immediately. Otherwise it sets the
 * ETag header on the outgoing response and the caller proceeds normally.
 *
 * Usage:
 *   const etag = buildETag(quickFingerprint(items));
 *   if (handleConditional(c, etag)) return c.body(null, 304);
 *   return c.json({ ok: true, data: items });
 */
export function handleConditional(c: Context, etag: string): boolean {
  const ifNoneMatch = c.req.header("if-none-match");
  if (ifNoneMatch && ifNoneMatch === etag) {
    c.header("ETag", etag);
    c.header("Cache-Control", "private, must-revalidate");
    return true;
  }
  c.header("ETag", etag);
  c.header("Cache-Control", "private, must-revalidate");
  return false;
}
