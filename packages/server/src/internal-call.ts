/**
 * Marks requests the server sends to itself (turn scheduler, channel runner, background-wait
 * continuations). Only those may use the internal completion headers — x-polpo-lease (hand a
 * session lease over), unbounded x-polpo-lease-wait and x-polpo-skip-user-message. The marker
 * is a per-process random secret that never leaves the process.
 */

export const INTERNAL_CALL_HEADER = "x-polpo-internal-call";

const SECRET: string = (() => {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
})();

/** Headers that mark a request as sent by this process to itself. */
export function internalCallHeaders(): Record<string, string> {
  return { [INTERNAL_CALL_HEADER]: SECRET };
}

/** Was this request sent by this process? (constant-time comparison) */
export function isInternalCall(value: string | undefined | null): boolean {
  if (!value || value.length !== SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < SECRET.length; i++) diff |= value.charCodeAt(i) ^ SECRET.charCodeAt(i);
  return diff === 0;
}
