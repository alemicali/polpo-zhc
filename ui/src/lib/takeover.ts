/** A takeover request's countdown: "12 min left", "1 h 5 min left", "time is up". */
export function takeoverTimeLeft(expiresAt: string, now = Date.now()): string {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "time is up";
  const min = Math.ceil(ms / 60_000);
  return min < 60 ? `${min} min left` : `${Math.floor(min / 60)} h ${min % 60} min left`;
}
