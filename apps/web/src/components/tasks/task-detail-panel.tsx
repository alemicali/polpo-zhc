"use client";

import { useState, useCallback } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Task, TaskExpectation } from "@orchestra/react";
import { useTask } from "@orchestra/react";
import { TaskStatusBadge } from "./task-status-badge";
import { AssessmentScores } from "./assessment-scores";
import { formatDuration, formatScore, formatTimeAgo } from "@/lib/orchestra";
import {
  RotateCcw,
  Square,
  ClipboardCheck,
  Pencil,
  Plus,
  X,
  Save,
} from "lucide-react";
import { toast } from "sonner";

interface TaskDetailPanelProps {
  task: Task | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const EDITABLE_STATUSES = new Set(["pending", "failed", "done"]);

const EXP_TYPE_LABELS: Record<string, string> = {
  test: "Test",
  script: "Script",
  file_exists: "File Exists",
  llm_review: "LLM Review",
};

const EXP_TYPE_COLORS: Record<string, string> = {
  test: "text-cyan-400 border-cyan-400/30 bg-cyan-400/10",
  script: "text-blue-400 border-blue-400/30 bg-blue-400/10",
  file_exists: "text-green-400 border-green-400/30 bg-green-400/10",
  llm_review: "text-purple-400 border-purple-400/30 bg-purple-400/10",
};

function newExpectation(type: TaskExpectation["type"]): TaskExpectation {
  switch (type) {
    case "test":
      return { type: "test", command: "" };
    case "script":
      return { type: "script", command: "" };
    case "file_exists":
      return { type: "file_exists", paths: [""] };
    case "llm_review":
      return { type: "llm_review", criteria: "", threshold: 3.0 };
  }
}

export function TaskDetailPanel({
  task,
  open,
  onOpenChange,
}: TaskDetailPanelProps) {
  const { killTask, retryTask, reassessTask, updateTask } = useTask(
    task?.id ?? ""
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<TaskExpectation[]>([]);
  const [reassessAfterSave, setReassessAfterSave] = useState(true);
  const [saving, setSaving] = useState(false);

  const canEdit = task ? EDITABLE_STATUSES.has(task.status) : false;

  const startEditing = useCallback(() => {
    if (!task) return;
    setDraft(task.expectations.map((e) => ({ ...e })));
    setEditing(true);
  }, [task]);

  const cancelEditing = useCallback(() => {
    setEditing(false);
    setDraft([]);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await updateTask({ expectations: draft });
      toast.success("Expectations updated");
      if (reassessAfterSave) {
        try {
          await reassessTask();
          toast.success("Reassessment started");
        } catch {
          toast.error("Could not reassess — task may need a retry first");
        }
      }
      setEditing(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [draft, updateTask, reassessTask, reassessAfterSave]);

  const updateDraft = useCallback(
    (index: number, updates: Partial<TaskExpectation>) => {
      setDraft((prev) =>
        prev.map((e, i) => (i === index ? { ...e, ...updates } : e))
      );
    },
    []
  );

  const removeDraft = useCallback((index: number) => {
    setDraft((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const addDraft = useCallback((type: TaskExpectation["type"]) => {
    setDraft((prev) => [...prev, newExpectation(type)]);
  }, []);

  if (!task) return null;

  const assessment = task.result?.assessment;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[440px] overflow-auto sm:max-w-[440px]">
        <SheetHeader>
          <div className="flex items-center gap-2">
            <TaskStatusBadge status={task.status} />
            <SheetTitle className="text-base">{task.title}</SheetTitle>
          </div>
          <SheetDescription className="text-xs font-mono">
            {task.id}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {/* Description */}
          <div>
            <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Description
            </h4>
            <p className="text-sm whitespace-pre-wrap">{task.description}</p>
          </div>

          <Separator />

          {/* Metadata */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-xs text-muted-foreground">Agent</span>
              <p className="font-medium">{task.assignTo || "—"}</p>
            </div>
            <div>
              <span className="text-xs text-muted-foreground">Group</span>
              <p className="font-medium">{task.group || "—"}</p>
            </div>
            <div>
              <span className="text-xs text-muted-foreground">Retries</span>
              <p className="font-medium tabular-nums">
                {task.retries}/{task.maxRetries}
              </p>
            </div>
            <div>
              <span className="text-xs text-muted-foreground">Duration</span>
              <p className="font-medium tabular-nums">
                {task.result?.duration
                  ? formatDuration(task.result.duration)
                  : "—"}
              </p>
            </div>
            <div>
              <span className="text-xs text-muted-foreground">Created</span>
              <p className="font-medium">{formatTimeAgo(task.createdAt)}</p>
            </div>
            <div>
              <span className="text-xs text-muted-foreground">Updated</span>
              <p className="font-medium">{formatTimeAgo(task.updatedAt)}</p>
            </div>
          </div>

          {/* Dependencies */}
          {task.dependsOn.length > 0 && (
            <>
              <Separator />
              <div>
                <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Dependencies
                </h4>
                <div className="flex flex-wrap gap-1">
                  {task.dependsOn.map((dep) => (
                    <Badge
                      key={dep}
                      variant="outline"
                      className="text-xs font-mono"
                    >
                      {dep}
                    </Badge>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Assessment */}
          {assessment && (
            <>
              <Separator />
              <div>
                <h4 className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Assessment
                </h4>
                <div className="mb-3 flex items-center gap-3">
                  <Badge
                    variant={assessment.passed ? "default" : "destructive"}
                  >
                    {assessment.passed ? "PASSED" : "FAILED"}
                  </Badge>
                  {assessment.globalScore !== undefined && (
                    <span className="text-sm font-medium tabular-nums">
                      {formatScore(assessment.globalScore)}
                    </span>
                  )}
                </div>
                {assessment.scores && assessment.scores.length > 0 && (
                  <AssessmentScores dimensions={assessment.scores} />
                )}
                {assessment.llmReview && (
                  <p className="mt-3 text-xs text-muted-foreground whitespace-pre-wrap">
                    {assessment.llmReview}
                  </p>
                )}
              </div>
            </>
          )}

          {/* Expectations */}
          <Separator />
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Expectations
                {task.expectations.length > 0 && (
                  <span className="ml-1 text-muted-foreground/50">
                    ({task.expectations.length})
                  </span>
                )}
              </h4>
              {canEdit && !editing && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs px-2"
                  onClick={startEditing}
                >
                  <Pencil className="mr-1 h-3 w-3" /> Edit
                </Button>
              )}
            </div>

            {editing ? (
              /* ── Edit mode ── */
              <div className="space-y-3">
                {draft.map((exp, i) => (
                  <div
                    key={i}
                    className="rounded-md border bg-muted/30 p-3 text-xs space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${EXP_TYPE_COLORS[exp.type] ?? ""}`}
                      >
                        {EXP_TYPE_LABELS[exp.type] ?? exp.type}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 text-muted-foreground hover:text-destructive"
                        onClick={() => removeDraft(i)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>

                    {(exp.type === "test" || exp.type === "script") && (
                      <Textarea
                        value={exp.command ?? ""}
                        onChange={(e) =>
                          updateDraft(i, { command: e.target.value })
                        }
                        placeholder={
                          exp.type === "test"
                            ? "e.g. npm test"
                            : "e.g. npm run build && test -f dist/index.js"
                        }
                        rows={2}
                        className="text-xs font-mono"
                      />
                    )}

                    {exp.type === "file_exists" && (
                      <Input
                        value={(exp.paths ?? []).join(", ")}
                        onChange={(e) =>
                          updateDraft(i, {
                            paths: e.target.value
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                        placeholder="src/file.ts, src/other.ts"
                        className="text-xs font-mono"
                      />
                    )}

                    {exp.type === "llm_review" && (
                      <>
                        <Textarea
                          value={exp.criteria ?? ""}
                          onChange={(e) =>
                            updateDraft(i, { criteria: e.target.value })
                          }
                          placeholder="Quality criteria for LLM review..."
                          rows={2}
                          className="text-xs"
                        />
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">
                            Threshold:
                          </span>
                          <Input
                            type="number"
                            min={1}
                            max={5}
                            step={0.5}
                            value={exp.threshold ?? 3}
                            onChange={(e) =>
                              updateDraft(i, {
                                threshold: parseFloat(e.target.value) || 3,
                              })
                            }
                            className="w-16 text-xs h-7"
                          />
                          <span className="text-muted-foreground/50">/ 5</span>
                        </div>
                      </>
                    )}
                  </div>
                ))}

                {/* Add new expectation */}
                <Select
                  onValueChange={(v) =>
                    addDraft(v as TaskExpectation["type"])
                  }
                >
                  <SelectTrigger className="h-8 text-xs border-dashed">
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <Plus className="h-3 w-3" /> Add expectation
                    </div>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="test">Test</SelectItem>
                    <SelectItem value="script">Script</SelectItem>
                    <SelectItem value="file_exists">File Exists</SelectItem>
                    <SelectItem value="llm_review">LLM Review</SelectItem>
                  </SelectContent>
                </Select>

                {/* Save / Cancel */}
                <div className="space-y-2 pt-1">
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={reassessAfterSave}
                      onCheckedChange={setReassessAfterSave}
                      className="scale-75"
                    />
                    <span className="text-xs text-muted-foreground">
                      Reassess after saving
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={handleSave}
                      disabled={saving}
                    >
                      <Save className="mr-1 h-3 w-3" />
                      {saving ? "Saving..." : "Save"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={cancelEditing}
                      disabled={saving}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              /* ── Read-only mode ── */
              <div className="space-y-2">
                {task.expectations.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No expectations defined.
                    {canEdit && " Click Edit to add acceptance criteria."}
                  </p>
                ) : (
                  task.expectations.map((exp, i) => (
                    <div
                      key={i}
                      className="rounded-md border bg-muted/30 p-2 text-xs"
                    >
                      <Badge
                        variant="outline"
                        className={`text-[10px] mb-1 ${EXP_TYPE_COLORS[exp.type] ?? ""}`}
                      >
                        {EXP_TYPE_LABELS[exp.type] ?? exp.type}
                      </Badge>
                      {exp.command && (
                        <p className="font-mono text-muted-foreground whitespace-pre-wrap">
                          {exp.command}
                        </p>
                      )}
                      {exp.paths && exp.paths.length > 0 && (
                        <p className="font-mono text-muted-foreground">
                          {exp.paths.join(", ")}
                        </p>
                      )}
                      {exp.criteria && (
                        <p className="text-muted-foreground">{exp.criteria}</p>
                      )}
                      {exp.threshold !== undefined && (
                        <p className="text-muted-foreground/60">
                          threshold: {exp.threshold}/5
                        </p>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          <Separator />

          {/* Actions */}
          <div className="flex gap-2">
            {(task.status === "in_progress" || task.status === "assigned") && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => killTask()}
              >
                <Square className="mr-1.5 h-3 w-3" />
                Kill
              </Button>
            )}
            {task.status === "failed" && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => retryTask()}
              >
                <RotateCcw className="mr-1.5 h-3 w-3" />
                Retry
              </Button>
            )}
            {(task.status === "done" || task.status === "failed") && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => reassessTask()}
              >
                <ClipboardCheck className="mr-1.5 h-3 w-3" />
                Reassess
              </Button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
