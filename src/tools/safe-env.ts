/**
 * Safe environment variable filtering for child processes.
 *
 * Instead of passing the full `process.env` (which leaks API keys, tokens,
 * and secrets to every subprocess), this module provides a filtered env
 * containing only system-essential variables plus an explicit allowlist.
 *
 * Security motivation:
 *   - Bash tool commands can read env vars via `env`, `echo $SECRET`, etc.
 *   - Any subprocess with full env access has all API keys and credentials.
 *
 * Every command Polpo runs for an agent on this machine builds its environment here: the bash
 * tool and the checks (NodeShell), the local workspace, the agent harnesses' host processes and
 * the app services/deployments. Credentials an agent is entitled to reach a command explicitly
 * (env_from_vault, the caller's `env`), never by inheritance from the server.
 */

/**
 * System-essential env vars that are always included.
 * These are required for basic shell/process functionality.
 */
const SYSTEM_VARS = [
  // Core system
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "COLORTERM", "LANG", "LANGUAGE",
  // Temp directories
  "TMPDIR", "TMP", "TEMP",
  // Node.js
  "NODE_ENV", "NODE_PATH", "NODE_OPTIONS",
  // Editor (for interactive tools)
  "EDITOR", "VISUAL",
  // XDG base directories
  "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
  // Platform-specific
  "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS",  // Linux
  // Windows (process.env is case-insensitive there)
  "SYSTEMROOT", "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
  "PROGRAMW6432", "PROGRAMDATA", "COMMONPROGRAMFILES", "WINDIR", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
  // SSH (for git operations)
  "SSH_AUTH_SOCK", "SSH_AGENT_PID",
  // Git
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
  // Timezone
  "TZ",
];

/** Proxy settings (for network access): passed wherever the system set is. */
export const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];

/** Name prefixes passed through as well: the locale categories (LC_ALL, LC_CTYPE, LC_MESSAGES…). */
const SYSTEM_PREFIXES = ["LC_"];

/**
 * The variables of `base` named in `names` or starting with one of `prefixes` (unset ones skipped).
 * Windows matches names case-insensitively, as its environment does.
 */
export function pickEnv(base: NodeJS.ProcessEnv, names: readonly string[], prefixes: readonly string[] = []): Record<string, string> {
  const result: Record<string, string> = {};
  const fold = process.platform === "win32";
  const wanted = new Set(fold ? names.map((n) => n.toUpperCase()) : names);
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const k = fold ? key.toUpperCase() : key;
    if (wanted.has(k) || prefixes.some((p) => k.startsWith(p))) result[key] = value;
  }
  return result;
}

/**
 * Create a filtered copy of process.env containing only safe variables.
 *
 * @param extra - Additional env vars to include (e.g. from MCP config).
 *                These take precedence over process.env values.
 * @param allowVars - Additional var names to pass through from process.env.
 *                    Use this for specific Polpo env vars agents need.
 */
export function safeEnv(
  extra?: Record<string, string>,
  allowVars?: string[],
): Record<string, string> {
  // Include system essentials (and the proxy and locale settings) from process.env
  const result = pickEnv(process.env, [...SYSTEM_VARS, ...PROXY_VARS], SYSTEM_PREFIXES);

  // Include explicitly allowed vars
  if (allowVars) {
    for (const key of allowVars) {
      if (process.env[key] !== undefined) {
        result[key] = process.env[key]!;
      }
    }
  }

  // Override/add extra vars (from config)
  if (extra) {
    Object.assign(result, extra);
  }

  return result;
}

/**
 * Convenience: create safe env for bash tool.
 * Includes system vars only — no API keys, no secrets.
 */
export function bashSafeEnv(): Record<string, string> {
  return safeEnv();
}


/**
 * The environment of a command run for an agent: the safe system set plus what the caller passes
 * on purpose (vault-granted credentials, workspace variables), never the rest of the server's.
 * Unset caller values are dropped.
 */
export function commandEnv(callerEnv?: Record<string, string | undefined>): Record<string, string> {
  const env = bashSafeEnv();
  for (const [key, value] of Object.entries(callerEnv ?? {})) if (value !== undefined) env[key] = value;
  return env;
}
