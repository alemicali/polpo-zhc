/**
 * Types used by tools — local definitions to avoid importing from polpo-ai root.
 */

/** Resolved vault credentials for an agent. */
export interface ResolvedVault {
  get(service: string): Record<string, string> | undefined;
  getSmtp(): Record<string, any> | undefined;
  getImap(): Record<string, any> | undefined;
  getKey(service: string, key: string): string | undefined;
  has(service: string): boolean;
  list(): Array<{ service: string; type: string; keys: string[] }>;
}

/** WhatsApp message store interface. Uses any for maximum compatibility. */
export interface WhatsAppStore {
  [method: string]: (...args: any[]) => any;
}
