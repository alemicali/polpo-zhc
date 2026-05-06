import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, CloudDownload, FolderOpen, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiUrl } from "@/lib/config";
import { cn } from "@/lib/utils";
import { browseDir, type BrowseResult } from "./use-git-meta";

// ── New workspace popover ────────────────────────────────────────────────
//
// Triggered from the sidebar footer "Add workspace" button. Lets the user
// browse from the server's working directory and pick a folder to use as
// the new workspace's cwd. The folder name becomes the workspace name.
//
// `root` constrains traversal — the browser starts at `root` and won't let
// the user navigate above it. Falls back to the server's default browse
// location (homedir) when not provided.
//
// `extraRoots` widens the picker: when non-empty, the user can switch the
// active root to any whitelisted absolute path (configured via the coding
// settings dialog when "allow outside workspace" is on).
export function NewWorkspacePopover({
  root,
  extraRoots = [],
  label = "Add workspace",
  onCreate,
}: {
  root?: string;
  extraRoots?: string[];
  label?: string;
  onCreate: (cwd: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const roots = useMemo(() => {
    const list = [root, ...extraRoots].filter((p): p is string => !!p && p.length > 0);
    return Array.from(new Set(list));
  }, [root, extraRoots]);
  const [activeRoot, setActiveRoot] = useState<string | undefined>(root);
  const [mode, setMode] = useState<"browse" | "clone">("browse");

  useEffect(() => { setActiveRoot(root); }, [root]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 rounded-md px-2 text-[11px] text-white/55 hover:bg-white/[0.05] hover:text-white"
          title={label}
        >
          <Plus className="h-4 w-4" />
          <span className="hidden lg:inline">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-[22rem] max-h-[30rem] overflow-hidden p-0 border-white/[0.08] bg-[#141414] text-white/80"
      >
        <ModePicker mode={mode} onChange={setMode} />
        {mode === "browse" ? (
          <>
            {roots.length > 1 && (
              <div className="flex flex-wrap gap-1 border-b border-white/[0.06] px-2 py-1.5">
                {roots.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setActiveRoot(r)}
                    className={cn(
                      "rounded px-1.5 py-0.5 font-mono text-[10.5px] transition-colors",
                      activeRoot === r
                        ? "bg-emerald-500/15 text-emerald-300"
                        : "bg-white/[0.04] text-white/55 hover:bg-white/[0.08] hover:text-white",
                    )}
                    title={r}
                  >
                    {labelForRoot(r)}
                  </button>
                ))}
              </div>
            )}
            <PathBrowser
              key={activeRoot ?? "default"}
              root={activeRoot}
              onConfirm={(path) => {
                const name = path.split("/").filter(Boolean).pop() ?? "Workspace";
                onCreate(path, name);
                setOpen(false);
              }}
            />
          </>
        ) : (
          <CloneFromUrl onDone={(path, name) => { onCreate(path, name); setOpen(false); }} />
        )}
      </PopoverContent>
    </Popover>
  );
}

function ModePicker({ mode, onChange }: { mode: "browse" | "clone"; onChange: (m: "browse" | "clone") => void }) {
  return (
    <div className="flex border-b border-white/[0.06]">
      <ModeTab active={mode === "browse"} onClick={() => onChange("browse")} icon={<FolderOpen className="h-3.5 w-3.5" />} label="Browse folder" />
      <ModeTab active={mode === "clone"} onClick={() => onChange("clone")} icon={<CloudDownload className="h-3.5 w-3.5" />} label="From repo URL" />
    </div>
  );
}

function ModeTab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex h-9 flex-1 items-center justify-center gap-1.5 text-[11.5px] transition-colors",
        active ? "text-white" : "text-white/45 hover:text-white/85",
      )}
    >
      {icon}
      {label}
      {active && <span aria-hidden className="absolute inset-x-0 bottom-0 h-[2px] bg-white/85" />}
    </button>
  );
}

type GhRepo = {
  nameWithOwner: string;
  description: string | null;
  sshUrl: string;
  url: string;
  updatedAt: string;
  isPrivate: boolean;
};

