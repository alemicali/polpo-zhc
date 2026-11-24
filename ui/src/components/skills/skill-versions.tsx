import { useEffect, useMemo, useState } from "react";
import { Download, Eye, GitCompare, History, Loader2, RotateCcw, ChevronDown, ChevronRight } from "lucide-react";
import type { SkillVersionDiff, SkillFileDiff, UseSkillVersionsReturn } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { cn } from "@/lib/utils";
import { formatSize } from "@/lib/skill-files";
import { versionAuthor, versionSourceLabel } from "@/lib/skill-versions";

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

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

export function SkillVersionDiffView({ diff }: { diff: SkillVersionDiff }) {
  const { summary } = diff;
  return (
    <section aria-label={`Changes from v${diff.a.version} to v${diff.b.version}`} className="rounded-lg border border-border/40 bg-card/80" data-testid="version-diff">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 px-4 py-2">
        <GitCompare className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">v{diff.a.version} → v{diff.b.version}</span>
        <span className="text-caption text-muted-foreground">
          {summary.added} added · {summary.removed} removed · {summary.changed} changed · {diff.unchanged} unchanged
        </span>
      </header>
      {diff.files.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">The two versions have the same files</p>
      ) : (
        <ul>{diff.files.map((f) => <FileDiffBlock key={f.path} file={f} defaultOpen={diff.files.length <= 5} />)}</ul>
      )}
    </section>
  );
}

// ── Panel ──

export interface SkillVersionsPanelProps {
  versions: UseSkillVersionsReturn;
  /** Open a version's files in the file browser (read-only). */
  onView?: (version: number) => void;
}

/**
 * A skill's versions: the list (number, date, author, source, files, size), two selected → their diff,
 * view one's files, download one, restore one (confirmed; the current state is kept as a version first).
 */
export function SkillVersionsPanel({ versions, onView }: SkillVersionsPanelProps) {
  const { data, isLoading, error } = versions;
  const [selected, setSelected] = useState<number[]>([]);
  const [diff, setDiff] = useState<{ key: string; diff?: SkillVersionDiff; error?: string } | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const list = useMemo(() => data?.versions ?? [], [data]);

  const pair = selected.length === 2 ? [...selected].sort((a, b) => a - b) as [number, number] : null;
  const pairKey = pair ? `${pair[0]}-${pair[1]}` : "";
  const { diff: loadDiff } = versions;
  useEffect(() => {
    if (!pair) return;
    let cancelled = false;
    loadDiff(pair[0], pair[1])
      .then((d) => { if (!cancelled) setDiff({ key: pairKey, diff: d }); })
      .catch((err: unknown) => { if (!cancelled) setDiff({ key: pairKey, error: err instanceof Error ? err.message : "Could not compare the versions" }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairKey]);

  const toggle = (n: number, on: boolean) => setSelected((prev) => {
    if (!on) return prev.filter((x) => x !== n);
    // two at most: a third replaces the oldest pick
    return [...prev.filter((x) => x !== n), n].slice(-2);
  });

  const restore = async () => {
    if (confirm === null) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      await versions.restore(confirm);
      setConfirm(null);
      setSelected([]);
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : "The restore failed");
    } finally {
      setRestoring(false);
    }
  };

  if (isLoading) return <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (error) return <p className="rounded-lg border border-border/40 bg-card/80 p-6 text-center text-sm text-muted-foreground">{error.message}</p>;

  const shownDiff = diff?.key === pairKey ? diff : null;
  const retention = data?.retention;

  return (
    <div className="space-y-4" data-testid="skill-versions">
      <section aria-label="Versions" className="rounded-lg border border-border/40 bg-card/80">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 px-4 py-2">
          <History className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">{list.length} version{list.length === 1 ? "" : "s"}</span>
          <span className="min-w-0 flex-1 text-caption text-muted-foreground">
            {pair ? `Comparing v${pair[0]} and v${pair[1]}` : "Select two versions to compare them"}
          </span>
          {retention && (
            <span className="text-micro text-muted-foreground">
              Keeps the last {retention.maxVersions}, up to {formatSize(retention.maxBytes)}
            </span>
          )}
        </header>
        {data?.deletedAt && (
          <p className="border-b border-border/40 bg-warning/10 px-4 py-2 text-caption text-warning" role="status">
            This skill was deleted {when(data.deletedAt)}{data.deletedBy ? ` by ${versionAuthor(data.deletedBy)}` : ""}: restore a version to bring it back
            (its history is kept {retention?.deletedDays ?? 30} days).
          </p>
        )}
        {list.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">No versions yet: the next change to this skill records one</p>
        ) : (
          <ul aria-label="Skill versions">
            {list.map((v) => {
              const current = v.version === data?.current;
              const checked = selected.includes(v.version);
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
                    aria-label={`Select version ${v.version} to compare`}
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="font-mono text-xs font-medium">v{v.version}</span>
                      {current && <Badge variant="outline" className="text-micro text-success border-success/30">Current</Badge>}
                      <Badge variant="secondary" className="text-micro">{versionSourceLabel(v)}</Badge>
                    </div>
                    <span className="truncate text-caption text-muted-foreground">
                      {when(v.createdAt)} · {versionAuthor(v.author)} · {v.files} file{v.files === 1 ? "" : "s"} · {formatSize(v.totalBytes)}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {onView && (
                      <Button variant="ghost" size="sm" className="h-7" onClick={() => onView(v.version)} aria-label={`View the files of version ${v.version}`}>
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" className="h-7" asChild>
                      <a href={versions.downloadUrl(v.version)} download aria-label={`Download version ${v.version}`}>
                        <Download className="h-3.5 w-3.5" />
                      </a>
                    </Button>
                    {!current && (
                      <Button variant="outline" size="sm" className="h-7" onClick={() => { setRestoreError(null); setConfirm(v.version); }} aria-label={`Restore version ${v.version}`}>
                        <RotateCcw className="h-3.5 w-3.5 mr-1" /> Restore
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {pair && (shownDiff?.diff ? <SkillVersionDiffView diff={shownDiff.diff} />
        : shownDiff?.error ? <p className="rounded-lg border border-border/40 bg-card/80 p-6 text-center text-sm text-destructive">{shownDiff.error}</p>
        : <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>)}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => { if (!open) setConfirm(null); }}
        title={`Restore version ${confirm ?? ""}?`}
        description={(
          <>
            The skill's files become those of version {confirm}. The current files are kept as a version first, so you can undo this.
            Agents use the restored skill from their next run.
            {restoreError && <span className="mt-2 block text-destructive">{restoreError}</span>}
          </>
        )}
        confirmLabel="Restore"
        loading={restoring}
        onConfirm={() => void restore()}
      />
    </div>
  );
}
