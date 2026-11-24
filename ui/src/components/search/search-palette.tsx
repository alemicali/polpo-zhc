/**
 * The search palette (⌘K / Ctrl+K, the sidebar's search field, the mobile header's icon): one box
 * that finds everything — pages and commands at once, then the server's results (chats with the
 * message that matched and who said it, tasks, agents, files…) grouped by type, with a preview of
 * the selected one on the right.
 *
 * Keyboard: ↑ ↓ move, ↵ opens, ⌘/Ctrl ↵ opens in a new tab, Tab / Shift Tab jump between groups,
 * Esc closes. Prefixes narrow the search: > commands, / pages, @ agents, # tasks, chat: file: …
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Command as CommandPrimitive } from "cmdk";
import { AlertCircle, ArrowRight, Clock, CornerDownLeft, History, Loader2, Search, X, type LucideIcon } from "lucide-react";
import { useSearch, type SearchRange, type SearchResult, type SearchType } from "@polpo-ai/react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { useChatActions } from "@/hooks/chat-context";
import { closeSearchPalette, openSearchPalette, searchShortcutLabel, useSearchPalette, useSearchShortcut } from "@/hooks/use-search-palette";
import { useTheme } from "@/hooks/use-theme";
import { setSidebarStyle, useSidebarStyle } from "@/hooks/use-sidebar-style";
import { openWhatsNew } from "@/hooks/use-whats-new-drawer";
import { requestNewGroup } from "@/hooks/use-chat-room";
import {
  PALETTE_PREFIXES, clearRecents, getRecents, localMatch, pageEntries, parsePaletteQuery, recentFromResult, rememberItem, rememberSearch, shortAge,
  type RecentItem,
} from "@/lib/global-search";
import { cn } from "@/lib/utils";
import { matchActions, paletteActions, type PaletteContext } from "./palette-actions";
import { Highlighted, Kbd, KindIcon, StatusBadge } from "./search-parts";
import { SearchPreview } from "./search-preview";

/** One row of the palette. */
export interface PaletteEntry {
  key: string;
  kind: SearchType | "page" | "action";
  title: string;
  titleHighlights?: SearchRange[];
  subtitle?: string;
  hint?: string;
  icon?: LucideIcon;
  url?: string;
  result?: SearchResult;
  recent?: RecentItem;
  /** What selecting it does (commands, recent searches); otherwise it opens url. */
  run?: () => void;
  /** Keep the palette open after run (a command waiting for words, a recent search). */
  keepOpen?: boolean;
}

interface PaletteGroup {
  id: string;
  label: string;
  entries: PaletteEntry[];
  /** "Show all N" for a type with more results than shown. */
  more?: { total: number; prefix: string };
}

/** The prefix that shows only one type (for "Show all"). */
const PREFIX_OF: Partial<Record<SearchType, string>> = {
  chat: "chat:", task: "task:", mission: "mission:", agent: "agent:", file: "file:", artifact: "artifact:", data: "data:", skill: "skill:", memory: "memory:", event: "event:",
};

/** The filter chips under the input (a click sets the prefix). */
const CHIPS = [
  { label: "All", prefix: "" },
  { label: "Chats", prefix: "chat:" },
  { label: "Agents", prefix: "@" },
  { label: "Tasks", prefix: "#" },
  { label: "Missions", prefix: "mission:" },
  { label: "Files", prefix: "file:" },
  { label: "Artifacts", prefix: "artifact:" },
  { label: "Commands", prefix: ">" },
  { label: "Pages", prefix: "/" },
];

const isDesktop = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(min-width: 768px)").matches;

function resultEntry(r: SearchResult): PaletteEntry {
  return { key: `${r.type}:${r.id}`, kind: r.type, title: r.title, ...(r.titleHighlights ? { titleHighlights: r.titleHighlights } : {}), ...(r.subtitle ? { subtitle: r.subtitle } : {}), url: r.url, result: r };
}

