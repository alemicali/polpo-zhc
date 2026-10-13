/**
 * AgentDriveTab — what the agent pursues on its own initiative: purpose, goals and autonomy, the
 * self-portrait it keeps, what it plans (intentions, proposed ones to approve) and its reflections.
 */

import { useCallback, useEffect, useState } from "react";
import { Check, Compass, Loader2, NotebookPen, RotateCcw, Sparkles, Target, UserRound, X, CalendarClock } from "lucide-react";
import { toast } from "sonner";
import { useEvents } from "@polpo-ai/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { driveApi, type DriveAutonomy, type DriveData, type DriveSettings, type GoalHorizon, type Intention, type PlanItem } from "@/lib/drive-api";
import { useAgentDetail } from "./agent-detail-context";

const AUTONOMY: { value: DriveAutonomy; label: string; hint: string }[] = [
  { value: "propose", label: "Propose", hint: "What it would do on its own waits for your yes." },
  { value: "balanced", label: "Balanced", hint: "Acts on low-stakes things (wishes, check-ins, reminders), asks first otherwise." },
  { value: "act", label: "Act", hint: "Acts on its own judgment." },
];

const HORIZON: Record<GoalHorizon, string> = { long: "6–12 months", quarter: "Quarter", month: "Month", week: "Week", day: "Today" };

/** The open plan as a tree (each goal with what serves it), then the latest closed items. */
function planRows(plan: PlanItem[]): { item: PlanItem; depth: number }[] {
  const open = plan.filter((i) => i.status === "todo" || i.status === "doing");
  const ids = new Set(open.map((i) => i.id));
  const rows: { item: PlanItem; depth: number }[] = [];
  const walk = (parent: string | undefined, depth: number) => {
    for (const item of open.filter((i) => (i.parentId && ids.has(i.parentId) ? i.parentId : undefined) === parent)) {
      rows.push({ item, depth });
      walk(item.id, depth + 1);
    }
  };
  walk(undefined, 0);
  return rows;
}

function PlanRow({ item, depth, busy, onStatus }: { item: PlanItem; depth: number; busy: boolean; onStatus: (status: PlanItem["status"]) => void }) {
  const closed = item.status === "done" || item.status === "dropped";
  return (
    <div className="rounded-md border border-border/40 bg-background/40 px-3 py-2 text-xs space-y-1" style={{ marginLeft: depth * 16 }}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={item.horizon ? "default" : "outline"} className="text-[10px]">{item.horizon ? HORIZON[item.horizon] : "Step"}</Badge>
        <span className={closed ? "line-through text-muted-foreground" : "font-medium"}>{item.title}</span>
        {item.owner && <span className="text-muted-foreground">for {item.owner}</span>}
        {item.status === "doing" && <Badge variant="secondary" className="text-[10px]">In progress</Badge>}
        {!closed && (
          <span className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={busy} onClick={() => onStatus("done")}>
              <Check className="h-3 w-3" /> Done
            </Button>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={busy} onClick={() => onStatus("dropped")}>
              <X className="h-3 w-3" /> Drop
            </Button>
          </span>
        )}
      </div>
      {(item.measure || item.due) && (
        <p className="text-muted-foreground">{[item.measure && `Measure: ${item.measure}`, item.due && `Due: ${item.due}`].filter(Boolean).join(" · ")}</p>
      )}
      {item.progress !== undefined && !closed && (
        <div className="h-1.5 w-full max-w-xs rounded bg-muted" title={`${item.progress}%`}>
          <div className="h-1.5 rounded bg-primary" style={{ width: `${item.progress}%` }} />
        </div>
      )}
      {item.notes && <p className="whitespace-pre-wrap text-muted-foreground">{item.notes}</p>}
    </div>
  );
}

const TRIGGER: Record<string, string> = { first: "first", activity: "after new messages", daily: "daily", manual: "on request" };

