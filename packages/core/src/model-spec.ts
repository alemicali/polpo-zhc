/**
 * Model spec parsing — pure logic, no runtime dependencies.
 *
 * Parses "provider:model" or "provider/model" strings into { provider, modelId }.
 * Auto-infers provider from well-known model prefixes.
 * Used by both self-hosted (src/llm/pi-client.ts) and cloud (handler.ts).
 */

export interface ParsedModelSpec {
  provider: string;
  modelId: string;
}

/**
 * Well-known model prefixes → provider mapping.
 * Used for auto-inference when the spec doesn't include "provider:".
 */
const PREFIX_MAP: [string, string][] = [
  // Anthropic
  ["claude-", "anthropic"],
  // OpenAI
  ["gpt-", "openai"],
  ["o1-", "openai"],
  ["o3-", "openai"],
  ["o4-", "openai"],
  ["chatgpt-", "openai"],
  ["codex-", "openai"],
  // Google
  ["gemini-", "google"],
  // Mistral
  ["mistral-", "mistral"],
  ["codestral-", "mistral"],
  ["devstral-", "mistral"],
  // Groq
  ["llama-", "groq"],
  ["llama3", "groq"],
  // xAI
  ["grok-", "xai"],
];

/**
 * Parse a model spec string into { provider, modelId }.
 *
 * Supported formats:
 *   "provider:model"  — explicit (e.g. "anthropic:claude-opus-4-6")
 *   "provider/model"  — slash format (e.g. "anthropic/claude-opus-4-6")
 *   "model-id"        — auto-inferred from prefix map
 *
 * @param spec - Model spec string. Falls back to `fallback` if not provided.
 * @param fallback - Optional fallback spec (e.g. from env var or config).
 * @throws If no spec is available or provider cannot be inferred.
 */
export function parseModelSpec(spec?: string, fallback?: string): ParsedModelSpec {
  const s = spec || fallback;
  if (!s) {
    throw new Error(
      'No model configured. Use "provider:model" format (e.g. "anthropic:claude-sonnet-4-5").'
    );
  }

  // Explicit "provider:model" format
  const colonIdx = s.indexOf(":");
  if (colonIdx > 0) {
    const provider = s.slice(0, colonIdx);
    const modelId = s.slice(colonIdx + 1);
    if (!provider.includes("/") && !provider.includes("\\")) {
      return { provider, modelId };
    }
  }

  // Explicit "provider/model" format (OpenAI Gateway style)
  const slashIdx = s.indexOf("/");
  if (slashIdx > 0) {
    const provider = s.slice(0, slashIdx);
    const modelId = s.slice(slashIdx + 1);
    if (!provider.includes(":") && !provider.includes("\\")) {
      return { provider, modelId };
    }
  }

  // Auto-infer from prefix map
  const lower = s.toLowerCase();
  for (const [prefix, provider] of PREFIX_MAP) {
    if (lower.startsWith(prefix)) {
      return { provider, modelId: s };
    }
  }

  throw new Error(
    `Cannot infer provider for model "${s}". Use "provider:model" format (e.g. "anthropic:${s}").`
  );
}

/**
 * Map of known providers → environment variable name for API keys.
 * Used by both self-hosted and cloud for BYOK resolution.
 */
export const PROVIDER_ENV_MAP: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  mistral: "MISTRAL_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  zai: "ZAI_API_KEY",
  minimax: "MINIMAX_API_KEY",
  "minimax-cn": "MINIMAX_CN_API_KEY",
  huggingface: "HF_TOKEN",
  opencode: "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  "azure-openai-responses": "AZURE_OPENAI_API_KEY",
  "github-copilot": "COPILOT_GITHUB_TOKEN",
  "amazon-bedrock": "AWS_ACCESS_KEY_ID",
  "google-vertex": "GOOGLE_CLOUD_PROJECT",
  "openai-codex": "OPENAI_API_KEY",
  "google-gemini-cli": "GEMINI_API_KEY",
  "google-antigravity": "GEMINI_API_KEY",
};
