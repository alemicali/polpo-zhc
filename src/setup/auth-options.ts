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
export const FREE_OAUTH_PROVIDERS = new Set<OAuthProviderName>();

/**
 * Get the full list of auth options (OAuth + manual API key).
 * Single source of truth for both CLI and server.
 */
export function getAuthOptions(): AuthOption[] {
  return [
    { id: "anthropic", label: "Anthropic (Claude Pro/Max)", description: "Requires Claude Pro or Max subscription", type: "oauth", oauthId: "anthropic", free: false },
    { id: "github-copilot", label: "GitHub Copilot", description: "Requires Copilot subscription — multi-model access", type: "oauth", oauthId: "github-copilot", free: false },
    { id: "kimi-coding", label: "Kimi Code", description: "Sign in with a Kimi Code subscription", type: "oauth", oauthId: "kimi-coding", free: false },
    { id: "openai-codex", label: "OpenAI Codex (ChatGPT Plus/Pro)", description: "Requires ChatGPT Plus or Pro subscription", type: "oauth", oauthId: "openai-codex", free: false },
    { id: "openrouter", label: "OpenRouter", description: "Sign in with OpenRouter", type: "oauth", oauthId: "openrouter", free: false },
    { id: "radius", label: "Radius", description: "Sign in to a Radius gateway", type: "oauth", oauthId: "radius", free: false },
    { id: "xai", label: "xAI (Grok/X)", description: "Requires an eligible SuperGrok or X subscription", type: "oauth", oauthId: "xai", free: false },
    // Manual
    { id: "api-key", label: "Enter an API key manually", description: "For any provider (OpenAI, Anthropic, Groq, etc.)", type: "api_key", free: false },
  ];
}
