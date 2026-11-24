import { Suspense, use, useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, Check, ChevronDown, Cloud, Code2, CopyPlus, Download, ExternalLink, FileDown, History, House, Link2, Maximize2, MessageSquare, Pencil, Pin, Printer, RefreshCw, RotateCcw, Save, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { useEvents } from "@polpo-ai/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ARTIFACT_LARGE_WARNING_BYTES, artifactDownload, artifactWorkspace, artifactsApi, downloadArtifactContent, downloadArtifactFile, saveArtifactFile, type Artifact } from "@/lib/artifacts-api";
import { ARTIFACT_UPLOAD_ACCEPT, formatSize, prepareArtifactFile } from "@/lib/artifact-upload";
import { ArtifactLargeView } from "./artifact-large-view";
import { absoluteTime, artifactAuthor } from "@/lib/artifacts-list";
import { artifactPath, useArtifactActions } from "@/hooks/use-artifact-actions";
import { productName, useInstanceBranding } from "@/lib/branding";
import { askAboutArtifact } from "@/hooks/use-artifact-quote";
import { useProjectInfo } from "@/hooks/use-polpo";
import { ChatSessionStateContext, sidebarActions, useSidebarOpen } from "@/hooks/chat-context";
import { useLayoutMode } from "@/hooks/use-layout-mode";
import { ArtifactIcon } from "./artifact-icon";
import { ArtifactPreparation } from "./artifact-preparation";
import { ArtifactView } from "./artifact-view";

import { ArtifactLiveWorkspace } from "./artifact-live-workspace";
import { useLiveArtifactUpdate } from "@/hooks/use-live-artifact";
import { liveArtifactKind } from "@/lib/artifact-stream";

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
  const { info } = useProjectInfo();
  const sessionId = use(ChatSessionStateContext)?.sessionId ?? null;
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
  // versions kept as blobs come without their content: read when shown
  const [loadedVersions, setLoadedVersions] = useState<Record<number, { content: string; omitted?: boolean }>>({});
  const replaceInput = useRef<HTMLInputElement>(null);
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

  const acceptCommitted = useCallback((next: Artifact) => {
    setArtifact(current => current && current.updatedAt > next.updatedAt ? current : next);
  }, []);

  const dirty = !!draft && (draft.content !== draft.base.content || draft.title !== draft.base.title);

  const live = useLiveArtifactUpdate(artifact, !dirty && !saving && version === undefined && !embedded, acceptCommitted);

  const pendingVersion = version !== undefined ? artifact?.versions.find((item) => item.version === version) : undefined;
  const needsVersion = !!pendingVersion && !pendingVersion.content && (pendingVersion.size ?? pendingVersion.blob?.size ?? 0) > 0 && !loadedVersions[pendingVersion.version];
  useEffect(() => {
    if (!needsVersion || !pendingVersion) return;
    let active = true;
    void artifactsApi.version(id, pendingVersion.version).then((loaded) => {
      if (active) setLoadedVersions((current) => ({ ...current, [loaded.version]: { content: loaded.content, ...(loaded.contentOmitted ? { omitted: true } : {}) } }));
    }, (err: Error) => { if (active) toast.error(err.message); });
    return () => { active = false; };
  }, [id, needsVersion, pendingVersion]);

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
  const loadedVersion = shownVersion ? loadedVersions[shownVersion.version] : undefined;
  const shownContent = shownVersion ? loadedVersion?.content ?? shownVersion.content : undefined;
  // too large for the editors: the large view (size, download, replace, outline, preview by pages)
  const omitted = shownVersion ? !!loadedVersion?.omitted : !!artifact.contentOmitted;
  const versionLoading = !!shownVersion && needsVersion;
  const large = !omitted && (artifact.size ?? 0) > ARTIFACT_LARGE_WARNING_BYTES && !shownVersion;
  const content = shownContent ?? draft?.content ?? artifact.content;
  const workspace = artifactWorkspace(artifact, shownContent ?? draft?.base.content ?? (artifact.contentOmitted ? artifact.excerpt ?? "" : content));
  const legacy = artifact.type === "view";
  const docSurface = artifact.type === "doc" ? "artifact-doc-surface" : "";
  const BackIcon = docSurface ? House : ArrowLeft;
  const kind = workspace ?? ((artifact.type === "doc" || artifact.kind === "design") ? liveArtifactKind(artifact.type, artifact.kind) : undefined);
  const editable = !legacy && !shownVersion && !embedded && !artifact.contentOmitted;
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

  async function replaceContent(file: File) {
    if (!artifact || busy || saving) return;
    if (dirty && !window.confirm("Replace the content and discard the changes not saved yet?")) return;
    setBusy(true);
    const toastId = toast.loading(`Uploading ${file.name}…`);
    try {
      const prepared = await prepareArtifactFile(file);
      const updated = await artifactsApi.replaceContent(artifact.id, prepared.file, {
        expectedVersion: artifact.version, filename: prepared.filename,
        onProgress: (sent, total) => toast.loading(`Uploading ${file.name}… ${total ? Math.round((sent / total) * 100) : 100}%`, { id: toastId }),
      });
      setArtifact(updated);
      setDraft(undefined);
      setVersion(undefined);
      toast.success(`Content replaced (version ${updated.version})`, { id: toastId });
    } catch (err) {
      toast.error((err as Error).message, { id: toastId });
    } finally {
      setBusy(false);
    }
  }

  function downloadSource() {
    if (!artifact) return;
    if (omitted || (shownVersion && !shownContent)) void downloadArtifactContent(artifact, shownVersion?.version).catch((err: Error) => toast.error(err.message));
    else saveArtifactFile(artifact, content);
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

  function askAssistant(selection?: string) {
    askAboutArtifact(id, sessionId, selection);
    if (window.matchMedia("(max-width: 1023px)").matches) void leaveEditor(`/chat?artifact=${encodeURIComponent(id)}`);
    else sidebarActions.setSidebarOpen(true);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className={`${docSurface} flex h-[45px] shrink-0 items-center gap-1.5 border-b bg-background px-2 text-foreground`}>
        {!embedded && <Button size="icon" variant="ghost" className="size-8" disabled={busy || saving} onClick={() => void leaveEditor("/artifacts")} aria-label="Back to artifacts"><BackIcon className="size-4" /></Button>}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" className="h-7 min-w-0 max-w-[58%] gap-1.5 px-1.5" aria-label={`Artifact actions for ${draft?.title ?? artifact.title}`}>
              {!docSurface && <ArtifactIcon artifact={artifact} className="size-4 shrink-0 text-primary" />}
              <span className="truncate">{draft?.title ?? artifact.title}</span><ChevronDown className="size-3 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className={`${docSurface} min-w-48`}>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><Download /> Export</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className={docSurface}>
                {artifact.type === "doc" && <>
                  <DropdownMenuItem onSelect={() => void exportDoc("word")}><FileDown /> Word document</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void exportDoc("print")}><Printer /> Print or save PDF</DropdownMenuItem>
                </>}
                <DropdownMenuItem onSelect={downloadSource}><Download /> Download source</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {!legacy && <DropdownMenuItem disabled={busy || saving || dirty} onSelect={() => void togglePin()}><Pin />{artifact.pinned ? "Unpin" : "Pin"}</DropdownMenuItem>}
            {editable && <DropdownMenuItem onSelect={() => setRename(draft?.title ?? artifact.title)}><Pencil /> Rename</DropdownMenuItem>}
            {!legacy && !embedded && !shownVersion && <DropdownMenuItem disabled={busy || saving} onSelect={() => replaceInput.current?.click()}><Upload /> Replace content…</DropdownMenuItem>}
            {!legacy && <DropdownMenuItem disabled={busy || dirty || saving} onSelect={() => void duplicate()}><CopyPlus /> Duplicate</DropdownMenuItem>}
            {!workspace && (artifact.type === "html" || legacy) && <DropdownMenuItem onSelect={() => setRefreshKey(key => key + 1)}><RefreshCw /> Refresh</DropdownMenuItem>}
            {!legacy && <DropdownMenuItem onSelect={() => setShowHistory(true)}><History /> Version history</DropdownMenuItem>}
            <DropdownMenuSeparator />
            {!legacy && !omitted && !versionLoading && <DropdownMenuItem onSelect={() => setSource({ value: content, version: artifact.version })}><Code2 /> View source</DropdownMenuItem>}
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
        {live.generating && <ArtifactPreparation kind={kind} compact phase="Preparing" />}
        {editable && !live.generating && <span role="status" title={saveError || autoSaveStatus} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          {autoSaveStatus === "Saved" ? <Check className="size-3.5" /> : <Cloud className="size-3.5" />}
          <span className={autoSaveStatus === "Saved" ? "sr-only" : "hidden sm:inline"}>{autoSaveStatus}</span>
        </span>}
        {shownVersion && <Button size="sm" variant="outline" disabled={busy} onClick={() => void restore()}><RotateCcw className="size-3.5" /> Restore</Button>}
        {embedded && <Button size="sm" variant="outline" onClick={() => navigate(artifactPath(id))} aria-label="Open"><ExternalLink className="size-3.5" /> Open</Button>}
      </header>
      {((artifact.type !== "doc" && (artifact.description || artifact.sources?.length)) || shownVersion || error) && (
        <p className="px-1 text-xs text-muted-foreground">
          {shownVersion && `Showing v${shownVersion.version}${shownVersion.author ? ` by ${artifactAuthor(shownVersion.author, product)}` : ""}. `}
          {artifact.type !== "doc" && artifact.description}
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
      {large && <p role="status" className="border-b border-warning/30 bg-warning/5 px-3 py-1.5 text-xs text-warning">
        This artifact is {formatSize(artifact.size ?? 0)}: the editor may be slow. Agents can change parts of it without rewriting it.
      </p>}
      <input ref={replaceInput} type="file" hidden accept={ARTIFACT_UPLOAD_ACCEPT} data-testid="artifact-replace-input"
        onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void replaceContent(file); }} />
      <div ref={stage} className="min-h-0 flex-1 overflow-hidden bg-background" inert={busy}>
        <Suspense fallback={<ArtifactPreparation kind={artifact.kind} />}>
          {omitted ? (
            <ArtifactLargeView artifact={artifact} version={shownVersion?.version}
              onReplace={!legacy && !embedded && !shownVersion ? () => replaceInput.current?.click() : undefined} />
          ) : versionLoading ? (
            <ArtifactPreparation kind={artifact.kind} />
          ) : kind ? (
            <ArtifactLiveWorkspace kind={kind} artifact={artifact} content={live.preview ?? content}
              streaming={live.preview !== undefined} readOnly={!editable} onChange={onChange} refreshKey={refreshKey}
              appearanceVersion={live.preview !== undefined ? live.tick : shownVersion?.version ?? artifact.version}
              onShowHistory={() => setShowHistory(true)} instanceName={info?.project || product}
              onAskAssistant={editable ? askAssistant : undefined} />
          ) : (
            <ArtifactView artifact={artifact} content={content} refreshKey={refreshKey} />
          )}
        </Suspense>
      </div>
      <Dialog open={showHistory} onOpenChange={setShowHistory}>
        <DialogContent className={`${docSurface} sm:max-w-sm`}>
          <DialogHeader><DialogTitle>Version history</DialogTitle><DialogDescription>{artifact.title}</DialogDescription></DialogHeader>
          {artifact.usage && <p className="text-xs text-muted-foreground" data-testid="artifact-version-usage">
            {artifact.usage.count} earlier version{artifact.usage.count === 1 ? "" : "s"}, {formatSize(artifact.usage.bytes)} of {formatSize(artifact.usage.maxBytes)} (at most {artifact.usage.maxCount}; the oldest are removed first)
          </p>}
          <div className="max-h-[55dvh] overflow-auto" role="list" aria-label="Artifact versions">
            {[artifact, ...artifact.versions].map(item => <button key={item.version} type="button" disabled={saving || busy}
              className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left hover:bg-accent"
              onClick={async () => {
                if (dirty && !(await save())) return;
                setVersion(item.version === artifact.version ? undefined : item.version);
                setShowHistory(false);
              }}>
              <span className="min-w-0"><span className="block text-sm font-medium">Version {item.version}{item.version === artifact.version ? " · Current" : ""}</span>
                <span className="block truncate text-xs text-muted-foreground">{absoluteTime("at" in item ? item.at : artifact.updatedAt)}{typeof item.size === "number" ? ` · ${formatSize(item.size)}` : ""}</span></span>
              {(shownVersion?.version ?? artifact.version) === item.version && <Check className="size-4" />}
            </button>)}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={rename !== undefined} onOpenChange={open => { if (!open) setRename(undefined); }}>
        <DialogContent className={`${docSurface} sm:max-w-sm`}>
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
        <DialogContent className={`${docSurface} max-h-[90dvh] sm:max-w-4xl`}>
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
