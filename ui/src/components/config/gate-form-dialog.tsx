/**
 * GateFormDialog — add/edit an approval gate.
 *
 * Approval gates live in `settings.approvalGates` of `polpo.json` and are
 * persisted via `PUT /api/v1/config/gates/:id`.
 */

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, Bot, Users } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────────

export type LifecycleHook =
  | "task:create"
  | "task:spawn"
  | "task:transition"
  | "task:complete"
  | "task:fail"
  | "task:retry"
  | "mission:execute"
  | "mission:complete"
  | "assessment:run"
  | "assessment:complete"
  | "quality:gate"
  | "quality:sla"
  | "schedule:trigger"
  | "orchestrator:tick"
  | "orchestrator:shutdown";

export interface ApprovalGateDraft {
  id: string;
  name: string;
  handler: "auto" | "human";
  hook: LifecycleHook;
  condition?: { expression: string };
  notifyChannels?: string[];
  timeoutMs?: number;
  timeoutAction?: "approve" | "reject";
  priority?: number;
  maxRevisions?: number;
  includeOutcomes?: boolean;
}

interface GateFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: ApprovalGateDraft;
  channels: string[];
  existingIds: string[];
  onSave: (gate: ApprovalGateDraft) => Promise<void>;
}

// ── Constants ────────────────────────────────────────────────────────

const HOOK_OPTIONS: Array<{ value: LifecycleHook; label: string; description: string }> = [
  { value: "task:create", label: "task:create", description: "Before a task is created" },
  { value: "task:spawn", label: "task:spawn", description: "Before an agent is spawned for a task" },
  { value: "task:transition", label: "task:transition", description: "On any task status change" },
  { value: "task:complete", label: "task:complete", description: "After a task succeeds" },
  { value: "task:fail", label: "task:fail", description: "After a task fails" },
  { value: "task:retry", label: "task:retry", description: "Before a task retries" },
  { value: "mission:execute", label: "mission:execute", description: "Before a mission starts" },
  { value: "mission:complete", label: "mission:complete", description: "After a mission ends" },
  { value: "assessment:run", label: "assessment:run", description: "Before quality assessment" },
  { value: "assessment:complete", label: "assessment:complete", description: "After quality assessment" },
  { value: "quality:gate", label: "quality:gate", description: "When a quality gate evaluates" },
  { value: "quality:sla", label: "quality:sla", description: "On SLA warning or violation" },
  { value: "schedule:trigger", label: "schedule:trigger", description: "When a schedule fires" },
  { value: "orchestrator:tick", label: "orchestrator:tick", description: "Each orchestrator tick" },
  { value: "orchestrator:shutdown", label: "orchestrator:shutdown", description: "On graceful shutdown" },
];

// ── Helpers ──────────────────────────────────────────────────────────

type TimeoutUnit = "sec" | "min" | "hour";

function splitTimeoutMs(ms?: number): { value: string; unit: TimeoutUnit } {
  if (!ms || ms <= 0) return { value: "", unit: "min" };
  if (ms % 3_600_000 === 0) return { value: String(ms / 3_600_000), unit: "hour" };
  if (ms % 60_000 === 0) return { value: String(ms / 60_000), unit: "min" };
  return { value: String(Math.round(ms / 1000)), unit: "sec" };
}

function joinTimeoutMs(value: string, unit: TimeoutUnit): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const factor = unit === "sec" ? 1000 : unit === "min" ? 60_000 : 3_600_000;
  return Math.round(n * factor);
}

function emptyDraft(): ApprovalGateDraft {
  return {
    id: "",
    name: "",
    handler: "human",
    hook: "task:create",
    priority: 50,
    maxRevisions: 3,
  };
}

// ── Component ────────────────────────────────────────────────────────

