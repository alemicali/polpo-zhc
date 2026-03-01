/**
 * Vault resolver — resolves ${ENV_VAR} references in credential values.
 *
 * Supports:
 *   "${FOO}"                  → full env var replacement
 *   "prefix-${FOO}-suffix"   → inline replacement
 *   "plain value"             → returned as-is
 */

import type { VaultEntry } from "../core/types.js";

// ─── Env Var Resolution ──────────────────────────────

const ENV_RE = /\$\{(\w+)\}/g;

/**
 * Resolve ${ENV_VAR} references in a string value.
 * Supports full ("${FOO}") and inline ("prefix-${FOO}-suffix") patterns.
 * Unresolved vars are replaced with empty string.
 */
export function resolveEnvVar(value: string): string {
  return value.replace(ENV_RE, (_match, varName: string) => {
    return process.env[varName] ?? "";
  });
}

/**
 * Resolve all ${ENV_VAR} references in a VaultEntry's credentials.
 * Returns a new record with all values resolved.
 */
export function resolveVaultCredentials(entry: VaultEntry): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(entry.credentials)) {
    resolved[key] = resolveEnvVar(value);
  }
  return resolved;
}

// ─── SMTP / IMAP credential helpers ─────────────────

export interface SmtpCredentials {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  secure?: boolean;
}

export interface ImapCredentials {
  host: string;
  port: number;
  user: string;
  pass: string;
  tls?: boolean;
}

// ─── ResolvedVault ──────────────────────────────────

/** Resolved vault — all ${ENV_VAR} replaced with actual values */
export interface ResolvedVault {
  /** Get resolved credentials for a service by name */
  get(service: string): Record<string, string> | undefined;
  /** Get SMTP credentials (looks for service type "smtp") */
  getSmtp(): SmtpCredentials | undefined;
  /** Get IMAP credentials (looks for service type "imap") */
  getImap(): ImapCredentials | undefined;
  /** Check if a service exists in the vault */
  has(service: string): boolean;
  /** List all available services with their types and credential keys (values masked) */
  list(): Array<{ service: string; type: string; keys: string[] }>;
}

/**
 * Build a ResolvedVault for an agent — resolves all vault entries.
 */
export function resolveAgentVault(vault?: Record<string, VaultEntry>): ResolvedVault {
  const resolved = new Map<string, { type: VaultEntry["type"]; creds: Record<string, string> }>();

  if (vault) {
    for (const [service, entry] of Object.entries(vault)) {
      resolved.set(service, {
        type: entry.type,
        creds: resolveVaultCredentials(entry),
      });
    }
  }

  return {
    get(service: string) {
      return resolved.get(service)?.creds;
    },

    getSmtp() {
      // Find first entry with type "smtp"
      for (const [, entry] of resolved) {
        if (entry.type === "smtp") {
          const c = entry.creds;
          if (!c.host) return undefined;
          return {
            host: c.host,
            port: Number(c.port ?? "587"),
            user: c.user ?? "",
            pass: c.pass ?? "",
            from: c.from ?? "",
            secure: c.secure === "true" || c.secure === "1" ? true : undefined,
          };
        }
      }
      return undefined;
    },

    getImap() {
      // Find first entry with type "imap"
      for (const [, entry] of resolved) {
        if (entry.type === "imap") {
          const c = entry.creds;
          if (!c.host) return undefined;
          return {
            host: c.host,
            port: Number(c.port ?? "993"),
            user: c.user ?? "",
            pass: c.pass ?? "",
            tls: c.tls !== "false" && c.tls !== "0" ? true : undefined,
          };
        }
      }
      return undefined;
    },

    has(service: string) {
      return resolved.has(service);
    },

    list() {
      return Array.from(resolved.entries()).map(([service, entry]) => ({
        service,
        type: entry.type,
        keys: Object.keys(entry.creds),
      }));
    },
  };
}
