/**
 * Artifacts — documents, dashboards, designs and diagrams made by agents and people. The list (by type,
 * searchable) as a sortable table or as a file manager with the selected artifact live beside it, and a
 * viewer with the artifact running live, its versions (go back to any), its source, and download. The
 * former data views are here too, as artifacts of type "view".
 */
import { BetaBadge } from "@/components/shared/beta-badge";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  LayoutGrid, List, ListFilter, PanelRight, Search, Sparkles, X,
} from "lucide-react";
import { toast } from "sonner";
import { useEvents, useMissions, useTasks } from "@polpo-ai/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ArtifactPreparation } from "@/components/artifacts/artifact-preparation";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SegmentedControl, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ArtifactTemplates } from "@/components/artifacts/artifact-templates";
import { ArtifactsGrid } from "@/components/artifacts/artifacts-grid";
import { ArtifactDetail } from "@/components/artifacts/artifact-detail";
import { ArtifactDropZone, ArtifactUploadButton } from "@/components/artifacts/artifact-upload";
import {
  ArtifactsPreviewLayout, ArtifactsTable, type ArtifactRowInfo,
} from "@/components/artifacts/artifacts-browser";
import { useArtifactActions } from "@/hooks/use-artifact-actions";
import {
  artifactLabel, artifactsApi, type ArtifactSummary, type ArtifactType,
} from "@/lib/artifacts-api";
import {
  DEFAULT_ARTIFACT_SORT, artifactAuthor, groupArtifactsByType, artifactOrigin, nextArtifactSort, readArtifactsLayout, sortArtifacts,
  writeArtifactsLayout, type ArtifactSort, type ArtifactsLayout,
} from "@/lib/artifacts-list";
import { useNow } from "@/hooks/use-now";
import { productName, useInstanceBranding } from "@/lib/branding";

const FILTERS: { value: "all" | ArtifactType; label: string }[] = [
  { value: "all", label: "All" },
  { value: "html", label: "Pages" },
  { value: "doc", label: "Documents" },
  { value: "mermaid", label: "Diagrams" },
  { value: "svg", label: "Drawings" },
];

const SORTS: { key: ArtifactSort["key"]; dir: ArtifactSort["dir"]; label: string }[] = [
  { key: "updatedAt", dir: "desc", label: "Newest updated" },
  { key: "updatedAt", dir: "asc", label: "Oldest updated" },
  { key: "title", dir: "asc", label: "Name (A–Z)" },
  { key: "createdBy", dir: "asc", label: "Created by" },
  { key: "type", dir: "asc", label: "Artifact type" },
  { key: "size", dir: "desc", label: "Largest first" },
];

const WORKSPACE_FILTERS = [
  { value: "slides", label: "Slides" },
  { value: "sheets", label: "Sheets" },
  { value: "design", label: "Design" },
  { value: "motion", label: "Motion" },
] as const;

const DATE_FILTERS = [
  { days: 0, label: "Any time" },
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
] as const;
const DAY_MS = 86_400_000;

export function ArtifactsPage() {
  const { artifactId } = useParams();
  return artifactId ? <ArtifactDetail key={artifactId} id={artifactId} /> : <ArtifactGallery />;
}

