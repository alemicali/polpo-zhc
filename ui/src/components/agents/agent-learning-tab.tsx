/**
 * AgentLearningTab — learning from conversations: the agent's setting (it can also change it itself,
 * set_learning), a review on demand, and what it changed in its memory and own skills, with undo.
 */

import { useCallback, useEffect, useState } from "react";
import { Brain, GraduationCap, Loader2, RotateCcw, Sparkles, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { useEvents } from "@polpo-ai/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { learningApi, type LearningChange, type LearningSettings } from "@/lib/learning-api";
import { useAgentDetail } from "./agent-detail-context";

const KIND_LABEL: Record<LearningChange["kind"], string> = {
  memory: "Memory",
  "skill-created": "New skill",
  "skill-updated": "Skill updated",
};

function when(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function ChangeRow({ change, onRevert, reverting }: { change: LearningChange; onRevert: () => void; reverting: boolean }) {
  return (
    <details className="group rounded-md border border-border/40 bg-background/40 px-3 py-2 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2">
        <Badge variant="outline" className="text-micro">{KIND_LABEL[change.kind]}</Badge>
        {change.kind !== "memory" && <span className="font-mono">{change.target}</span>}
        <span className="text-muted-foreground">{change.source === "review" ? "while reviewing" : "in a chat"} · {when(change.at)}</span>
        <span className="ml-auto flex items-center gap-2">
          {change.revertedAt
            ? <Badge variant="secondary" className="text-micro">Reverted</Badge>
            : (
              <Button
                size="sm" variant="ghost" className="h-6 px-2 text-caption" disabled={reverting}
                onClick={(e) => { e.preventDefault(); onRevert(); }}
              >
                {reverting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
                Undo
              </Button>
            )}
        </span>
      </summary>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <div>
          <div className="mb-1 text-label text-muted-foreground">Before</div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-caption">{change.before || "(empty)"}</pre>
        </div>
        <div>
          <div className="mb-1 text-label text-muted-foreground">After</div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-caption">{change.after || "(empty)"}</pre>
        </div>
      </div>
    </details>
  );
}

export function AgentLearningTab() {
  const { actions: { refetch }, meta: { agentName } } = useAgentDetail();
  const { events } = useEvents(["agent:learned"], 1);
  const [stored, setStored] = useState<LearningSettings>({});
  const [draft, setDraft] = useState<LearningSettings>({});
  const [changes, setChanges] = useState<LearningChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reverting, setReverting] = useState<string | null>(null);

  const load = useCallback(() => learningApi.get(agentName).then(
    (data) => { setStored(data.learning); setDraft(data.learning); setChanges(data.changes); setLoading(false); },
    (e: Error) => { toast.error(e.message); setLoading(false); },
  ), [agentName]);
  // reload on mount and whenever an agent reports what it learned
  useEffect(() => { void load(); }, [load, events.length]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);

  const save = async () => {
    setSaving(true);
    try {
      await learningApi.save(agentName, draft);
      await Promise.all([load(), refetch()]);
      toast.success("Learning settings saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const reviewNow = async () => {
    setReviewing(true);
    try {
      const { changes: made } = await learningApi.reviewNow(agentName);
      toast.success(made.length ? `${made.length} change(s) learned` : "Nothing new to learn");
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setReviewing(false);
    }
  };

  const revert = async (id: string) => {
    setReverting(id);
    try {
      await learningApi.revert(agentName, id);
      toast.success("Change undone");
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setReverting(null);
    }
  };

  const number = (value: string, min: number) => (value === "" ? undefined : Math.max(min, Math.round(Number(value))));

  return (
    <ScrollArea className="h-full">
      <div className="pr-4 pb-bottom-nav lg:pb-4 space-y-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <GraduationCap className="h-4 w-4" /> Learning from conversations
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <p className="text-muted-foreground max-w-2xl">
              Every few messages (all its chats and groups) or when a conversation goes quiet, {agentName} reviews what was said
              with its own model and keeps its memory current; it can also write procedures down as skills of its own.
              Changes apply right away and can be undone below. {agentName} can also turn this on or off itself when asked.
            </p>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : (
              <>
                <label className="flex items-center gap-2 font-medium">
                  <input type="checkbox" className="accent-primary" checked={!!draft.enabled}
                    onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
                  Learn from conversations
                </label>
                <div className="grid max-w-xl gap-3 sm:grid-cols-2">
                  <label className="space-y-1">
                    <span className="text-muted-foreground">Review every N new messages</span>
                    <Input type="number" min={5} placeholder="30" value={draft.everyMessages ?? ""} disabled={!draft.enabled}
                      onChange={(e) => setDraft({ ...draft, everyMessages: number(e.target.value, 5) })} />
                  </label>
                  <label className="space-y-1">
                    <span className="text-muted-foreground">…or after this many quiet minutes (0 = never)</span>
                    <Input type="number" min={0} placeholder="30" value={draft.idleMinutes ?? ""} disabled={!draft.enabled}
                      onChange={(e) => setDraft({ ...draft, idleMinutes: number(e.target.value, 0) })} />
                  </label>
                </div>
                <label className="flex items-center gap-2">
                  <input type="checkbox" className="accent-primary" checked={draft.skills !== false} disabled={!draft.enabled}
                    onChange={(e) => setDraft({ ...draft, skills: e.target.checked })} />
                  Create and update its own skills (not only memory)
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={save} disabled={!dirty || saving}>
                    {saving && <Loader2 className="h-3 w-3 animate-spin" />} Save
                  </Button>
                  {dirty && (
                    <Button size="sm" variant="ghost" onClick={() => setDraft(stored)}>
                      <RotateCcw className="h-3 w-3" /> Reset
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={reviewNow} disabled={reviewing || !stored.enabled}>
                    {reviewing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} Review now
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Brain className="h-4 w-4" /> What it learned
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {changes.length === 0
              ? <p className="text-xs text-muted-foreground">Nothing yet.</p>
              : changes.map((change) => (
                <ChangeRow key={change.id} change={change} reverting={reverting === change.id} onRevert={() => void revert(change.id)} />
              ))}
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  );
}
