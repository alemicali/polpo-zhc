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
 */

/**
 * System-essential env vars that are always included.
 * These are required for basic shell/process functionality.
 */
const SYSTEM_VARS = [
  // Core system
  "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE",
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
  "SYSTEMROOT", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "WINDIR",  // Windows
  // SSH (for git operations)
  "SSH_AUTH_SOCK", "SSH_AGENT_PID",
  // Git
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
  // Proxy (for network access)
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  // Timezone
  "TZ",
];

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
  const result: Record<string, string> = {};

  // Include system essentials from process.env
  for (const key of SYSTEM_VARS) {
    if (process.env[key] !== undefined) {
      result[key] = process.env[key]!;
    }
  }

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

