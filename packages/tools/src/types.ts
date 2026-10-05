/**
 * Types used by tools — local definitions to avoid importing from polpo-ai root.
 */

/** A logical email mailbox composed of one or both of SMTP (send) and IMAP (read). */
export interface MailboxDescriptor {
  /** Account name — either the explicit VaultEntry.account or the service key as fallback. */
  name: string;
  /** Sender address pulled from the SMTP entry (`credentials.from`) when present. */
  from?: string;
  /** Optional human label aggregated from the underlying entries. */
  label?: string;
  /** True if an SMTP entry exists for this account (the agent can send). */
  canSend: boolean;
  /** True if an IMAP entry exists for this account (the agent can read). */
  canRead: boolean;
}

/** Resolved vault credentials for an agent. */
export interface ResolvedVault {
  get(service: string): Record<string, string> | undefined;
  /** Get the SMTP config for an account. If `account` is omitted, returns
   *  the first SMTP entry found — preserves single-mailbox behaviour. */
  getSmtp(account?: string): Record<string, any> | undefined;
  /** Get the IMAP config for an account. If `account` is omitted, returns
   *  the first IMAP entry found — preserves single-mailbox behaviour. */
  getImap(account?: string): Record<string, any> | undefined;
  /** Enumerate distinct mailboxes (SMTP and/or IMAP) available to the agent. */
  listMailboxes(): MailboxDescriptor[];
  getKey(service: string, key: string): string | undefined;
  has(service: string): boolean;
  list(): Array<{ service: string; type: string; keys: string[] }>;
}

/** WhatsApp message store interface. Uses any for maximum compatibility. */
export interface WhatsAppStore {
  [method: string]: (...args: any[]) => any;
}
