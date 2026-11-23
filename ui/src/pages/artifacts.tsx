/**
 * Artifacts — documents, dashboards, designs and diagrams made by agents and people. The list (by type,
 * searchable) as a sortable table or as a file manager with the selected artifact live beside it, and a
 * viewer with the artifact running live, its versions (go back to any), its source, and download. The
 * former data views are here too, as artifacts of type "view".
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  LayoutGrid, List, Loader2, PanelRight, Search, Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { useEvents, useMissions, useTasks } from "@polpo-ai/react";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SegmentedControl, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ArtifactTemplates } from "@/components/artifacts/artifact-templates";
import { ArtifactsGrid } from "@/components/artifacts/artifacts-grid";
import { ArtifactDetail } from "@/components/artifacts/artifact-detail";
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

export function ArtifactsPage() {
  const { artifactId } = useParams();
  return artifactId ? <ArtifactDetail key={artifactId} id={artifactId} /> : <ArtifactGallery />;
}

function ArtifactGallery() {
  const product = productName(useInstanceBranding());
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const filter = (params.get("type") as ArtifactType | null) ?? "all";
  // the former views have no tab of their own: they show in All (marked Legacy), or with ?type=view
  const tab = FILTERS.some((f) => f.value === filter) ? filter : "all";
  const [q, setQ] = useState("");
  const [items, setItems] = useState<ArtifactSummary[] | null>(null);
  const [layout, setLayoutState] = useState<ArtifactsLayout>(readArtifactsLayout);
  const [sort, setSort] = useState<ArtifactSort>(DEFAULT_ARTIFACT_SORT);
  const [active, setActive] = useState(-1);
  const { events: [lastEvent] } = useEvents(["artifact:changed", "data-view:changed"], 1);
  const { tasks } = useTasks();
  const { missions } = useMissions();

  const load = useCallback(() => artifactsApi.list(filter === "all" ? {} : { type: filter }).then(setItems, (e: Error) => toast.error(e.message)), [filter]);
  useEffect(() => { void load(); }, [load, lastEvent]);
  const actions = useArtifactActions(() => void load());

  const setLayout = (next: ArtifactsLayout) => { setLayoutState(next); writeArtifactsLayout(next); };

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
    const list = items ?? [];
    const filtered = needle ? list.filter((a) => a.title.toLowerCase().includes(needle) || (a.description ?? "").toLowerCase().includes(needle) || artifactLabel(a).toLowerCase().includes(needle)) : list;
    return sortArtifacts(filtered, sort, { author: (a) => info(a).author, origin: (a) => info(a).origin?.label ?? "" });
  }, [items, q, sort, info]);

  // the preview layout shows one artifact: the one picked (kept in the address), else the first
  const picked = params.get("selected");
  const selectedId = shown.some((a) => a.id === picked) ? picked : groupArtifactsByType(shown)[0]?.items[0]?.id ?? null;
  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("selected", id);
    setParams(next, { replace: true });
  };
  const changeTab = (v: string) => setParams(v === "all" ? {} : { type: v });

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <ArtifactTemplates />
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={tab} onValueChange={changeTab} className="max-w-full overflow-x-auto">
          <TabsList>{FILTERS.map((f) => <TabsTrigger key={f.value} value={f.value}>{f.label}</TabsTrigger>)}</TabsList>
        </Tabs>
        <div className="ml-auto flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <div className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
            <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input value={q} onChange={(e) => { setQ(e.target.value); setActive(-1); }} placeholder="Search artifacts" className="h-8 pl-7 text-sm" />
          </div>
          <SegmentedControl value={layout} onValueChange={setLayout} size="sm" aria-label="Layout">
            <ToggleGroupItem value="table" aria-label="List" title="List"><List className="size-3.5" /><span className="hidden sm:inline">List</span></ToggleGroupItem>
            <ToggleGroupItem value="grid" aria-label="Grid" title="Grid"><LayoutGrid className="size-3.5" /><span className="hidden sm:inline">Grid</span></ToggleGroupItem>
            <ToggleGroupItem value="preview" aria-label="Preview" title="Preview"><PanelRight className="h-3.5 w-3.5" /><span className="hidden sm:inline">Preview</span></ToggleGroupItem>
          </SegmentedControl>
        </div>
      </div>
      {items === null ? (
        <div className="flex flex-1 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : shown.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
          <Sparkles className="h-6 w-6" />
          <p>{q.trim() ? "No artifacts match." : "No artifacts yet."}</p>
          {!q.trim() && <p className="max-w-sm text-xs">Choose a template above or ask {product} to create an artifact.</p>}
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
    </div>
  );
}
