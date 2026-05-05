import { useState } from "react";
import { ExternalLink, Globe, RefreshCcw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

/** Reusable iframe-based browser preview pane. */
export function BrowserTab({ defaultUrl = "http://localhost:3000" }: { defaultUrl?: string }) {
  const [draft, setDraft] = useState(defaultUrl);
  const [url, setUrl] = useState<string | null>(null);
  // Bumped to force the iframe to remount on reload.
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <div className="flex h-full w-full flex-col">
      <form
        onSubmit={(e) => { e.preventDefault(); setUrl(draft); setReloadKey((k) => k + 1); }}
        className="flex shrink-0 items-center gap-1 border-b border-white/[0.06] px-2 py-1.5"
      >
        <Globe className="h-3.5 w-3.5 shrink-0 text-white/35" />
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="http://localhost:3000"
          className="h-6 min-w-0 flex-1 border-0 bg-white/[0.04] px-2 font-mono text-[11px] text-white/85 shadow-none focus-visible:ring-1 focus-visible:ring-white/15"
        />
        <Button
          type="submit"
          variant="ghost"
          size="sm"
          className="h-6 rounded px-2 text-[10px] font-medium text-white/70 hover:bg-white/[0.06] hover:text-white"
        >
          Go
        </Button>
        {url && (
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            title="Reload"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-white/45 hover:bg-white/[0.06] hover:text-white"
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
            className="inline-flex h-6 w-6 items-center justify-center rounded text-white/45 hover:bg-white/[0.06] hover:text-white"
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
            <p className="text-[12px] font-medium text-white/70">Browser preview</p>
            <p className="mt-1 text-[11px] text-white/40">Enter a URL above and press Enter to load it.</p>
          </div>
        </div>
      )}
    </div>
  );
}
