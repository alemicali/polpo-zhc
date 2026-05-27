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

/** A logical email mailbox composed of one or both of SMTP and IMAP. */
export interface MailboxDescriptor {
  name: string;
  from?: string;
  label?: string;
  canSend: boolean;
  canRead: boolean;
}

/** Resolved vault — all ${ENV_VAR} replaced with actual values */
export interface ResolvedVault {
  /** Get resolved credentials for a service by name */
  get(service: string): Record<string, string> | undefined;
  /** Get SMTP credentials for the named account, or the first SMTP entry. */
  getSmtp(account?: string): SmtpCredentials | undefined;
  /** Get IMAP credentials for the named account, or the first IMAP entry. */
  getImap(account?: string): ImapCredentials | undefined;
  /** Enumerate distinct mailboxes (SMTP/IMAP grouped by `account`). */
  listMailboxes(): MailboxDescriptor[];
  /** Get a credential value by service name and key.
   *  Convenience shortcut for `get(service)?.[key]`. */
  getKey(service: string, key: string): string | undefined;
  /** Check if a service exists in the vault */
  has(service: string): boolean;
  /** List all available services with their types and credential keys (values masked) */
  list(): Array<{ service: string; type: string; keys: string[] }>;
}

/**
 * Build a ResolvedVault for an agent — resolves all vault entries.
 */
export function resolveAgentVault(vault?: Record<string, VaultEntry>): ResolvedVault {
  // Holds the (resolved) credentials per service-key plus the entry's
  // logical account (defaults to the service key when not declared on
  // the VaultEntry). The account is what lets multiple SMTP/IMAP entries
  // coexist for the same agent — see listMailboxes() below.
  const resolved = new Map<string, {
    type: VaultEntry["type"];
    account: string;
    label?: string;
    creds: Record<string, string>;
  }>();

  if (vault) {
    for (const [service, entry] of Object.entries(vault)) {
      resolved.set(service, {
        type: entry.type,
        account: entry.account ?? service,
        label: entry.label,
        creds: resolveVaultCredentials(entry),
      });
    }
  }

  /** Find the first entry of `type` matching the given account. When
   *  `account` is omitted, returns the first entry of that type — keeps
   *  single-mailbox setups working without changes. */
  const findByType = (type: VaultEntry["type"], account?: string) => {
    for (const entry of resolved.values()) {
      if (entry.type !== type) continue;
      if (account != null && entry.account !== account) continue;
      return entry;
    }
    return undefined;
  };

  return {
    get(service: string) {
      return resolved.get(service)?.creds;
    },

    getSmtp(account?: string) {
      const entry = findByType("smtp", account);
      if (!entry) return undefined;
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
    },

    getImap(account?: string) {
      const entry = findByType("imap", account);
      if (!entry) return undefined;
      const c = entry.creds;
      if (!c.host) return undefined;
      return {
        host: c.host,
        port: Number(c.port ?? "993"),
        user: c.user ?? "",
        pass: c.pass ?? "",
        tls: c.tls !== "false" && c.tls !== "0" ? true : undefined,
      };
    },

    listMailboxes() {
      // Group SMTP/IMAP entries by their `account`. An account with only
      // SMTP can send, with only IMAP can read, with both can do both.
      // Non-mail types (oauth/api_key/login/custom) are ignored.
      const byAccount = new Map<string, {
        smtp?: { creds: Record<string, string>; label?: string };
        imap?: { creds: Record<string, string>; label?: string };
      }>();
      for (const entry of resolved.values()) {
        if (entry.type !== "smtp" && entry.type !== "imap") continue;
        const slot = byAccount.get(entry.account) ?? {};
        if (entry.type === "smtp") slot.smtp = { creds: entry.creds, label: entry.label };
        else slot.imap = { creds: entry.creds, label: entry.label };
        byAccount.set(entry.account, slot);
      }
      return Array.from(byAccount.entries()).map(([name, slot]) => ({
        name,
        from: slot.smtp?.creds.from || slot.imap?.creds.user || undefined,
        label: slot.smtp?.label || slot.imap?.label,
        canSend: !!slot.smtp?.creds.host,
        canRead: !!slot.imap?.creds.host,
      }));
    },

    getKey(service: string, key: string) {
      return resolved.get(service)?.creds[key];
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
