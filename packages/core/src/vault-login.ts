/**
 * Logins whose password Polpo generates: an agent (vault_create_login) or a person (REST, MCP,
 * the dashboard) asks for a new account's credentials, Polpo makes the password with a CSPRNG and
 * stores it in the owner's vault. The password is never returned to whoever asked: agents fill it
 * with browser_fill { from_vault: "<service>.password" } (or bash env_from_vault), people see it
 * only where the dashboard lets them.
 *
 * Store-agnostic (any VaultStore) and runtime-agnostic (Web Crypto: Node 22+, browsers).
 */
import type { VaultEntry, VaultEntryMetadata, VaultEntryProvenance } from "./types.js";
import type { VaultStore } from "./vault-store.js";
import { isReservedVaultOwner } from "./vault-store.js";

export const VAULT_PASSWORD_DEFAULT_LENGTH = 24;
export const VAULT_PASSWORD_MIN_LENGTH = 16;
export const VAULT_PASSWORD_MAX_LENGTH = 64;

export const VAULT_PASSWORD_LOWER = "abcdefghijklmnopqrstuvwxyz";
export const VAULT_PASSWORD_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const VAULT_PASSWORD_DIGITS = "0123456789";
/** Symbols most sites accept: no quotes, backslash, space, backtick or characters shells and forms mangle. */
export const VAULT_PASSWORD_SYMBOLS = "!#$%&()*+,-./:;<=>?@[]^_{|}~";

/** A vault service name an agent can reference as "service.key": letters, digits, _ and -. */
export const VAULT_SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

type RandomSource = (bytes: Uint8Array) => Uint8Array;

const defaultRandom: RandomSource = (bytes) => {
  const c = (globalThis as unknown as { crypto?: { getRandomValues<T extends Uint8Array>(a: T): T } }).crypto;
  if (!c?.getRandomValues) throw new Error("No secure random source available (Web Crypto)");
  return c.getRandomValues(bytes);
};

/** An unbiased random integer in [0, n) (rejection sampling over bytes; n ≤ 256). */
function randomIndex(n: number, random: RandomSource): number {
  if (n <= 0 || n > 256) throw new Error(`randomIndex: bad range ${n}`);
  const limit = 256 - (256 % n);
  const buf = new Uint8Array(1);
  for (;;) {
    random(buf);
    if (buf[0]! < limit) return buf[0]! % n;
  }
}

export interface VaultPasswordOptions {
  /** Default 24, between 16 and 64. */
  length?: number;
  /** Include symbols (default true): some sites reject them. */
  symbols?: boolean;
}

/** The length to use: default 24, refused outside 16–64 or not an integer. */
export function vaultPasswordLengthProblem(length: unknown): string | undefined {
  if (length === undefined || length === null) return undefined;
  if (typeof length !== "number" || !Number.isInteger(length)) return "length must be an integer";
  if (length < VAULT_PASSWORD_MIN_LENGTH || length > VAULT_PASSWORD_MAX_LENGTH) {
    return `length must be between ${VAULT_PASSWORD_MIN_LENGTH} and ${VAULT_PASSWORD_MAX_LENGTH}`;
  }
  return undefined;
}

/**
 * A random password: every character uniformly from the alphabet, at least one lowercase,
 * uppercase, digit and (with symbols) symbol, in random positions.
 */
export function generateVaultPassword(opts: VaultPasswordOptions = {}, random: RandomSource = defaultRandom): string {
  const length = opts.length ?? VAULT_PASSWORD_DEFAULT_LENGTH;
  const problem = vaultPasswordLengthProblem(length);
  if (problem) throw new Error(problem);
  const classes = [VAULT_PASSWORD_LOWER, VAULT_PASSWORD_UPPER, VAULT_PASSWORD_DIGITS, ...(opts.symbols === false ? [] : [VAULT_PASSWORD_SYMBOLS])];
  const alphabet = classes.join("");
  const chars: string[] = classes.map((set) => set[randomIndex(set.length, random)]!);
  while (chars.length < length) chars.push(alphabet[randomIndex(alphabet.length, random)]!);
  // Fisher–Yates: the required characters land anywhere
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1, random);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

// ─── Creating a login ───

export interface VaultLoginRequest {
  /** The vault service (slug), e.g. "sitoinchat". */
  service: string;
  username?: string;
  email?: string;
  /** The site. */
  url?: string;
  label?: string;
  length?: number;
  symbols?: boolean;
  /** Replace the password of an existing login (keeps username, email and url). */
  rotate?: boolean;
}

export type VaultLoginResult =
  | {
      ok: true;
      service: string;
      action: "created" | "rotated";
      /** Credential key names (never values). */
      keys: string[];
      label?: string;
      /** The stored credentials, password included: for the caller's own masker / vault cache. Never show them. */
      credentials: Record<string, string>;
      metadata: VaultEntryMetadata;
    }
  | { ok: false; code: "invalid" | "exists" | "not_found" | "not_login" | "reserved"; error: string };

/** The hint agents get: how to use the password without seeing it. */
export function vaultLoginFillHint(service: string): string {
  return `browser_fill { from_vault: "${service}.password" }`;
}

