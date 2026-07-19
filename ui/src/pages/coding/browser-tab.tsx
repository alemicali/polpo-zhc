import { useEffect, useState } from "react";
import { ExternalLink, Globe, RefreshCcw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useLocalState } from "./use-local-state";

function defaultPreviewUrl(port = 5173): string {
  if (typeof window === "undefined") return `http://localhost:${port}`;
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:${port}`;
}

/** Reusable iframe-based browser preview pane.
 *
 * Persists the loaded URL per workspace in localStorage so reloading the
 * page restores whatever the user was last previewing instead of dropping
 * back to the empty-state placeholder. */
export function BrowserTab({ workspaceId, defaultUrl }: { workspaceId?: string; defaultUrl?: string }) {
  const initial = defaultUrl ?? defaultPreviewUrl();
  const storageKey = `polpo:coding:browserUrl:${workspaceId ?? "_"}`;
  const [savedUrl, setSavedUrl] = useLocalState<string | null>(storageKey, null);
  const [draft, setDraft] = useState(savedUrl ?? initial);
  const [url, setUrl] = useState<string | null>(savedUrl);
  // Bumped to force the iframe to remount on reload.
  const [reloadKey, setReloadKey] = useState(0);

  // Each workspace has its own slot — re-hydrate when the prop changes
  // (the parent stacks multiple BrowserTab instances and toggles visibility).
  useEffect(() => {
    setUrl(savedUrl);
    setDraft(savedUrl ?? initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // Mirror loaded URL back into the persisted slot.
  useEffect(() => {
    setSavedUrl(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return (
    <div className="flex h-full w-full flex-col">
      <form
        onSubmit={(e) => { e.preventDefault(); setUrl(draft); setReloadKey((k) => k + 1); }}
        className="flex shrink-0 items-center gap-1 border-b border-border/70 px-2 py-1.5"
      >
        <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={initial}
          className="h-6 min-w-0 flex-1 border-0 bg-muted px-2 font-mono text-[11px] text-foreground shadow-none focus-visible:ring-1"
        />
        <Button
          type="submit"
          variant="ghost"
          size="sm"
          className="h-6 rounded px-2 text-[10px] font-medium"
        >
          Go
        </Button>
        {url && (
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            title="Reload"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <RefreshCcw className="h-3.5 w-3.5" />
          </button>
        )}
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            title="Open in new tab"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </form>
      {url ? (
        <iframe
          key={`${url}_${reloadKey}`}
          src={url}
          className="flex-1 w-full border-0 bg-white"
          title="Browser preview"
          // sandbox is intentionally permissive for dev preview workflows
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
        />
      ) : (
        <div className="flex h-full items-center justify-center p-6">
          <div className="text-center">
            <p className="text-xs font-medium text-foreground">Browser preview</p>
            <p className="mt-1 text-[11px] text-muted-foreground">Enter a URL above and press Enter to load it.</p>
          </div>
        </div>
      )}
    </div>
  );
}
