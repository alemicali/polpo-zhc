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

/**
 * Keys written to a project's .env through the API (provider key routes),
 * per resolved .polpo dir. Used by setup: when the wizard initializes a
 * different project directory, exactly these keys are moved there.
 */
const apiWrittenKeys = new Map<string, Set<string>>();

export function recordApiWrittenEnvKey(polpoDir: string, key: string): void {
  const dir = resolve(polpoDir);
  if (!apiWrittenKeys.has(dir)) apiWrittenKeys.set(dir, new Set());
  apiWrittenKeys.get(dir)!.add(key);
}

export function forgetApiWrittenEnvKey(polpoDir: string, key: string): void {
  apiWrittenKeys.get(resolve(polpoDir))?.delete(key);
}

/** Return and clear the keys recorded for `polpoDir`. */
export function takeApiWrittenEnvKeys(polpoDir: string): string[] {
  const dir = resolve(polpoDir);
  const keys = [...(apiWrittenKeys.get(dir) ?? [])];
  apiWrittenKeys.delete(dir);
  return keys;
}

/**
 * Move the given keys from one .polpo/.env to another: upsert into the
 * destination (values re-validated), then remove them from the source so
 * secrets saved during setup don't linger in the starting directory.
 * Returns the keys moved.
 */
export function moveEnvEntries(fromPolpoDir: string, toPolpoDir: string, keys: Iterable<string>): string[] {
  const fromPath = join(fromPolpoDir, ".env");
  if (!existsSync(fromPath)) return [];
  const wanted = new Set(keys);
  const moved: string[] = [];
  for (const line of readFileSync(fromPath, "utf-8").split("\n")) {
    const key = lineKey(line);
    if (!key || !wanted.has(key) || moved.includes(key)) continue;
    const trimmed = line.trim();
    const value = trimmed.slice(trimmed.indexOf("=") + 1).trim();
    try {
      persistToEnvFile(toPolpoDir, key, value);
      moved.push(key);
    } catch { /* skip invalid entries */ }
  }
  for (const key of moved) removeFromEnvFile(fromPolpoDir, key);
  return moved;
}
