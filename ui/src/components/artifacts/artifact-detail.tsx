import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, Code2, Download, Eye, ExternalLink, FileDown, History, Link2, Loader2, Maximize2, Pencil, Printer, RefreshCw, RotateCcw, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useEvents } from "@polpo-ai/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { artifactDownload, artifactLabel, artifactWorkspace, artifactsApi, downloadArtifactFile, saveArtifactFile, type Artifact } from "@/lib/artifacts-api";
import { absoluteTime, artifactAuthor } from "@/lib/artifacts-list";
import { artifactPath, useArtifactActions } from "@/hooks/use-artifact-actions";
import { productName, useInstanceBranding } from "@/lib/branding";
import { ArtifactIcon } from "./artifact-icon";
import { ArtifactView } from "./artifact-view";

const DocEditor = lazy(() => import("./artifact-doc-editor").then((m) => ({ default: m.ArtifactDocEditor })));
const DesignEditor = lazy(() => import("./artifact-design-editor").then((m) => ({ default: m.ArtifactDesignEditor })));
const SlidesEditor = lazy(() => import("./artifact-slides-editor").then((m) => ({ default: m.ArtifactSlidesEditor })));
const SheetsEditor = lazy(() => import("./artifact-sheets-editor").then((m) => ({ default: m.ArtifactSheetsEditor })));
const MotionEditor = lazy(() => import("./artifact-motion-editor").then((m) => ({ default: m.ArtifactMotionEditor })));

type Mode = "preview" | "edit" | "source";
interface Draft {
  base: Pick<Artifact, "version" | "title" | "content">;
  title: string;
  content: string;
}

function Working() {
  return <div className="flex h-full items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" /></div>;
}

