/**
 * Browser profiles: the persistent browser state of agents (cookies, local storage, logins) in
 * `.polpo/browser-profiles/<name>/`. An agent uses the profile named by its `browserProfile`, else
 * its own name; Polpo's chat browser uses `orchestrator`.
 *
 * Used by Polpo's tools (browser_profiles, browser_profile_login, browser_profile_clear) and the
 * /browser-profiles routes. A login opens the profile in a browser session `login-<name>` that the
 * Live browser view shows: the person signs in there, then finishing the login closes the session
 * and the profile keeps it.
 */
import { existsSync } from "node:fs";
import { lstat, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { execBrowserAsync } from "./browser-tools.js";
import { assertWebUrl } from "./browser-url-guard.js";

export const BROWSER_PROFILE_NAME = /^[A-Za-z0-9_-]+$/;
/** Polpo's own chat browser profile. */
export const ORCHESTRATOR_PROFILE = "orchestrator";

export interface BrowserProfileAgent {
  name: string;
  browserProfile?: string;
  allowedTools?: string[];
}

export interface BrowserProfileInfo {
  name: string;
  /** Agents that use it (Polpo for "orchestrator"). */
  agents: string[];
  /** The folder exists (an agent assigned to a profile it never opened has none yet). */
  exists: boolean;
  sizeBytes: number;
  lastUsedAt?: string;
  /** It holds cookies: some site is probably signed in. */
  hasCookies: boolean;
  /** A login session is open in the Live browser view. */
  loginOpen: boolean;
}

export const profileNameOf = (agent: BrowserProfileAgent): string => agent.browserProfile || agent.name;
const usesBrowser = (agent: BrowserProfileAgent): boolean =>
  !agent.allowedTools || agent.allowedTools.some((t) => t.toLowerCase().startsWith("browser_"));

export const profilesDir = (polpoDir: string): string => join(polpoDir, "browser-profiles");
export const loginSessionOf = (name: string): string => `login-${name}`;

function checkName(name: string): string {
  if (!BROWSER_PROFILE_NAME.test(name)) throw new Error(`Invalid profile name "${name}": letters, digits, - and _ only`);
  return name;
}

/** Bytes under a folder (symlinks not followed; stops counting after `limit` entries). */
async function folderSize(dir: string, limit = 50_000): Promise<number> {
  let total = 0;
  let seen = 0;
  const walk = async (d: string): Promise<void> => {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > limit) return;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) total += (await lstat(p).catch(() => undefined))?.size ?? 0;
    }
  };
  await walk(dir);
  return total;
}

/** Open agent-browser sessions (names). */
async function openSessions(): Promise<Set<string>> {
  const result = await execBrowserAsync(["session", "list"], { timeout: 10_000 }).catch(() => undefined);
  const data = result?.success ? result.data : undefined;
  const list: unknown[] = Array.isArray(data) ? data : Array.isArray(data?.sessions) ? data.sessions : [];
  return new Set(list.map((s) => (typeof s === "string" ? s : String((s as { name?: string })?.name ?? ""))).filter(Boolean));
}

/** Every profile: the folders, and the ones agents with browser tools are assigned to. */
export async function listBrowserProfiles(polpoDir: string, agents: BrowserProfileAgent[]): Promise<BrowserProfileInfo[]> {
  const users = new Map<string, string[]>();
  for (const a of agents) if (usesBrowser(a)) users.set(profileNameOf(a), [...(users.get(profileNameOf(a)) ?? []), a.name]);
  const root = profilesDir(polpoDir);
  const folders = existsSync(root)
    ? (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && BROWSER_PROFILE_NAME.test(e.name)).map((e) => e.name)
    : [];
  const names = [...new Set([...folders, ...users.keys()])].sort();
  const sessions = await openSessions();
  return Promise.all(names.map(async (name) => {
    const dir = join(root, name);
    const exists = folders.includes(name);
    const cookies = [join(dir, "Default", "Cookies"), join(dir, "Cookies")].find((p) => existsSync(p));
    const times = await Promise.all([dir, cookies].filter((p): p is string => !!p && existsSync(p)).map((p) => stat(p).then((s) => s.mtimeMs).catch(() => 0)));
    const last = Math.max(0, ...times);
    return {
      name,
      agents: name === ORCHESTRATOR_PROFILE ? ["Polpo", ...(users.get(name) ?? [])] : users.get(name) ?? [],
      exists,
      sizeBytes: exists ? await folderSize(dir) : 0,
      ...(last > 0 ? { lastUsedAt: new Date(last).toISOString() } : {}),
      hasCookies: !!cookies,
      loginOpen: sessions.has(loginSessionOf(name)),
    };
  }));
}

/**
 * Open a profile in a browser session the Live view shows, at `url`: the person signs in there.
 * The session stays open until finishProfileLogin (or clear) closes it.
 */
export async function startProfileLogin(polpoDir: string, name: string, url: string): Promise<{ session: string; profileDir: string }> {
  checkName(name);
  const target = assertWebUrl(url, "browser_profile_login");
  const profileDir = join(profilesDir(polpoDir), name);
  const session = loginSessionOf(name);
  const result = await execBrowserAsync(["open", target], { session, profileDir, timeout: 60_000 });
  if (!result.success) throw new Error(`Could not open the browser: ${result.error ?? result.raw}`);
  return { session, profileDir };
}

/** Close the login session: what the person signed into stays in the profile. */
export async function finishProfileLogin(name: string): Promise<boolean> {
  checkName(name);
  const result = await execBrowserAsync(["close"], { session: loginSessionOf(name), timeout: 15_000 }).catch(() => undefined);
  return !!result?.success;
}

/**
 * Delete a profile and every login it holds. Its browser sessions (the login one, and those of the
 * agents that use it) are closed first, so no browser writes into the folder while it goes.
 */
export async function clearBrowserProfile(polpoDir: string, name: string, agents: BrowserProfileAgent[]): Promise<{ deleted: boolean; closedSessions: string[] }> {
  checkName(name);
  const dir = join(profilesDir(polpoDir), name);
  const open = await openSessions();
  const sessions = [loginSessionOf(name), ...(name === ORCHESTRATOR_PROFILE ? [ORCHESTRATOR_PROFILE] : []),
    ...agents.filter((a) => profileNameOf(a) === name).map((a) => a.name)].filter((s) => open.has(s));
  for (const session of sessions) await execBrowserAsync(["close"], { session, timeout: 15_000 }).catch(() => undefined);
  if (!existsSync(dir)) return { deleted: false, closedSessions: sessions };
  await rm(dir, { recursive: true, force: true });
  return { deleted: true, closedSessions: sessions };
}
