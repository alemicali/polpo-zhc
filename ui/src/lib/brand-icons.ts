/** The marks <BrandIcon> knows (components/shared/brand-icon.tsx) and their accessible names. */
export type BrandName =
  | "claude-code" | "claude" | "anthropic"
  | "codex" | "openai"
  | "polpo"
  | "bedrock" | "vertex" | "google-cloud" | "api-key"
  | "daytona" | "e2b" | "host" | "ephemeral"
  | "tailscale";

export const BRAND_TITLES: Record<BrandName, string> = {
  "claude-code": "Claude Code", claude: "Claude", anthropic: "Anthropic",
  codex: "Codex", openai: "OpenAI", polpo: "Polpo",
  bedrock: "Amazon Bedrock", vertex: "Google Vertex AI", "google-cloud": "Google Cloud", "api-key": "API key",
  daytona: "Daytona", e2b: "E2B", host: "This server", ephemeral: "Ephemeral sandbox",
  tailscale: "Tailscale",
};