/** Problems with a request (empty when valid). */
export function vaultLoginRequestProblems(req: Partial<VaultLoginRequest> | undefined): string[] {
  const problems: string[] = [];
  if (!req || typeof req !== "object") return ["a service is required"];
  if (typeof req.service !== "string" || !VAULT_SERVICE_PATTERN.test(req.service.trim())) {
    problems.push("service must be a slug of letters, digits, _ or - (e.g. \"sitoinchat\"), at most 63 characters");
  }
  for (const k of ["username", "email", "url", "label"] as const) {
    const v = req[k];
    if (v !== undefined && v !== null && (typeof v !== "string" || v.length > 500)) problems.push(`${k} must be a text of at most 500 characters`);
  }
  if (typeof req.email === "string" && req.email.trim() && !/^[^\s@]+@[^\s@]+$/.test(req.email.trim())) problems.push("email is not an email address");
  if (typeof req.url === "string" && req.url.trim() && !/^https?:\/\/\S+$/i.test(req.url.trim())) problems.push("url must start with http:// or https://");
  const lengthProblem = vaultPasswordLengthProblem(req.length);
  if (lengthProblem) problems.push(lengthProblem);
  if (req.symbols !== undefined && req.symbols !== null && typeof req.symbols !== "boolean") problems.push("symbols must be true or false");
  if (req.rotate !== undefined && req.rotate !== null && typeof req.rotate !== "boolean") problems.push("rotate must be true or false");
  return problems;
}

/** "sitoinchat" → "Sitoinchat"; "my-site" → "My-site". */
function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/**
 * Create (or, with rotate, re-key) a login in `owner`'s vault with a generated password.
 * The owner always comes from the caller's context (the run, the chat, the URL a person chose),
 * never from what an agent wrote. Refuses an existing entry without rotate.
 */
export async function generateVaultLogin(
  store: Pick<VaultStore, "get" | "set">,
  owner: string,
  req: VaultLoginRequest,
  provenance: VaultEntryProvenance,
  opts: { ownerDisplayName?: string; now?: () => Date; random?: RandomSource } = {},
): Promise<VaultLoginResult> {
  if (!owner || typeof owner !== "string" || isReservedVaultOwner(owner)) {
    return { ok: false, code: "reserved", error: "This vault cannot be written from here" };
  }
  const problems = vaultLoginRequestProblems(req);
  if (problems.length) return { ok: false, code: "invalid", error: problems.join("; ") };
  const service = req.service.trim();
  const at = (opts.now ?? (() => new Date()))().toISOString();
  const password = generateVaultPassword({ ...(req.length !== undefined ? { length: req.length } : {}), ...(req.symbols !== undefined ? { symbols: req.symbols } : {}) }, opts.random);
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const existing = await store.get(owner, service);

  if (existing && !req.rotate) {
    return {
      ok: false, code: "exists",
      error: `A vault entry "${service}" already exists. Use it (from_vault "${service}.password"), pick another service name, or pass rotate: true to replace its password.`,
    };
  }
  if (!existing && req.rotate) {
    return { ok: false, code: "not_found", error: `There is no vault entry "${service}" to rotate: create it first (without rotate).` };
  }

  let entry: VaultEntry;
  let action: "created" | "rotated";
  if (existing) {
    if (existing.type !== "login") {
      return { ok: false, code: "not_login", error: `The vault entry "${service}" is a ${existing.type} entry, not a login: its password cannot be rotated here.` };
    }
    const credentials: Record<string, string> = { ...existing.credentials, password };
    for (const k of ["username", "email", "url"] as const) {
      if (!credentials[k] && text(req[k])) credentials[k] = text(req[k])!;
    }
    const generated = Array.from(new Set([...(existing.metadata?.generated ?? []), "password"]));
    entry = {
      ...existing,
      credentials,
      metadata: { ...(existing.metadata ?? {}), rotatedAt: at, rotatedBy: provenance, generated },
    };
    action = "rotated";
  } else {
    const credentials: Record<string, string> = {};
    if (text(req.username)) credentials.username = text(req.username)!;
    if (text(req.email)) credentials.email = text(req.email)!;
    credentials.password = password;
    if (text(req.url)) credentials.url = text(req.url)!;
    entry = {
      type: "login",
      label: text(req.label) ?? `${capitalize(service)} – ${opts.ownerDisplayName?.trim() || owner}`,
      credentials,
      metadata: { createdBy: provenance, createdAt: at, generated: ["password"] },
    };
    action = "created";
  }
  await store.set(owner, service, entry);
  return {
    ok: true, service, action, keys: Object.keys(entry.credentials),
    ...(entry.label ? { label: entry.label } : {}),
    credentials: entry.credentials, metadata: entry.metadata!,
  };
}

/**
 * The metadata after a patch: what was there, minus the generated marks of keys a person (or a
 * tool) has just replaced.
 */
export function vaultMetadataAfterPatch(
  existing: VaultEntryMetadata | undefined, credentials: Record<string, string> | undefined,
): VaultEntryMetadata | undefined {
  if (!existing) return undefined;
  if (!credentials || !existing.generated?.length) return existing;
  const generated = existing.generated.filter((k) => !Object.hasOwn(credentials, k));
  const { generated: _g, ...rest } = existing;
  return generated.length ? { ...rest, generated } : rest;
}

/** The non-secret provenance fields a listing shows (flattened). */
export function vaultEntryProvenanceView(metadata: VaultEntryMetadata | undefined): {
  createdBy?: VaultEntryProvenance; createdAt?: string; rotatedAt?: string; rotatedBy?: VaultEntryProvenance; generated?: string[];
} {
  if (!metadata) return {};
  return {
    ...(metadata.createdBy ? { createdBy: metadata.createdBy } : {}),
    ...(metadata.createdAt ? { createdAt: metadata.createdAt } : {}),
    ...(metadata.rotatedAt ? { rotatedAt: metadata.rotatedAt } : {}),
    ...(metadata.rotatedBy ? { rotatedBy: metadata.rotatedBy } : {}),
    ...(metadata.generated?.length ? { generated: metadata.generated } : {}),
  };
}