function ArtifactGallery() {
  const product = productName(useInstanceBranding());
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const requestedType = params.get("type");
  const filter = requestedType === "view" ? "view" : FILTERS.find((f) => f.value === requestedType)?.value ?? "all";
  const format = filter === "html" ? WORKSPACE_FILTERS.find((item) => item.value === params.get("kind"))?.value : undefined;
  const mine = params.get("owner") === "me";
  const [q, setQ] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [days, setDays] = useState(0);
  const [items, setItems] = useState<ArtifactSummary[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const requestIndex = useRef(0);
  const [layout, setLayoutState] = useState<ArtifactsLayout>(readArtifactsLayout);
  const [sort, setSort] = useState<ArtifactSort>(DEFAULT_ARTIFACT_SORT);
  const [active, setActive] = useState(-1);
  const { events: [lastEvent] } = useEvents(["artifact:changed", "data-view:changed"], 1);
  const { tasks } = useTasks();
  const { missions } = useMissions();

  const load = useCallback(() => {
    const request = ++requestIndex.current;
    return artifactsApi.list({ ...(filter === "all" ? {} : { type: filter }), ...(mine ? { mine: true } : {}) }).then((result) => {
      if (requestIndex.current === request) {
        setItems(result);
        setLoadError(false);
      }
    }, (error: Error) => {
      if (requestIndex.current === request) {
        setLoadError(true);
        toast.error(error.message);
      }
    });
  }, [filter, mine]);
  useEffect(() => { void load(); }, [load, lastEvent]);
  const actions = useArtifactActions(() => void load());

  const setLayout = (next: ArtifactsLayout) => { setLayoutState(next); writeArtifactsLayout(next); };

  useEffect(() => {
    if (searchOpen) search.current?.focus();
  }, [searchOpen]);

  const closeSearch = () => {
    setSearchOpen(false);
    setQ("");
    setActive(-1);
    searchTrigger.current?.focus();
  };

  const info = useMemo(() => {
    const taskTitle = new Map((tasks ?? []).map((t) => [t.id, t.title]));
    const missionName = new Map((missions ?? []).map((m) => [m.id, m.name]));
    const rows = new Map<string, ArtifactRowInfo>((items ?? []).map((a) => [a.id, {
      author: artifactAuthor(a.createdBy, product),
      origin: artifactOrigin(a, { task: (id) => taskTitle.get(id), mission: (id) => missionName.get(id) }),
    }]));
    return (a: ArtifactSummary): ArtifactRowInfo => rows.get(a.id) ?? { author: artifactAuthor(a.createdBy, product), origin: null };
  }, [items, tasks, missions, product]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const since = days ? now - days * DAY_MS : undefined;
    const filtered = (items ?? []).filter((artifact) =>
      (filter === "all" || artifact.type === filter) &&
      (!format || artifact.kind === format) &&
      (!pinnedOnly || artifact.pinned) &&
      (since === undefined || Date.parse(artifact.updatedAt) >= since) &&
      (!needle || [artifact.title, artifact.description ?? "", artifactLabel(artifact)].some((value) => value.toLowerCase().includes(needle))),
    );
    return sortArtifacts(filtered, sort, { author: (a) => info(a).author, origin: (a) => info(a).origin?.label ?? "" });
  }, [items, q, sort, info, filter, format, pinnedOnly, days, now]);

  // the preview layout shows one artifact: the one picked (kept in the address), else the first
  const picked = params.get("selected");
  const selectedId = shown.some((a) => a.id === picked) ? picked : groupArtifactsByType(shown)[0]?.items[0]?.id ?? null;
  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("selected", id);
    setParams(next, { replace: true });
  };
  const changeTab = (value: string) => {
    setActive(-1);
    setParams({ ...(mine ? { owner: "me" } : {}), ...(value === "all" ? {} : { type: value }) });
  };
  const changeFormat = (value: string) => {
    const workspace = WORKSPACE_FILTERS.find((item) => item.value === value);
    if (!workspace) { changeTab(value); return; }
    setActive(-1);
    setParams({ ...(mine ? { owner: "me" } : {}), type: "html", kind: workspace.value });
  };
  const filtered = q.trim() !== "" || filter !== "all" || pinnedOnly || days !== 0;

  return (
    <ArtifactDropZone onUploaded={() => void load()} className={cn("mx-auto flex h-full min-h-0 w-full flex-col gap-3", layout === "preview" ? "max-w-[86rem]" : "max-w-5xl")}>
      <h1 className="mb-1 flex items-center gap-2 font-heading text-2xl font-semibold tracking-tight">Artifacts <BetaBadge /></h1>
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={mine ? "mine" : "all"} onValueChange={value => {
          const next = new URLSearchParams(params);
          next.delete("selected");
          if (value === "mine") next.set("owner", "me"); else next.delete("owner");
          setActive(-1);
          setParams(next);
        }} className="max-w-full overflow-x-auto">
          <TabsList><TabsTrigger value="all">All</TabsTrigger><TabsTrigger value="mine">Yours</TabsTrigger></TabsList>
        </Tabs>
        <div className="ml-auto flex items-center gap-1.5">
          <ArtifactUploadButton onUploaded={() => void load()} />
          <Button ref={searchTrigger} size="icon-sm" variant="ghost" aria-label="Search artifacts" title="Search artifacts"
            aria-expanded={searchOpen} aria-controls={searchOpen ? "artifact-search" : undefined} onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}>
            <Search className="size-4" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant={filter === "all" && !pinnedOnly && !days ? "ghost" : "secondary"} aria-label="Filter and sort" title="Filter and sort">
                <ListFilter className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Sort by</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup value={`${sort.key}:${sort.dir}`} onValueChange={(value) => {
                    const next = SORTS.find((option) => `${option.key}:${option.dir}` === value);
                    if (next) { setSort({ key: next.key, dir: next.dir }); setActive(-1); }
                  }}>
                    {SORTS.map(({ key, dir, label }) => <DropdownMenuRadioItem key={`${key}:${dir}`} value={`${key}:${dir}`}>{label}</DropdownMenuRadioItem>)}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Type</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup value={format ?? filter} onValueChange={changeFormat}>
                    {FILTERS.map(({ value, label }) => <DropdownMenuRadioItem key={value} value={value}>{label}</DropdownMenuRadioItem>)}
                    {WORKSPACE_FILTERS.map(({ value, label }) => <DropdownMenuRadioItem key={value} value={value}>{label}</DropdownMenuRadioItem>)}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Updated</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup value={String(days)} onValueChange={(value) => { setDays(Number(value)); setActive(-1); }}>
                    {DATE_FILTERS.map(({ days, label }) => <DropdownMenuRadioItem key={days} value={String(days)}>{label}</DropdownMenuRadioItem>)}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem checked={pinnedOnly} onCheckedChange={(checked) => { setPinnedOnly(checked); setActive(-1); }}>
                Pinned only
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <SegmentedControl value={layout} onValueChange={setLayout} size="sm" aria-label="Layout">
            <ToggleGroupItem value="table" aria-label="List" title="List view"><List className="size-3.5" /></ToggleGroupItem>
            <ToggleGroupItem value="grid" aria-label="Grid" title="Grid view"><LayoutGrid className="size-3.5" /></ToggleGroupItem>
            <ToggleGroupItem value="preview" aria-label="Preview" title="Split preview"><PanelRight className="size-3.5" /></ToggleGroupItem>
          </SegmentedControl>
        </div>
        {searchOpen && (
          <div id="artifact-search" className="relative w-full sm:ml-auto sm:w-72">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" aria-hidden="true" />
            <Input ref={search} type="search" value={q}
              onChange={(event) => { setQ(event.target.value); setActive(-1); }}
              onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeSearch(); } }}
              aria-label="Find an artifact" placeholder="Search by name or type" className="h-8 min-w-0 pl-8 pr-9 text-sm [&::-webkit-search-cancel-button]:hidden" />
            <Button type="button" size="icon-sm" variant="ghost" className="absolute right-0.5 top-0.5 size-7" aria-label="Close search" onClick={closeSearch}>
              <X className="size-3.5" />
            </Button>
          </div>
        )}
      </div>
      <ArtifactTemplates />
      {loadError ? (
        <div role="status" className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
          <p>Couldn't load artifacts.</p>
          <Button size="sm" variant="outline" onClick={() => { setLoadError(false); void load(); }}>Retry</Button>
        </div>
      ) : items === null ? (
        <div className="min-h-0 flex-1"><ArtifactPreparation /></div>
      ) : shown.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
          <Sparkles className="h-6 w-6" />
          <p>{filtered ? "No artifacts match." : "No artifacts yet."}</p>
          {!filtered && <p className="max-w-sm text-xs">Choose a template above, drop files here to upload them, or ask {product} to create an artifact.</p>}
        </div>
      ) : layout === "grid" ? (
        <ArtifactsGrid items={shown} info={info} actions={actions} now={now} />
      ) : layout === "table" ? (
        <ArtifactsTable items={shown} info={info} sort={sort} now={now} actions={actions}
          onSort={(key) => setSort((s) => nextArtifactSort(s, key))} active={active} setActive={setActive} />
      ) : (
        <ArtifactsPreviewLayout items={shown} selectedId={selectedId} onSelect={select} info={info} actions={actions} now={now}
          preview={selectedId ? <ArtifactDetail key={selectedId} id={selectedId} embedded onDeleted={() => void load()} /> : null} />
      )}
    </ArtifactDropZone>
  );
}
