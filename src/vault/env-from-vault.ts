/**
 * Secrets from the vault as environment variables of one command ("env_from_vault").
 *
 * The bash tool accepts a map VAR_NAME → "service.key" (or { service, key }). The host resolves
 * each reference against the agent's own and shared vault entries (the same entries vault_get
 * sees, nothing else), passes the values as environment variables to that single command, and
 * masks them in the command's output before anything else sees it (model, tool result, offloaded
 * output files, activity logs, transcripts). Nothing is written to files, and only the references
 * are ever logged.
 *
 * Masking replaces the value and its cheap encodings (base64, base64url, base64 of the value
 * followed by a newline as `echo $X | base64` prints it, URL-encoded) with "***". Values shorter
 * than MIN_MASKED_SECRET_LENGTH characters are not masked: short strings ("true", "587", "admin")
 * occur everywhere in normal output and masking them would garble it. Deliberate transformations
 * (reversing, hex, splitting) are not caught: masking prevents accidental leaks, it is not a
 * barrier against a model that wants to print a secret.
 */

import type { ResolvedVault } from "./resolver.js";

/** A vault reference: "service.key" or { service, key }. */
export type VaultRef = string | { service: string; key: string };

/** Values shorter than this are passed to the command but not masked in its output. */
export const MIN_MASKED_SECRET_LENGTH = 6;

/** The replacement for a secret in command output. */
export const SECRET_MASK = "***";

const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
/** Variables the sandbox itself sets or that change how every program starts. */
const RESERVED_ENV_VARS = new Set(["PATH", "HOME", "BASH_ENV", "ENV"]);

/** Why `name` cannot carry a secret, or undefined when it can. */
export function invalidEnvVarName(name: string): string | undefined {
  if (!ENV_VAR_NAME_RE.test(name)) return `"${name}" is not a valid variable name (use uppercase letters, digits and _, e.g. GITHUB_TOKEN)`;
  if (RESERVED_ENV_VARS.has(name) || name.startsWith("LD_")) return `"${name}" is reserved and cannot be set from the vault`;
  return undefined;
}

/** A variable name derived from a reference ("github", "token" → GITHUB_TOKEN), for hints. */
export function suggestedEnvVarName(service: string, key: string): string {
  const name = `${service}_${key}`.toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/_+/g, "_");
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

/** The reference as written in logs and the UI: "service.key". */
export function formatVaultRef(ref: VaultRef): string {
  return typeof ref === "string" ? ref.trim() : `${ref?.service ?? ""}.${ref?.key ?? ""}`;
}

export interface EnvFromVaultResult {
  /** VAR → value, for the command's environment only. Never log or return this. */
  env: Record<string, string>;
  /** The resolved values, for masking the output. */
  secrets: string[];
  /** VAR → "service.key": what may be logged and shown. */
  refs: Record<string, string>;
  /** Problems, without values. When not empty the command must not run. */
  errors: string[];
}

/** Resolve one reference. A service name may contain dots: every split is tried, the first that exists wins. */
function resolveRef(ref: VaultRef, vault: ResolvedVault): { value: string; service: string; key: string } | { error: string } {
  if (ref && typeof ref === "object") {
    const service = typeof ref.service === "string" ? ref.service.trim() : "";
    const key = typeof ref.key === "string" ? ref.key.trim() : "";
    if (!service || !key) return { error: `invalid reference ${JSON.stringify(ref)}: use "service.key" or { service, key }` };
    const creds = vault.get(service);
    if (!creds) return { error: `no vault entry "${service}"` };
    if (!Object.hasOwn(creds, key)) return { error: `vault entry "${service}" has no key "${key}" (keys: ${Object.keys(creds).join(", ") || "none"})` };
    return { value: creds[key]!, service, key };
  }
  if (typeof ref !== "string") return { error: `invalid reference: use "service.key" or { service, key }` };
  const text = ref.trim();
  const splits: Array<{ service: string; key: string }> = [];
  for (let i = text.indexOf("."); i > 0 && i < text.length - 1; i = text.indexOf(".", i + 1)) {
    splits.push({ service: text.slice(0, i), key: text.slice(i + 1) });
  }
  if (splits.length === 0) return { error: `invalid reference "${text}": use "service.key" (e.g. "github.token")` };
  for (const s of splits) {
    const creds = vault.get(s.service);
    if (creds && Object.hasOwn(creds, s.key) && typeof creds[s.key] === "string") return { value: creds[s.key]!, ...s };
  }
  const existing = splits.find((s) => vault.has(s.service));
  if (existing) {
    const keys = Object.keys(vault.get(existing.service) ?? {});
    return { error: `vault entry "${existing.service}" has no key "${existing.key}" (keys: ${keys.join(", ") || "none"})` };
  }
  return { error: `no vault entry for "${text}"` };
}

