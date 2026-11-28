/**
 * Task page → "Computer": which of its agent's computers the task runs on (Task.sandbox.computer).
 *
 * "Agent default" (no choice: the agent's defaultComputer, else this server) or one of the agent's
 * computers ("host" is this server), or a fresh sandbox ("ephemeral"). Only the agent's computers
 * are offered; the server rejects any other (400 INVALID_COMPUTER). Saved with
 * PATCH /tasks/:id { sandbox } (null = the agent's default). A running task keeps its run.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Monitor } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import {
  AGENT_DEFAULT, sandboxWithComputer, taskComputerOptions, type TaskComputerAgent,
} from "@/lib/task-computer";

export function TaskComputerSelect({
  sandbox, agent, computers, onSave, disabled,
}: {
  sandbox: { computer?: string; [key: string]: unknown } | undefined;
  agent: TaskComputerAgent | undefined;
  computers: ReadonlyArray<{ id: string; name: string }>;
  onSave: (sandbox: Record<string, unknown> | null) => Promise<unknown>;
  disabled?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const current = sandbox?.computer;
  const options = taskComputerOptions(agent, computers, current);
  const change = async (value: string) => {
    if ((current ?? AGENT_DEFAULT) === value) return;
    setSaving(true);
    try {
      await onSave(sandboxWithComputer(sandbox, value));
      toast.success(value === AGENT_DEFAULT ? "The task runs on the agent's default computer" : `The task runs on ${options.find((o) => o.value === value)?.label ?? value}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not change the computer");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div data-testid="task-computer" className="flex min-w-0 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <Monitor className="h-3 w-3 shrink-0" />
      <span className="shrink-0">Computer:</span>
      <Select value={current ?? AGENT_DEFAULT} onValueChange={change} disabled={disabled || saving || !agent}>
        <SelectTrigger size="sm" className="h-6 min-w-0 max-w-64 text-xs" aria-label="Computer">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
      {saving && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
    </div>
  );
}
