/**
 * Skill versions — a skill's lifecycle, like an agent's: the draft (the skill's folder: changes made
 * here, through the API or MCP, or on disk), production (the published version agents run), the
 * published versions (semver) and the history of publishes, rollbacks, discards and rebases.
 *
 * Publishing turns the draft into a new version and puts it in production at once (skills have no
 * separate deploy). A rollback points production at an earlier version; a pending draft survives it
 * and becomes out of date (rebase or discard it before publishing).
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle, ArchiveRestore, ChevronDown, ChevronRight, Download, Eye, GitCompare, GitMerge, HardDrive, History, Loader2, Rocket, RotateCcw, Trash2, Upload,
} from "lucide-react";
import type { SkillVersion, SkillVersionBump, SkillVersionDiff, SkillVersionState, SkillFileDiff, UseSkillVersionsReturn } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SegmentedControl, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { cn } from "@/lib/utils";
import { formatSize } from "@/lib/skill-files";
import { bumpVersion, isSemver } from "@/lib/agent-versions";
import { versionAuthor, versionEventLabel, versionLabel, versionSourceLabel } from "@/lib/skill-versions";

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

// ── Diff ──

const STATUS: Record<SkillFileDiff["status"], { label: string; className: string }> = {
  added: { label: "Added", className: "text-success border-success/30 bg-success/10" },
  removed: { label: "Removed", className: "text-destructive border-destructive/30 bg-destructive/10" },
  changed: { label: "Changed", className: "text-warning border-warning/30 bg-warning/10" },
};

/** A unified diff, one line per row: additions, deletions and hunk headers coloured with the tokens. */
function UnifiedDiff({ text }: { text: string }) {
  const lines = text.replace(/\n$/, "").split("\n").filter((l) => !l.startsWith("--- ") && !l.startsWith("+++ "));
  return (
    <pre className="overflow-x-auto font-mono text-xs leading-relaxed" data-testid="unified-diff">
      {lines.map((l, i) => (
        <div
          key={i}
          data-line={l.startsWith("@@") ? "hunk" : l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx"}
          className={cn(
            "whitespace-pre px-3",
            l.startsWith("@@") ? "bg-info/10 text-info"
              : l[0] === "+" ? "bg-success/10 text-success"
              : l[0] === "-" ? "bg-destructive/10 text-destructive"
              : "text-muted-foreground",
          )}
        >
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

function FileDiffBlock({ file, defaultOpen }: { file: SkillFileDiff; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const s = STATUS[file.status];
  return (
    <li className="border-b border-border/40 last:border-b-0" data-testid="diff-file" data-status={file.status} data-path={file.path}>
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-accent/40"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>{file.path}</span>
        {file.additions !== undefined && (
          <span className="shrink-0 font-mono text-micro tabular-nums">
            <span className="text-success">+{file.additions}</span> <span className="text-destructive">−{file.deletions}</span>
          </span>
        )}
        <Badge variant="outline" className={cn("text-micro", s.className)}>{s.label}</Badge>
      </button>
      {open && (
        <div className="border-t border-border/40 py-2">
          {file.binary ? (
            <p className="px-3 text-caption text-muted-foreground">
              Binary file{file.sizeA !== undefined && file.sizeB !== undefined ? ` (${formatSize(file.sizeA)} → ${formatSize(file.sizeB)})` : ""}: no text diff
            </p>
          ) : file.diff ? (
            <>
              <UnifiedDiff text={file.diff} />
              {file.truncated && <p className="px-3 pt-1 text-micro text-muted-foreground">The diff is cut here: download both versions to compare the rest</p>}
            </>
          ) : (
            <p className="px-3 text-caption text-muted-foreground">Too large to show: download both versions to compare</p>
          )}
        </div>
      )}
    </li>
  );
}

/** A diff side's label: "1.2.0", "draft", "production", "v3". */
function sideLabel(label: string | undefined, v: SkillVersion | undefined): string {
  return label || (v ? versionLabel(v) : "?");
}

export function SkillVersionDiffView({ diff }: { diff: SkillVersionDiff }) {
  const { summary } = diff;
  const from = sideLabel(diff.from, diff.a);
  const to = sideLabel(diff.to, diff.b);
  return (
    <section aria-label={`Changes from ${from} to ${to}`} className="rounded-lg border border-border/40 bg-card/80" data-testid="version-diff">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 px-4 py-2">
        <GitCompare className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-mono text-xs font-medium">{from} → {to}</span>
        <span className="text-caption text-muted-foreground">
          {summary.added} added · {summary.removed} removed · {summary.changed} changed · {diff.unchanged} unchanged
        </span>
      </header>
      {diff.files.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">The two sides have the same files</p>
      ) : (
        <ul>{diff.files.map((f) => <FileDiffBlock key={f.path} file={f} defaultOpen={diff.files.length <= 5} />)}</ul>
      )}
    </section>
  );
}

// ── Header badges ──

/** Production version and "Draft has changes" / "Draft out of date", for the skill's header. */
export function SkillVersionBadges({ state, className }: { state?: SkillVersionState; className?: string }) {
  if (!state) return null;
  const { production, draft } = state;
  if (!production && !draft.hasChanges) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", className)} data-testid="skill-version-badges">
      {production && (
        <Badge variant="outline" className="font-mono text-micro" title="The version agents run">v{production.semver}</Badge>
      )}
      {draft.hasChanges && (
        <Badge variant="outline" className="text-micro text-warning border-warning/30 bg-warning/10"
          title={draft.warning ?? `Unpublished: ${draft.changes.map((c) => c.path).join(", ")}`}>
          {draft.stale ? "Draft out of date" : "Draft has changes"}
        </Badge>
      )}
    </span>
  );
}

// ── Publish dialog ──

function PublishDialog({ open, onOpenChange, latest, suggested, onPublish }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  latest?: string;
  suggested: SkillVersionBump;
  onPublish: (req: { bump?: SkillVersionBump; version?: string; note?: string }) => Promise<void>;
}) {
  const [bump, setBump] = useState<SkillVersionBump>(suggested);
  const [custom, setCustom] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setBump(suggested); setCustom(""); setNote(""); setError(null); } }, [open, suggested]);
  const base = latest && isSemver(latest) ? latest : "0.0.0";
  const next = custom.trim() || bumpVersion(base, bump);
  const invalid = !!custom.trim() && !isSemver(custom.trim());

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onPublish({ ...(custom.trim() ? { version: custom.trim() } : { bump }), ...(note.trim() ? { note: note.trim() } : {}) });
      onOpenChange(false);
    } catch (e) {
      setError(errorText(e, "The publish failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="publish-dialog">
        <DialogHeader>
          <DialogTitle>Publish version {next}</DialogTitle>
          <DialogDescription>
            The draft becomes version {next} and goes to production at once: agents use it from their next run.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <SegmentedControl value={bump} onValueChange={(b) => { setBump(b); setCustom(""); }} size="sm" aria-label="Version bump">
              {(["patch", "minor", "major"] as const).map((b) => (
                <ToggleGroupItem key={b} value={b} aria-label={`${b} (${bumpVersion(base, b)})`}>
                  {b}{b === suggested ? " · suggested" : ""}
                </ToggleGroupItem>
              ))}
            </SegmentedControl>
            <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={`or a version, e.g. ${bumpVersion(base, "major")}`}
              className="h-8 w-48 font-mono text-xs" aria-label="Explicit version" aria-invalid={invalid} />
          </div>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Release note: what changed and why" rows={2} aria-label="Release note" />
          {error && <p className="text-caption text-destructive" role="alert">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy || invalid} data-testid="publish-confirm">
            {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1 h-3.5 w-3.5" />} Publish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Panel ──

export interface SkillVersionsPanelProps {
  versions: UseSkillVersionsReturn;
  /** Open a version's files in the file browser (read-only). */
  onView?: (version: number) => void;
}

type Confirm =
  | { kind: "rollback"; to?: number; label: string; forward?: boolean }
  | { kind: "restore"; version: number; label: string }
  | { kind: "discard" };

/**
 * A skill's lifecycle: the draft (changes, external edits, out-of-date warning, diff from production,
 * publish, discard, rebase), production (rollback), the versions (view, download, compare two, roll
 * back to one, restore one into the draft) and the history.
 */
export function SkillVersionsPanel({ versions, onView }: SkillVersionsPanelProps) {
  const { data, isLoading, error } = versions;
  const state = versions.state ?? data?.state;
  const draft = state?.draft;
  const deleted = !!data?.deletedAt;
  const [selected, setSelected] = useState<number[]>([]);
  const [pairDiff, setPairDiff] = useState<{ key: string; diff?: SkillVersionDiff; error?: string } | null>(null);
  const [draftDiff, setDraftDiff] = useState<{ key: string; diff?: SkillVersionDiff; error?: string } | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const list = useMemo(() => data?.versions ?? [], [data]);
  const byNumber = useMemo(() => new Map(list.map((v) => [v.version, v])), [list]);
  const labelOf = (n: number | undefined, fallback?: string) => (n !== undefined && byNumber.get(n) ? versionLabel(byNumber.get(n)!) : fallback ?? (n !== undefined ? `v${n}` : "?"));
  const productionLabel = state?.production?.semver ?? data?.production ?? (data?.current !== undefined ? labelOf(data.current) : undefined);

  const { diff: loadDiff } = versions;

  // production → draft
  const draftKey = draft?.hasChanges ? `${data?.current ?? ""}:${draft.updatedAt ?? ""}:${draft.changes.map((c) => `${c.status}:${c.path}`).join(",")}` : "";
  useEffect(() => {
    if (!draftKey) return;
    let cancelled = false;
    loadDiff("production", "draft")
      .then((d) => { if (!cancelled) setDraftDiff({ key: draftKey, diff: d }); })
      .catch((err: unknown) => { if (!cancelled) setDraftDiff({ key: draftKey, error: errorText(err, "Could not compare the draft") }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  // two selected versions
  const pair = selected.length === 2 ? [...selected].sort((a, b) => a - b) as [number, number] : null;
  const pairKey = pair ? `${pair[0]}-${pair[1]}` : "";
  useEffect(() => {
    if (!pair) return;
    let cancelled = false;
    loadDiff(pair[0], pair[1])
      .then((d) => { if (!cancelled) setPairDiff({ key: pairKey, diff: d }); })
      .catch((err: unknown) => { if (!cancelled) setPairDiff({ key: pairKey, error: errorText(err, "Could not compare the versions") }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairKey]);

  const toggle = (n: number, on: boolean) => setSelected((prev) => {
    if (!on) return prev.filter((x) => x !== n);
    // two at most: a third replaces the oldest pick
    return [...prev.filter((x) => x !== n), n].slice(-2);
  });

  const ask = (c: Confirm) => { setConfirmError(null); setConfirm(c); };

  const run = async () => {
    if (!confirm) return;
    setBusy(true);
    setConfirmError(null);
    try {
      if (confirm.kind === "rollback") {
        const r = await versions.rollback(confirm.to !== undefined ? { to: confirm.to } : {});
        toast.success(`Production ${r.from ?? productionLabel ?? "?"} → ${versionLabel(r.to)}${r.folderReset ? "" : ": the draft was kept and is now out of date"}`);
      } else if (confirm.kind === "restore") {
        const r = await versions.restore(confirm.version, { publish: false });
        toast.success(r.published ? `Restored ${confirm.label}: published as ${r.published}` : `${confirm.label} restored into the draft: publish it to put it in production`);
        setSelected([]);
      } else {
        await versions.discardDraft();
        toast.success("Draft discarded: the skill's files are production's again");
      }
      setConfirm(null);
    } catch (e) {
      setConfirmError(errorText(e, "The action failed"));
    } finally {
      setBusy(false);
    }
  };

  const rebase = async () => {
    setBusy(true);
    try {
      const r = await versions.rebaseDraft();
      toast.success(r.dropped ? "Nothing left to change over production: draft dropped" : `Draft rebased onto ${productionLabel ?? "production"}`);
    } catch (e) {
      toast.error(errorText(e, "The rebase failed"));
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) return <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (error) return <p className="rounded-lg border border-border/40 bg-card/80 p-6 text-center text-sm text-muted-foreground">{error.message}</p>;

  const shownPair = pairDiff?.key === pairKey ? pairDiff : null;
  const shownDraftDiff = draftKey && draftDiff?.key === draftKey ? draftDiff : null;
  const retention = data?.retention;
  const events = data?.events ?? [];
  // the production before this one: the latest event that moved production here
  const previous = events.find((e) => (e.action === "publish" || e.action === "rollback") && e.toVersion === data?.current && e.fromVersion !== undefined && e.fromVersion !== data?.current);
  const canRollback = !deleted && data?.current !== undefined && list.some((v) => v.version !== data.current);

  return (
    <div className="space-y-4" data-testid="skill-versions">
      {/* Draft */}
      {!deleted && draft && (
        <section aria-label="Draft" className="rounded-lg border border-border/40 bg-card/80" data-testid="skill-draft">
          <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium">Draft</span>
                {draft.hasChanges
                  ? <Badge variant="outline" className="text-micro text-warning border-warning/30 bg-warning/10">Draft has changes</Badge>
                  : <span className="text-caption text-muted-foreground">· no changes</span>}
                {draft.external && (
                  <Badge variant="outline" className="gap-1 text-micro text-info border-info/30 bg-info/10" data-testid="draft-external"
                    title="Files of this skill were changed on disk, outside Polpo">
                    <HardDrive className="h-3 w-3" /> External changes
                  </Badge>
                )}
              </div>
              <p className="text-caption text-muted-foreground">
                {draft.hasChanges
                  ? <>
                      {draft.changes.length} file{draft.changes.length === 1 ? "" : "s"} changed
                      {draft.updatedBy ? ` · by ${versionAuthor(draft.updatedBy)}` : ""}
                      {draft.updatedAt ? ` · ${when(draft.updatedAt)}` : ""}
                      {draft.restoredFrom ? ` · restored from ${labelOf(draft.restoredFrom)}` : ""}
                      {draft.nextVersion ? ` · next ${draft.nextVersion}${draft.suggestedBump ? ` (${draft.suggestedBump})` : ""}` : ""}
                    </>
                  : "Changes to the skill's files (here, through the API or MCP, or on disk) stay in the draft until you publish them. Agents run production."}
              </p>
            </div>
            {draft.hasChanges && (
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => ask({ kind: "discard" })} aria-label="Discard the draft">
                  <Trash2 className="mr-1 h-3.5 w-3.5" /> Discard
                </Button>
                <Button size="sm" onClick={() => setPublishOpen(true)} data-testid="open-publish" disabled={draft.stale}
                  title={draft.stale ? "Rebase the draft onto production (or discard it) first" : undefined}>
                  <Upload className="mr-1 h-3.5 w-3.5" /> Publish…
                </Button>
              </div>
            )}
          </header>
          {draft.stale && (
            <div className="flex flex-wrap items-center gap-2 border-t border-warning/30 bg-warning/10 px-4 py-2 text-caption text-warning" role="alert" data-testid="draft-stale">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">
                {draft.warning ?? `The draft is based on ${draft.baseVersion ?? "an earlier version"}, production is now ${productionLabel ?? "another version"}.`}
                {" "}Rebase it onto production (its changes applied over what runs now) or discard it before publishing.
              </span>
              <Button variant="outline" size="sm" className="h-7" disabled={busy} onClick={() => void rebase()} data-testid="rebase-draft">
                <GitMerge className="mr-1 h-3.5 w-3.5" /> Rebase onto {productionLabel ?? "production"}
              </Button>
              <Button variant="ghost" size="sm" className="h-7" disabled={busy} onClick={() => ask({ kind: "discard" })} data-testid="discard-stale">Discard</Button>
            </div>
          )}
          {draft.hasChanges && draft.changes.length > 0 && (
            <ul className="border-t border-border/40 px-4 py-2" aria-label="Changed files" data-testid="draft-changes">
              {draft.changes.map((c) => (
                <li key={c.path} className="flex min-w-0 items-center gap-2 py-0.5" data-status={c.status} data-change-path={c.path}>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={c.path}>{c.path}</span>
                  <Badge variant="outline" className={cn("text-micro", STATUS[c.status].className)}>{STATUS[c.status].label}</Badge>
                </li>
              ))}
            </ul>
          )}
          {draft.hasChanges && (
            <div className="border-t border-border/40 p-3">
              {shownDraftDiff?.diff ? <SkillVersionDiffView diff={shownDraftDiff.diff} />
                : shownDraftDiff?.error ? <p className="text-caption text-destructive">{shownDraftDiff.error}</p>
                : <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>}
            </div>
          )}
        </section>
      )}

      {/* Production */}
      {!deleted && (
        <section aria-label="Production" className="rounded-lg border border-border/40 bg-card/80" data-testid="skill-production">
          <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
            <Rocket className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">Production</span>
            <Badge variant="outline" className="font-mono text-micro text-success border-success/30" data-testid="production-version">{productionLabel ?? "—"}</Badge>
            <span className="min-w-0 flex-1 text-caption text-muted-foreground">
              Agents run this version from their next run.
              {state?.production ? ` Published ${when(state.production.createdAt)} by ${versionAuthor(state.production.author)}` : ""}
              {state?.production?.note ? ` · “${state.production.note}”` : ""}
            </span>
            <Button variant="outline" size="sm" disabled={!canRollback} data-testid="rollback"
              onClick={() => ask({ kind: "rollback", ...(previous?.fromVersion !== undefined ? { to: previous.fromVersion } : {}), label: previous ? sideLabel(previous.from, byNumber.get(previous.fromVersion!)) : "the previous version" })}>
              <RotateCcw className="mr-1 h-3.5 w-3.5" /> Rollback{previous ? ` to ${sideLabel(previous.from, byNumber.get(previous.fromVersion!))}` : ""}
            </Button>
          </header>
        </section>
      )}

      {/* Versions */}
      <section aria-label="Versions" className="rounded-lg border border-border/40 bg-card/80">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 px-4 py-2">
          <History className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">{list.length} version{list.length === 1 ? "" : "s"}</span>
          <span className="min-w-0 flex-1 text-caption text-muted-foreground">
            {pair ? `Comparing ${labelOf(pair[0])} and ${labelOf(pair[1])}` : "Select two versions to compare them"}
          </span>
          {retention && (
            <span className="text-micro text-muted-foreground">
              Keeps the last {retention.maxVersions}, up to {formatSize(retention.maxBytes)}
            </span>
          )}
        </header>
        {deleted && (
          <p className="border-b border-border/40 bg-warning/10 px-4 py-2 text-caption text-warning" role="status">
            This skill was deleted {when(data!.deletedAt!)}{data?.deletedBy ? ` by ${versionAuthor(data.deletedBy)}` : ""}: restore a version to bring it back
            (its history is kept {retention?.deletedDays ?? 30} days).
          </p>
        )}
        {list.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">No versions yet: publishing the draft records one</p>
        ) : (
          <ul aria-label="Skill versions">
            {list.map((v) => {
              const isProd = !deleted && v.version === data?.current;
              const checked = selected.includes(v.version);
              const label = versionLabel(v);
              const older = data?.current !== undefined && v.version < data.current;
              return (
                <li
                  key={v.version}
                  data-testid="version-row"
                  data-version={v.version}
                  className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 px-4 py-2 last:border-b-0", checked && "bg-primary/5")}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(on) => toggle(v.version, on === true)}
                    aria-label={`Select version ${label} to compare`}
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="font-mono text-xs font-medium" data-testid="version-label">{label}</span>
                      {isProd && <Badge variant="outline" className="text-micro text-success border-success/30">Production</Badge>}
                      <Badge variant="secondary" className="text-micro">{versionSourceLabel(v)}</Badge>
                      {v.external && (
                        <Badge variant="outline" className="gap-1 text-micro text-info border-info/30 bg-info/10" title="Holds files changed on disk, outside Polpo">
                          <HardDrive className="h-3 w-3" /> External
                        </Badge>
                      )}
                    </div>
                    <span className="truncate text-caption text-muted-foreground">
                      {when(v.createdAt)} · {versionAuthor(v.author)} · {v.files} file{v.files === 1 ? "" : "s"} · {formatSize(v.totalBytes)}
                      {v.note ? ` · “${v.note}”` : ""}
                    </span>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1">
                    {onView && (
                      <Button variant="ghost" size="sm" className="h-7" onClick={() => onView(v.version)} aria-label={`View the files of version ${label}`}>
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" className="h-7" asChild>
                      <a href={versions.downloadUrl(v.version)} download aria-label={`Download version ${label}`}>
                        <Download className="h-3.5 w-3.5" />
                      </a>
                    </Button>
                    {deleted ? (
                      <Button variant="outline" size="sm" className="h-7" onClick={() => ask({ kind: "restore", version: v.version, label })} aria-label={`Restore version ${label}`}>
                        <ArchiveRestore className="mr-1 h-3.5 w-3.5" /> Restore
                      </Button>
                    ) : (
                      <>
                        <Button variant="ghost" size="sm" className="h-7" onClick={() => ask({ kind: "restore", version: v.version, label })} aria-label={`Restore version ${label} into the draft`}>
                          <ArchiveRestore className="mr-1 h-3.5 w-3.5" /> Restore into draft
                        </Button>
                        {!isProd && (
                          <Button variant="outline" size="sm" className="h-7" onClick={() => ask({ kind: "rollback", to: v.version, label, forward: !older })} aria-label={`Roll production to version ${label}`}>
                            <RotateCcw className="mr-1 h-3.5 w-3.5" /> {older ? "Rollback" : "Use in production"}
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {pair && (shownPair?.diff ? <SkillVersionDiffView diff={shownPair.diff} />
        : shownPair?.error ? <p className="rounded-lg border border-border/40 bg-card/80 p-6 text-center text-sm text-destructive">{shownPair.error}</p>
        : <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>)}

      {/* History */}
      {events.length > 0 && (
        <section aria-label="History" className="rounded-lg border border-border/40 bg-card/80" data-testid="skill-history">
          <header className="flex items-center gap-2 border-b border-border/40 px-4 py-2">
            <History className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">History</span>
          </header>
          <ul>
            {events.map((e) => (
              <li key={e.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 px-4 py-2 last:border-b-0" data-testid="history-row" data-action={e.action}>
                <Badge variant="outline" className={cn("text-micro",
                  e.action === "rollback" ? "text-warning border-warning/30 bg-warning/10"
                    : e.action === "publish" ? "text-success border-success/30 bg-success/10"
                    : e.action === "discard" ? "text-destructive border-destructive/30 bg-destructive/10"
                    : "text-muted-foreground")}>
                  {versionEventLabel(e.action)}
                </Badge>
                {(e.from || e.to) && (
                  <span className="font-mono text-xs">{e.from ? `${e.from} → ` : ""}{e.to ?? ""}</span>
                )}
                {e.direct && <Badge variant="secondary" className="text-micro">Applied directly</Badge>}
                <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">
                  {when(e.at)} · {versionAuthor(e.actor)}{e.note ? ` · “${e.note}”` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <PublishDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        latest={data?.latest ?? state?.latest}
        suggested={draft?.suggestedBump ?? "patch"}
        onPublish={async (req) => {
          const r = await versions.publish(req);
          toast.success(`Published ${versionLabel(r.version)}: agents use it from their next run`);
        }}
      />

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => { if (!open) setConfirm(null); }}
        title={confirm?.kind === "rollback" ? (confirm.forward ? `Put ${confirm.label} in production?` : `Roll production back to ${confirm.label}?`)
          : confirm?.kind === "restore" ? (deleted ? `Restore version ${confirm.label}?` : `Restore ${confirm.label} into the draft?`)
          : "Discard the draft?"}
        description={(
          <>
            {confirm?.kind === "rollback" ? (
              <>
                Production {confirm.forward ? "moves" : "goes back"} from {productionLabel ?? "—"} to {confirm.label}; agents use it from their next run. It is recorded as a rollback in the history.
                {draft?.hasChanges && <span className="mt-2 block">The draft keeps its changes and becomes out of date: rebase or discard it before publishing.</span>}
              </>
            ) : confirm?.kind === "restore" ? (
              deleted
                ? <>The skill comes back with the files of {confirm.label}, published as a new version in production.</>
                : <>
                    The draft's files become those of {confirm.label}. Production does not change: publish the draft to put them in production.
                    {draft?.hasChanges && <span className="mt-2 block">The draft's unpublished changes are replaced.</span>}
                  </>
            ) : (
              <>The unpublished changes are thrown away: the skill's files go back to production's ({productionLabel ?? "—"}). Production and the published versions are not touched.</>
            )}
            {confirmError && <span className="mt-2 block text-destructive">{confirmError}</span>}
          </>
        )}
        confirmLabel={confirm?.kind === "rollback" ? (confirm.forward ? "Put in production" : "Roll back") : confirm?.kind === "restore" ? "Restore" : "Discard"}
        destructive={confirm?.kind === "discard"}
        loading={busy}
        onConfirm={() => void run()}
      />
    </div>
  );
}
