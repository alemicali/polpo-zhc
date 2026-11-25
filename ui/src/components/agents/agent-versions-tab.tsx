/**
 * Agent versions — the Versions tab of an agent: the draft (unpublished changes, publish, discard),
 * the published versions (view one read-only, diff any two, deploy one) and the deploys (production
 * pointer, rollback, the deploy history with each deploy's git-style diff).
 *
 * Every change made in the dashboard goes to the draft; publishing makes an immutable version and
 * deploying it moves production (what chats, tasks, missions, schedules and channels run).
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, GitCompare, GitMerge, History, Loader2, Rocket, RotateCcw, Trash2, Upload, Eye } from "lucide-react";
import {
  useAgentDeploys, useAgentVersions,
  type AgentDeployEntry, type AgentVersion, type AgentVersionBump, type AgentVersionDiff, type AgentConfig,
} from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SegmentedControl, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { cn } from "@/lib/utils";
import { useAgentDetail } from "./agent-detail-context";
import { actorLabel, bumpVersion as bumpOf, isSemver } from "@/lib/agent-versions";

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// ── Diff ──

type DiffLine = { kind: "hunk" | "add" | "del" | "ctx"; text: string };

function parseUnified(text: string): DiffLine[] {
  return text.replace(/\n$/, "").split("\n")
    .filter((l) => l && !l.startsWith("--- ") && !l.startsWith("+++ "))
    .map((l) => ({ kind: l.startsWith("@@") ? "hunk" : l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx", text: l.startsWith("@@") ? l : l.slice(1) }));
}

const LINE_CLASS: Record<DiffLine["kind"], string> = {
  hunk: "bg-info/10 text-info",
  add: "bg-success/10 text-success",
  del: "bg-destructive/10 text-destructive",
  ctx: "text-muted-foreground",
};

/** Split rows: deletions on the left, additions on the right, context on both. */
function splitRows(lines: DiffLine[]): Array<{ left?: DiffLine; right?: DiffLine }> {
  const rows: Array<{ left?: DiffLine; right?: DiffLine }> = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ left: dels[i], right: adds[i] });
    dels = []; adds = [];
  };
  for (const l of lines) {
    if (l.kind === "del") dels.push(l);
    else if (l.kind === "add") adds.push(l);
    else { flush(); rows.push({ left: l, right: l }); }
  }
  flush();
  return rows;
}

function DiffCell({ line }: { line?: DiffLine }) {
  return (
    <div className={cn("min-w-0 whitespace-pre-wrap break-all px-3", line ? LINE_CLASS[line.kind] : "bg-muted/30")}>
      {line ? (line.kind === "hunk" ? line.text : `${line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "} ${line.text}`) : " "}
    </div>
  );
}

/** What a version diff view shows (agent versions, hosted MCP server versions). */
export interface VersionDiffLike { from?: string; to: string; changes: Array<{ field: string }>; unified: string; suggestedBump?: string }

