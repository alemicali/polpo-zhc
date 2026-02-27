/**
 * Non-blocking update checker.
 *
 * Fires a single HTTP GET to the npm registry at CLI startup.
 * If a newer version exists, prints a one-liner after the command finishes.
 * Never blocks, never throws, never slows anything down.
 *
 * Rate-limited to once per 24 hours via a tiny timestamp file in ~/.polpo/.
 */

import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const PACKAGE_NAME = "@lumea-labs/polpo";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** File where we store the last check timestamp + latest version. */
function stateFilePath(): string {
  const dir = resolve(homedir(), ".polpo");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return resolve(dir, ".update-check");
}

interface CheckState {
  lastCheck: number;
  latestVersion?: string;
}

function readState(): CheckState {
  try {
    const raw = readFileSync(stateFilePath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return { lastCheck: 0 };
  }
}

function writeState(state: CheckState): void {
  try {
    writeFileSync(stateFilePath(), JSON.stringify(state));
  } catch { /* best-effort */ }
}

/**
 * Compare two semver strings. Returns true if `remote` is newer than `local`.
 */
function isNewer(local: string, remote: string): boolean {
  const a = local.split(".").map(Number);
  const b = remote.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((b[i] || 0) > (a[i] || 0)) return true;
    if ((b[i] || 0) < (a[i] || 0)) return false;
  }
  return false;
}

/**
 * Start a non-blocking update check. Returns a function you call at exit
 * to print the update notice (if any). Safe to ignore the return value.
 */
export function startUpdateCheck(currentVersion: string): () => void {
  // Respect POLPO_NO_UPDATE_CHECK=1 or CI environments
  if (
    process.env.POLPO_NO_UPDATE_CHECK === "1" ||
    process.env.CI === "true" ||
    process.env.NO_COLOR !== undefined
  ) {
    return () => {};
  }

  const state = readState();
  const now = Date.now();

  // Already checked recently — use cached result
  if (now - state.lastCheck < CHECK_INTERVAL_MS && state.latestVersion) {
    if (isNewer(currentVersion, state.latestVersion)) {
      return () => printNotice(currentVersion, state.latestVersion!);
    }
    return () => {};
  }

  // Fire-and-forget fetch — never awaited, never blocks
  let latestVersion: string | undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
    signal: controller.signal,
    headers: { Accept: "application/json" },
  })
    .then((r) => r.json())
    .then((data: any) => {
      clearTimeout(timeout);
      latestVersion = data.version;
      writeState({ lastCheck: now, latestVersion });
    })
    .catch(() => {
      clearTimeout(timeout);
      /* offline, timeout, etc. — silently ignore */
    });

  // Return a sync function that the caller invokes when the CLI is about to exit
  return () => {
    if (latestVersion && isNewer(currentVersion, latestVersion)) {
      printNotice(currentVersion, latestVersion);
    }
  };
}

function printNotice(current: string, latest: string): void {
  // Dynamic import would be async; just use plain ANSI since chalk is ESM-heavy
  const yellow = "\x1b[33m";
  const cyan = "\x1b[36m";
  const dim = "\x1b[2m";
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";

  process.stderr.write(
    `\n${yellow}${bold}  Update available!${reset} ${dim}${current}${reset} → ${cyan}${bold}${latest}${reset}\n` +
    `${dim}  Run ${reset}${cyan}polpo update${reset}${dim} to upgrade${reset}\n\n`,
  );
}
