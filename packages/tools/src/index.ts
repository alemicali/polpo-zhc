/**
 * @polpo-ai/tools — Agent tools for Polpo.
 *
 * Core tools (always available):
 *   read, write, edit, bash, glob, grep, ls,
 *   register_outcome, http_fetch, http_download,
 *   vault_get, vault_list
 *
 * Extended tools (opt-in, require optional deps):
 *   browser_*, email_*, excel_*, pdf_*, docx_*,
 *   image_*, audio_*, search_*, phone_*, whatsapp_*, memory_*
 */

// Core tool factory
export { createCodingTools, createAllTools, matchToolPattern, expandToolWildcards } from "./coding-tools.js";

// Individual tool factories (for custom composition)
export { createOutcomeTools } from "./outcome-tools.js";
export { createHttpTools } from "./http-tools.js";
export { createVaultToolsCore } from "./vault-tools.js";

// Extended tool factories
export { createBrowserTools } from "./browser-tools.js";
export { createEmailTools } from "./email-tools.js";
export { createExcelTools } from "./excel-tools.js";
export { createPdfTools } from "./pdf-tools.js";
export { createDocxTools } from "./docx-tools.js";
export { createImageTools } from "./image-tools.js";
export { createAudioTools } from "./audio-tools.js";
export { createSearchTools } from "./search-tools.js";
export { createPhoneTools } from "./phone-tools.js";
export { createWhatsAppTools } from "./whatsapp-tools.js";
export { createMemoryTools } from "./memory-tools.js";

// Adapters (FileSystem/Shell implementations)
export { NodeFileSystem } from "./adapters/node-filesystem.js";
export { NodeShell } from "./adapters/node-shell.js";

// Security utilities
export { assertPathAllowed, resolveAllowedPaths } from "./path-sandbox.js";
export { bashSafeEnv } from "./safe-env.js";

// Types
export type { ResolvedVault, WhatsAppStore } from "./types.js";
