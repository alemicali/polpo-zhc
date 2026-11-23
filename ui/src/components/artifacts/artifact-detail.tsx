import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, Check, ChevronDown, Cloud, Code2, CopyPlus, Download, ExternalLink, FileDown, History, Link2, Maximize2, MessageSquare, Pencil, Pin, Printer, RefreshCw, RotateCcw, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useEvents } from "@polpo-ai/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { artifactDownload, artifactWorkspace, artifactsApi, downloadArtifactFile, saveArtifactFile, type Artifact } from "@/lib/artifacts-api";
import { absoluteTime, artifactAuthor } from "@/lib/artifacts-list";
import { artifactPath, useArtifactActions } from "@/hooks/use-artifact-actions";
import { productName, useInstanceBranding } from "@/lib/branding";
import { sidebarActions, useSidebarOpen } from "@/hooks/chat-context";
import { useLayoutMode } from "@/hooks/use-layout-mode";
import { ArtifactIcon } from "./artifact-icon";
import { ArtifactPreparation } from "./artifact-preparation";
import { ArtifactView } from "./artifact-view";

const DocEditor = lazy(() => import("./artifact-doc-editor").then((m) => ({ default: m.ArtifactDocEditor })));
const DesignEditor = lazy(() => import("./artifact-design-editor").then((m) => ({ default: m.ArtifactDesignEditor })));
const SlidesEditor = lazy(() => import("./artifact-slides-editor").then((m) => ({ default: m.ArtifactSlidesEditor })));
const ActiveWorkbook = lazy(() => import("./artifact-generation").then(m => ({ default: m.ActiveWorkbook })));
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
  const chatOpen = useSidebarOpen();
  const layout = useLayoutMode();
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
  const [rename, setRename] = useState<string>();
  const [showHistory, setShowHistory] = useState(false);
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
    if (!dirty || !draft || busy || savingRef.current || artifact?.version !== draft.base.version) return false;
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
      return true;
    } catch (err) {
      setSaveError((err as Error).message);
      return false;
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
  async function duplicate() {
    if (!artifact || busy || saving) return;
    setBusy(true);
    try {
      const copy = await artifactsApi.duplicate(id, shownVersion?.version ?? artifact.version);
      navigate(artifactPath(copy.id), { state: { createdArtifact: copy } });
    } catch (err) { toast.error((err as Error).message); }
    finally { setBusy(false); }
  }

  async function togglePin() {
    if (!artifact || busy || saving) return;
    setBusy(true);
    try { setArtifact(await artifactsApi.update(id, { pinned: !artifact.pinned, expectedVersion: artifact.version })); }
    catch (err) { toast.error((err as Error).message); }
    finally { setBusy(false); }
  }
  async function leaveEditor(path: string) {
    if (busy || saving) return;
    if (dirty) {
      setBusy(true);
      const saved = await save();
      setBusy(false);
      if (!saved) return;
    }
    navigate(path);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-[45px] shrink-0 items-center gap-1.5 border-b bg-background px-2">
        {!embedded && <Button size="icon" variant="ghost" className="size-8" disabled={busy || saving} onClick={() => void leaveEditor("/artifacts")} aria-label="Back to artifacts"><ArrowLeft className="size-4" /></Button>}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" className="h-7 min-w-0 max-w-[58%] gap-1.5 px-1.5" aria-label={`Artifact actions for ${draft?.title ?? artifact.title}`}>
              <ArtifactIcon artifact={artifact} className="size-4 shrink-0 text-primary" />
              <span className="truncate">{draft?.title ?? artifact.title}</span><ChevronDown className="size-3 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-48">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><Download /> Export</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {artifact.type === "doc" && <>
                  <DropdownMenuItem onSelect={() => void exportDoc("word")}><FileDown /> Word document</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void exportDoc("print")}><Printer /> Print or save PDF</DropdownMenuItem>
                </>}
                <DropdownMenuItem onSelect={() => saveArtifactFile(artifact, content)}><Download /> Download source</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {!legacy && <DropdownMenuItem disabled={busy || saving || dirty} onSelect={() => void togglePin()}><Pin />{artifact.pinned ? "Unpin" : "Pin"}</DropdownMenuItem>}
            {editable && <DropdownMenuItem onSelect={() => setRename(draft?.title ?? artifact.title)}><Pencil /> Rename</DropdownMenuItem>}
            {!legacy && <DropdownMenuItem disabled={busy || dirty || saving} onSelect={() => void duplicate()}><CopyPlus /> Duplicate</DropdownMenuItem>}
            {!workspace && (artifact.type === "html" || legacy) && <DropdownMenuItem onSelect={() => setRefreshKey(key => key + 1)}><RefreshCw /> Refresh</DropdownMenuItem>}
            {artifact.versions.length > 0 && <DropdownMenuItem onSelect={() => setShowHistory(true)}><History /> Version history</DropdownMenuItem>}
            <DropdownMenuSeparator />
            {!legacy && <DropdownMenuItem onSelect={() => setSource({ value: content, version: artifact.version })}><Code2 /> View source</DropdownMenuItem>}
            {editable && dirty && <DropdownMenuItem disabled={saving || versionChanged} onSelect={() => void save()}><Save /> Save now</DropdownMenuItem>}
            <DropdownMenuItem onSelect={() => void stage.current?.requestFullscreen?.().catch(() => {})}><Maximize2 /> Full screen</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void copyLink(artifact)}><Link2 /> Copy link</DropdownMenuItem>
            {!legacy && <><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" disabled={busy || saving} onSelect={() => void remove()}><Trash2 /> Delete</DropdownMenuItem></>}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex-1" />
        {!embedded && <Button size="sm" variant="ghost" className={layout === "chat-first" ? "lg:hidden" : ""} aria-label="Chat with assistant"
          onClick={() => {
            if (window.matchMedia("(max-width: 1023px)").matches) void leaveEditor(`/chat?artifact=${encodeURIComponent(id)}`);
            else sidebarActions.setSidebarOpen(!chatOpen);
          }}><MessageSquare className="size-4" /><span className="hidden sm:inline">Chat</span></Button>}
        {editable && <span role="status" title={saveError || autoSaveStatus} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          {autoSaveStatus === "Saved" ? <Check className="size-3.5" /> : <Cloud className="size-3.5" />}
          <span className={autoSaveStatus === "Saved" ? "sr-only" : "hidden sm:inline"}>{autoSaveStatus}</span>
        </span>}
        {!legacy && showHistory && artifact.versions.length > 0 && (
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
      <div ref={stage} className="min-h-0 flex-1 overflow-hidden bg-background" inert={busy}>
        <Suspense fallback={<ArtifactPreparation kind={artifact.kind} />}>
          {workspace === "slides" ? (
            <SlidesEditor content={content} onChange={onChange} title={artifact.title} />
          ) : workspace === "sheets" ? (
            <ActiveWorkbook artifactId={id} content={content} onChange={onChange} version={shownVersion?.version ?? artifact.version} follow={!dirty && !shownVersion && !embedded} />
          ) : workspace === "motion" ? (
            <MotionEditor content={content} onChange={onChange} title={artifact.title} />
          ) : onChange && artifact.type === "doc" ? (
            <DocEditor content={content} onChange={onChange} />
          ) : artifact.type === "html" && artifact.kind === "design" ? (
            <DesignEditor artifact={artifact} content={content} onChange={onChange} refreshKey={refreshKey} />
          ) : (
            <ArtifactView artifact={artifact} content={content} refreshKey={refreshKey} />
          )}
        </Suspense>
      </div>
      <Dialog open={rename !== undefined} onOpenChange={open => { if (!open) setRename(undefined); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Rename artifact</DialogTitle></DialogHeader>
          <form className="grid gap-3" onSubmit={event => {
            event.preventDefault();
            if (rename?.trim()) { updateDraft({ title: rename.trim() }); setRename(undefined); }
          }}>
            <Input aria-label="Artifact title" value={rename ?? ""} onChange={event => setRename(event.target.value)} autoFocus />
            <Button type="submit" className="justify-self-end" disabled={!rename?.trim()}>Rename</Button>
          </form>
        </DialogContent>
      </Dialog>
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
