/**
 * A connector's icon on a light tile (so dark marks stay visible in dark mode):
 *
 *   1. a catalog connector's official logo, bundled under /connector-icons (scripts/fetch-connector-icons.mjs);
 *   2. a custom connector's icon found by the server (its MCP serverInfo, OAuth metadata or website) or
 *      set by the person, served by GET /api/v1/connectors/:id/icon. The API needs the instance's auth
 *      (an API key header or the session cookie), so it is fetched and shown as an object URL, cached
 *      by its hashed URL; a dark variant, when the server gave one, is shown on a dark tile in dark mode;
 *   3. a preview (a data URI, e.g. while adding a connector);
 *   4. else (or when the image fails) a letter avatar in the brand color.
 *
 * Images are never hotlinked from third-party sites.
 */
import { useEffect, useState } from "react";
import { connectorIconSrc } from "@/lib/connectors-api";
import { loadApiImage } from "@/lib/connector-icon-cache";
import { cn } from "@/lib/utils";

const SIZES = { sm: "h-7 w-7 rounded-md text-xs", md: "h-9 w-9 rounded-lg text-sm", lg: "h-12 w-12 rounded-xl text-lg" } as const;

function readableOn(hex: string | undefined): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return "#fff";
  const n = parseInt(m[1]!, 16);
  const luminance = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return luminance > 0.6 ? "#111" : "#fff";
}

/** An image of the API (auth needed) as a displayable URL; undefined while loading, null when unavailable. */
function useApiImage(path: string | undefined): string | null | undefined {
  const [state, setState] = useState<{ path?: string; url?: string | null }>({});
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    void loadApiImage(path).then((url) => { if (!cancelled) setState({ path, url }); });
    return () => { cancelled = true; };
  }, [path]);
  if (!path) return null;
  return state.path === path ? state.url : undefined;
}

export interface ConnectorIconProps {
  catalogId?: string;
  name: string;
  color?: string;
  /** A custom connector's icon (Connector.iconUrl): an API path. */
  iconUrl?: string;
  /** Its dark-background variant (Connector.iconDarkUrl). */
  iconDarkUrl?: string;
  /** An image to show as is (a data URI preview). */
  previewSrc?: string;
  size?: keyof typeof SIZES;
  className?: string;
}

export function ConnectorIcon({ catalogId, name, color, iconUrl, iconDarkUrl, previewSrc, size = "md", className }: ConnectorIconProps) {
  const bundled = connectorIconSrc(catalogId);
  const apiPath = !bundled && iconUrl?.startsWith("/api/") ? iconUrl : undefined;
  const darkPath = apiPath && iconDarkUrl?.startsWith("/api/") ? iconDarkUrl : undefined;
  const custom = useApiImage(apiPath);
  const dark = useApiImage(darkPath);
  const src = bundled ?? previewSrc ?? custom ?? undefined;
  const [failed, setFailed] = useState<string | null>(null);
  const tile = cn("inline-flex shrink-0 items-center justify-center border border-border/50 p-1.5 dark:border-white/10", SIZES[size], className);

  if (src && failed !== src) {
    if (dark && !bundled && !previewSrc) {
      return (
        <span className="contents">
          <span className={cn(tile, "bg-white dark:hidden")} data-testid="connector-icon-light">
            <img src={src} alt="" aria-hidden className="h-full w-full object-contain" onError={() => setFailed(src)} />
          </span>
          <span className={cn(tile, "hidden bg-neutral-900 dark:inline-flex")} data-testid="connector-icon-dark">
            <img src={dark} alt="" aria-hidden className="h-full w-full object-contain" />
          </span>
        </span>
      );
    }
    return (
      <span className={cn(tile, "bg-white")} data-testid={bundled ? "connector-icon-bundled" : "connector-icon-custom"}>
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
