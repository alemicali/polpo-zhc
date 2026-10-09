export {
  detectProviders,
  hasOAuthProfilesForProvider,
  type DetectedProvider,
} from "./providers.js";

export {
  persistToEnvFile,
  removeFromEnvFile,
  moveEnvEntries,
  recordApiWrittenEnvKey,
  forgetApiWrittenEnvKey,
  takeApiWrittenEnvKeys,
  readEnvFileValue,
  type ApiWrittenEnvKey,
  assertValidEnvEntry,
  isValidEnvKey,
} from "./env-persistence.js";

export {
  getAuthOptions,
  FREE_OAUTH_PROVIDERS,
  type AuthOption,
} from "./auth-options.js";

export {
  findOAuthProvider,
  getOAuthProviderList,
  startOAuthLogin,
  type LoginCallbacks,
  type LoginDeviceCode,
  type LoginPrompt,
  type LoginPromptOption,
} from "./oauth-flow.js";

export {
  getProviderModels,
  formatCost,
  modelLabel,
  type ModelInfo,
} from "./models.js";