/** A version diff: changed fields, then the configuration's unified or split diff (red/green with the theme's tokens). */
export function AgentVersionDiffView({ diff }: { diff: VersionDiffLike | AgentVersionDiff }) {
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const lines = useMemo(() => parseUnified(diff.unified), [diff.unified]);
  return (
    <section aria-label={`Changes from ${diff.from ?? "nothing"} to ${diff.to}`} className="rounded-lg border border-border/40 bg-card/80" data-testid="agent-version-diff">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 px-4 py-2">
        <GitCompare className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-mono text-xs font-medium">{diff.from ?? "∅"} → {diff.to}</span>
        <span className="min-w-0 flex-1 text-caption text-muted-foreground">
          {diff.changes.length ? diff.changes.map((c) => c.field).join(", ") : "No changes"}
          {diff.suggestedBump && ` · ${diff.suggestedBump}`}
        </span>
        <SegmentedControl value={mode} onValueChange={setMode} size="sm" aria-label="Diff layout">
          <ToggleGroupItem value="unified" aria-label="Unified diff">Unified</ToggleGroupItem>
          <ToggleGroupItem value="split" aria-label="Split diff">Split</ToggleGroupItem>
        </SegmentedControl>
      </header>
      {lines.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">The two versions have the same configuration</p>
      ) : mode === "unified" ? (
        <pre className="max-h-[28rem] overflow-auto py-2 font-mono text-xs leading-relaxed" data-testid="unified-diff">
          {lines.map((l, i) => (
            <div key={i} data-line={l.kind} className={cn("whitespace-pre px-3", LINE_CLASS[l.kind])}>
              {l.kind === "hunk" ? l.text : `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`}
            </div>
          ))}
        </pre>
      ) : (
        <div className="max-h-[28rem] overflow-auto py-2 font-mono text-xs leading-relaxed" data-testid="split-diff">
          {splitRows(lines).map((r, i) => (
            <div key={i} className="grid grid-cols-2 gap-px">
              <DiffCell line={r.left} />
              <DiffCell line={r.right} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Header badge ──

/** Production version and "Draft has changes", for the agent's header. */
export function AgentVersionBadges({ agent, className }: { agent: AgentConfig; className?: string }) {
  const v = agent.versioning;
  if (!v) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", className)} data-testid="agent-version-badges">
      {v.production && (
        <Badge variant="outline" className="font-mono text-micro" title="The version production runs">v{v.production}</Badge>
      )}
      {v.draft.hasChanges && (
        <Badge variant="outline" className="text-micro text-warning border-warning/30 bg-warning/10" title={v.draft.warning ?? `Unpublished: ${v.draft.changedFields.join(", ")}`}>
          {v.draft.stale ? "Draft out of date" : "Draft has changes"}
        </Badge>
      )}
    </span>
  );
}

// ── Publish dialog ──

function PublishDialog({ open, onOpenChange, latest, suggested, diff, onPublish }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  latest?: string;
  suggested: AgentVersionBump;
  diff?: AgentVersionDiff;
  onPublish: (req: { bump?: AgentVersionBump; version?: string; note?: string; deploy: boolean }) => Promise<void>;
}) {
  const [bump, setBump] = useState<AgentVersionBump>(suggested);
  const [custom, setCustom] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"publish" | "deploy" | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setBump(suggested); setCustom(""); setNote(""); setError(null); } }, [open, suggested]);
  const next = custom.trim() || bumpOf(latest ?? "0.0.0", bump);
  const invalid = !!custom.trim() && !isSemver(custom.trim());

  const submit = async (deploy: boolean) => {
    setBusy(deploy ? "deploy" : "publish");
    setError(null);
    try {
      await onPublish({ ...(custom.trim() ? { version: custom.trim() } : { bump }), ...(note.trim() ? { note: note.trim() } : {}), deploy });
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" data-testid="publish-dialog">
        <DialogHeader>
          <DialogTitle>Publish version {next}</DialogTitle>
          <DialogDescription>
            The draft becomes an immutable version. Publishing does not change what runs: deploy it to production now or later.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <SegmentedControl value={bump} onValueChange={(b) => { setBump(b); setCustom(""); }} size="sm" aria-label="Version bump">
              {(["patch", "minor", "major"] as const).map((b) => (
                <ToggleGroupItem key={b} value={b} aria-label={`${b} (${bumpOf(latest ?? "0.0.0", b)})`}>
                  {b}{b === suggested ? " ·  suggested" : ""}
                </ToggleGroupItem>
              ))}
            </SegmentedControl>
            <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={`or a version, e.g. ${bumpOf(latest ?? "0.0.0", "major")}`}
              className="h-8 w-48 font-mono text-xs" aria-label="Explicit version" aria-invalid={invalid} />
          </div>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Release note: what changed and why" rows={2} aria-label="Release note" />
          {diff && <AgentVersionDiffView diff={diff} />}
          {error && <p className="text-caption text-destructive" role="alert">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={!!busy}>Cancel</Button>
          <Button variant="outline" onClick={() => void submit(false)} disabled={!!busy || invalid}>
            {busy === "publish" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1 h-3.5 w-3.5" />} Publish
          </Button>
          <Button onClick={() => void submit(true)} disabled={!!busy || invalid}>
            {busy === "deploy" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Rocket className="mr-1 h-3.5 w-3.5" />} Publish and deploy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── The tab ──

export function AgentVersionsTab() {
  const { meta: { agentName }, actions: { refetch } } = useAgentDetail();
  const versions = useAgentVersions(agentName);
  const deploys = useAgentDeploys(agentName, { limit: 50 });
  const state = versions.data?.state;
  const list = versions.data?.versions ?? [];

  const [publishOpen, setPublishOpen] = useState(false);
  const [draftDiff, setDraftDiff] = useState<AgentVersionDiff | undefined>();
  const [selected, setSelected] = useState<string[]>([]);
  const [pairDiff, setPairDiff] = useState<{ key: string; diff?: AgentVersionDiff; error?: string } | null>(null);
  const [viewing, setViewing] = useState<AgentVersion | null>(null);
  const [openDeploy, setOpenDeploy] = useState<{ id: string; diff?: AgentVersionDiff; error?: string } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "deploy"; version: string; diff?: AgentVersionDiff } | { kind: "rollback"; to?: string } | { kind: "discard" } | null>(null);
  const [busy, setBusy] = useState(false);

  const draftKey = state?.draft.hasChanges ? `${state.latest}:${state.draft.updatedAt}` : "";
  const { diff: loadDiff } = versions;
  useEffect(() => {
    if (!draftKey) { setDraftDiff(undefined); return; }
    let cancelled = false;
    loadDiff({ to: "draft" }).then((d) => { if (!cancelled) setDraftDiff(d); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [draftKey, loadDiff]);

  const pair = selected.length === 2 ? [...selected].sort((a, b) => list.findIndex((v) => v.version === b) - list.findIndex((v) => v.version === a)) : null;
  const pairKey = pair ? `${pair[0]}..${pair[1]}` : "";
  useEffect(() => {
    if (!pair) return;
    let cancelled = false;
    loadDiff({ from: pair[0], to: pair[1] })
      .then((d) => { if (!cancelled) setPairDiff({ key: pairKey, diff: d }); })
      .catch((e: Error) => { if (!cancelled) setPairDiff({ key: pairKey, error: e.message }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairKey, loadDiff]);

  const toggle = (v: string) => setSelected((s) => s.includes(v) ? s.filter((x) => x !== v) : [...s.slice(-1), v]);

  const after = async (message: string) => {
    toast.success(message);
    await Promise.all([versions.refetch(), deploys.refetch(), refetch()]);
  };

  const run = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === "deploy") {
        const e = await deploys.deploy(confirm.version);
        await after(`Deployed ${e.to} to production`);
      } else if (confirm.kind === "rollback") {
        const e = await deploys.rollback(confirm.to ? { to: confirm.to } : {});
        await after(`Rolled back: production ${e.from ?? "?"} → ${e.to}`);
      } else {
        await versions.discardDraft();
        await after("Draft discarded");
      }
      setConfirm(null);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const askDeploy = async (version: string) => {
    setConfirm({ kind: "deploy", version });
    const diff = await versions.diff({ from: "production", to: version }).catch(() => undefined);
    setConfirm((c) => (c && c.kind === "deploy" && c.version === version ? { ...c, diff } : c));
  };

  const showDeploy = async (entry: AgentDeployEntry) => {
    if (openDeploy?.id === entry.id) { setOpenDeploy(null); return; }
    setOpenDeploy({ id: entry.id });
    try {
      const d = await deploys.get(entry.id);
      setOpenDeploy((o) => (o?.id === entry.id ? { id: entry.id, diff: d.diff } : o));
    } catch (e) {
      setOpenDeploy((o) => (o?.id === entry.id ? { id: entry.id, error: (e as Error).message } : o));
    }
  };

  const rebase = async () => {
    setBusy(true);
    try {
      const r = await versions.rebaseDraft();
      await after(r.dropped ? `Nothing left to change over ${r.to ?? "production"}: draft dropped` : `Draft rebased from ${r.from ?? "?"} onto ${r.to ?? "production"}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const view = async (version: string) => {
    try { setViewing(await versions.get(version)); } catch (e) { toast.error((e as Error).message); }
  };

  if (versions.isLoading) return <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (versions.error) return <p className="rounded-lg border border-border/40 bg-card/80 p-6 text-center text-sm text-muted-foreground">{versions.error.message}</p>;

  const previousDeploy = deploys.data?.find((d) => d.to === state?.production && d.action !== "rollback" && d.from && d.from !== state?.production)?.from;
  const shownPair = pairDiff?.key === pairKey ? pairDiff : null;

  return (
    <div className="space-y-4 pb-bottom-nav lg:pb-4" data-testid="agent-versions">
      {/* Draft */}
      <section aria-label="Draft" className="rounded-lg border border-border/40 bg-card/80">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">
              Draft {state?.draft.hasChanges ? <span className="text-warning">· unpublished changes</span> : <span className="text-muted-foreground">· no changes</span>}
            </p>
            <p className="text-caption text-muted-foreground">
              {state?.draft.hasChanges
                ? <>Changed: {state.draft.changes.map((c) => c.field).join(", ")}{state.draft.updatedBy ? ` · by ${actorLabel(state.draft.updatedBy)}` : ""}{state.draft.nextVersion ? ` · next ${state.draft.nextVersion} (${state.draft.suggestedBump})` : ""}</>
                : "Changes made in this page go to the draft. Production keeps running its version until you publish and deploy."}
            </p>
          </div>
          {state?.draft.hasChanges && (
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirm({ kind: "discard" })} aria-label="Discard the draft">
                <Trash2 className="mr-1 h-3.5 w-3.5" /> Discard
              </Button>
              <Button size="sm" onClick={() => setPublishOpen(true)} data-testid="open-publish" disabled={state.draft.stale}
                title={state.draft.stale ? "Rebase the draft onto production (or discard it) first" : undefined}>
                <Upload className="mr-1 h-3.5 w-3.5" /> Publish…
              </Button>
            </div>
          )}
        </header>
        {state?.draft.stale && (
          <div className="flex flex-wrap items-center gap-2 border-t border-warning/30 bg-warning/10 px-4 py-2 text-caption text-warning" role="alert" data-testid="draft-stale">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              The draft is based on {state.draft.baseVersion ?? "an earlier version"}, production is now {state.production ?? "another version"}.
              Rebase it onto production (its changes applied over what runs now) or discard it before publishing.
            </span>
            <Button variant="outline" size="sm" className="h-7" disabled={busy} onClick={() => void rebase()} data-testid="rebase-draft">
              <GitMerge className="mr-1 h-3.5 w-3.5" /> Rebase onto {state.production ?? "production"}
            </Button>
            <Button variant="ghost" size="sm" className="h-7" disabled={busy} onClick={() => setConfirm({ kind: "discard" })}>Discard</Button>
          </div>
        )}
        {state?.draft.hasChanges && draftDiff && (
          <div className="border-t border-border/40 p-3"><AgentVersionDiffView diff={draftDiff} /></div>
        )}
      </section>

      {/* Deploys */}
      <section aria-label="Deploys" className="rounded-lg border border-border/40 bg-card/80" data-testid="agent-deploys">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/40 px-4 py-3">
          <Rocket className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">Production</span>
          <Badge variant="outline" className="font-mono text-micro text-success border-success/30" data-testid="production-version">{state?.production ? `v${state.production}` : "—"}</Badge>
          <span className="min-w-0 flex-1 text-caption text-muted-foreground">Chats, tasks, missions, schedules and channels run this version unless they pin another (name@1.2.0).</span>
          <Button variant="outline" size="sm" disabled={!previousDeploy && list.length < 2} onClick={() => setConfirm({ kind: "rollback", ...(previousDeploy ? { to: previousDeploy } : {}) })} data-testid="rollback">
            <RotateCcw className="mr-1 h-3.5 w-3.5" /> Rollback{previousDeploy ? ` to ${previousDeploy}` : ""}
          </Button>
        </header>
        {deploys.isLoading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        ) : !deploys.data?.length ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">No deploys yet</p>
        ) : (
          <ul>
            {deploys.data.map((d) => (
              <li key={d.id} className="border-b border-border/40 last:border-b-0" data-testid="deploy-row" data-action={d.action}>
                <button type="button" onClick={() => void showDeploy(d)} className="flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left hover:bg-accent/40" aria-expanded={openDeploy?.id === d.id}>
                  <span className="font-mono text-xs">{d.from ? `${d.from} → ` : ""}{d.to}</span>
                  {d.action === "rollback" && <Badge variant="outline" className="text-micro text-warning border-warning/30 bg-warning/10">Rollback</Badge>}
                  {d.action === "initial" && <Badge variant="secondary" className="text-micro">Initial</Badge>}
                  <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">
                    {when(d.at)} · {actorLabel(d.actor)}{d.note ? ` · “${d.note}”` : ""}
                  </span>
                </button>
                {openDeploy?.id === d.id && (
                  <div className="border-t border-border/40 p-3">
                    {openDeploy.diff ? <AgentVersionDiffView diff={openDeploy.diff} />
                      : openDeploy.error ? <p className="text-caption text-destructive">{openDeploy.error}</p>
                      : <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Versions */}
      <section aria-label="Versions" className="rounded-lg border border-border/40 bg-card/80">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 px-4 py-2">
          <History className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">{list.length} version{list.length === 1 ? "" : "s"}</span>
          <span className="min-w-0 flex-1 text-caption text-muted-foreground">Select two to compare them</span>
        </header>
        <ul>
          {list.map((v) => {
            const isProd = v.version === state?.production;
            return (
              <li key={v.version} className="flex min-w-0 items-center gap-3 border-b border-border/40 px-4 py-2 last:border-b-0" data-testid="version-row">
                <Checkbox checked={selected.includes(v.version)} onCheckedChange={() => toggle(v.version)} aria-label={`Compare version ${v.version}`} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="font-mono text-xs font-medium">{v.version}</span>
                    {isProd && <Badge variant="outline" className="text-micro text-success border-success/30">Production</Badge>}
                    <Badge variant="secondary" className="text-micro">{v.bump}</Badge>
                  </div>
                  <span className="truncate text-caption text-muted-foreground">
                    {when(v.createdAt)} · {actorLabel(v.author)}{v.note ? ` · “${v.note}”` : ""}{v.changedFields?.length ? ` · ${v.changedFields.join(", ")}` : ""}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="sm" className="h-7" onClick={() => void view(v.version)} aria-label={`View version ${v.version}`}>
                    <Eye className="h-3.5 w-3.5" />
                  </Button>
                  {!isProd && (
                    <Button variant="outline" size="sm" className="h-7" onClick={() => void askDeploy(v.version)} aria-label={`Deploy version ${v.version}`}>
                      <Rocket className="mr-1 h-3.5 w-3.5" /> Deploy
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {pair && (shownPair?.diff ? <AgentVersionDiffView diff={shownPair.diff} />
        : shownPair?.error ? <p className="rounded-lg border border-border/40 bg-card/80 p-6 text-center text-sm text-destructive">{shownPair.error}</p>
        : <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>)}

      <PublishDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        latest={state?.latest}
        suggested={state?.draft.suggestedBump ?? "patch"}
        diff={draftDiff}
        onPublish={async (req) => {
          const r = await versions.publish(req);
          await after(r.deploy ? `Published and deployed ${r.version.version}` : `Published ${r.version.version} (not deployed)`);
        }}
      />

      <Dialog open={!!viewing} onOpenChange={(o) => { if (!o) setViewing(null); }}>
        <DialogContent className="sm:max-w-2xl" data-testid="version-view">
          <DialogHeader>
            <DialogTitle>Version {viewing?.version}</DialogTitle>
            <DialogDescription>
              {viewing && <>{when(viewing.createdAt)} · {actorLabel(viewing.author)}{viewing.note ? ` · “${viewing.note}”` : ""} · read-only</>}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {viewing?.skillVersions && Object.keys(viewing.skillVersions).length > 0 && (
              <p className="mb-2 text-caption text-muted-foreground">Skills pinned: {Object.entries(viewing.skillVersions).map(([s, n]) => `${s} v${n}`).join(", ")}</p>
            )}
            <pre className="max-h-[28rem] overflow-auto rounded-md bg-muted/40 p-3 font-mono text-xs">{JSON.stringify(viewing?.config ?? {}, null, 2)}</pre>
          </DialogBody>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => { if (!o) setConfirm(null); }}
        title={confirm?.kind === "deploy" ? `Deploy ${confirm.version} to production?`
          : confirm?.kind === "rollback" ? `Roll production back${confirm.to ? ` to ${confirm.to}` : ""}?`
          : "Discard the draft?"}
        description={confirm?.kind === "deploy" ? (
          <>
            Production moves from {state?.production ?? "—"} to {confirm.version}. New chats, tasks and runs use it; runs in flight keep their version.
            {confirm.diff && <span className="mt-2 block">Changes: {confirm.diff.changes.map((c) => c.field).join(", ") || "none"}</span>}
          </>
        ) : confirm?.kind === "rollback" ? (
          <>Production moves from {state?.production ?? "—"} back to {confirm.to ?? "the previous deploy"}. It is recorded as a rollback in the history.</>
        ) : (
          <>The unpublished changes are thrown away. Production and the published versions are not touched.</>
        )}
        confirmLabel={confirm?.kind === "deploy" ? "Deploy" : confirm?.kind === "rollback" ? "Roll back" : "Discard"}
        destructive={confirm?.kind !== "deploy"}
        loading={busy}
        onConfirm={() => void run()}
      />
    </div>
  );
}
