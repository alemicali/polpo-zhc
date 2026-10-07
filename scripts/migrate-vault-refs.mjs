#!/usr/bin/env node
/**
 * Move the remote sandbox provider keys (Daytona, E2B) out of the old system vault owner
 * "$sandbox" into an agent's vault, and point the instance settings at them (vault references).
 *
 * Before: vault rows ("$sandbox", "sandbox-provider:daytona" | "sandbox-provider:e2b") holding
 *         { apiKey, apiUrl?, target?, domain?, template? }.
 * After:  vault rows (<owner>, "daytona" | "e2b"), type api_key, credentials { apiKey };
 *         settings.sandbox.providers.<id> = { credential: { owner, service }, apiUrl?, target?, domain?, template? };
 *         the "$sandbox" rows are deleted once the instance confirms it finds the key.
 *
 * One instance per run. Run it from the repository root (it uses the built @polpo-ai/drizzle and
 * @polpo-ai/vault-crypto packages), with the instance's new code already deployed (it must serve
 * GET /api/v1/sandbox/providers with `keyFound`). It never prints key values, only names.
 *
 *   node scripts/migrate-vault-refs.mjs --port <api port> --db-env <path to db-<x>.env> --owner <agent> [--dry-run]
 *
 * Options:
 *   --port      the instance API port on 127.0.0.1 (settings are changed through PATCH /api/v1/config/settings)
 *   --db-env    env file with DATABASE_URL (the instance's PostgreSQL database)
 *   --owner     the agent that will own the entries (share them later from its Credentials tab if needed)
 *   --dry-run   show what would change, change nothing
 *   --api-key-env <NAME>  env var holding the instance API key, when the API requires one (default POLPO_API_KEY)
 *
 * The vault key is resolved like the server does: POLPO_VAULT_KEY, else ~/.polpo/vault.key. If
 * the instance runs with its own POLPO_VAULT_KEY, export the same one before running this.
 *
 * Idempotent: an entry already copied with the same key is not rewritten, settings already
 * pointing at it are not patched again, and when the "$sandbox" rows are gone there is nothing to do.
 * If <owner> already has a "daytona"/"e2b" entry with a different key, that provider is skipped
 * (nothing overwritten, nothing deleted) and reported.
 *
 * Intended runs (2026-10):
 *   Lumea      node scripts/migrate-vault-refs.mjs --port 3001 --db-env ~/.config/polpo/db-lumea.env     --owner alessio
 *   Shoplix    node scripts/migrate-vault-refs.mjs --port 3000 --db-env ~/.config/polpo/db-shoplix.env   --owner alessio-micali
 *   Choosy     node scripts/migrate-vault-refs.mjs --port 3002 --db-env ~/.config/polpo/db-choosy.env    --owner integrazioni-polpo
 *   Insurtech  node scripts/migrate-vault-refs.mjs --port 3003 --db-env ~/.config/polpo/db-insurtech.env --owner operatore-generale
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const OLD_OWNER = "$sandbox";
export const PROVIDERS = ["daytona", "e2b"];
export const oldService = (id) => `sandbox-provider:${id}`;
const OPTION_FIELDS = ["apiUrl", "target", "domain", "template"];

// ── Pure parts (unit-tested) ─────────────────────────────────────────

export function parseArgs(argv) {
  const out = { dryRun: false, apiKeyEnv: "POLPO_API_KEY" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--port") out.port = Number(next());
    else if (arg === "--db-env") out.dbEnv = next();
    else if (arg === "--owner") out.owner = next();
    else if (arg === "--api-key-env") out.apiKeyEnv = next();
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (out.help) return out;
  if (!Number.isInteger(out.port) || out.port <= 0) throw new Error("--port <api port> is required");
  if (!out.dbEnv) throw new Error("--db-env <path> is required");
  if (!out.owner || !out.owner.trim()) throw new Error("--owner <agent> is required");
  if (out.owner.startsWith("$")) throw new Error("--owner must be an agent, not a system owner");
  return out;
}

/** KEY=value lines (optional quotes, comments ignored). */
export function parseEnvFile(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[m[1]] = value;
  }
  return env;
}

const sameRef = (a, b) => !!a && !!b && a.owner === b.owner && a.service === b.service;

/**
 * What to do for one instance.
 *  old:      { daytona?: VaultEntry, e2b?: VaultEntry }   the "$sandbox" entries
 *  existing: { daytona?: VaultEntry, e2b?: VaultEntry }   the owner's entries named "daytona"/"e2b"
 *  sandbox:  the instance's current sandbox settings (or null)
 * Returns { writes: [{ id, service, entry }], sandbox: next settings or undefined (unchanged),
 *           deletes: [id], report: [string] } — the report has names only.
 */
