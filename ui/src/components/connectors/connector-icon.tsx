/**
 * A connector's official logo, bundled under /connector-icons (scripts/fetch-connector-icons.mjs:
 * no hotlinking), on a light tile so dark marks stay visible in dark mode. Falls back to a letter
 * avatar in the brand color (custom connectors, or entries without a usable icon).
 */
import { useState } from "react";
import { connectorIconSrc } from "@/lib/connectors-api";
import { cn } from "@/lib/utils";

const SIZES = { sm: "h-7 w-7 rounded-md text-xs", md: "h-9 w-9 rounded-lg text-sm", lg: "h-12 w-12 rounded-xl text-lg" } as const;

function readableOn(hex: string | undefined): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return "#fff";
  const n = parseInt(m[1]!, 16);
  const luminance = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return luminance > 0.6 ? "#111" : "#fff";
}

export function ConnectorIcon({
  catalogId, name, color, size = "md", className,
}: { catalogId?: string; name: string; color?: string; size?: keyof typeof SIZES; className?: string }) {
  const src = connectorIconSrc(catalogId);
  const [failed, setFailed] = useState<string | null>(null);
  if (src && failed !== src) {
    return (
      <span className={cn("inline-flex shrink-0 items-center justify-center border border-border/50 bg-white p-1.5 dark:border-white/10", SIZES[size], className)}>
        <img src={src} alt="" aria-hidden className="h-full w-full object-contain" loading="lazy" onError={() => setFailed(src)} />
      </span>
    );
  }
  const bg = /^#?[0-9a-f]{6}$/i.test(color ?? "") ? `#${color!.replace("#", "")}` : undefined;
  return (
    <span
      aria-hidden
      data-testid="connector-letter-avatar"
      className={cn("inline-flex shrink-0 items-center justify-center font-semibold", !bg && "bg-muted text-muted-foreground", SIZES[size], className)}
      style={bg ? { backgroundColor: bg, color: readableOn(bg) } : undefined}
    >
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}