export function ArtifactDetail({ id, embedded = false, onDeleted }: { id: string; embedded?: boolean; onDeleted?: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { copyLink, remove: deleteArtifact } = useArtifactActions(onDeleted);
  const product = productName(useInstanceBranding());
  const stage = useRef<HTMLDivElement>(null);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(!embedded && location.state?.edit ? "edit" : "preview");
  const [version, setVersion] = useState<number>();
  const [draft, setDraft] = useState<Draft>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const { events } = useEvents(["artifact:changed"], 1);
  const lastEvent = events[0];

  useEffect(() => {
    let active = true;
    void artifactsApi.get(id).then((result) => {
      if (!active) return;
      setArtifact((current) => current && current.updatedAt > result.updatedAt ? current : result);
      setError(null);
    }, (err: Error) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [id, lastEvent]);

  const dirty = !!draft && (draft.content !== draft.base.content || draft.title !== draft.base.title);

  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty]);

  const save = useCallback(async () => {
    if (!dirty || !draft || busy) return;
    setBusy(true);
    try {
      const title = draft.title.trim();
      if (!title) throw new Error("Enter an artifact title.");
      const workspace = artifact ? artifactWorkspace(artifact, draft.base.content) : undefined;
      if (workspace && draft.content !== draft.base.content) {
        const valid = workspace === "slides" ? (await import("./artifact-slides-format")).parseSlides(draft.content) :
          workspace === "sheets" ? (await import("./artifact-sheets-model")).readWorkbook(draft.content) :
          (await import("./artifact-motion-model")).parseMotion(draft.content);
        if (!valid) throw new Error(`Enter a valid ${workspace} workspace document.`);
      }
      const updated = await artifactsApi.update(id, {
        ...(title !== draft.base.title ? { title } : {}),
        ...(draft.content !== draft.base.content ? { content: draft.content, note: "Edited in the artifact workspace" } : {}),
        expectedVersion: draft.base.version,
      });
      setArtifact(updated);
      setDraft(undefined);
      toast.success(`Saved ${updated.title}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [artifact, busy, dirty, draft, id]);

  useEffect(() => {
    if (!dirty || version !== undefined) return;
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dirty, save, version]);

  if (!artifact) {
    return error
      ? <div className="p-4 text-sm text-destructive">{error} {!embedded && <Link to="/artifacts" className="underline">Back to artifacts</Link>}</div>
      : <Working />;
  }

  const shownVersion = artifact.versions.find((item) => item.version === version);
  const content = shownVersion?.content ?? draft?.content ?? artifact.content;
  const workspace = artifactWorkspace(artifact, shownVersion?.content ?? draft?.base.content ?? content);
  const legacy = artifact.type === "view";
  const editable = !legacy && !shownVersion && !embedded;
  const visualEditor = !!workspace || artifact.type === "doc" || (artifact.type === "html" && artifact.kind === "design");
  const activeMode = legacy || (!editable && mode === "edit") ? "preview" : mode === "edit" && !visualEditor ? "source" : mode;

  function updateDraft(patch: Partial<Pick<Draft, "title" | "content">>) {
    if (!artifact) return;
    setDraft((current) => ({
      ...(current ?? { base: artifact, title: artifact.title, content: artifact.content }),
      ...patch,
    }));
  }

  async function restore() {
    if (!shownVersion || !artifact || busy) return;
    setBusy(true);
    try {
      setArtifact(await artifactsApi.restore(artifact.id, shownVersion.version));
      setVersion(undefined);
      setDraft(undefined);
      toast.success(`Version ${shownVersion.version} restored`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!artifact || busy) return;
    setBusy(true);
    try {
      if (await deleteArtifact(artifact) && !embedded) navigate("/artifacts");
    } finally {
      setBusy(false);
    }
  }

  async function exportDoc(format: "word" | "print") {
    if (!artifact) return;
    try {
      const { artifactDocToWord, printArtifactDoc } = await import("./artifact-doc-export");
      if (format === "print") printArtifactDoc(content, artifact.title);
      else {
        const file = artifactDownload(artifact);
        downloadArtifactFile(file.filename.replace(/\.md$/, ".docx"), await artifactDocToWord(content, artifact.title));
      }
    } catch (error) {
      toast.error((error as Error).message);
    }
  }

  const switchMode = (next: Mode) => setMode(next === "edit" && !visualEditor ? "source" : next);
  const onChange = activeMode === "edit" && editable && !busy ? (value: string) => updateDraft({ content: value }) : undefined;
  const goBack = () => {
    if (!dirty || window.confirm("Discard your unsaved changes?")) navigate("/artifacts");
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <header className="flex flex-wrap items-center gap-2">
        {!embedded && <Button size="icon" variant="ghost" className="size-8" onClick={goBack} aria-label="Back to artifacts"><ArrowLeft className="size-4" /></Button>}
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><ArtifactIcon artifact={artifact} /></span>
        <div className="min-w-0 flex-1">
          {editable && activeMode !== "preview" ? (
            <Input aria-label="Artifact title" value={draft?.title ?? artifact.title} disabled={busy}
              className="h-8 max-w-sm font-heading text-base" onChange={(event) => updateDraft({ title: event.target.value })} />
          ) : (
            <h1 className="flex items-center gap-2 truncate font-heading text-h3">{artifact.title}{legacy && <Badge variant="outline">Legacy</Badge>}</h1>
          )}
          <p className="truncate text-caption text-muted-foreground">
            {artifactLabel(artifact)} · {artifactAuthor(artifact.createdBy, product)}{legacy ? "" : ` · v${artifact.version}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {!legacy && artifact.versions.length > 0 && (
            <label className="flex items-center gap-1 rounded-md border px-1.5 text-xs text-muted-foreground">
              <History className="size-3.5" />
              <select className="h-8 max-w-40 rounded bg-background text-xs" value={shownVersion?.version ?? ""}
                onChange={(event) => {
                  if (dirty && !window.confirm("Discard your unsaved changes?")) return;
                  setDraft(undefined);
                  setVersion(event.target.value ? Number(event.target.value) : undefined);
                  setMode("preview");
                }} aria-label="Version" disabled={busy}>
                <option value="">v{artifact.version} (current)</option>
                {artifact.versions.map((item) => <option key={item.version} value={item.version}>v{item.version} · {absoluteTime(item.at)}{item.note ? ` · ${item.note}` : ""}</option>)}
              </select>
            </label>
          )}
          {shownVersion && <Button size="sm" variant="outline" disabled={busy} onClick={() => void restore()}><RotateCcw className="size-3.5" /> Restore</Button>}
          {artifact.type === "doc" && (
            <>
              <Button size="icon" variant="ghost" aria-label="Download Word document" title="Download Word document" onClick={() => void exportDoc("word")}><FileDown className="size-4" /></Button>
              <Button size="icon" variant="ghost" aria-label="Print or save PDF" title="Print or save PDF" onClick={() => void exportDoc("print")}><Printer className="size-4" /></Button>
            </>
          )}
          {!workspace && (artifact.type === "html" || legacy) && (
            <Button size="icon" variant="ghost" aria-label="Reload data" title="Reload data" onClick={() => setRefreshKey((key) => key + 1)}><RefreshCw className="size-4" /></Button>
          )}
          <Button size="icon" variant="ghost" aria-label="Full screen" title="Full screen" onClick={() => void stage.current?.requestFullscreen?.().catch(() => {})}><Maximize2 className="size-4" /></Button>
          <Button size="icon" variant="ghost" aria-label="Download source" title="Download source" onClick={() => saveArtifactFile(artifact, content)}><Download className="size-4" /></Button>
          <Button size="icon" variant="ghost" aria-label="Copy link" title="Copy link" onClick={() => void copyLink(artifact)}><Link2 className="size-4" /></Button>
          {embedded && <Button size="icon" variant="ghost" aria-label="Open" title="Open in workspace" onClick={() => navigate(artifactPath(id))}><ExternalLink className="size-4" /></Button>}
          {!legacy && <Button size="icon" variant="ghost" className="text-destructive" aria-label="Delete" title="Delete" disabled={busy} onClick={() => void remove()}><Trash2 className="size-4" /></Button>}
        </div>
      </header>
      {(artifact.description || artifact.sources?.length || shownVersion || error) && (
        <p className="text-xs text-muted-foreground">
          {shownVersion && `Showing v${shownVersion.version}${shownVersion.author ? ` by ${artifactAuthor(shownVersion.author, product)}` : ""}. `}
          {artifact.description}
          {!!artifact.sources?.length && ` Reads ${artifact.sources.join(", ")}.`}
          {error && <span className="text-destructive"> {error}</span>}
        </p>
      )}
      {legacy && <p className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">Edit this view on the Data page.</p>}
      <div ref={stage} className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/70 bg-background">
        {!legacy && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 bg-card px-2 py-1.5">
            <div className="flex items-center gap-0.5" aria-label="Workspace mode">
              <Button size="sm" variant={activeMode === "preview" ? "secondary" : "ghost"} aria-pressed={activeMode === "preview"} onClick={() => switchMode("preview")}><Eye className="size-3.5" /> Preview</Button>
              {editable && visualEditor && <Button size="sm" variant={activeMode === "edit" ? "secondary" : "ghost"} aria-pressed={activeMode === "edit"} onClick={() => switchMode("edit")}><Pencil className="size-3.5" /> Edit</Button>}
              <Button size="sm" variant={activeMode === "source" ? "secondary" : "ghost"} aria-pressed={activeMode === "source"} onClick={() => switchMode("source")}><Code2 className="size-3.5" /> Source</Button>
            </div>
            {editable && (dirty || activeMode !== "preview") && (
              <div className="flex items-center gap-2">
                {dirty && <span className="text-caption text-muted-foreground" role="status">{artifact.version === draft.base.version ? "Unsaved changes" : "A newer version is available"}</span>}
                {dirty && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(undefined)}>Discard</Button>}
                <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}><Save className="size-3.5" /> Save version</Button>
              </div>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-hidden" inert={busy}>
          <Suspense fallback={<Working />}>
            {activeMode === "source" ? (
              <textarea aria-label="Artifact source" spellCheck={false} readOnly={!editable || busy} value={content}
                className="h-full w-full resize-none bg-muted/20 p-4 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onChange={(event) => updateDraft({ content: event.target.value })} />
            ) : workspace === "slides" ? (
              <SlidesEditor content={content} onChange={onChange} title={artifact.title} />
            ) : workspace === "sheets" ? (
              <SheetsEditor content={content} onChange={onChange} />
            ) : workspace === "motion" ? (
              <MotionEditor content={content} onChange={onChange} title={artifact.title} />
            ) : onChange && artifact.type === "doc" ? (
              <DocEditor content={content} onChange={onChange} />
            ) : onChange && artifact.type === "html" && artifact.kind === "design" ? (
              <DesignEditor artifact={artifact} content={content} onChange={onChange} refreshKey={refreshKey} />
            ) : (
              <ArtifactView artifact={artifact} content={content} refreshKey={refreshKey} />
            )}
          </Suspense>
        </div>
      </div>
    </div>
  );
}
