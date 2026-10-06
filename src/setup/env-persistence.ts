import { join, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";

/** Valid env var names: letters, digits, underscore; not starting with a digit. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

export function isValidEnvKey(key: unknown): key is string {
  return typeof key === "string" && key.length <= 256 && ENV_KEY_RE.test(key);
}

/** Throws when the key/value pair cannot be written as a single, inert .env line. */
export function assertValidEnvEntry(envVar: string, value: string): void {
  if (!isValidEnvKey(envVar)) {
    throw new Error(`Invalid environment variable name: ${JSON.stringify(String(envVar).slice(0, 64))}`);
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid value for ${envVar}: must be a string`);
  }
  if (CONTROL_CHARS_RE.test(value)) {
    // Newlines would let a value inject extra variables into .env.
    throw new Error(`Invalid value for ${envVar}: newlines and control characters are not allowed`);
  }
  if (value.length > 16_384) {
    throw new Error(`Invalid value for ${envVar}: too long`);
  }
}

function lineKey(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const eq = trimmed.indexOf("=");
  if (eq === -1) return undefined;
  return trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
}

/**
 * Persist an env var to the .polpo/.env file (upsert semantics).
 *
 * Line-based rewrite (no regex replacement strings, so "$&" / "$1" in the
 * value are written literally). Rejects invalid names and values containing
 * newlines/control characters.
 */
export function persistToEnvFile(polpoDir: string, envVar: string, value: string): void {
  assertValidEnvEntry(envVar, value);
  const envPath = join(polpoDir, ".env");
  if (!existsSync(polpoDir)) mkdirSync(polpoDir, { recursive: true });

  const newLine = `${envVar}=${value}`;
  const lines = existsSync(envPath) ? readFileSync(envPath, "utf-8").split("\n") : [];
  let replaced = false;
  const out: string[] = [];
  for (const line of lines) {
    if (lineKey(line) === envVar) {
      if (!replaced) out.push(newLine);
      replaced = true;
      continue; // drop duplicates of the same key
    }
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  if (!replaced) out.push(newLine);

  writeFileSync(envPath, `${out.join("\n")}\n`, { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(envPath, 0o600); } catch { /* best-effort */ }
}

/**
 * Remove an env var from the .polpo/.env file.
 */
export function removeFromEnvFile(polpoDir: string, envVar: string): void {
  if (!isValidEnvKey(envVar)) return;
  const envPath = join(polpoDir, ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf-8").split("\n");
  const updated = lines.filter((line) => lineKey(line) !== envVar).join("\n");
  writeFileSync(envPath, updated, "utf-8");
}

/** Current value of `key` in `<polpoDir>/.env`, or undefined when absent. */
export function readEnvFileValue(polpoDir: string, key: string): string | undefined {
  const envPath = join(polpoDir, ".env");
  if (!existsSync(envPath)) return undefined;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    if (lineKey(line) !== key) continue;
    const trimmed = line.trim();
    return trimmed.slice(trimmed.indexOf("=") + 1).trim();
  }
  return undefined;
}

/**
 * Keys written to a project's .env through the API (provider key routes),
 * per resolved .polpo dir, with the value each key had BEFORE the first API
 * write (undefined = the key did not exist). Used by setup: when the wizard
 * initializes a different project directory, these keys are moved there and
 * the starting .env is put back exactly as it was.
 *
 * In-memory only: after a restart nothing is recorded, so nothing is moved
 * and nothing is ever deleted from the starting .env.
 */
const apiWrittenKeys = new Map<string, Map<string, string | undefined>>();

/** Call BEFORE persisting `key` through the API: remembers the pre-existing value once. */
export function recordApiWrittenEnvKey(polpoDir: string, key: string): void {
  const dir = resolve(polpoDir);
  if (!apiWrittenKeys.has(dir)) apiWrittenKeys.set(dir, new Map());
  const keys = apiWrittenKeys.get(dir)!;
  if (!keys.has(key)) keys.set(key, readEnvFileValue(polpoDir, key));
}

export function forgetApiWrittenEnvKey(polpoDir: string, key: string): void {
  apiWrittenKeys.get(resolve(polpoDir))?.delete(key);
}

export interface ApiWrittenEnvKey {
  key: string;
  /** Value before setup wrote it; undefined when the key did not exist. */
  previous: string | undefined;
}

/** Return and clear the keys recorded for `polpoDir`. */
export function takeApiWrittenEnvKeys(polpoDir: string): ApiWrittenEnvKey[] {
  const dir = resolve(polpoDir);
  const entries = [...(apiWrittenKeys.get(dir) ?? new Map<string, string | undefined>())]
    .map(([key, previous]) => ({ key, previous }));
  apiWrittenKeys.delete(dir);
  return entries;
}

/**
 * Move keys written by the setup flow from one .polpo/.env to another:
 * upsert the current value into the destination, then put the source back
 * as it was before setup — remove keys that did not exist, restore the
 * previous value of keys that did. Returns the keys moved.
 */
export function moveEnvEntries(fromPolpoDir: string, toPolpoDir: string, entries: Iterable<ApiWrittenEnvKey>): string[] {
  const moved: string[] = [];
  for (const { key, previous } of entries) {
    const value = readEnvFileValue(fromPolpoDir, key);
    if (value === undefined) continue;
    try {
      persistToEnvFile(toPolpoDir, key, value);
    } catch {
      continue; // invalid entry: leave the source untouched
    }
    moved.push(key);
    if (previous === undefined) removeFromEnvFile(fromPolpoDir, key);
    else persistToEnvFile(fromPolpoDir, key, previous);
  }
  return moved;
}
