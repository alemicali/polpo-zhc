/**
 * ProviderIcon — branded icon for an LLM provider.
 *
 * Uses @lobehub/icons which ships per-provider components with three
 * variants:
 *   - default export = `Mono`  (single-colour, currentColor)
 *   - `.Avatar`               (rounded box, brand colours, like an app icon)
 *   - `.Text`                 (logo + wordmark)
 *
 * For unknown / custom-baseUrl providers we fall back to a generic Server
 * icon so layout doesn't shift.
 */

import { Server } from "lucide-react";
import { cn } from "@/lib/utils";
import Anthropic from "@lobehub/icons/es/Anthropic";
import OpenAI from "@lobehub/icons/es/OpenAI";
import Google from "@lobehub/icons/es/Google";
import Gemini from "@lobehub/icons/es/Gemini";
import Mistral from "@lobehub/icons/es/Mistral";
import Groq from "@lobehub/icons/es/Groq";
import Cohere from "@lobehub/icons/es/Cohere";
import DeepSeek from "@lobehub/icons/es/DeepSeek";
import Cerebras from "@lobehub/icons/es/Cerebras";
import OpenRouter from "@lobehub/icons/es/OpenRouter";
import XAI from "@lobehub/icons/es/XAI";
import HuggingFace from "@lobehub/icons/es/HuggingFace";
import Bedrock from "@lobehub/icons/es/Bedrock";
import Perplexity from "@lobehub/icons/es/Perplexity";
import Together from "@lobehub/icons/es/Together";
import Fireworks from "@lobehub/icons/es/Fireworks";
import Ollama from "@lobehub/icons/es/Ollama";
import Azure from "@lobehub/icons/es/Azure";
import Kimi from "@lobehub/icons/es/Kimi";
import Minimax from "@lobehub/icons/es/Minimax";
import Moonshot from "@lobehub/icons/es/Moonshot";
import Github from "@lobehub/icons/es/Github";

// `Anthropic`-style components have a `Mono` default + `.Avatar` etc.
type LobeIcon = {
  (props: { size?: number; className?: string; style?: React.CSSProperties }): React.ReactElement;
  Avatar?: (props: { size?: number; className?: string; shape?: "circle" | "square" }) => React.ReactElement;
};

/**
 * Map every provider name we know about (config + auth status keys) to a
 * lobehub icon component. Provider names from polpo-config (`anthropic`,
 * `openai`, `google-gemini-cli`, `bedrock`, `azure-openai-responses`,
 * `openai-codex`, `github-copilot`, …) all need an entry.
 */
const ICON_BY_PROVIDER: Record<string, LobeIcon> = {
  anthropic: Anthropic as unknown as LobeIcon,
  openai: OpenAI as unknown as LobeIcon,
  "openai-codex": OpenAI as unknown as LobeIcon,
  "openai-completions": OpenAI as unknown as LobeIcon,
  "openai-responses": OpenAI as unknown as LobeIcon,
  google: Google as unknown as LobeIcon,
  "google-gemini-cli": Gemini as unknown as LobeIcon,
  "google-vertex": Gemini as unknown as LobeIcon,
  "google-antigravity": Google as unknown as LobeIcon,
  gemini: Gemini as unknown as LobeIcon,
  mistral: Mistral as unknown as LobeIcon,
  groq: Groq as unknown as LobeIcon,
  cohere: Cohere as unknown as LobeIcon,
  deepseek: DeepSeek as unknown as LobeIcon,
  cerebras: Cerebras as unknown as LobeIcon,
  openrouter: OpenRouter as unknown as LobeIcon,
  xai: XAI as unknown as LobeIcon,
  grok: XAI as unknown as LobeIcon,
  huggingface: HuggingFace as unknown as LobeIcon,
  bedrock: Bedrock as unknown as LobeIcon,
  "amazon-bedrock": Bedrock as unknown as LobeIcon,
  perplexity: Perplexity as unknown as LobeIcon,
  together: Together as unknown as LobeIcon,
  fireworks: Fireworks as unknown as LobeIcon,
  ollama: Ollama as unknown as LobeIcon,
  azure: Azure as unknown as LobeIcon,
  "azure-openai-responses": Azure as unknown as LobeIcon,
  kimi: Kimi as unknown as LobeIcon,
  "kimi-coding": Kimi as unknown as LobeIcon,
  minimax: Minimax as unknown as LobeIcon,
  "minimax-cn": Minimax as unknown as LobeIcon,
  moonshot: Moonshot as unknown as LobeIcon,
  github: Github as unknown as LobeIcon,
  "github-copilot": Github as unknown as LobeIcon,
  copilot: Github as unknown as LobeIcon,
};

export function ProviderIcon({
  name,
  size = 16,
  variant = "mono",
  className,
}: {
  /** Polpo provider id, e.g. "anthropic", "google-gemini-cli". */
  name: string;
  size?: number;
  /** "mono" = currentColor SVG, "avatar" = brand-colour rounded square. */
  variant?: "mono" | "avatar";
  className?: string;
}) {
  // Normalize: lowercase, also try the prefix before the first dash
  const normalized = name.toLowerCase();
  const Icon = ICON_BY_PROVIDER[normalized] ?? ICON_BY_PROVIDER[normalized.split("-")[0]];

  if (!Icon) {
    return (
      <Server
        className={cn("shrink-0 text-muted-foreground", className)}
        style={{ width: size, height: size }}
      />
    );
  }

  if (variant === "avatar" && Icon.Avatar) {
    return <Icon.Avatar size={size} className={cn("shrink-0", className)} />;
  }

  return <Icon size={size} className={cn("shrink-0", className)} />;
}