/** The leading visual of a row: the agent's avatar for agents and agent chats, else the kind's icon. */
function EntryIcon({ entry }: { entry: PaletteEntry }) {
  const meta = entry.result?.meta ?? entry.recent?.meta;
  const agent = typeof meta?.agent === "string" ? meta.agent : undefined;
  if ((entry.kind === "agent" || (entry.kind === "chat" && agent))) {
    return (
      <AgentAvatar avatar={typeof meta?.avatar === "string" ? meta.avatar : undefined} name={agent ?? entry.result?.id ?? entry.title}
        size="sm" fallbackVariant="circle" shape="circle" className="h-7 w-7 shrink-0" />
    );
  }
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-muted text-muted-foreground group-data-[selected=true]:bg-primary/10 group-data-[selected=true]:text-primary">
      <KindIcon kind={entry.kind} meta={meta} icon={entry.icon} className="h-4 w-4" />
    </span>
  );
}

function EntryRow({ entry }: { entry: PaletteEntry }) {
  const r = entry.result;
  const status = r?.meta?.status ?? entry.recent?.meta?.status;
  const snippet = r?.snippet;
  const author = typeof r?.meta?.author === "string" ? r.meta.author : undefined;
  const matches = typeof r?.meta?.matches === "number" && r.meta.matches > 1 ? r.meta.matches : undefined;
  return (
    <div className="flex min-w-0 flex-1 items-start gap-2.5">
      <EntryIcon entry={entry} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <Highlighted text={entry.title} ranges={entry.titleHighlights} className="min-w-0 truncate text-sm font-medium text-foreground" />
          {(entry.kind === "task" || entry.kind === "mission") && <StatusBadge kind={entry.kind} status={status} />}
        </div>
        {snippet ? (
          <p className="truncate text-xs text-muted-foreground">
            {author && <span className="font-medium text-foreground/70">{author}: </span>}
            <Highlighted text={snippet.text} ranges={snippet.highlights} />
          </p>
        ) : entry.subtitle || entry.hint ? (
          <p className="truncate text-xs text-muted-foreground">{entry.subtitle ?? entry.hint}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5 pt-0.5">
        {r?.updatedAt && <span className="text-micro text-muted-foreground/80">{shortAge(r.updatedAt)}</span>}
        {matches && <span className="text-micro text-muted-foreground/70">{matches} matches</span>}
        <CornerDownLeft className="hidden h-3.5 w-3.5 text-muted-foreground group-data-[selected=true]:block" />
      </div>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-1 px-2 py-1" aria-label="Searching">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-2.5 px-2 py-2">
          <div className="h-7 w-7 animate-pulse rounded-control bg-muted" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-2/5 animate-pulse rounded-xs bg-muted" />
            <div className="h-2.5 w-4/5 animate-pulse rounded-xs bg-muted/70" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SearchPalette() {
  const { open, query: initialQuery, seq } = useSearchPalette();
  const navigate = useNavigate();
  const chat = useChatActions();
  const { resolved, setTheme } = useTheme();
  const sidebarStyle = useSidebarStyle();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [recents, setRecents] = useState(getRecents);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // every open starts from the query asked for (a prefix, or empty) and the latest recents
  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    setRecents(getRecents());
  }, [open, seq, initialQuery]);

  const parsed = useMemo(() => parsePaletteQuery(query), [query]);
  const serverWanted = parsed.scope === "all" || parsed.scope === "types";
  const { data, isLoading, error } = useSearch(serverWanted ? parsed.text : "", {
    types: parsed.types,
    perType: parsed.scope === "types" ? undefined : 5,
    limit: parsed.scope === "types" ? 50 : 40,
    enabled: open,
  });

  const ctx: PaletteContext = useMemo(() => ({
    navigate,
    newChat: (first?: string) => {
      chat.newSession();
      if (first) void chat.send(first);
      navigate("/chat");
    },
    newGroup: () => { requestNewGroup(null); navigate("/chat?newGroup=1"); },
    theme: resolved,
    setTheme,
    sidebarStyle,
    setSidebarStyle: (s) => setSidebarStyle(s),
    openWhatsNew,
    clearRecents: () => { clearRecents(); setRecents(getRecents()); },
  }), [navigate, chat, resolved, setTheme, sidebarStyle]);

  const pages = useMemo(() => pageEntries(), []);
  const actions = useMemo(() => paletteActions({ theme: resolved, sidebarStyle }, pages), [resolved, sidebarStyle, pages]);

  const finish = useCallback((entry: PaletteEntry, newTab = false) => {
    if (entry.run) {
      entry.run();
      if (!entry.keepOpen) closeSearchPalette();
      return;
    }
    if (!entry.url) return;
    if (parsed.text) rememberSearch(query.trim());
    if (entry.result) rememberItem(recentFromResult(entry.result));
    else if (entry.kind === "page") rememberItem({ key: entry.key, kind: "page", title: entry.title, ...(entry.subtitle ? { subtitle: entry.subtitle } : {}), url: entry.url });
    if (newTab) {
      window.open(entry.url, "_blank", "noopener");
      return;
    }
    closeSearchPalette();
    navigate(entry.url);
  }, [navigate, parsed.text, query]);

  const groups: PaletteGroup[] = useMemo(() => {
    const out: PaletteGroup[] = [];
    const text = parsed.text;
    const actionEntries = (limit: number): PaletteEntry[] => matchActions(actions, text).slice(0, limit).map(({ action, argument, highlights }) => {
      // a command that needs words, picked without them: it waits for them in the box
      const needsWords = !!action.argument && argument === undefined && action.id !== "new-chat";
      return {
        key: `action:${action.id}`,
        kind: "action" as const,
        title: argument ? `${action.label}: “${argument}”` : action.label,
        titleHighlights: highlights,
        hint: needsWords ? `${action.hint ? `${action.hint} · ` : ""}type ${action.argument!.placeholder} after the name` : action.hint,
        icon: action.icon,
        run: needsWords ? () => { setQuery(`> ${action.label} `); inputRef.current?.focus(); } : () => action.run(ctx, argument),
        keepOpen: needsWords,
      };
    });
    const pageEntriesFor = (limit: number): PaletteEntry[] => pages
      .map((p) => ({ p, m: localMatch(text, p.label, `${p.section} ${p.keywords ?? ""}`) }))
      .filter(({ m }) => m.score > 0)
      .sort((a, b) => b.m.score - a.m.score)
      .slice(0, limit)
      .map(({ p, m }) => ({ key: `page:${p.to}`, kind: "page" as const, title: p.label, titleHighlights: m.highlights, subtitle: p.section, icon: p.icon, url: p.to }));

    if (parsed.scope === "commands") {
      const entries = actionEntries(40);
      if (entries.length) out.push({ id: "commands", label: "Commands", entries });
      return out;
    }
    if (parsed.scope === "pages") {
      const entries = pageEntriesFor(60);
      if (entries.length) out.push({ id: "pages", label: "Pages", entries });
      return out;
    }
    if (!text) {
      if (parsed.scope === "all") {
        if (recents.searches.length) {
          out.push({ id: "recent-searches", label: "Recent searches", entries: recents.searches.map((s) => ({
            key: `recent-search:${s}`, kind: "action" as const, title: s, icon: History, run: () => setQuery(s), keepOpen: true,
          })) });
        }
        if (recents.items.length) {
          out.push({ id: "recent-items", label: "Recently opened", entries: recents.items.map((i) => ({
            key: `recent:${i.key}`, kind: i.kind, title: i.title, ...(i.subtitle ? { subtitle: i.subtitle } : {}), ...(i.url ? { url: i.url } : {}), recent: i,
            icon: i.kind === "page" ? pages.find((p) => p.to === i.url)?.icon ?? Clock : undefined,
          })) });
        }
        out.push({ id: "suggested", label: "Commands", entries: actionEntries(40).filter((e) => ["action:new-chat", "action:new-task", "action:new-mission", "action:new-agent", "action:theme"].includes(e.key)) });
      }
      return out;
    }
    if (parsed.scope === "all") {
      const pageHits = pageEntriesFor(4);
      const actionHits = actionEntries(4);
      if (pageHits.length) out.push({ id: "pages", label: "Pages", entries: pageHits });
      if (actionHits.length) out.push({ id: "commands", label: "Commands", entries: actionHits });
    }
    // the server's groups, for the query now in the box (or the previous one while the new loads)
    for (const g of data?.groups ?? []) {
      const prefix = PREFIX_OF[g.type];
      out.push({
        id: `type:${g.type}`, label: g.label, entries: g.items.map(resultEntry),
        ...(parsed.scope === "all" && prefix && g.total > g.items.length ? { more: { total: g.total, prefix } } : {}),
      });
    }
    // pages that start with the words come first; otherwise the server's best groups do
    if (parsed.scope === "all" && out[0]?.id === "pages" && !pages.some((p) => p.label.toLowerCase().startsWith(text.toLowerCase())) && out.length > 2) {
      const local = out.filter((g) => g.id === "pages" || g.id === "commands");
      const rest = out.filter((g) => g.id !== "pages" && g.id !== "commands");
      return [...rest.slice(0, 1), ...local, ...rest.slice(1)];
    }
    return out;
  }, [parsed, actions, pages, recents, data, ctx]);

  const entries = useMemo(() => groups.flatMap((g) => g.entries), [groups]);
  const byKey = useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries]);

  // keep a selection that still exists (a row or a group's "Show all"); otherwise the first row
  useEffect(() => {
    if (!entries.length) { setSelected(""); return; }
    if (!byKey.has(selected) && !groups.some((g) => g.more && `more:${g.id}` === selected)) setSelected(entries[0]!.key);
  }, [entries, byKey, groups, selected]);

  // a new query starts at the top
  useEffect(() => {
    if (entries[0]) setSelected(entries[0].key);
    listRef.current?.scrollTo?.({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, data?.query]);

  const selectedEntry = byKey.get(selected);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Tab" && groups.length > 1) {
      e.preventDefault();
      const at = groups.findIndex((g) => g.entries.some((x) => x.key === selected));
      const next = groups[(at + (e.shiftKey ? -1 : 1) + groups.length) % groups.length];
      if (next?.entries[0]) setSelected(next.entries[0].key);
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && selectedEntry?.url) {
      e.preventDefault();
      finish(selectedEntry, true);
      return;
    }
  };

  const showSkeleton = serverWanted && !!parsed.text && isLoading && !data;
  const nothing = !!parsed.text && !entries.length && !isLoading && !error;
  const showPreview = isDesktop();
  const shortcut = searchShortcutLabel();
  const activeChip = CHIPS.find((c) => c.prefix && parsed.prefix === c.prefix)?.prefix ?? (parsed.prefix === "task:" ? "#" : parsed.prefix === "agent:" ? "@" : "");

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) closeSearchPalette(); }}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          "gap-0 overflow-hidden p-0",
          // full screen on phones, a centred panel above
          "max-sm:inset-0 max-sm:h-[100dvh] max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:border-0",
          "sm:top-[12vh] sm:h-[min(640px,76vh)] sm:max-w-4xl sm:translate-y-0",
        )}
        onOpenAutoFocus={(e) => { e.preventDefault(); inputRef.current?.focus(); }}
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">Search chats, tasks, agents, files, pages and commands</DialogDescription>
        <CommandPrimitive
          shouldFilter={false}
          loop
          value={selected}
          onValueChange={setSelected}
          onKeyDown={onKeyDown}
          className="flex h-full min-h-0 flex-col bg-popover text-popover-foreground"
          label="Search"
        >
          <div className="flex items-center gap-2.5 border-b border-border/70 px-4 max-sm:pt-safe-head">
            <Search className="h-5 w-5 shrink-0 text-muted-foreground" />
            <CommandPrimitive.Input
              ref={inputRef}
              value={query}
              onValueChange={setQuery}
              placeholder="Search chats, tasks, agents, files… or type > for commands"
              className="h-14 min-w-0 flex-1 bg-transparent text-base outline-hidden placeholder:text-muted-foreground"
              aria-label="Search everything"
            />
            {isLoading && parsed.text && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-label="Searching" />}
            {query && (
              <button type="button" onClick={() => { setQuery(""); inputRef.current?.focus(); }} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Clear the search">
                <X className="h-4 w-4" />
              </button>
            )}
            <button type="button" onClick={closeSearchPalette} className="shrink-0 text-sm text-muted-foreground hover:text-foreground sm:hidden">Cancel</button>
            <Kbd className="max-sm:hidden">Esc</Kbd>
          </div>

          <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border/50 px-3 py-2 scrollbar-none" role="toolbar" aria-label="Filters">
            {CHIPS.map((c) => {
              const active = c.prefix === activeChip;
              return (
                <button
                  key={c.label}
                  type="button"
                  aria-pressed={active}
                  onClick={() => { setQuery(c.prefix ? `${c.prefix}${c.prefix.endsWith(":") ? " " : ""}${parsed.text}` : parsed.text); inputRef.current?.focus(); }}
                  className={cn(
                    "shrink-0 rounded-pill border px-2.5 py-0.5 text-xs transition-colors",
                    active ? "border-primary/40 bg-primary/10 text-primary" : "border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {c.label}
                </button>
              );
            })}
          </div>

          <div className="flex min-h-0 flex-1">
            <CommandPrimitive.List ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2 md:max-w-[52%] md:border-r md:border-border/60">
              {groups.map((g) => (
                <CommandPrimitive.Group
                  key={g.id}
                  heading={g.label}
                  className="mb-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-label [&_[cmdk-group-heading]]:text-muted-foreground"
                >
                  {g.entries.map((e) => (
                    <CommandPrimitive.Item
                      key={e.key}
                      value={e.key}
                      onSelect={() => finish(e)}
                      className="group flex cursor-pointer items-center rounded-control px-2 py-1.5 outline-hidden data-[selected=true]:bg-accent"
                    >
                      <EntryRow entry={e} />
                    </CommandPrimitive.Item>
                  ))}
                  {g.more && (
                    <CommandPrimitive.Item
                      value={`more:${g.id}`}
                      onSelect={() => { setQuery(`${g.more!.prefix} ${parsed.text}`); inputRef.current?.focus(); }}
                      className="group flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-xs text-muted-foreground outline-hidden data-[selected=true]:bg-accent data-[selected=true]:text-foreground"
                    >
                      <ArrowRight className="ml-2 h-3.5 w-3.5" />
                      Show all {g.more.total} {g.label.toLowerCase()}
                    </CommandPrimitive.Item>
                  )}
                </CommandPrimitive.Group>
              ))}
              {showSkeleton && <SkeletonRows />}
              {error && (
                <div className="mx-2 my-3 flex items-start gap-2 rounded-control border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>The search failed: {error.message}. Pages and commands still work.</span>
                </div>
              )}
              {nothing && (
                <div className="px-4 py-10 text-center">
                  <p className="text-sm text-foreground">Nothing found for “{parsed.text}”.</p>
                  <p className="mt-1 text-xs text-muted-foreground">Try fewer words, or narrow with a prefix: <span className="font-mono">chat:</span>, <span className="font-mono">@</span> agents, <span className="font-mono">#</span> tasks.</p>
                </div>
              )}
              {!parsed.text && parsed.scope === "types" && (
                <p className="px-4 py-8 text-center text-xs text-muted-foreground">Type to search {PALETTE_PREFIXES.find((p) => p.prefix === parsed.prefix)?.label.toLowerCase()}.</p>
              )}
            </CommandPrimitive.List>
            {showPreview && (
              <div className="hidden min-h-0 flex-1 md:block" aria-live="polite">
                <SearchPreview entry={selectedEntry} query={parsed.text} />
              </div>
            )}
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-4 py-2 text-micro text-muted-foreground max-sm:hidden">
            <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
            <span className="flex items-center gap-1"><Kbd>↵</Kbd> open</span>
            <span className="flex items-center gap-1"><Kbd>{shortcut.startsWith("⌘") ? "⌘" : "Ctrl"} ↵</Kbd> new tab</span>
            <span className="flex items-center gap-1"><Kbd>Tab</Kbd> next group</span>
            <span className="ml-auto flex items-center gap-2 font-mono">
              <span><b className="text-foreground/80">&gt;</b> commands</span>
              <span><b className="text-foreground/80">/</b> pages</span>
              <span><b className="text-foreground/80">@</b> agents</span>
              <span><b className="text-foreground/80">#</b> tasks</span>
              <span><b className="text-foreground/80">chat:</b> <b className="text-foreground/80">file:</b> …</span>
            </span>
            {!!data?.partial.length && <span className="w-full text-muted-foreground/80">Still loading: {data.partial.join(", ")}.</span>}
          </div>
        </CommandPrimitive>
      </DialogContent>
    </Dialog>
  );
}

/** The palette and its shortcut (⌘K / Ctrl+K): mounted once by the layout. */
export function GlobalSearch() {
  useSearchShortcut();
  const { open, seq } = useSearchPalette();
  // a link may open it (?search=<query>, e.g. What's new): open, then drop the parameter
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has("search")) return;
    openSearchPalette(params.get("search") ?? "");
    params.delete("search");
    const rest = params.toString();
    navigate({ pathname: location.pathname, search: rest ? `?${rest}` : "" }, { replace: true });
  }, [location.pathname, location.search, navigate]);
  // nothing mounted (no search hook running) until it is first opened (seq counts the openings)
  return open || seq > 0 ? <SearchPalette /> : null;
}