export function planMigration({ owner, old, existing, sandbox }) {
  const writes = [];
  const deletes = [];
  const report = [];
  const providers = { ...(sandbox?.providers ?? {}) };
  let settingsChanged = false;

  for (const id of PROVIDERS) {
    const entry = old[id];
    const apiKey = entry?.credentials?.apiKey?.trim?.();
    if (!entry) { report.push(`${id}: nothing in ${OLD_OWNER}`); continue; }
    if (!apiKey) { report.push(`${id}: ${OLD_OWNER}/${oldService(id)} has no apiKey, left as is`); continue; }

    const ref = { owner, service: id };
    const before = providers[id] && typeof providers[id] === "object" ? providers[id] : {};
    if (before.credential && !sameRef(before.credential, ref)) {
      report.push(`${id}: settings already reference ${before.credential.owner}/${before.credential.service}: skipped (nothing changed or deleted)`);
      continue;
    }
    const current = existing[id];
    if (current) {
      const currentKey = current.credentials?.apiKey?.trim?.();
      if (currentKey !== apiKey) {
        report.push(`${id}: ${owner} already has a "${id}" vault entry with a different key: skipped (nothing overwritten or deleted)`);
        continue;
      }
      report.push(`${id}: ${owner}/${id} already holds the key`);
    } else {
      writes.push({
        id, service: id,
        entry: { type: "api_key", label: id === "daytona" ? "Daytona API key" : "E2B API key", credentials: { apiKey } },
      });
      report.push(`${id}: copy ${OLD_OWNER}/${oldService(id)} → ${owner}/${id}`);
    }

    const options = {};
    for (const f of OPTION_FIELDS) {
      const v = entry.credentials?.[f];
      if (typeof v === "string" && v.trim()) options[f] = v.trim();
    }
    // options already in the settings win over the old entry's
    const next = { ...options, ...before, credential: ref };
    if (!sameRef(before.credential, ref) || OPTION_FIELDS.some((f) => before[f] !== next[f])) {
      providers[id] = next;
      settingsChanged = true;
      report.push(`${id}: settings.sandbox.providers.${id} → credential ${owner}/${id}${OPTION_FIELDS.filter((f) => next[f]).map((f) => `, ${f}`).join("")}`);
    } else {
      report.push(`${id}: settings already reference ${owner}/${id}`);
    }
    deletes.push(id);
  }

  return {
    writes,
    sandbox: settingsChanged ? { ...(sandbox ?? {}), providers } : undefined,
    deletes,
    report,
  };
}

// ── Side effects ─────────────────────────────────────────────────────

async function api(port, path, init = {}, apiKey) {
  const headers = { ...(init.body ? { "content-type": "application/json" } : {}), ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, { ...init, headers });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) throw new Error(`${init.method ?? "GET"} ${path} failed (${response.status}): ${typeof body?.error === "string" ? body.error : body?.error?.message ?? "no details"}`);
  return body.data;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scripts/migrate-vault-refs.mjs --port <api port> --db-env <db-<x>.env> --owner <agent> [--dry-run] [--api-key-env NAME]");
    return;
  }
  const apiKey = process.env[args.apiKeyEnv] || undefined;
  const env = parseEnvFile(readFileSync(args.dbEnv.replace(/^~(?=\/)/, homedir()), "utf8"));
  if (!env.DATABASE_URL) throw new Error(`${args.dbEnv} has no DATABASE_URL`);
  if (!process.env.POLPO_VAULT_KEY && !existsSync(join(homedir(), ".polpo", "vault.key"))) {
    // resolveKey() would generate a new key and every decryption would fail: stop here instead
    throw new Error("No vault key: set POLPO_VAULT_KEY (as the instance does) or provide ~/.polpo/vault.key");
  }

  // The instance must run the new code (vault references) before its old rows are removed.
  const status = await api(args.port, "/sandbox/providers", {}, apiKey);
  if (!Array.isArray(status) || !status.every((p) => "keyFound" in p)) {
    throw new Error(`The instance on port ${args.port} does not serve vault references yet: deploy the new code first`);
  }
  const agents = await api(args.port, "/agents", {}, apiKey);
  if (Array.isArray(agents) && !agents.some((a) => a?.name === args.owner)) {
    throw new Error(`No agent "${args.owner}" on the instance on port ${args.port}`);
  }

  const postgres = (await import("postgres")).default;
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { DrizzleVaultStore, pgSchema } = await import("@polpo-ai/drizzle");
  const sql = postgres(env.DATABASE_URL, { max: 1, idle_timeout: 10, connect_timeout: 15, onnotice: () => {} });
  try {
    const vault = new DrizzleVaultStore(drizzle(sql), pgSchema.vault);
    const old = {};
    const existing = {};
    for (const id of PROVIDERS) {
      old[id] = await vault.get(OLD_OWNER, oldService(id));
      existing[id] = await vault.get(args.owner, id);
    }
    const overview = await api(args.port, "/sandbox", {}, apiKey);
    const plan = planMigration({ owner: args.owner, old, existing, sandbox: overview?.settings ?? null });

    console.log(`Instance on port ${args.port}, owner ${args.owner}${args.dryRun ? " (dry run)" : ""}:`);
    for (const line of plan.report) console.log(`  - ${line}`);
    if (args.dryRun) {
      console.log(plan.deletes.length ? `  would delete ${plan.deletes.map((id) => `${OLD_OWNER}/${oldService(id)}`).join(", ")} after checking` : "  nothing to delete");
      return;
    }

    for (const w of plan.writes) {
      await vault.set(args.owner, w.service, w.entry);
      console.log(`  wrote ${args.owner}/${w.service}`);
    }
    if (plan.sandbox) {
      await api(args.port, "/config/settings", { method: "PATCH", body: JSON.stringify({ sandbox: plan.sandbox }) }, apiKey);
      console.log("  settings.sandbox.providers updated");
    }
    if (!plan.deletes.length) { console.log("  nothing to delete"); return; }

    // Delete the old rows only once the instance resolves the key through the new reference.
    const after = await api(args.port, "/sandbox/providers", {}, apiKey);
    for (const id of plan.deletes) {
      const p = after.find((x) => x.id === id);
      if (!p?.keyFound || p.credential?.owner !== args.owner || p.credential?.service !== id) {
        console.log(`  ${id}: the instance does not find the key through ${args.owner}/${id} yet: ${OLD_OWNER}/${oldService(id)} kept`);
        process.exitCode = 1;
        continue;
      }
      await vault.remove(OLD_OWNER, oldService(id));
      console.log(`  deleted ${OLD_OWNER}/${oldService(id)}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`migrate-vault-refs: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
