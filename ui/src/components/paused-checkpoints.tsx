// Missions paused at a checkpoint, with the button that lets them continue.
//
// A playbook checkpoint pauses its mission until someone resumes it
// (POST /missions/:id/checkpoints/:name/resume). The API existed but nothing in
// the dashboard called it, so a paused mission could only continue from a chat
// or a notification channel.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, PauseCircle, PlayCircle } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { useEvents, useMissions, usePolpo } from "@polpo-ai/react";
import type { ActiveCheckpoint } from "@polpo-ai/react";
import { Button } from "@/components/ui/button";

/** Repeated runs of a mission use the group "<name> #<n>". */
function missionNameOf(group: string): string {
  return group.replace(/ #\d+$/, "");
}

const CHECKPOINT_EVENTS = ["checkpoint:reached", "checkpoint:resumed", "mission:completed", "mission:resumed", "mission:aborted", "mission:deleted"];

/** Checkpoints where a mission is paused, kept current by events (with a slow poll as fallback). */
function useActiveCheckpoints(pollMs = 5000) {
  const { client } = usePolpo();
  const { events } = useEvents(CHECKPOINT_EVENTS, 1);
  const [active, setActive] = useState<ActiveCheckpoint[]>([]);
  const [tick, setTick] = useState(0);

  // The event buffer is capped, so react to the latest event id, not to its length.
  const latestEventId = events.at(-1)?.id;
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    client.getActiveCheckpoints()
      .then((list) => { if (!cancelled) setActive(list); })
      .catch(() => { /* server unreachable: keep the last list */ });
    return () => { cancelled = true; };
  }, [client, latestEventId, tick]);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), pollMs);
    return () => clearInterval(t);
  }, [pollMs]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { active, refresh };
}

export function PausedCheckpoints({ missionId, missionName }: { missionId?: string; missionName?: string }) {
  const { client } = usePolpo();
  const { missions } = useMissions();
  const { active, refresh } = useActiveCheckpoints();
  const [resuming, setResuming] = useState<string | null>(null);

  const shown = active
    .map((cp) => {
      const name = missionNameOf(cp.group);
      const id = missionId && missionName && name === missionName
        ? missionId
        : missions.find((m) => m.name === name)?.id;
      return { cp, missionName: name, missionId: id };
    })
    .filter((x) => (missionName ? x.missionName === missionName : true));

  if (shown.length === 0) return null;

  const resume = async (id: string | undefined, cp: ActiveCheckpoint) => {
    if (!client || !id) return;
    const key = `${cp.group}:${cp.checkpointName}`;
    setResuming(key);
    try {
      await client.resumeCheckpoint(id, cp.checkpointName);
      toast.success(`Checkpoint "${cp.checkpointName}" approved — the mission continues`);
      refresh();
    } catch (e) {
      toast.error(`Could not resume: ${(e as Error).message}`);
    } finally {
      setResuming(null);
    }
  };

  return (
    <div className="space-y-2">
      {shown.map(({ cp, missionName: name, missionId: id }) => {
        const key = `${cp.group}:${cp.checkpointName}`;
        return (
          <div key={key} className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3">
            <PauseCircle className="h-5 w-5 shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {!missionName && id ? <Link to={`/missions/${id}`} className="hover:underline">{name}</Link> : name}
                {" "}is paused at checkpoint <span className="font-semibold">"{cp.checkpointName}"</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {cp.checkpoint.message ? `${cp.checkpoint.message} · ` : ""}
                Done: {cp.checkpoint.afterTasks.join(", ") || "—"} · Waiting: {cp.checkpoint.blocksTasks.join(", ") || "—"}
                {" · "}reached {formatDistanceToNow(new Date(cp.reachedAt), { addSuffix: true })}
              </p>
            </div>
            <Button size="sm" className="gap-1.5" disabled={!id || resuming === key} onClick={() => void resume(id, cp)}>
              {resuming === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />}
              Approve and continue
            </Button>
          </div>
        );
      })}
    </div>
  );
}
