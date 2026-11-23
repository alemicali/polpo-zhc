/**
 * Artifacts — documents, dashboards, designs and diagrams made by agents and people. The list (by type,
 * searchable) as a sortable table or as a file manager with the selected artifact live beside it, and a
 * viewer with the artifact running live, its versions (go back to any), its source, and download. The
 * former data views are here too, as artifacts of type "view".
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft, Code2, Download, ExternalLink, History, Link2, List, Loader2, Maximize2, PanelRight, RefreshCw, RotateCcw, Search, Sparkles, Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useEvents, useMissions, useTasks } from "@polpo-ai/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SegmentedControl, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ArtifactView } from "@/components/artifacts/artifact-view";
import {
  ArtifactIcon, ArtifactsPreviewLayout, ArtifactsTable, LegacyBadge, type ArtifactRowInfo,
} from "@/components/artifacts/artifacts-browser";
import { artifactPath, useArtifactActions } from "@/hooks/use-artifact-actions";
import {
  artifactLabel, artifactLink, artifactsApi, saveArtifactFile,
  type Artifact, type ArtifactSummary, type ArtifactType,
} from "@/lib/artifacts-api";
import {
  DEFAULT_ARTIFACT_SORT, absoluteTime, artifactAuthor, groupArtifactsByType, artifactOrigin, nextArtifactSort, readArtifactsLayout, sortArtifacts,
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
  return artifactId ? <ArtifactDetail id={artifactId} /> : <ArtifactGallery />;
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
  const { events } = useEvents(["artifact:changed", "data-view:changed"], 1);
  const { tasks } = useTasks();
  const { missions } = useMissions();

  const load = useCallback(() => artifactsApi.list(filter === "all" ? {} : { type: filter }).then(setItems, (e: Error) => toast.error(e.message)), [filter]);
  useEffect(() => { void load(); }, [load, events.length]);
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
    const filtered = needle ? list.filter((a) => a.title.toLowerCase().includes(needle) || (a.description ?? "").toLowerCase().includes(needle)) : list;
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
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={tab} onValueChange={changeTab} className="max-w-full overflow-x-auto">
          <TabsList>{FILTERS.map((f) => <TabsTrigger key={f.value} value={f.value}>{f.label}</TabsTrigger>)}</TabsList>
        </Tabs>
        <div className="ml-auto flex w-full items-center gap-2 sm:w-auto">
          <div className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
            <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input value={q} onChange={(e) => { setQ(e.target.value); setActive(-1); }} placeholder="Search artifacts" className="h-8 pl-7 text-sm" />
          </div>
          <SegmentedControl value={layout} onValueChange={setLayout} size="sm" aria-label="Layout">
            <ToggleGroupItem value="table" aria-label="Table" title="Table"><List className="h-3.5 w-3.5" /><span className="hidden sm:inline">Table</span></ToggleGroupItem>
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
          {!q.trim() && <p className="max-w-sm text-xs">Ask {product} or an agent for a dashboard on your data, a document, a design or a diagram: it appears here.</p>}
        </div>
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

function ArtifactDetail({ id, embedded = false, onDeleted }: {
  id: string;
  /** Shown beside the list (the preview layout): no way back, a way to open it on its own page. */
  embedded?: boolean;
  onDeleted?: () => void;
}) {
  const product = productName(useInstanceBranding());
  const navigate = useNavigate();
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The version shown: the current one (undefined) or an earlier one. */
  const [version, setVersion] = useState<number | undefined>();
  const [showSource, setShowSource] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const { events } = useEvents(["artifact:changed"], 1);

  const load = useCallback(() => artifactsApi.get(id).then((a) => { setArtifact(a); setError(null); }, (e: Error) => setError(e.message)), [id]);
  useEffect(() => { void load(); }, [load, events.length]);

  if (error) return <div className="p-4 text-sm text-destructive">{error} {!embedded && <Link to="/artifacts" className="underline">Back to artifacts</Link>}</div>;
  if (!artifact) return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  const shownVersion = version !== undefined ? artifact.versions.find((v) => v.version === version) : undefined;
  const content = shownVersion?.content ?? artifact.content;
  const legacyView = artifact.type === "view";
  const stageId = embedded ? "artifact-preview-stage" : "artifact-stage";

  const restore = async () => {
    if (version === undefined) return;
    setBusy(true);
    try {
      await artifactsApi.restore(artifact.id, version);
      setVersion(undefined);
      await load();
      toast.success(`Version ${version} restored`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete "${artifact.title}" and its versions?`)) return;
    try {
      await artifactsApi.remove(artifact.id);
      if (embedded) onDeleted?.(); else navigate("/artifacts");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(artifactLink(artifact.id));
      toast.success("Link copied");
    } catch {
      toast.error("Could not copy the link");
    }
  };

  const fullscreen = () => document.getElementById(stageId)?.requestFullscreen?.().catch(() => {});

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {!embedded && <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => navigate("/artifacts")} aria-label="Back to artifacts"><ArrowLeft className="h-4 w-4" /></Button>}
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary"><ArtifactIcon artifact={artifact} className="h-3.5 w-3.5" /></span>
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 truncate font-heading text-h3">{artifact.title}{legacyView && <LegacyBadge />}</h1>
          <p className="text-caption text-muted-foreground">
            {artifactLabel(artifact)} · by {artifactAuthor(artifact.createdBy, product)}{legacyView ? "" : ` · v${artifact.version}`} · {absoluteTime(artifact.updatedAt)}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {!legacyView && artifact.versions.length > 0 && (
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              <History className="h-3.5 w-3.5" />
              <select className="h-8 rounded-md border border-border bg-background px-2 text-xs" value={version ?? ""}
                onChange={(e) => setVersion(e.target.value ? Number(e.target.value) : undefined)} aria-label="Version">
                <option value="">v{artifact.version} (current)</option>
                {artifact.versions.map((v) => <option key={v.version} value={v.version}>v{v.version} · {absoluteTime(v.at)}{v.note ? ` · ${v.note}` : ""}</option>)}
              </select>
            </label>
          )}
          {version !== undefined && (
            <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => void restore()}>
              <RotateCcw className="h-3.5 w-3.5" /> Restore v{version}
            </Button>
          )}
          {(artifact.type === "html" || legacyView) && (
            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setRefreshKey((k) => k + 1)} aria-label="Reload data"><RefreshCw className="h-3.5 w-3.5" /></Button>
          )}
          {!legacyView && (
            <Button size="icon" variant={showSource ? "secondary" : "ghost"} className="h-8 w-8" onClick={() => setShowSource((s) => !s)} aria-label="Source"><Code2 className="h-3.5 w-3.5" /></Button>
          )}
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={fullscreen} aria-label="Full screen"><Maximize2 className="h-3.5 w-3.5" /></Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => saveArtifactFile(artifact, content)} aria-label="Download"><Download className="h-3.5 w-3.5" /></Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => void copyLink()} aria-label="Copy link"><Link2 className="h-3.5 w-3.5" /></Button>
          {embedded && <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => navigate(artifactPath(artifact.id))} aria-label="Open"><ExternalLink className="h-3.5 w-3.5" /></Button>}
          {!legacyView && <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={() => void remove()} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>}
        </div>
      </div>
      {legacyView && (
        <p className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
          A legacy view, from before artifacts. It still works, but it can no longer be edited here: ask {product} or an agent to remake it as an html dashboard.
        </p>
      )}
      {(artifact.description || artifact.sources?.length || shownVersion) && (
        <p className="text-xs text-muted-foreground">
          {shownVersion ? `Showing v${shownVersion.version}${shownVersion.author ? ` by ${artifactAuthor(shownVersion.author, product)}` : ""}. ` : ""}
          {artifact.description}
          {artifact.sources?.length ? ` Reads: ${artifact.sources.join(", ")}.` : ""}
        </p>
      )}
      <div id={stageId} className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border/50 bg-background">
        {showSource
          ? <pre className="h-full overflow-auto p-4 text-xs"><code>{content}</code></pre>
          : <ArtifactView artifact={artifact} content={content} refreshKey={refreshKey} />}
      </div>
    </div>
  );
}
