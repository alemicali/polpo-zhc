export { querySDK, querySDKText, querySDKTextDetailed, querySDKStream, querySDKStreamDetailed, querySDKWithFallback, queryOrchestratorText } from "./query.js";
export type { OnProgress, QueryResult } from "./query.js";
export { withRetry, isTransientError } from "./retry.js";
export type { RetryOptions } from "./retry.js";
export { buildChatSystemPrompt, buildMissionSystemPrompt, buildTaskPrepPrompt, buildTeamGenPrompt } from "./prompts.js";
export {
  discoverSkills, parseSkillFrontmatter, loadAgentSkills, assignSkillToAgent, unassignSkillFromAgent, buildSkillPrompt,
  installSkills, removeSkill, createAgentSkill, parseSkillSource, listSkillsWithAssignments,
  loadSkillContent, getSkillByName,
  // Skills index (tags & categories)
  loadSkillIndex, saveSkillIndex, updateSkillIndex, removeSkillFromIndex,
} from "./skills.js";
export type { SkillInfo, LoadedSkill, ParsedSource, FoundSkill, InstallResult, SkillWithAssignment, SkillIndexEntry, SkillIndex } from "./skills.js";
export {
  // Model resolution
  parseModelSpec, resolveModel, resolveModelSpec, resolveModelWithFallback, resolveModelWithFallbackAsync, resolveApiKey, resolveApiKeyAsync,
  // Catalog
  listProviders, listModels, getModelInfo, buildModelListingForPrompt,
  // Cost tracking
  estimateCost,
  // Provider management
  setProviderOverrides, getProviderOverrides, validateProviderKeys, validateProviderKeysDetailed,
  // Cooldown
  isProviderInCooldown, markProviderCooldown, clearProviderCooldown, getProviderCooldowns,
  // Error classification
  classifyProviderError,
  // Model allowlist
  setModelAllowlist, getModelAllowlist, isModelAllowed, enforceModelAllowlist,
} from "./pi-client.js";
export type { ParsedModelSpec, ModelInfo, CostEstimate, ProviderValidationResult } from "./pi-client.js";
