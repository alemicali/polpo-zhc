/**
 * Confirmation for the destructive computer actions (Reset, Recreate, Delete / Remove from Polpo),
 * and for Stop / Restart of a busy computer: what runs on it, and "anyway".
 */
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { PendingComputerAction } from "@/hooks/use-computer-actions";
import { stopLabel, type ComputerBusy } from "@/lib/computers-api";

function copy(pending: PendingComputerAction | null): { title: string; description: string; confirm: string } {
  const name = pending?.computer.name ?? "";
  switch (pending?.what) {
    case "stop": {
      const verb = stopLabel(pending.computer);
      return {
        title: `${name} is busy`,
        description: `Work is running on it. ${verb === "Hibernate" ? "Hibernating" : verb === "Pause" ? "Pausing" : "Stopping"} it now interrupts it: wait for it to finish, or ${verb.toLowerCase()} it anyway.`,
        confirm: `${verb} anyway`,
      };
    }
    case "restart":
      return {
        title: `${name} is busy`,
        description: "Work is running on it. Restarting it now interrupts it: wait for it to finish, or restart it anyway.",
        confirm: "Restart anyway",
      };
    case "reset":
      return {
        title: `Reset ${name}?`,
        description: "Its machine is deleted and a new one is created: everything on its disk (files, installed tools, browser sign-ins) is lost.",
        confirm: "Reset",
      };
    case "recreate":
      return {
        title: `Recreate ${name}?`,
        description: "Its machine was deleted at the provider. A new one is made from its image: what the old one had (files, installed tools, browser sign-ins) is lost and does not come back.",
        confirm: "Recreate",
      };
    default:
      return pending?.computer.status === "deleted"
        ? {
          title: `Remove ${name} from Polpo?`,
          description: "Its machine is already gone at the provider. The computer is removed from Polpo; agents that may use it lose it.",
          confirm: "Remove",
        }
        : {
          title: `Delete ${name}?`,
          description: "The computer and its machine are deleted, with everything on its disk. This cannot be undone.",
          confirm: "Delete",
        };
  }
}

export function ComputerConfirmDialog({
  pending, onCancel, onConfirm,
}: { pending: PendingComputerAction | null; onCancel: () => void; onConfirm: () => void }) {
  const { title, description, confirm } = copy(pending);
  return (
    <Dialog open={!!pending} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {pending && "busy" in pending && <BusyList busy={pending.busy} />}
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="destructive" onClick={onConfirm}>{confirm}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The tasks and sessions running on a busy computer. */
function BusyList({ busy }: { busy: ComputerBusy }) {
  return (
    <ul data-testid="computer-busy-list" className="space-y-1 text-sm text-muted-foreground">
      {busy.tasks.map((t) => (
        <li key={`task-${t.taskId}`}>
          <span className="font-medium text-foreground">Task</span> {t.title} <span className="font-mono text-xs">({t.taskId})</span>{t.agent ? ` · ${t.agent}` : ""}
        </li>
      ))}
      {busy.sessions.map((s) => (
        <li key={`session-${s.key}`}>
          <span className="font-medium text-foreground">{s.scope === "chat" ? "Chat session" : "Task session"}</span> <span className="font-mono text-xs">{s.sessionId ?? s.key}</span> · {s.agent} · {s.harness} ({s.state})
        </li>
      ))}
    </ul>
  );
}
