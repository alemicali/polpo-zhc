/**
 * Secret redaction for config objects exposed through the API.
 *
 * - Values under secret-looking keys (botToken, apiKey, inboundSecret,
 *   vapidPrivateKey, webhookUrl, password, ...) are masked as "••••last4".
 * - Every value inside a `headers` map is masked (Authorization, X-Api-Key, ...).
 * - Passwords embedded in URLs (e.g. settings.databaseUrl) are masked in place:
 *   postgres://user:••••@host/db
 * - `${ENV_VAR}` references are left visible: they are pointers, not secrets.
 *
 * `restoreRedactedSecrets()` is the inverse used on save: any value that still
 * carries the mask is replaced by the stored secret at the same path, so a
 * client that round-trips a redacted config never overwrites real secrets
 * with the masked placeholder.
 */

/** Marker used by every masked value. */
export const REDACTED_MARK = "••••";

const SECRET_KEY_RE =
  /(api[-_]?key|access[-_]?key|secret[-_]?key|private[-_]?key|signing[-_]?key|token|secret|password|passwd|credentials?|webhook[-_]?url|connection[-_]?string|dsn)$/i;

const HEADERS_KEY_RE = /^headers$/i;

const ENV_REF_RE = /\$\{\w+\}/g;

/** URL with a userinfo password: scheme://user:password@host... */
const URL_WITH_PASSWORD_RE = /^([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:)([^@/\s]+)(@.*)$/i;

/** True when a key name denotes a secret value. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/** True when a value is a masked placeholder produced by this module. */
export function isRedactedValue(value: unknown): boolean {
  return typeof value === "string" && value.includes(REDACTED_MARK);
}

/**
 * True when the value is (essentially) an env-var reference such as
 * "${TELEGRAM_BOT_TOKEN}" or "Bearer ${API_TOKEN}" — safe to show.
 */
export function isEnvReference(value: string): boolean {
  if (!value.includes("${")) return false;
  const literal = value.replace(ENV_REF_RE, "");
  if (literal === value) return false;
  return literal.trim().length <= 16;
}

/** Mask a literal secret, keeping env references and empty values intact. */
export function maskSecret(value: string): string {
  if (value.length === 0 || isEnvReference(value) || isRedactedValue(value)) return value;
  if (value.length >= 16) return `${REDACTED_MARK}${value.slice(-4)}`;
  return `${REDACTED_MARK}${REDACTED_MARK}`;
}

/** Mask only the password component of a URL; other strings are returned unchanged. */
export function maskUrlPassword(value: string): string {
  const m = value.match(URL_WITH_PASSWORD_RE);
  if (!m) return value;
  const password = m[2];
  if (isEnvReference(password) || isRedactedValue(password)) return value;
  return `${m[1]}${REDACTED_MARK}${m[3]}`;
}

function maskAllStrings(value: unknown): unknown {
  if (typeof value === "string") return maskSecret(value);
  if (Array.isArray(value)) return value.map(maskAllStrings);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskAllStrings(v);
    return out;
  }
  return value;
}

/**
 * Return a deep copy of `value` with secrets masked. Never mutates the input.
 */
export function redactSecrets<T>(value: T): T {
  return redactNode(value, undefined) as T;
}

function redactNode(value: unknown, key: string | undefined): unknown {
  if (key !== undefined && isSecretKey(key)) return maskAllStrings(value);
  if (key !== undefined && HEADERS_KEY_RE.test(key) && value && typeof value === "object" && !Array.isArray(value)) {
    return maskAllStrings(value);
  }
  if (typeof value === "string") return maskUrlPassword(value);
  if (Array.isArray(value)) return value.map((v) => redactNode(v, undefined));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactNode(v, k);
    return out;
  }
  return value;
}

/**
 * Merge an incoming (possibly redacted) object with the stored version:
 * every string that still carries the redaction mark is replaced with the
 * stored value at the same path. A masked value with no stored counterpart
 * is dropped, so placeholders are never persisted. Returns a new object.
 */
export function restoreRedactedSecrets<T>(incoming: T, stored: unknown): T {
  return restoreNode(incoming, stored) as T;
}

function restoreNode(incoming: unknown, stored: unknown): unknown {
  if (typeof incoming === "string") {
    if (!isRedactedValue(incoming)) return incoming;
    if (typeof stored !== "string") return undefined;
    if (incoming === stored) return stored;
    // URL with a masked password: keep the (possibly edited) URL, restore the password.
    const inUrl = incoming.match(URL_WITH_PASSWORD_RE);
    const storedUrl = stored.match(URL_WITH_PASSWORD_RE);
    if (inUrl && storedUrl && isRedactedValue(inUrl[2]) && !isRedactedValue(inUrl[1] + inUrl[3])) {
      return `${inUrl[1]}${storedUrl[2]}${inUrl[3]}`;
    }
    return stored;
  }
  if (Array.isArray(incoming)) {
    const storedArr = Array.isArray(stored) ? stored : [];
    return incoming
      .map((v, i) => restoreNode(v, storedArr[i]))
      .filter((v, i) => !(v === undefined && isRedactedValue(incoming[i])));
  }
  if (incoming && typeof incoming === "object") {
    const storedObj = stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
      const restored = restoreNode(v, storedObj[k]);
      if (restored === undefined && isRedactedValue(v)) continue;
      out[k] = restored;
    }
    return out;
  }
  return incoming;
}