function CloneFromUrl({ onDone }: { onDone: (path: string, name: string) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [repos, setRepos] = useState<GhRepo[] | null>(null);
  const [reposLoading, setReposLoading] = useState(true);

  // Best-effort `gh repo list` on mount. If it fails (gh not installed,
  // not signed in) we fall back to a plain URL field.
  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl("/api/v1/coding/projects/gh-repos"), { credentials: "include" })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.ok) throw new Error(body?.error || "gh-repos");
        return body.data as GhRepo[];
      })
      .then((data) => { if (!cancelled) setRepos(data); })
      .catch(() => { if (!cancelled) setRepos(null); })
      .finally(() => { if (!cancelled) setReposLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    if (!repos) return [];
    const q = query.trim().toLowerCase();
    if (!q) return repos.slice(0, 30);
    return repos.filter((r) => r.nameWithOwner.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q)).slice(0, 30);
  }, [repos, query]);

  const clone = async (cloneUrl: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/v1/coding/projects/clone"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: cloneUrl }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || `Clone failed (${res.status})`);
      toast.success(`Cloned ${body.data.name}`);
      onDone(body.data.path, body.data.name);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Clone failed");
    } finally {
      setBusy(false);
    }
  };

  // Loading state
  if (reposLoading) {
    return (
      <div className="flex items-center justify-center gap-2 p-6 text-[11px] text-white/45">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading your GitHub repos…
      </div>
    );
  }

  // gh signed-in → searchable repo list
  if (repos) {
    return (
      <div className="flex flex-col">
        <div className="border-b border-white/[0.06] p-2">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${repos.length} repos…`}
            className="h-8 border-white/[0.08] bg-white/[0.02] text-[11.5px] text-white/85 focus-visible:ring-1 focus-visible:ring-white/15"
          />
        </div>
        <div className="max-h-72 min-h-[8rem] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="px-3 py-3 text-center text-[11px] text-white/35">No matches.</div>
          )}
          {filtered.map((r) => (
            <button
              key={r.nameWithOwner}
              type="button"
              onClick={() => void clone(r.sshUrl || r.url)}
              disabled={busy}
              className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-white/[0.04] disabled:opacity-40"
            >
              <CloudDownload className="mt-0.5 h-3.5 w-3.5 shrink-0 text-white/35" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-mono text-[11.5px] text-white/85">{r.nameWithOwner}</span>
                  {r.isPrivate && (
                    <span className="shrink-0 rounded bg-white/[0.05] px-1 py-px text-[9px] uppercase tracking-wider text-white/45">
                      private
                    </span>
                  )}
                </div>
                {r.description && (
                  <div className="truncate text-[10.5px] text-white/45">{r.description}</div>
                )}
              </div>
              {busy && <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-emerald-300/80" />}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // gh not available — manual URL fallback
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); void clone(url.trim()); }}
      className="flex flex-col gap-2 p-3"
    >
      <label className="text-[10.5px] uppercase tracking-[0.14em] text-white/40">Repository URL</label>
      <Input
        autoFocus
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://github.com/owner/repo.git"
        className="h-8 border-white/[0.08] bg-white/[0.02] font-mono text-[11.5px] text-white/85 focus-visible:ring-1 focus-visible:ring-white/15"
      />
      <p className="text-[10.5px] leading-relaxed text-white/35">
        Sign in with <code className="font-mono">gh auth login</code> to browse your repos here.
      </p>
      <div className="flex justify-end gap-1.5">
        <Button
          type="submit"
          size="sm"
          disabled={busy || !url.trim()}
          className="h-7 gap-1 px-3 text-[11px] font-medium"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CloudDownload className="h-3.5 w-3.5" />}
          Clone
        </Button>
      </div>
    </form>
  );
}

function labelForRoot(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

// ── Reusable directory browser ───────────────────────────────────────────
//
// `root` constrains parent navigation: the "Up" button is disabled when
// `browse.current` is at or above `root`. Initial fetch starts at `root`
// when provided.
function PathBrowser({ root, onConfirm }: { root?: string; onConfirm: (path: string) => void }) {
  const [browse, setBrowse] = useState<BrowseResult | null>(null);

  useEffect(() => {
    browseDir(root ?? "").then(setBrowse);
  }, [root]);

  const navigate = async (path: string) => {
    if (root && !path.startsWith(root)) return;
    const next = await browseDir(path);
    if (next) setBrowse(next);
  };

  const atRoot = !!root && (!browse || browse.current === root || !browse.current.startsWith(root));
  const canGoUp = !atRoot && !!browse?.parent && (!root || browse.parent.startsWith(root));

  return (
    <>
      <div className="flex items-center gap-1 border-b border-white/[0.06] px-2 py-1.5">
        <button
          type="button"
          disabled={!canGoUp}
          onClick={() => browse?.parent && canGoUp && navigate(browse.parent)}
          className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-white/[0.06] disabled:opacity-30"
          title="Up"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <code className="flex-1 truncate font-mono text-[11px] text-white/55">{browse?.current || "…"}</code>
      </div>
      <div className="max-h-64 overflow-y-auto py-1">
        {browse && browse.dirs.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-white/35">No subdirectories</div>
        )}
        {browse?.dirs.map((d) => (
          <button
            key={d.path}
            type="button"
            onClick={() => navigate(d.path)}
            className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11.5px] text-white/80 hover:bg-white/[0.05]"
          >
            <FolderOpen className={cn("h-4 w-4", d.hasPolpoConfig ? "text-emerald-400/80" : "text-white/35")} />
            <span className="truncate">{d.name}</span>
            {d.hasPolpoConfig && <span className="ml-auto text-[9px] text-emerald-400/70">polpo</span>}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between gap-1 border-t border-white/[0.06] px-2 py-1.5">
        <span className="text-[10px] text-white/35 truncate">{browse?.dirs.length ?? 0} folders</span>
        <button
          type="button"
          onClick={() => browse?.current && onConfirm(browse.current)}
          disabled={!browse?.current}
          className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-2 py-1 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40"
        >
          Use this folder
        </button>
      </div>
    </>
  );
}
