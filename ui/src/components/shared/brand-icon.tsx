/**
 * BrandIcon — the official mark of what a run executes with or on: engines (Claude Code, Codex,
 * Polpo), auth providers (Amazon Bedrock, Vertex AI, an API key), computers (Daytona, E2B, this
 * server) and egress (Tailscale).
 *
 * The marks are bundled, never hotlinked (scripts/fetch-brand-icons.mjs): simple-icons vectors
 * inline (ui/src/generated/brand-icons.ts), the vendors' own PNGs for Daytona and E2B
 * (ui/public/brand-icons), and @lobehub/icons for OpenAI, Bedrock and Vertex AI (loaded lazily,
 * like ProviderIcon). Monochrome marks (Anthropic, OpenAI, Tailscale) take the text colour, so
 * they stay visible in dark mode. Unknown names fall back to a letter tile.
 */
import { Suspense, lazy, type ComponentType } from "react";
import { KeyRound, Server, Box } from "lucide-react";
import { BRAND_VECTORS } from "@/generated/brand-icons";
import { cn } from "@/lib/utils";
import { BRAND_TITLES, type BrandName } from "@/lib/brand-icons";

export type { BrandName };


type LobeProps = { size?: number; className?: string; style?: React.CSSProperties };
const lobe = (load: () => Promise<unknown>) => lazy(load as () => Promise<{ default: ComponentType<LobeProps> }>);
const LOBE: Partial<Record<BrandName, ComponentType<LobeProps>>> = {
  openai: lobe(() => import("@lobehub/icons/es/OpenAI/components/Mono")),
  codex: lobe(() => import("@lobehub/icons/es/OpenAI/components/Mono")),
  bedrock: lobe(() => import("@lobehub/icons/es/Bedrock/components/Color")),
  vertex: lobe(() => import("@lobehub/icons/es/VertexAI/components/Color")),
};

/** Vector marks drawn in their brand colour; the others in the current text colour. */
const VECTOR: Partial<Record<BrandName, { key: keyof typeof BRAND_VECTORS; mono?: boolean }>> = {
  "claude-code": { key: "claude-code" },
  claude: { key: "claude" },
  anthropic: { key: "anthropic", mono: true },
  tailscale: { key: "tailscale", mono: true },
  "google-cloud": { key: "google-cloud" },
};

const asset = (file: string) => `${import.meta.env.BASE_URL ?? "/"}brand-icons/${file}`.replace(/\/{2,}/g, "/");

export function BrandIcon({
  name,
  size = 16,
  className,
  title,
}: {
  name: BrandName | string;
  size?: number;
  className?: string;
  /** Accessible name (default: the brand's). */
  title?: string;
}) {
  const label = title ?? BRAND_TITLES[name as BrandName] ?? name;
  const box = { width: size, height: size };
  const common = { role: "img" as const, "aria-label": label, "data-brand": name };

  const vector = VECTOR[name as BrandName];
  if (vector) {
    const v = BRAND_VECTORS[vector.key];
    return (
      <svg {...common} viewBox="0 0 24 24" style={box} className={cn("shrink-0", vector.mono && "fill-current", className)}>
        <path d={v.path} fill={vector.mono ? undefined : v.hex} />
      </svg>
    );
  }

  if (name === "daytona") {
    return (
      <span {...common} className={cn("inline-flex shrink-0", className)} style={box} title={label}>
        <img src={asset("daytona-light.png")} alt="" className="h-full w-full dark:hidden" />
        <img src={asset("daytona-dark.png")} alt="" className="hidden h-full w-full rounded-sm dark:block" />
      </span>
    );
  }
  if (name === "e2b") {
    return <img {...common} src={asset("e2b.png")} alt={label} title={label} style={box} className={cn("shrink-0 rounded-sm", className)} />;
  }
  if (name === "polpo") {
    return (
      <span {...common} title={label} style={{ ...box, fontSize: Math.round(size * 0.8) }} className={cn("inline-flex shrink-0 items-center justify-center leading-none", className)}>
        🐙
      </span>
    );
  }
  if (name === "api-key") return <KeyRound {...common} style={box} className={cn("shrink-0 text-muted-foreground", className)} />;
  if (name === "host") return <Server {...common} style={box} className={cn("shrink-0 text-muted-foreground", className)} />;
  if (name === "ephemeral") return <Box {...common} style={box} className={cn("shrink-0 text-muted-foreground", className)} />;

  const fallback = (
    <span
      {...common}
      title={label}
      style={{ ...box, fontSize: Math.max(8, Math.round(size * 0.6)) }}
      className={cn("inline-flex shrink-0 items-center justify-center rounded-sm bg-muted font-semibold uppercase text-muted-foreground", className)}
    >
      {label.slice(0, 1)}
    </span>
  );
  const Lobe = LOBE[name as BrandName];
  if (!Lobe) return fallback;
  return (
    <Suspense fallback={fallback}>
      <span {...common} title={label} className={cn("inline-flex shrink-0", className)} style={box}>
        <Lobe size={size} />
      </span>
    </Suspense>
  );
}
