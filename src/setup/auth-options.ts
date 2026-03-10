import type { OAuthProviderName } from "../auth/types.js";

export interface AuthOption {
  id: string;
  label: string;
  description: string;
  type: "oauth" | "api_key";
  oauthId?: OAuthProviderName;
  free: boolean;
}

/** OAuth providers that are free (no paid subscription required). */
export const FREE_OAUTH_PROVIDERS = new Set<OAuthProviderName>([
  "google-antigravity",
  "google-gemini-cli",
]);

/**
 * Get the full list of auth options (OAuth + manual API key).
 * Single source of truth for both CLI and server.
 */
export function getAuthOptions(): AuthOption[] {
  return [
    // Free OAuth
    { id: "google-antigravity", label: "Google Antigravity", description: "Free — Gemini 3, Claude, GPT-OSS via Google account", type: "oauth", oauthId: "google-antigravity", free: true },
    { id: "google-gemini-cli", label: "Google Gemini CLI", description: "Free — Gemini models via Google account", type: "oauth", oauthId: "google-gemini-cli", free: true },
    // Paid OAuth
    { id: "anthropic", label: "Anthropic (Claude Pro/Max)", description: "Requires Claude Pro or Max subscription", type: "oauth", oauthId: "anthropic", free: false },
    { id: "openai-codex", label: "OpenAI Codex (ChatGPT Plus/Pro)", description: "Requires ChatGPT Plus or Pro subscription", type: "oauth", oauthId: "openai-codex", free: false },
    { id: "github-copilot", label: "GitHub Copilot", description: "Requires Copilot subscription — multi-model access", type: "oauth", oauthId: "github-copilot", free: false },
    // Manual
    { id: "api-key", label: "Enter an API key manually", description: "For any provider (OpenAI, Anthropic, Groq, etc.)", type: "api_key", free: false },
  ];
}