export function GateFormDialog({
  open,
  onOpenChange,
  initial,
  channels,
  existingIds,
  onSave,
}: GateFormDialogProps) {
  const isEdit = !!initial;
  const [draft, setDraft] = useState<ApprovalGateDraft>(initial ?? emptyDraft());
  const [expression, setExpression] = useState<string>(initial?.condition?.expression ?? "");
  const [timeout, setTimeoutFields] = useState<{ value: string; unit: TimeoutUnit }>(
    splitTimeoutMs(initial?.timeoutMs),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(initial ?? emptyDraft());
    setExpression(initial?.condition?.expression ?? "");
    setTimeoutFields(splitTimeoutMs(initial?.timeoutMs));
    setErrors({});
    setSaveError(null);
  }, [open, initial]);

  const toggleChannel = (name: string) => {
    setDraft((d) => {
      const current = d.notifyChannels ?? [];
      return current.includes(name)
        ? { ...d, notifyChannels: current.filter((c) => c !== name) }
        : { ...d, notifyChannels: [...current, name] };
    });
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    const id = draft.id.trim();
    const name = draft.name.trim();
    if (!id) errs.id = "ID is required";
    else if (!/^[a-zA-Z0-9_:-]+$/.test(id))
      errs.id = "ID must be alphanumeric (dashes, underscores, colons allowed)";
    else if (!isEdit && existingIds.includes(id)) errs.id = "ID already exists";
    if (!name) errs.name = "Name is required";

    if (expression.trim() && expression.trim().length < 2) {
      errs.expression = "Expression looks too short";
    }

    if (timeout.value.trim()) {
      const ms = joinTimeoutMs(timeout.value, timeout.unit);
      if (ms === undefined) errs.timeout = "Timeout must be a positive number";
    }

    if (
      draft.priority !== undefined &&
      (!Number.isFinite(draft.priority) || draft.priority < 0)
    ) {
      errs.priority = "Priority must be a non-negative integer";
    }
    if (
      draft.maxRevisions !== undefined &&
      (!Number.isFinite(draft.maxRevisions) || draft.maxRevisions < 0)
    ) {
      errs.maxRevisions = "Max revisions must be a non-negative integer";
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;

    const timeoutMs = timeout.value.trim() ? joinTimeoutMs(timeout.value, timeout.unit) : undefined;
    const trimmedExpr = expression.trim();

    const gate: ApprovalGateDraft = {
      id: draft.id.trim(),
      name: draft.name.trim(),
      handler: draft.handler,
      hook: draft.hook,
      condition: trimmedExpr ? { expression: trimmedExpr } : undefined,
      notifyChannels:
        draft.handler === "human" && draft.notifyChannels && draft.notifyChannels.length > 0
          ? draft.notifyChannels
          : undefined,
      timeoutMs,
      timeoutAction: timeoutMs ? draft.timeoutAction ?? "reject" : undefined,
      priority: draft.priority,
      maxRevisions: draft.handler === "human" ? draft.maxRevisions : undefined,
      includeOutcomes: draft.includeOutcomes,
    };

    setSaving(true);
    setSaveError(null);
    try {
      await onSave(gate);
      onOpenChange(false);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const selectedHook = HOOK_OPTIONS.find((h) => h.value === draft.hook);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-3 shrink-0">
          <DialogTitle>{isEdit ? "Edit approval gate" : "New approval gate"}</DialogTitle>
          <DialogDescription>
            Pause execution at a lifecycle hook for human review or automatic decisioning.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0">
          <div className="px-6 pb-2 space-y-5">
            {/* Identity */}
            <Section title="Identity">
              <Field label="ID" error={errors.id} required>
                <Input
                  value={draft.id}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                  placeholder="gate-task-create-review"
                  className="font-mono text-xs"
                  disabled={isEdit}
                />
              </Field>
              <Field label="Name" error={errors.name} required>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Review new tasks before assignment"
                />
              </Field>
            </Section>

            {/* Handler */}
            <Section title="Handler">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, handler: "human" })}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors cursor-pointer",
                    draft.handler === "human"
                      ? "border-primary bg-primary/5"
                      : "border-border/40 hover:bg-muted",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <Users className="h-3.5 w-3.5" />
                    <span className="text-xs font-semibold">human</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Pause for human approval (notifies channels)
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, handler: "auto" })}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors cursor-pointer",
                    draft.handler === "auto"
                      ? "border-primary bg-primary/5"
                      : "border-border/40 hover:bg-muted",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <Bot className="h-3.5 w-3.5" />
                    <span className="text-xs font-semibold">auto</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Decide automatically based on condition
                  </p>
                </button>
              </div>
            </Section>

            {/* Hook */}
            <Section title="Lifecycle hook">
              <Select
                value={draft.hook}
                onValueChange={(v) => setDraft({ ...draft, hook: v as LifecycleHook })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOOK_OPTIONS.map((h) => (
                    <SelectItem key={h.value} value={h.value}>
                      <span className="font-mono text-xs">{h.label}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedHook && (
                <p className="text-[10px] text-muted-foreground">{selectedHook.description}</p>
              )}
            </Section>

            {/* Condition */}
            <Section title="Condition (optional)">
              <Field
                label="Expression"
                description="JS-like expression. Available scopes: task.*, mission.*, data.*"
                error={errors.expression}
              >
                <Textarea
                  value={expression}
                  onChange={(e) => setExpression(e.target.value)}
                  placeholder='task.priority === "high" && task.sideEffects'
                  className="font-mono text-xs min-h-16"
                />
              </Field>
            </Section>

            {/* Notify channels (human only) */}
            {draft.handler === "human" && (
              <Section title="Notify channels">
                {channels.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground italic">
                    No channels configured. Add one in the Channels tab first.
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-1.5">
                    {channels.map((c) => {
                      const selected = draft.notifyChannels?.includes(c) ?? false;
                      return (
                        <button
                          type="button"
                          key={c}
                          onClick={() => toggleChannel(c)}
                          className={cn(
                            "flex items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors cursor-pointer",
                            selected
                              ? "bg-accent border-primary/30 text-accent-foreground"
                              : "border-border/40 hover:bg-muted",
                          )}
                        >
                          <div
                            className={cn(
                              "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                              selected
                                ? "bg-primary border-primary"
                                : "border-muted-foreground/40",
                            )}
                          >
                            {selected && (
                              <span className="text-[8px] text-primary-foreground">✓</span>
                            )}
                          </div>
                          <span className="truncate font-mono">{c}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </Section>
            )}

            {/* Timeout */}
            <Section title="Timeout (optional)">
              <Field label="Duration" error={errors.timeout}>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    min="0"
                    value={timeout.value}
                    onChange={(e) => setTimeoutFields({ ...timeout, value: e.target.value })}
                    placeholder="0"
                    className="flex-1"
                  />
                  <Select
                    value={timeout.unit}
                    onValueChange={(v) =>
                      setTimeoutFields({ ...timeout, unit: v as TimeoutUnit })
                    }
                  >
                    <SelectTrigger className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sec">seconds</SelectItem>
                      <SelectItem value="min">minutes</SelectItem>
                      <SelectItem value="hour">hours</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </Field>
              {timeout.value.trim() && (
                <Field label="On timeout">
                  <Select
                    value={draft.timeoutAction ?? "reject"}
                    onValueChange={(v) =>
                      setDraft({ ...draft, timeoutAction: v as "approve" | "reject" })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="reject">reject (default)</SelectItem>
                      <SelectItem value="approve">approve</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </Section>

            {/* Advanced */}
            <Section title="Advanced">
              <Field label="Priority" description="Lower runs first. Default: 50." error={errors.priority}>
                <Input
                  type="number"
                  min="0"
                  value={draft.priority ?? ""}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setDraft({
                      ...draft,
                      priority: e.target.value === "" || !Number.isFinite(n) ? undefined : n,
                    });
                  }}
                  placeholder="50"
                />
              </Field>
              {draft.handler === "human" && (
                <Field
                  label="Max revisions"
                  description="How many revision rounds before final reject. Default: 3."
                  error={errors.maxRevisions}
                >
                  <Input
                    type="number"
                    min="0"
                    value={draft.maxRevisions ?? ""}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setDraft({
                        ...draft,
                        maxRevisions: e.target.value === "" || !Number.isFinite(n) ? undefined : n,
                      });
                    }}
                    placeholder="3"
                  />
                </Field>
              )}
            </Section>

            {saveError && (
              <div className="text-[11px] text-destructive bg-destructive/10 border border-destructive/30 rounded px-2 py-1.5">
                {saveError}
              </div>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="px-6 py-4 border-t shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Local UI helpers ─────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h4>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

function Field({
  label,
  description,
  error,
  required,
  children,
}: {
  label: string;
  description?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] font-medium text-muted-foreground flex items-center gap-1">
        {label}
        {required && <span className="text-destructive">*</span>}
      </label>
      {children}
      {description && !error && (
        <p className="text-[10px] text-muted-foreground">{description}</p>
      )}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
