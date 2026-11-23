import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, Check, ChevronDown, Cloud, Code2, Download, ExternalLink, FileDown, History, Link2, Maximize2, MoreHorizontal, Printer, RefreshCw, RotateCcw, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useEvents } from "@polpo-ai/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { artifactDownload, artifactLabel, artifactWorkspace, artifactsApi, downloadArtifactFile, saveArtifactFile, type Artifact } from "@/lib/artifacts-api";
import { absoluteTime, artifactAuthor } from "@/lib/artifacts-list";
import { artifactPath, useArtifactActions } from "@/hooks/use-artifact-actions";
import { productName, useInstanceBranding } from "@/lib/branding";
import { ArtifactIcon } from "./artifact-icon";
import { ArtifactPreparation } from "./artifact-preparation";
import { ArtifactView } from "./artifact-view";

const DocEditor = lazy(() => import("./artifact-doc-editor").then((m) => ({ default: m.ArtifactDocEditor })));
const DesignEditor = lazy(() => import("./artifact-design-editor").then((m) => ({ default: m.ArtifactDesignEditor })));
const SlidesEditor = lazy(() => import("./artifact-slides-editor").then((m) => ({ default: m.ArtifactSlidesEditor })));
const SheetsEditor = lazy(() => import("./artifact-sheets-editor").then((m) => ({ default: m.ArtifactSheetsEditor })));
const MotionEditor = lazy(() => import("./artifact-motion-editor").then((m) => ({ default: m.ArtifactMotionEditor })));

interface Draft {
  base: Pick<Artifact, "version" | "title" | "content">;
  title: string;
  content: string;
}

