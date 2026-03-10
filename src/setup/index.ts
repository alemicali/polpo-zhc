export {
  detectProviders,
  hasOAuthProfilesForProvider,
  type DetectedProvider,
} from "./providers.js";

export {
  persistToEnvFile,
  removeFromEnvFile,
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
} from "./oauth-flow.js";

export {
  getProviderModels,
  formatCost,
  modelLabel,
  type ModelInfo,
} from "./models.js";
