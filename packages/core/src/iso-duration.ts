// ── ISO 8601 Duration Parser ──────────────────────────────────────────
// Supports: P[nY][nM][nW][nD][T[nH][nM][nS]]
// Examples: PT2H (2 hours), PT30M (30 min), P1D (1 day), P1DT6H (1 day 6 hours)
// Letters are case-insensitive ("PT1s" is PT1S) and surrounding spaces are ignored.

const ISO_DURATION_RE = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** Duration in milliseconds; throws on anything but a non-empty ISO 8601 duration. */
export function parseISO8601Duration(duration: string): number {
  const normalized = duration.trim().toUpperCase();
  const m = ISO_DURATION_RE.exec(normalized);
  // "P" and "PT" match the pattern but say nothing.
  if (!m || normalized === "P" || normalized.endsWith("T")) {
    throw new Error(`Invalid ISO 8601 duration: "${duration}" (examples: PT30S, PT30M, PT2H, P1D)`);
  }
  const years   = parseInt(m[1] || "0", 10);
  const months  = parseInt(m[2] || "0", 10);
  const weeks   = parseInt(m[3] || "0", 10);
  const days    = parseInt(m[4] || "0", 10);
  const hours   = parseInt(m[5] || "0", 10);
  const minutes = parseInt(m[6] || "0", 10);
  const seconds = parseFloat(m[7] || "0");
  // Approximate: 1 year ≈ 365.25 days, 1 month ≈ 30.44 days
  const totalDays = years * 365.25 + months * 30.44 + weeks * 7 + days;
  return ((totalDays * 24 + hours) * 60 + minutes) * 60000 + seconds * 1000;
}

export function isValidISO8601Duration(duration: string): boolean {
  try { parseISO8601Duration(duration); return true; } catch { return false; }
}
