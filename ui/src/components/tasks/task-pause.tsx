/**
 * Task page → Pause / Resume, and the paused banner (why, who, when).
 *
 * Pause asks for an optional reason (recorded on the task and told to the agent when it resumes):
 * POST /tasks/:id/pause. A running task's run stops but is not failed; Resume (with an optional
 * message for the agent) puts it back to pending and continues the stopped run: POST /tasks/:id/resume.
 */
import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Loader2, Monitor, Pause, Play } from "lucide-react";
import type { Task } from "@polpo-ai/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { canPauseTask, canResumeTask } from "@/lib/task-pause";

type Mode = "pause" | "resume";

const COPY: Record<Mode, { title: string; description: string; label: string; placeholder: string; action: string }> = {
  pause: {
    title: "Pause this task",
    description: "It is not scheduled until you resume it. A running agent stops where it is (not failed) and continues from there when resumed; its mission waits, and so do the tasks that depend on it.",
    label: "Reason (optional)",
    placeholder: "e.g. waiting for the client's logo",
    action: "Pause",
  },
  resume: {
    title: "Resume this task",
    description: "It goes back to the queue. If its run was stopped, the agent continues where it was and is told it was paused.",
    label: "Message for the agent (optional)",
    placeholder: "e.g. the logo is in the shared drive now",
    action: "Resume",
  },
};

/** Pause (pending, assigned, running) or Resume (paused) with a reason / message; nothing for other states. */
export function TaskPauseControl({
  task, onPause, onResume, disabled,
}: {
  task: Pick<Task, "status">;
  onPause: (reason?: string) => Promise<unknown>;
  onResume: (message?: string) => Promise<unknown>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mode: Mode | null = canResumeTask(task) ? "resume" : canPauseTask(task) ? "pause" : null;
  if (!mode) return null;
  const copy = COPY[mode];
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await (mode === "pause" ? onPause(text.trim() || undefined) : onResume(text.trim() || undefined));
      setOpen(false);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const Icon = mode === "pause" ? Pause : Play;
  return (
    <>
      <Button variant="outline" size="sm" disabled={disabled || busy} onClick={() => setOpen(true)} data-testid={`task-${mode}`}>
        <Icon className="h-3.5 w-3.5 mr-1.5" /> {copy.action}
      </Button>
      <Dialog open={open} onOpenChange={(v) => { if (!busy) setOpen(v); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
          </DialogHeader>
          <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            {copy.label}
            <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} rows={3} placeholder={copy.placeholder} aria-label={copy.label} />
          </label>
          {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
          <DialogFooter>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
            <Button size="sm" disabled={busy} onClick={() => void submit()} data-testid={`task-${mode}-confirm`}>
              {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Icon className="h-3.5 w-3.5 mr-1.5" />} {copy.action}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Why the task is paused, who paused it and when (and, for a blocking takeover, what resumes it). */
export function TaskPausedBanner({ task, className }: { task: Pick<Task, "status" | "pause">; className?: string }) {
  if (task.status !== "paused") return null;
  const p = task.pause;
  const when = p?.at ? formatDistanceToNow(new Date(p.at), { addSuffix: true }) : undefined;
  return (
    <div role="status" data-testid="task-paused-banner" className={cn("flex flex-col gap-1 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs", className)}>
      <div className="flex items-center gap-1.5 font-medium text-warning">
        <Pause className="h-3.5 w-3.5 shrink-0" />
        <span>Paused{p?.by ? ` by ${p.by}` : ""}{when ? ` ${when}` : ""}</span>
      </div>
      {p?.reason && <p className="text-foreground whitespace-pre-wrap break-words">{p.reason}</p>}
      {p?.takeover && (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <Monitor className="h-3 w-3 shrink-0" />
          Waiting for a person to take over computer {p.takeover.computerId}: completing the takeover resumes it (or resume it yourself).
        </p>
      )}
      {p?.runId && !p.takeover && <p className="text-muted-foreground">Its run was stopped: resuming continues it where it was.</p>}
    </div>
  );
}
