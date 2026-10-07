export {
  resolveEnvVar,
  resolveVaultCredentials,
  resolveAgentVault,
  loadAgentVaultEntries,
  type ResolvedVault,
  type SmtpCredentials,
  type ImapCredentials,
} from "./resolver.js";

export {
  resolveEnvFromVault,
  createSecretMasker,
  secretVariants,
  invalidEnvVarName,
  suggestedEnvVarName,
  formatVaultRef,
  isNonSecretVaultField,
  NON_SECRET_VAULT_FIELDS,
  MIN_MASKED_SECRET_LENGTH,
  SECRET_MASK,
  type VaultRef,
  type EnvFromVaultResult,
} from "./env-from-vault.js";

export { EncryptedVaultStore } from "./encrypted-store.js";
export type { VaultStore } from "../core/vault-store.js";