export function ArtifactDetail({ id, embedded = false, onDeleted }: { id: string; embedded?: boolean; onDeleted?: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { copyLink, remove: deleteArtifact } = useArtifactActions(onDeleted);
  const product = productName(useInstanceBranding());
  const stage = useRef<HTMLDivElement>(null);
  const [artifact, setArtifact] = useState<Artifact | null>(() =>
    location.state?.createdArtifact?.id === id ? location.state.createdArtifact : null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<{ value: string; version: number }>();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<string>();
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
    if (!dirty || !draft || busy || savingRef.current || artifact?.version !== draft.base.version) return;
    savingRef.current = true;
    setSaving(true);
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
      setArtifact((current) => current && current.updatedAt > updated.updatedAt ? current : updated);
      setDraft((current) => !current || current === draft ? undefined : {
        base: updated,
        title: current.title === draft.title ? updated.title : current.title,
        content: current.content === draft.content ? updated.content : current.content,
      });
      setSaveError(undefined);
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [artifact, busy, dirty, draft, id]);

  useEffect(() => {
    if (!dirty || saving || saveError || version !== undefined || embedded || artifact?.version !== draft?.base.version) return;
    const timer = window.setTimeout(() => { void save(); }, 1200);
    return () => window.clearTimeout(timer);
  }, [artifact?.version, dirty, draft?.base.version, embedded, save, saveError, saving, version]);

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
      : <ArtifactPreparation />;
  }

  const shownVersion = artifact.versions.find((item) => item.version === version);
  const content = shownVersion?.content ?? draft?.content ?? artifact.content;
  const workspace = artifactWorkspace(artifact, shownVersion?.content ?? draft?.base.content ?? content);
  const legacy = artifact.type === "view";
  const editable = !legacy && !shownVersion && !embedded;
  const versionChanged = !!draft && artifact.version !== draft.base.version && !saving;
  const autoSaveStatus = saving ? "Saving…" : versionChanged ? "A newer version is available" :
    saveError ? "Changes could not be saved" : dirty ? "Changes pending" : "Saved";

  function updateDraft(patch: Partial<Pick<Draft, "title" | "content">>) {
    if (!artifact) return;
    if (!versionChanged) setSaveError(undefined);
    setDraft((current) => ({
      ...(current ?? { base: artifact, title: artifact.title, content: artifact.content }),
      ...patch,
    }));
  }

  async function restore() {
    if (!shownVersion || !artifact || busy || saving) return;
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
    if (!artifact || busy || saving) return;
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

  const onChange = editable ? (value: string) => updateDraft({ content: value }) : undefined;
  const canUseSource = !legacy;
  const goBack = () => {
    if (!saving && (!dirty || window.confirm("Discard your unsaved changes?"))) navigate("/artifacts");
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border/70 bg-card/70 px-2 py-1.5">
        {!embedded && <Button size="icon" variant="ghost" className="size-8" onClick={goBack} aria-label="Back to artifacts"><ArrowLeft className="size-4" /></Button>}
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary"><ArtifactIcon artifact={artifact} /></span>
        <div className="min-w-0 flex-1">
          {editable ? (
            <Input aria-label="Artifact title" value={draft?.title ?? artifact.title} disabled={busy}
              className="h-7 max-w-md border-transparent bg-transparent px-1 font-heading text-sm font-semibold shadow-none hover:border-border focus-visible:bg-background"
              onChange={(event) => updateDraft({ title: event.target.value })} />
          ) : (
            <h1 className="flex items-center gap-2 truncate font-heading text-sm font-semibold">{artifact.title}{legacy && <Badge variant="outline">Legacy</Badge>}</h1>
          )}
          <p className="truncate px-1 text-caption text-muted-foreground">
            {artifactLabel(artifact)} · {artifactAuthor(artifact.createdBy, product)}{legacy ? "" : ` · v${artifact.version}`}
          </p>
        </div>
        {editable && <span role="status" title={saveError || autoSaveStatus} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          {autoSaveStatus === "Saved" ? <Check className="size-3.5" /> : <Cloud className="size-3.5" />}
          <span className="hidden sm:inline">{autoSaveStatus}</span>
        </span>}
        {!legacy && artifact.versions.length > 0 && (
          <label className="flex items-center gap-1 rounded-md border border-border px-1.5 text-xs text-muted-foreground">
            <History className="size-3.5" />
            <select className="h-7 max-w-28 rounded bg-transparent text-xs sm:max-w-36" value={shownVersion?.version ?? ""}
              onChange={(event) => {
                if (dirty && !window.confirm("Discard your unsaved changes?")) return;
                setDraft(undefined);
                setSaveError(undefined);
                setVersion(event.target.value ? Number(event.target.value) : undefined);
              }} aria-label="Version history" disabled={busy || saving}>
              <option value="">v{artifact.version} (current)</option>
              {artifact.versions.map((item) => <option key={item.version} value={item.version}>v{item.version} · {absoluteTime(item.at)}</option>)}
            </select>
          </label>
        )}
        {shownVersion && <Button size="sm" variant="outline" disabled={busy} onClick={() => void restore()}><RotateCcw className="size-3.5" /> Restore</Button>}
        {embedded && <Button size="sm" variant="outline" onClick={() => navigate(artifactPath(id))} aria-label="Open"><ExternalLink className="size-3.5" /> Open</Button>}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" aria-label="Export artifact"><Download className="size-3.5" /> <span className="hidden sm:inline">Export</span><ChevronDown className="size-3" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {artifact.type === "doc" && <>
              <DropdownMenuItem onSelect={() => void exportDoc("word")}><FileDown /> Word document</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportDoc("print")}><Printer /> Print or save PDF</DropdownMenuItem>
            </>}
            <DropdownMenuItem onSelect={() => saveArtifactFile(artifact, content)}><Download /> Download source</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="size-8" aria-label="Artifact actions"><MoreHorizontal className="size-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {canUseSource && <DropdownMenuItem onSelect={() => setSource({ value: content, version: artifact.version })}><Code2 /> View source</DropdownMenuItem>}
            {editable && <DropdownMenuItem disabled={!dirty || saving || versionChanged} onSelect={() => void save()}><Save /> Save now</DropdownMenuItem>}
            {!workspace && (artifact.type === "html" || legacy) && <DropdownMenuItem onSelect={() => setRefreshKey((key) => key + 1)}><RefreshCw /> Reload data</DropdownMenuItem>}
            <DropdownMenuItem onSelect={() => void stage.current?.requestFullscreen?.().catch(() => {})}><Maximize2 /> Full screen</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void copyLink(artifact)}><Link2 /> Copy link</DropdownMenuItem>
            {!legacy && <><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" disabled={busy || saving} onSelect={() => void remove()}><Trash2 /> Delete</DropdownMenuItem></>}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      {(artifact.description || artifact.sources?.length || shownVersion || error) && (
        <p className="px-1 text-xs text-muted-foreground">
          {shownVersion && `Showing v${shownVersion.version}${shownVersion.author ? ` by ${artifactAuthor(shownVersion.author, product)}` : ""}. `}
          {artifact.description}
          {!!artifact.sources?.length && ` Reads ${artifact.sources.join(", ")}.`}
          {error && <span className="text-destructive"> {error}</span>}
        </p>
      )}
      {editable && (saveError || versionChanged) && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-1.5 text-xs" role="alert">
          <span>{versionChanged ? "A newer version was saved. Download your draft or open the latest version." : saveError}</span>
          <div className="flex gap-1">
            {versionChanged ? <>
              <Button size="sm" variant="ghost" onClick={() => saveArtifactFile(artifact, content)}>Download draft</Button>
              <Button size="sm" variant="outline" onClick={() => {
                if (window.confirm("Open the latest version and discard these local changes?")) { setDraft(undefined); setSaveError(undefined); }
              }}>Open latest</Button>
            </> : <Button size="sm" variant="ghost" disabled={saving} onClick={() => void save()}>Try saving again</Button>}
          </div>
        </div>
      )}
      {legacy && <p className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">Edit this view on the Data page.</p>}
      <div ref={stage} className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border/70 bg-background" inert={busy}>
        <Suspense fallback={<ArtifactPreparation kind={artifact.kind} />}>
          {workspace === "slides" ? (
            <SlidesEditor content={content} onChange={onChange} title={artifact.title} />
          ) : workspace === "sheets" ? (
            <SheetsEditor content={content} onChange={onChange} appearanceVersion={shownVersion?.version ?? artifact.version} />
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
      <Dialog open={!!source} onOpenChange={(open) => { if (!open) setSource(undefined); }}>
        <DialogContent className="max-h-[90dvh] sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Artifact source</DialogTitle>
            <DialogDescription>{artifact.title}</DialogDescription>
          </DialogHeader>
          <textarea aria-label="Source code" spellCheck={false} readOnly={!editable} value={source?.value ?? ""}
            className="h-[55dvh] w-full resize-none rounded-md border border-input bg-muted/20 p-3 font-mono text-xs leading-relaxed focus-visible:outline-2 focus-visible:outline-ring"
            onChange={(event) => { if (source) setSource({ ...source, value: event.target.value }); }} />
          {editable && source && source.version !== artifact.version && <p className="text-xs text-warning" role="status">The source changed. Reopen this window to see the latest version.</p>}
          {editable && <Button className="justify-self-end" disabled={!source || source.value === content || source.version !== artifact.version}
            onClick={() => {
              if (source) updateDraft({ content: source.value });
              setSource(undefined);
            }}>Apply source</Button>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
