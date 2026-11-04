/**
 * Artifacts — documents, dashboards, designs and diagrams made by agents and people. A gallery
 * (by type, searchable) and a viewer with the artifact running live, its versions (go back to any),
 * its source, and download. The former data views are here too, as artifacts of type "view".
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft, BarChart3, Code2, Download, FileText, GitBranch, History, Image as ImageIcon, LayoutDashboard,
  Loader2, Maximize2, Palette, RefreshCw, RotateCcw, Search, Sparkles, Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useEvents } from "@polpo-ai/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArtifactView } from "@/components/artifacts/artifact-view";
import {
  artifactDownload, artifactLabel, artifactsApi,
  type Artifact, type ArtifactSummary, type ArtifactType,
} from "@/lib/artifacts-api";

const FILTERS: { value: "all" | ArtifactType; label: string }[] = [
  { value: "all", label: "All" },
  { value: "html", label: "Pages" },
  { value: "doc", label: "Documents" },
  { value: "mermaid", label: "Diagrams" },
  { value: "svg", label: "Drawings" },
];

function ArtifactIcon({ artifact, className = "h-4 w-4" }: { artifact: Pick<ArtifactSummary, "type" | "kind">; className?: string }) {
  if (artifact.type === "doc") return <FileText className={className} />;
  if (artifact.type === "mermaid") return <GitBranch className={className} />;
  if (artifact.type === "svg") return <ImageIcon className={className} />;
  if (artifact.type === "view") return <BarChart3 className={className} />;
  if (artifact.kind === "dashboard") return <LayoutDashboard className={className} />;
  if (artifact.kind === "design") return <Palette className={className} />;
  return <Sparkles className={className} />;
}

function when(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function LegacyBadge() {
  return <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-700 dark:text-amber-300">Legacy</Badge>;
}

const author = (by: string) => (by.startsWith("person:") ? by.slice("person:".length) : by === "polpo" ? "Polpo" : by);

export function ArtifactsPage() {
  const { artifactId } = useParams();
  return artifactId ? <ArtifactDetail id={artifactId} /> : <ArtifactGallery />;
}

function ArtifactGallery() {
  const [params, setParams] = useSearchParams();
  const filter = (params.get("type") as ArtifactType | null) ?? "all";
  // the former views have no tab of their own: they show in All (marked Legacy), or with ?type=view
  const tab = FILTERS.some((f) => f.value === filter) ? filter : "all";
  const [q, setQ] = useState("");
  const [items, setItems] = useState<ArtifactSummary[] | null>(null);
  const { events } = useEvents(["artifact:changed", "data-view:changed"], 1);

  const load = useCallback(() => artifactsApi.list(filter === "all" ? {} : { type: filter }).then(setItems, (e: Error) => toast.error(e.message)), [filter]);
  useEffect(() => { void load(); }, [load, events.length]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = items ?? [];
    return needle ? list.filter((a) => a.title.toLowerCase().includes(needle) || (a.description ?? "").toLowerCase().includes(needle)) : list;
  }, [items, q]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={tab} onValueChange={(v) => setParams(v === "all" ? {} : { type: v })}>
          <TabsList>{FILTERS.map((f) => <TabsTrigger key={f.value} value={f.value}>{f.label}</TabsTrigger>)}</TabsList>
        </Tabs>
        <div className="relative ml-auto w-full max-w-xs">
          <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search artifacts" className="h-8 pl-7 text-sm" />
        </div>
      </div>
      {items === null ? (
        <div className="flex flex-1 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : shown.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
          <Sparkles className="h-6 w-6" />
          <p>No artifacts yet.</p>
          <p className="max-w-sm text-xs">Ask Polpo or an agent for a dashboard on your data, a document, a design or a diagram: it appears here.</p>
        </div>
      ) : (
        <div className="grid gap-3 overflow-auto pb-bottom-nav sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((a) => (
            <Link key={a.id} to={`/artifacts/${encodeURIComponent(a.id)}`}
              className="group flex flex-col gap-2 rounded-lg border border-border/50 bg-card/80 p-4 transition-colors hover:border-primary/40 hover:bg-accent/30">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary"><ArtifactIcon artifact={a} /></span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-sm">{a.title}</p>
                  <p className="text-[11px] text-muted-foreground">{artifactLabel(a)} · {author(a.createdBy)}</p>
                </div>
                {a.type === "view" && <LegacyBadge />}
                {a.pinned && <Badge variant="secondary" className="text-[10px]">Pinned</Badge>}
              </div>
              {a.description && <p className="line-clamp-2 text-xs text-muted-foreground">{a.description}</p>}
              <p className="mt-auto text-[11px] text-muted-foreground">
                {a.type === "view" ? "" : `v${a.version} · `}{when(a.updatedAt)}
                {a.sources?.length ? ` · ${a.sources.length} source${a.sources.length === 1 ? "" : "s"}` : ""}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function ArtifactDetail({ id }: { id: string }) {
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

  if (error) return <div className="p-4 text-sm text-destructive">{error} <Link to="/artifacts" className="underline">Back to artifacts</Link></div>;
  if (!artifact) return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  const shownVersion = version !== undefined ? artifact.versions.find((v) => v.version === version) : undefined;
  const content = shownVersion?.content ?? artifact.content;
  const legacyView = artifact.type === "view";

  const download = () => {
    const { filename, mime } = artifactDownload(artifact);
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

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
      navigate("/artifacts");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const fullscreen = () => document.getElementById("artifact-stage")?.requestFullscreen?.().catch(() => {});

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => navigate("/artifacts")} aria-label="Back to artifacts"><ArrowLeft className="h-4 w-4" /></Button>
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary"><ArtifactIcon artifact={artifact} className="h-3.5 w-3.5" /></span>
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 truncate text-sm font-semibold">{artifact.title}{legacyView && <LegacyBadge />}</h1>
          <p className="text-[11px] text-muted-foreground">
            {artifactLabel(artifact)} · by {author(artifact.createdBy)}{legacyView ? "" : ` · v${artifact.version}`} · {when(artifact.updatedAt)}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {!legacyView && artifact.versions.length > 0 && (
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              <History className="h-3.5 w-3.5" />
              <select className="h-8 rounded-md border border-border bg-background px-2 text-xs" value={version ?? ""}
                onChange={(e) => setVersion(e.target.value ? Number(e.target.value) : undefined)} aria-label="Version">
                <option value="">v{artifact.version} (current)</option>
                {artifact.versions.map((v) => <option key={v.version} value={v.version}>v{v.version} · {when(v.at)}{v.note ? ` · ${v.note}` : ""}</option>)}
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
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={download} aria-label="Download"><Download className="h-3.5 w-3.5" /></Button>
          {!legacyView && <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={() => void remove()} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>}
        </div>
      </div>
      {legacyView && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          A legacy view, from before artifacts. It still works, but it can no longer be edited here: ask Polpo or an agent to remake it as an html dashboard.
        </p>
      )}
      {(artifact.description || artifact.sources?.length || shownVersion) && (
        <p className="text-xs text-muted-foreground">
          {shownVersion ? `Showing v${shownVersion.version}${shownVersion.author ? ` by ${author(shownVersion.author)}` : ""}. ` : ""}
          {artifact.description}
          {artifact.sources?.length ? ` Reads: ${artifact.sources.join(", ")}.` : ""}
        </p>
      )}
      <div id="artifact-stage" className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border/50 bg-background">
        {showSource
          ? <pre className="h-full overflow-auto p-4 text-xs"><code>{content}</code></pre>
          : <ArtifactView artifact={artifact} content={content} refreshKey={refreshKey} />}
      </div>
    </div>
  );
}