/**
 * Resolve an env_from_vault map against the agent's vault. Errors never contain values; when
 * there are errors the caller must not run the command.
 */
export function resolveEnvFromVault(spec: Record<string, VaultRef> | undefined, vault: ResolvedVault | undefined): EnvFromVaultResult {
  const out: EnvFromVaultResult = { env: {}, secrets: [], refs: {}, errors: [] };
  if (!spec || typeof spec !== "object") return out;
  const entries = Object.entries(spec);
  if (entries.length === 0) return out;
  if (!vault) {
    out.errors.push("no vault entries are available to this agent");
    return out;
  }
  let missingEntry = false;
  for (const [name, ref] of entries) {
    out.refs[name] = formatVaultRef(ref);
    const bad = invalidEnvVarName(name);
    if (bad) { out.errors.push(bad); continue; }
    const r = resolveRef(ref, vault);
    if ("error" in r) {
      out.errors.push(`${name}: ${r.error}`);
      if (r.error.startsWith("no vault entry")) missingEntry = true;
      continue;
    }
    out.env[name] = r.value;
    out.secrets.push(r.value);
  }
  if (missingEntry) {
    const services = vault.list().map((s) => s.service);
    out.errors.push(`available vault entries: ${services.length ? services.join(", ") : "none"} (vault_list shows their keys)`);
  }
  if (out.errors.length > 0) { out.env = {}; out.secrets = []; }
  return out;
}

/** `base64` (GNU coreutils) wraps its output at 76 columns. */
function wrap76(text: string): string {
  return text.length <= 76 ? text : text.match(/.{1,76}/g)!.join("\n");
}

/** The forms of a secret that are masked: the value and its cheap encodings, longest first. */
export function secretVariants(value: string): string[] {
  if (typeof value !== "string" || value.length < MIN_MASKED_SECRET_LENGTH) return [];
  const out = new Set<string>([value]);
  for (const raw of [value, `${value}\n`]) {
    const b64 = Buffer.from(raw, "utf8").toString("base64");
    out.add(b64);
    out.add(b64.replace(/=+$/, ""));
    out.add(wrap76(b64));
    out.add(Buffer.from(raw, "utf8").toString("base64url"));
  }
  const url = encodeURIComponent(value);
  out.add(url);
  out.add(url.replace(/%20/g, "+"));
  out.add(url.replace(/%2F/g, "/"));
  out.add(url.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
  return [...out].filter((v) => v.length >= MIN_MASKED_SECRET_LENGTH).sort((a, b) => b.length - a.length);
}

/** A function that replaces every given secret (and its encodings) with "***". */
export function createSecretMasker(secrets: string[]): (text: string) => string {
  const variants = [...new Set(secrets.flatMap(secretVariants))].sort((a, b) => b.length - a.length);
  if (variants.length === 0) return (text) => text;
  return (text) => {
    if (typeof text !== "string" || text.length === 0) return text;
    let out = text;
    for (const v of variants) if (out.includes(v)) out = out.split(v).join(SECRET_MASK);
    return out;
  };
}

// ─── vault_get in sandboxed runs ─────────────────────

/** Fields vault_get still shows in sandboxed runs: they locate a service, they do not unlock it. */
export const NON_SECRET_VAULT_FIELDS = [
  "host", "port", "user", "username", "from", "email", "account", "region", "endpoint", "url", "smtp_host", "imap_host",
] as const;
const NON_SECRET = new Set<string>(NON_SECRET_VAULT_FIELDS);
/** URLs with embedded credentials (user:pass@) or credential-looking query parameters stay masked. */
const URL_WITH_CREDENTIALS_RE = /:\/\/[^/\s@]*@|[?&][^=&\s]*(?:key|token|secret|sig|signature|password|passwd|pass|auth|credential)[^=&\s]*=/i;

/** True when vault_get may show this field's value in a sandboxed run. */
export function isNonSecretVaultField(key: string, value: string): boolean {
  const k = key.toLowerCase();
  if (!NON_SECRET.has(k)) return false;
  if ((k === "url" || k === "endpoint") && URL_WITH_CREDENTIALS_RE.test(value)) return false;
  return true;
}
