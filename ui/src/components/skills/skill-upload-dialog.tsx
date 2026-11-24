import { useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, CheckCircle2, FolderUp, Loader2, Upload, XCircle, ChevronDown, ChevronRight, Bot, Package } from "lucide-react";
import { useAgents, useSkillBundleUpload } from "@polpo-ai/react";
import type { SkillBundleInstallResult, SkillBundleSkill, SkillPool } from "@polpo-ai/react";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { SegmentedControl, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { archiveFromFiles, filesFromDataTransfer, formatSize, skillNameError as nameError, suggestName } from "@/lib/skill-files";

const isNameError = (e: string) => e.startsWith("The name ") || e.startsWith("The skill has no name");

type Choice = "replace" | "rename" | "skip";
interface SkillChoice { include: boolean; conflict: Choice; rename: string }

export interface SkillUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The pool to install into by default (the orchestrator's from Configuration → Agent). */
  defaultPool?: SkillPool;
}

/**
 * Upload a skill bundle: drop a .skill / .zip archive or a skill folder → preview (files, sizes, the
 * parsed name and description, warnings, errors) → choose the pool and scope, what to do with names
 * that exist (replace, install as a new name, skip), the agents to assign them to → install.
 */
export function SkillUploadDialog({ open, onOpenChange, defaultPool = "agent" }: SkillUploadDialogProps) {
  const navigate = useNavigate();
  const { agents } = useAgents();
  const upload = useSkillBundleUpload();
  const [pool, setPool] = useState<SkillPool>(defaultPool);
  const [scope, setScope] = useState<"project" | "global">("project");
  const [choices, setChoices] = useState<Record<string, SkillChoice>>({});
  const [assignTo, setAssignTo] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const preview = upload.current;
  const result = upload.result;

  const reset = () => {
    upload.reset();
    setChoices({});
    setAssignTo(new Set());
    setExpanded(null);
    setLocalError(null);
    setPool(defaultPool);
    setScope("project");
  };
  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const start = async (files: Array<{ file: File; path: string }>) => {
    setLocalError(null);
    if (files.length === 0) return;
    try {
      const { blob, filename } = await archiveFromFiles(files);
      const p = await upload.preview(blob, filename);
      setChoices(Object.fromEntries(p.skills.map((s) => [s.name, {
        include: !s.errors.some((e) => !isNameError(e)),
        conflict: "replace" as Choice,
        rename: s.errors.some(isNameError) ? suggestName(s.name) : `${s.name}-2`,
      }])));
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "The archive could not be read");
    }
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    await start(await filesFromDataTransfer(e.dataTransfer));
  };

  const taken = (s: SkillBundleSkill) => s.exists[pool][scope];
  const rows = (preview?.skills ?? []).map((s) => {
    const c = choices[s.name] ?? { include: true, conflict: "replace" as Choice, rename: s.name };
    const mustRename = s.errors.some(isNameError);
    const blocking = s.errors.filter((e) => !isNameError(e));
    const renaming = mustRename || (taken(s) && c.conflict === "rename");
    const renameError = renaming ? nameError(c.rename) : null;
    return { s, c, mustRename, blocking, renaming, renameError };
  });

  const selected = rows.filter((r) => r.c.include && r.blocking.length === 0 && !(taken(r.s) && r.c.conflict === "skip" && !r.mustRename));
  const canInstall = selected.length > 0 && selected.every((r) => !r.renameError) && !upload.isInstalling;

  const install = async () => {
    const renames: Record<string, string> = {};
    for (const r of selected) if (r.renaming) renames[r.s.name] = r.c.rename;
    const anyReplace = selected.some((r) => taken(r.s) && !r.renaming && r.c.conflict === "replace");
    try {
      await upload.install({
        pool, global: scope === "global",
        onConflict: anyReplace ? "replace" : "fail",
        skills: selected.map((r) => r.s.name),
        ...(Object.keys(renames).length ? { renames } : {}),
        ...(pool === "agent" && assignTo.size ? { assignTo: [...assignTo] } : {}),
      });
    } catch { /* shown below */ }
  };

  const setChoice = (name: string, patch: Partial<SkillChoice>) => setChoices((prev) => ({ ...prev, [name]: { ...prev[name]!, ...patch } }));

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Upload a skill</DialogTitle>
          <DialogDescription>
            A <code className="font-mono">.skill</code> or <code className="font-mono">.zip</code> archive, or a skill folder: SKILL.md (name and description) plus scripts, references and assets.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {result ? (
            <InstallSummary result={result} pool={pool} onOpen={(name) => { close(false); navigate(`/skills/${encodeURIComponent(name)}${pool === "orchestrator" ? "?pool=orchestrator" : ""}`); }} />
          ) : !preview ? (
            <div
              data-testid="skill-dropzone"
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => void onDrop(e)}
              className={cn(
                "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center transition-colors",
                dragging ? "border-primary bg-primary/5" : "border-border/60",
              )}
            >
              {upload.isUploading ? <Loader2 className="h-8 w-8 animate-spin text-primary" /> : <Package className="h-8 w-8 text-muted-foreground" />}
              <p className="text-sm text-muted-foreground">Drop a .skill or .zip file, or a skill folder, here</p>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={upload.isUploading} onClick={() => fileInput.current?.click()}>
                  <Upload className="mr-1.5 h-3.5 w-3.5" /> Choose a file
                </Button>
                <Button size="sm" variant="outline" disabled={upload.isUploading} onClick={() => folderInput.current?.click()}>
                  <FolderUp className="mr-1.5 h-3.5 w-3.5" /> Choose a folder
                </Button>
              </div>
              <p className="text-micro text-muted-foreground">Up to {formatSize(30 * 1024 * 1024)} and 1000 files. Nothing is installed before you confirm.</p>
              <input
                ref={fileInput} type="file" accept=".skill,.zip,application/zip" className="hidden" data-testid="skill-file-input"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void start([{ file: f, path: f.name }]); }}
              />
              <input
                ref={folderInput} type="file" className="hidden" multiple
                {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; void start(fs.map((f) => ({ file: f, path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name }))); }}
              />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <SegmentedControl size="sm" aria-label="Pool" value={pool} onValueChange={(v) => setPool(v as SkillPool)}>
                  <ToggleGroupItem value="agent">Agents</ToggleGroupItem>
                  <ToggleGroupItem value="orchestrator">Polpo</ToggleGroupItem>
                </SegmentedControl>
                <SegmentedControl size="sm" aria-label="Scope" value={scope} onValueChange={(v) => setScope(v as "project" | "global")}>
                  <ToggleGroupItem value="project">This project</ToggleGroupItem>
                  <ToggleGroupItem value="global">All projects</ToggleGroupItem>
                </SegmentedControl>
                <span className="ml-auto text-micro text-muted-foreground">{preview.archiveName}</span>
              </div>

              <ul className="divide-y divide-border/40 rounded-lg border border-border/40" aria-label="Skills in the archive">
                {rows.map(({ s, c, mustRename, blocking, renaming, renameError }) => (
                  <li key={s.name} className="space-y-2 px-3 py-3" data-testid={`bundle-skill-${s.name}`}>
                    <div className="flex items-start gap-2">
                      <Checkbox
                        className="mt-0.5"
                        checked={c.include && blocking.length === 0}
                        disabled={blocking.length > 0}
                        onCheckedChange={(v) => setChoice(s.name, { include: v === true })}
                        aria-label={`Install ${s.name}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-mono text-sm font-medium">{s.name}</span>
                          <span className="shrink-0 text-micro text-muted-foreground">{s.files.length} files · {formatSize(s.totalBytes)}</span>
                        </div>
                        {s.description && <p className="mt-0.5 line-clamp-2 text-caption text-muted-foreground">{s.description}</p>}
                      </div>
                      <button
                        type="button"
                        className="flex shrink-0 items-center gap-1 text-micro text-muted-foreground hover:text-foreground"
                        aria-expanded={expanded === s.name}
                        onClick={() => setExpanded(expanded === s.name ? null : s.name)}
                      >
                        {expanded === s.name ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} Files
                      </button>
                    </div>
                    {expanded === s.name && (
                      <ul className="ml-6 max-h-40 overflow-auto font-mono text-micro text-muted-foreground">
                        {s.files.map((f) => (
                          <li key={f.path} className="flex justify-between gap-3"><span className="truncate">{f.path}</span><span className="tabular-nums">{formatSize(f.size)}</span></li>
                        ))}
                      </ul>
                    )}
                    {blocking.map((e) => <Note key={e} tone="error">{e}</Note>)}
                    {s.errors.filter(isNameError).map((e) => <Note key={e} tone="error">{e}: install it under another name</Note>)}
                    {s.warnings.map((w) => <Note key={w} tone="warning">{w}</Note>)}
                    {blocking.length === 0 && c.include && taken(s) && !mustRename && (
                      <div className="ml-6 flex flex-wrap items-center gap-2">
                        <span className="text-caption text-warning">A skill named {s.name} exists</span>
                        <Select value={c.conflict} onValueChange={(v) => setChoice(s.name, { conflict: v as Choice })}>
                          <SelectTrigger className="h-7 w-48 text-xs" aria-label={`When ${s.name} exists`}><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="replace">Replace it</SelectItem>
                            <SelectItem value="rename">Install as a new name</SelectItem>
                            <SelectItem value="skip">Skip this skill</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {blocking.length === 0 && c.include && renaming && (
                      <div className="ml-6 space-y-1">
                        <Input
                          className="h-7 w-64 font-mono text-xs"
                          aria-label={`New name for ${s.name}`}
                          value={c.rename}
                          onChange={(e) => setChoice(s.name, { rename: e.target.value })}
                        />
                        {renameError && <p className="text-micro text-destructive">{renameError}</p>}
                      </div>
                    )}
                  </li>
                ))}
              </ul>

              {preview.warnings.map((w) => <Note key={w} tone="warning">{w}</Note>)}
              {preview.ignored.length > 0 && <p className="text-micro text-muted-foreground">Ignored {preview.ignored.length} system file(s) ({preview.ignored.slice(0, 3).join(", ")}{preview.ignored.length > 3 ? "…" : ""})</p>}

              {pool === "agent" && agents.length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-label text-muted-foreground">Assign to agents</span>
                  <div className="flex flex-wrap gap-1.5">
                    {agents.map((a) => {
                      const on = assignTo.has(a.name);
                      return (
                        <button
                          key={a.name}
                          type="button"
                          aria-pressed={on}
                          onClick={() => setAssignTo((prev) => { const n = new Set(prev); if (n.has(a.name)) n.delete(a.name); else n.add(a.name); return n; })}
                          className={cn(
                            "inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-micro transition-colors",
                            on ? "border-primary/40 bg-primary/10 text-primary" : "border-border/40 text-muted-foreground hover:text-foreground",
                          )}
                        >
                          <Bot className="h-3 w-3" /> {a.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
          {(localError || upload.error) && <Note tone="error">{localError ?? upload.error?.message ?? "Something went wrong"}</Note>}
        </DialogBody>
        <DialogFooter>
          {result ? (
            <Button size="sm" onClick={() => close(false)}>Done</Button>
          ) : preview ? (
            <>
              <Button size="sm" variant="ghost" onClick={reset}>Choose another</Button>
              <Button size="sm" disabled={!canInstall} onClick={() => void install()}>
                {upload.isInstalling && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Install {selected.length === 1 ? "1 skill" : `${selected.length} skills`}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => close(false)}>Cancel</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Note({ tone, children }: { tone: "error" | "warning"; children: React.ReactNode }) {
  const Icon = tone === "error" ? XCircle : AlertTriangle;
  return (
    <p className={cn("ml-6 flex items-start gap-1.5 text-caption", tone === "error" ? "text-destructive" : "text-warning")}>
      <Icon className="mt-0.5 h-3 w-3 shrink-0" /> <span className="min-w-0">{children}</span>
    </p>
  );
}

function InstallSummary({ result, pool, onOpen }: { result: SkillBundleInstallResult; pool: SkillPool; onOpen: (name: string) => void }) {
  return (
    <div className="space-y-2" data-testid="skill-install-summary">
      {result.installed.map((i) => (
        <div key={i.name} className="flex items-center gap-2 text-sm">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
          <span className="font-mono">{i.name}</span>
          <span className="text-caption text-muted-foreground">
            {i.replaced ? "replaced" : "installed"}{i.from !== i.name ? ` (from ${i.from})` : ""} · {i.files} files
            {pool === "agent" && result.assigned.some((a) => a.skill === i.name) ? ` · assigned to ${result.assigned.filter((a) => a.skill === i.name).map((a) => a.agent).join(", ")}` : ""}
          </span>
          <Button variant="link" size="sm" className="ml-auto h-auto p-0" onClick={() => onOpen(i.name)}>Open</Button>
        </div>
      ))}
      {result.skipped.map((s) => <p key={s.name} className="text-caption text-muted-foreground">Skipped {s.name}: {s.reason}</p>)}
      {result.errors.map((e) => <Note key={e.name} tone="error">{e.name}: {e.error}</Note>)}
      {result.assignErrors?.map((e) => <Note key={e} tone="warning">{e}</Note>)}
    </div>
  );
}

