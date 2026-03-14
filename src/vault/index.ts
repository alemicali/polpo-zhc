export {
  resolveEnvVar,
  resolveVaultCredentials,
  resolveAgentVault,
  type ResolvedVault,
  type SmtpCredentials,
  type ImapCredentials,
} from "./resolver.js";

export { EncryptedVaultStore } from "./encrypted-store.js";
export type { VaultStore } from "../core/vault-store.js";
