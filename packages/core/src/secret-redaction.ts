/**
 * Secret redaction for config objects exposed through the API.
 *
 * - Values under secret-looking keys (botToken, apiKey(s), inboundSecret,
 *   vapidPrivateKey, routingKey, password/pass, ...) are masked as "••••last4".
 * - Every value inside a `headers` map is masked (Authorization, X-Api-Key, ...).
 * - Capability URLs (`url`, `webhookUrl`: Slack/Zapier/n8n hooks, tokens in
 *   path or query) keep only scheme + host: "https://hooks.zapier.com/••••abcd".
 * - Passwords embedded in any URL (e.g. settings.databaseUrl) are masked in
 *   place: postgres://user:••••@host/db
 * - Pure `${ENV_VAR}` references are left visible: they are pointers, not
 *   secrets. Mixed values ("Bearer ${X}", "abc${X}") are masked.
 *
 * `restoreRedactedSecrets()` is the inverse used on save: any value that still
 * carries the mask is replaced by the stored secret at the same path, so a
 * client that round-trips a redacted config never overwrites real secrets
 * with the masked placeholder.
 */

/** Marker used by every masked value. */
export const REDACTED_MARK = "••••";

const SECRET_KEY_RE =
  /(keys?|tokens?|secrets?|passwords?|passwd|pass|credentials?|connection[-_]?string|dsn)$/i;

/** Public keys are not secrets (e.g. push vapidPublicKey). */
const PUBLIC_KEY_RE = /public[-_]?keys?$/i;

/** URL fields whose path/query act as a capability (anyone with the URL can post). */
const CAPABILITY_URL_KEY_RE = /^(url|webhook[-_]?url)$/i;

const HEADERS_KEY_RE = /^headers$/i;

const ENV_REF_RE = /\$\{\w+\}/g;

/** URL with a userinfo password: scheme://user:password@host... */
const URL_WITH_PASSWORD_RE = /^([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:)([^@/\s]+)(@.*)$/i;

/** scheme://host[:port] followed by a non-trivial path, query or fragment. */
const URL_WITH_PATH_RE = /^([a-z][a-z0-9+.-]*:\/\/[^/?#\s]+)([/?#].*)$/i;

/** True when a key name denotes a secret value. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key) && !PUBLIC_KEY_RE.test(key);
}

/** True when a value is a masked placeholder produced by this module. */
export function isRedactedValue(value: unknown): boolean {
  return typeof value === "string" && value.includes(REDACTED_MARK);
}

/**
 * True when the value consists only of `${ENV_VAR}` references (e.g.
 * "${TELEGRAM_BOT_TOKEN}") — safe to show. Any literal text mixed in
 * ("Bearer ${X}", "sk-live-${X}") disqualifies it.
 */
export function isEnvReference(value: string): boolean {
  if (!value.includes("${")) return false;
  const literal = value.replace(ENV_REF_RE, "");
  return literal !== value && literal.trim().length === 0;
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

/**
 * Mask a capability URL, keeping scheme + host visible:
 * "https://hooks.slack.com/services/T/B/xyz1234" → "https://hooks.slack.com/••••1234".
 * Non-URL values are masked entirely; origin-only URLs stay visible.
 */
export function maskCapabilityUrl(value: string): string {
  if (value.length === 0 || isEnvReference(value) || isRedactedValue(value)) return value;
  const withoutPassword = maskUrlPassword(value);
  const m = withoutPassword.match(URL_WITH_PATH_RE);
  if (!m) {
    return /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]+\/?$/i.test(withoutPassword) ? withoutPassword : maskSecret(value);
  }
  if (m[2] === "/") return withoutPassword;
  return `${m[1]}/${REDACTED_MARK}${value.slice(-4)}`;
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
  if (key !== undefined && CAPABILITY_URL_KEY_RE.test(key) && typeof value === "string") return maskCapabilityUrl(value);
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

/** Thrown by restoreRedactedSecrets({ strict: true }) when a masked value has no stored counterpart. */
export class UnrestorableSecretError extends Error {
  constructor(public readonly paths: string[]) {
    super(
      `Masked secret value(s) cannot be restored: ${paths.join(", ")}. ` +
      `Re-enter the secret (the hidden "••••" value only works for an unchanged, already saved field).`,
    );
    this.name = "UnrestorableSecretError";
  }
}

/**
 * Merge an incoming (possibly redacted) object with the stored version:
 * every string that still carries the redaction mark is replaced with the
 * stored value at the same path.
 *
 * A masked value with no stored counterpart (e.g. a channel saved under a
 * new name) cannot be restored: with `strict: true` this throws
 * UnrestorableSecretError (callers answer 400); otherwise the field is
 * dropped. Placeholders are never persisted. Returns a new object.
 */
export function restoreRedactedSecrets<T>(incoming: T, stored: unknown, opts: { strict?: boolean } = {}): T {
  const missing: string[] = [];
  const out = restoreNode(incoming, stored, "", missing) as T;
  if (opts.strict && missing.length > 0) throw new UnrestorableSecretError(missing);
  return out;
}

function restoreNode(incoming: unknown, stored: unknown, path: string, missing: string[]): unknown {
  if (typeof incoming === "string") {
    if (!isRedactedValue(incoming)) return incoming;
    if (typeof stored !== "string") {
      missing.push(path || "(value)");
      return undefined;
    }
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
      .map((v, i) => restoreNode(v, storedArr[i], `${path}[${i}]`, missing))
      .filter((v, i) => !(v === undefined && isRedactedValue(incoming[i])));
  }
  if (incoming && typeof incoming === "object") {
    const storedObj = stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
      const restored = restoreNode(v, storedObj[k], path ? `${path}.${k}` : k, missing);
      if (restored === undefined && isRedactedValue(v)) continue;
      out[k] = restored;
    }
    return out;
  }
  return incoming;
}
