/**
 * ProviderIcon — branded icon for an LLM provider.
 *
 * Lobehub icons are heavy (each ships a SVG path string + colour metadata).
 * Importing them statically dragged ~360 KB of brand SVGs into the model-
 * picker chunk on every page that uses ProviderIcon. This file now lazy-
 * imports each provider component on demand so the cost is paid only for
 * the icons actually rendered, and Vite emits one chunk per provider.
 */

import { Suspense, lazy, useMemo, type ComponentType } from "react";
import { Server } from "lucide-react";
import { cn } from "@/lib/utils";

type LobeIconProps = { size?: number; className?: string; style?: React.CSSProperties };
type LobeIconAvatarProps = { size?: number; className?: string; shape?: "circle" | "square" };
type LobeIconComponent = ComponentType<LobeIconProps> & {
  Avatar?: ComponentType<LobeIconAvatarProps>;
};

/**
 * Each entry returns a *thunk* that imports the lobehub component on demand.
 * Re-using the same key across providers (e.g. "openai-codex" → OpenAI) is
 * fine — Vite dedupes shared dynamic imports into the same chunk.
 */
const LOADERS: Record<string, () => Promise<{ default: LobeIconComponent }>> = {
  anthropic: () => import("@lobehub/icons/es/Anthropic") as unknown as Promise<{ default: LobeIconComponent }>,
  openai: () => import("@lobehub/icons/es/OpenAI") as unknown as Promise<{ default: LobeIconComponent }>,
  "openai-codex": () => import("@lobehub/icons/es/OpenAI") as unknown as Promise<{ default: LobeIconComponent }>,
  "openai-completions": () => import("@lobehub/icons/es/OpenAI") as unknown as Promise<{ default: LobeIconComponent }>,
  "openai-responses": () => import("@lobehub/icons/es/OpenAI") as unknown as Promise<{ default: LobeIconComponent }>,
  google: () => import("@lobehub/icons/es/Google") as unknown as Promise<{ default: LobeIconComponent }>,
  "google-gemini-cli": () => import("@lobehub/icons/es/Gemini") as unknown as Promise<{ default: LobeIconComponent }>,
  "google-vertex": () => import("@lobehub/icons/es/Gemini") as unknown as Promise<{ default: LobeIconComponent }>,
  "google-antigravity": () => import("@lobehub/icons/es/Google") as unknown as Promise<{ default: LobeIconComponent }>,
  gemini: () => import("@lobehub/icons/es/Gemini") as unknown as Promise<{ default: LobeIconComponent }>,
  mistral: () => import("@lobehub/icons/es/Mistral") as unknown as Promise<{ default: LobeIconComponent }>,
  groq: () => import("@lobehub/icons/es/Groq") as unknown as Promise<{ default: LobeIconComponent }>,
  cohere: () => import("@lobehub/icons/es/Cohere") as unknown as Promise<{ default: LobeIconComponent }>,
  deepseek: () => import("@lobehub/icons/es/DeepSeek") as unknown as Promise<{ default: LobeIconComponent }>,
  cerebras: () => import("@lobehub/icons/es/Cerebras") as unknown as Promise<{ default: LobeIconComponent }>,
  openrouter: () => import("@lobehub/icons/es/OpenRouter") as unknown as Promise<{ default: LobeIconComponent }>,
  xai: () => import("@lobehub/icons/es/XAI") as unknown as Promise<{ default: LobeIconComponent }>,
  grok: () => import("@lobehub/icons/es/XAI") as unknown as Promise<{ default: LobeIconComponent }>,
  huggingface: () => import("@lobehub/icons/es/HuggingFace") as unknown as Promise<{ default: LobeIconComponent }>,
  bedrock: () => import("@lobehub/icons/es/Bedrock") as unknown as Promise<{ default: LobeIconComponent }>,
  "amazon-bedrock": () => import("@lobehub/icons/es/Bedrock") as unknown as Promise<{ default: LobeIconComponent }>,
  perplexity: () => import("@lobehub/icons/es/Perplexity") as unknown as Promise<{ default: LobeIconComponent }>,
  together: () => import("@lobehub/icons/es/Together") as unknown as Promise<{ default: LobeIconComponent }>,
  fireworks: () => import("@lobehub/icons/es/Fireworks") as unknown as Promise<{ default: LobeIconComponent }>,
  ollama: () => import("@lobehub/icons/es/Ollama") as unknown as Promise<{ default: LobeIconComponent }>,
  azure: () => import("@lobehub/icons/es/Azure") as unknown as Promise<{ default: LobeIconComponent }>,
  "azure-openai-responses": () => import("@lobehub/icons/es/Azure") as unknown as Promise<{ default: LobeIconComponent }>,
  kimi: () => import("@lobehub/icons/es/Kimi") as unknown as Promise<{ default: LobeIconComponent }>,
  "kimi-coding": () => import("@lobehub/icons/es/Kimi") as unknown as Promise<{ default: LobeIconComponent }>,
  minimax: () => import("@lobehub/icons/es/Minimax") as unknown as Promise<{ default: LobeIconComponent }>,
  "minimax-cn": () => import("@lobehub/icons/es/Minimax") as unknown as Promise<{ default: LobeIconComponent }>,
  moonshot: () => import("@lobehub/icons/es/Moonshot") as unknown as Promise<{ default: LobeIconComponent }>,
  github: () => import("@lobehub/icons/es/Github") as unknown as Promise<{ default: LobeIconComponent }>,
  "github-copilot": () => import("@lobehub/icons/es/Github") as unknown as Promise<{ default: LobeIconComponent }>,
  copilot: () => import("@lobehub/icons/es/Github") as unknown as Promise<{ default: LobeIconComponent }>,
};

const lazyCache = new Map<string, LobeIconComponent>();
function lazyFor(key: string): LobeIconComponent | null {
  const loader = LOADERS[key];
  if (!loader) return null;
  let component = lazyCache.get(key);
  if (!component) {
    component = lazy(loader) as unknown as LobeIconComponent;
    lazyCache.set(key, component);
  }
  return component;
}

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
  const Icon = useMemo(() => {
    const normalized = name.toLowerCase();
    return lazyFor(normalized) ?? lazyFor(normalized.split("-")[0]);
  }, [name]);

  const fallback = (
    <Server
      className={cn("shrink-0 text-muted-foreground", className)}
      style={{ width: size, height: size }}
    />
  );

  if (!Icon) return fallback;

  return (
    <Suspense fallback={fallback}>
      {variant === "avatar" && Icon.Avatar ? (
        <Icon.Avatar size={size} className={cn("shrink-0", className)} />
      ) : (
        <Icon size={size} className={cn("shrink-0", className)} />
      )}
    </Suspense>
  );
}