function when(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function schedule(i: Intention): string {
  if (i.cron) return `cron ${i.cron}${i.timezone ? ` (${i.timezone})` : ""}`;
  if (i.everyMinutes > 0) return `every ${i.everyMinutes} min · next ${when(i.nextRunAt)}`;
  return when(i.nextRunAt);
}

function IntentionRow({ intention, busy, onConfirm, onCancel }: { intention: Intention; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="rounded-md border border-border/40 bg-background/40 px-3 py-2 text-xs space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        {intention.state === "proposed"
          ? <Badge className="text-[10px]">Waiting for your yes</Badge>
          : <Badge variant="outline" className="text-[10px]">{intention.cron || intention.everyMinutes > 0 ? "Routine" : "Planned"}</Badge>}
        <span className="text-muted-foreground">{schedule(intention)} → {intention.target?.name ?? intention.target?.chatId ?? "its chat"}</span>
        <span className="ml-auto flex gap-1">
          {intention.state === "proposed" && (
            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={busy} onClick={onConfirm}>
              <Check className="h-3 w-3" /> Approve
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={busy} onClick={onCancel}>
            <X className="h-3 w-3" /> {intention.state === "proposed" ? "Reject" : "Cancel"}
          </Button>
        </span>
      </div>
      <p className="whitespace-pre-wrap">{intention.message ?? intention.prompt}</p>
      {intention.why && <p className="text-muted-foreground italic">Why: {intention.why}</p>}
    </div>
  );
}

export function AgentDriveTab() {
  const { actions: { refetch }, meta: { agentName } } = useAgentDetail();
  const { events } = useEvents(["agent:reflected"], 1);
  const [data, setData] = useState<DriveData | null>(null);
  const [draft, setDraft] = useState<DriveSettings>({});
  const [goalsText, setGoalsText] = useState("");
  const [selfDraft, setSelfDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reflecting, setReflecting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => driveApi.get(agentName).then(
    (d) => { setData(d); setDraft(d.drive); setGoalsText((d.drive.goals ?? []).join("\n")); },
    (e: Error) => toast.error(e.message),
  ), [agentName]);
  // reload on mount and whenever an agent reflects
  useEffect(() => { void load(); }, [load, events.length]);

  const goals = goalsText.split("\n").map((g) => g.trim()).filter(Boolean);
  const next: DriveSettings = { ...draft, goals: goals.length ? goals : undefined };
  const dirty = !!data && JSON.stringify(next) !== JSON.stringify({ ...data.drive, goals: data.drive.goals?.length ? data.drive.goals : undefined });

  const run = async (key: string, action: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await action();
      toast.success(done);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await driveApi.save(agentName, next);
      await Promise.all([load(), refetch()]);
      toast.success("Saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const reflectNow = async () => {
    setReflecting(true);
    try {
      const { entry } = await driveApi.reflectNow(agentName);
      toast.success(entry.actions.length ? `${agentName}: ${entry.actions.length} action(s)` : `${agentName} reflected`);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setReflecting(false);
    }
  };

  if (!data) return <Loader2 className="h-4 w-4 animate-spin" />;
  const stored = data.drive;

  return (
    <ScrollArea className="h-full">
      <div className="pr-4 pb-bottom-nav lg:pb-4 space-y-4">
        <Card className="bg-card/80 backdrop-blur-sm border-border/40">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Compass className="h-4 w-4" /> Purpose and goals
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <p className="text-muted-foreground max-w-2xl">
              With a purpose, {agentName} doesn't wait to be called: it reflects on its chats and groups (also what it only reads),
              remembers what matters to the people around it, and decides on its own when to write, to whom, or what to plan for later,
              weighing how much it serves its purpose, how serious and how urgent it is, and following human customs
              (birthdays, wishes, check-ins, tact, timing). It keeps a personality of its own and carries it forward.
            </p>
            <label className="flex items-center gap-2 font-medium">
              <input type="checkbox" className="accent-primary" checked={!!draft.enabled}
                onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
              Pursue its purpose on its own
            </label>
            <label className="block space-y-1 max-w-2xl">
              <span className="text-muted-foreground">Purpose</span>
              <Textarea rows={2} placeholder="e.g. Be Alessio's health coach: help him eat well and train three times a week, without preaching."
                value={draft.purpose ?? ""} onChange={(e) => setDraft({ ...draft, purpose: e.target.value || undefined })} />
            </label>
            <label className="block space-y-1 max-w-2xl">
              <span className="text-muted-foreground">Goals (one per line)</span>
              <Textarea rows={3} placeholder={"Three workouts a week\nNo sugar on weekdays"} value={goalsText} onChange={(e) => setGoalsText(e.target.value)} />
            </label>
            <div className="space-y-1">
              <span className="text-muted-foreground">Autonomy</span>
              <div className="grid max-w-2xl gap-2 sm:grid-cols-3">
                {AUTONOMY.map((a) => (
                  <label key={a.value} className={`cursor-pointer rounded-md border px-3 py-2 ${(draft.autonomy ?? "balanced") === a.value ? "border-primary bg-primary/5" : "border-border/40"}`}>
                    <input type="radio" className="sr-only" name="autonomy" checked={(draft.autonomy ?? "balanced") === a.value}
                      onChange={() => setDraft({ ...draft, autonomy: a.value })} />
                    <div className="font-medium">{a.label}</div>
                    <div className="text-muted-foreground">{a.hint}</div>
                  </label>
                ))}
              </div>
            </div>
            <label className="block max-w-xs space-y-1">
              <span className="text-muted-foreground">Reflect every N minutes when something happens (also daily)</span>
              <Input type="number" min={15} placeholder="120" value={draft.reflectEveryMinutes ?? ""}
                onChange={(e) => setDraft({ ...draft, reflectEveryMinutes: e.target.value === "" ? undefined : Math.max(15, Math.round(Number(e.target.value))) })} />
            </label>
            <label className="block max-w-xs space-y-1">
              <span className="text-muted-foreground">Its day starts at (daily planning; weekly, monthly, quarterly reviews)</span>
              <Input type="time" placeholder="07:30" value={draft.dayStartsAt ?? ""}
                onChange={(e) => setDraft({ ...draft, dayStartsAt: e.target.value || undefined })} />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={save} disabled={!dirty || saving}>
                {saving && <Loader2 className="h-3 w-3 animate-spin" />} Save
              </Button>
              {dirty && (
                <Button size="sm" variant="ghost" onClick={() => { setDraft(stored); setGoalsText((stored.goals ?? []).join("\n")); }}>
                  <RotateCcw className="h-3 w-3" /> Reset
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={reflectNow} disabled={reflecting || !stored.enabled}>
                {reflecting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} Reflect now
              </Button>
              {data.lastReflectionAt && <span className="self-center text-muted-foreground">Last reflection: {when(data.lastReflectionAt)}</span>}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/80 backdrop-blur-sm border-border/40">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <UserRound className="h-4 w-4" /> Who it is
              {selfDraft === null && (
                <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[11px]" onClick={() => setSelfDraft(data.self)}>Edit</Button>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            {selfDraft === null
              ? (data.self
                ? <pre className="max-h-96 overflow-auto whitespace-pre-wrap font-sans">{data.self}</pre>
                : <p className="text-muted-foreground">Not written yet: {agentName} writes its self-portrait (personality, the people who matter, open threads) at its first reflection, and keeps it current.</p>)
              : (
                <>
                  <Textarea rows={12} value={selfDraft} onChange={(e) => setSelfDraft(e.target.value)} />
                  <div className="flex gap-2">
                    <Button size="sm" disabled={busy === "self"}
                      onClick={() => void run("self", () => driveApi.saveSelf(agentName, selfDraft), "Self-portrait saved").then(() => setSelfDraft(null))}>
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setSelfDraft(null)}>Cancel</Button>
                  </div>
                </>
              )}
          </CardContent>
        </Card>

        <Card className="bg-card/80 backdrop-blur-sm border-border/40">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Target className="h-4 w-4" /> Goals and steps
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {planRows(data.plan ?? []).length === 0
              ? <p className="text-xs text-muted-foreground">No plan yet: {agentName} breaks its purpose down into goals (6–12 months, quarter, month, week, today) and steps at its reflections.</p>
              : planRows(data.plan ?? []).map(({ item, depth }) => (
                <PlanRow key={item.id} item={item} depth={depth} busy={busy === item.id}
                  onStatus={(status) => void run(item.id, () => driveApi.updatePlanItem(agentName, item.id, { status }), status === "done" ? "Marked done" : "Dropped")} />
              ))}
            {(data.plan ?? []).some((i) => i.status === "done") && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">Done recently</summary>
                <div className="mt-2 space-y-1">
                  {(data.plan ?? []).filter((i) => i.status === "done").slice(0, 10).map((item) => (
                    <PlanRow key={item.id} item={item} depth={0} busy={false} onStatus={() => {}} />
                  ))}
                </div>
              </details>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card/80 backdrop-blur-sm border-border/40">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <CalendarClock className="h-4 w-4" /> What it will do (scheduled)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.intentions.length === 0
              ? <p className="text-xs text-muted-foreground">Nothing planned.</p>
              : data.intentions.map((i) => (
                <IntentionRow key={i.id} intention={i} busy={busy === i.id}
                  onConfirm={() => void run(i.id, () => driveApi.confirm(agentName, i.id), "Approved")}
                  onCancel={() => void run(i.id, () => driveApi.cancel(agentName, i.id), i.state === "proposed" ? "Rejected" : "Cancelled")} />
              ))}
          </CardContent>
        </Card>

        <Card className="bg-card/80 backdrop-blur-sm border-border/40">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <NotebookPen className="h-4 w-4" /> Reflections
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            {data.journal.length === 0
              ? <p className="text-muted-foreground">No reflections yet.</p>
              : data.journal.map((e) => (
                <div key={e.id} className="rounded-md border border-border/40 bg-background/40 px-3 py-2 space-y-1">
                  <div className="text-muted-foreground">
                    {when(e.at)} · {TRIGGER[e.trigger] ?? e.trigger}{e.reviews?.length ? ` (${e.reviews.map((r) => (r === "day" ? "daily" : `${r}ly`)).join(", ")} review)` : ""} · {e.messages} new message(s)
                  </div>
                  <p className="whitespace-pre-wrap">{e.summary}</p>
                  {e.actions.length > 0 && (
                    <ul className="list-disc pl-4 text-muted-foreground">
                      {e.actions.map((a, i) => <li key={i}>{a}</li>)}
                    </ul>
                  )}
                </div>
              ))}
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  );
}
