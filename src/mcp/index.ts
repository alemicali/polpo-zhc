/**
 * Connectors: Polpo as an MCP *client* (Linear, Notion, Google Workspace, custom servers).
 * See docs/connectors.md.
 */
export { ConnectorStore } from "./store.js";
export { ConnectorSecrets, SECRET_KEYS, resolveSecretRefs } from "./secrets.js";
export { VaultOAuthProvider, OAUTH_STATE_TTL_MS } from "./oauth-provider.js";
export { ConnectorManager, ConnectorError, getConnectorManager, closeAllConnectorManagers } from "./manager.js";
export type { ConnectorManagerOptions, ConnectorToolsResult } from "./manager.js";
export { CONNECTOR_CATALOG, catalogEntry, GOOGLE_WORKSPACE_SETUP } from "./catalog.js";
export { checkConnectorUrl, allowPrivateNetwork, ConnectorUrlError } from "./net.js";
export {
  mcpToolName, isMcpToolName, connectorToolAllowed, convertToolResult, bridgeMcpTool, toolParameters, toolResultText,
  MAX_RESULT_TEXT, MCP_TOOL_PREFIX,
} from "./tools.js";
export { buildConnector, applyConnectorPatch, ConnectorInputError } from "./validate.js";
export type { ConnectorInput, ConnectorSecretsInput } from "./validate.js";
export { publicConnector } from "./view.js";
export type { PublicConnector } from "./view.js";
export { connectorManagerFor, notePublicOrigin, connectorRedirectUri, connectorsPromptSection } from "./runtime.js";
export { CONNECTOR_OAUTH_CALLBACK_PATH, CONNECTOR_CLIENT_METADATA_PATH, clientMetadataDocument, clientMetadataUrlFor } from "./paths.js";
export { normalizeCatalogEntry } from "./catalog.js";
export type { RawCatalogEntry } from "./catalog.js";
