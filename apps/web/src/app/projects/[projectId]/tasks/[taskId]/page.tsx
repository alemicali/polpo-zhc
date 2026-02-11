"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTask, useTasks, useProcesses } from "@orchestra/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TaskStatusBadge } from "@/components/tasks/task-status-badge";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  STATUS_DOT_COLORS,
  formatDuration,
  formatScore,
  formatTimeAgo,
} from "@/lib/orchestra";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  RotateCcw,
  Square,
  Trash2,
  ClipboardCheck,
  CheckCircle2,
  XCircle,
  FileText,
  Wrench,
  Activity,
  BarChart3,
  Gauge,
  MessageSquareText,
  Link2,
  Target,
  Timer,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

export default function TaskDetailPage() {
  const params = useParams<{ projectId: string; taskId: string }>();
  const router = useRouter();
  const { task, killTask, retryTask, reassessTask, deleteTask } = useTask(params.taskId);
  const { tasks } = useTasks();
  const { processes } = useProcesses();
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (!task) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        Loading task…
      </div>
    );
  }

  const proc = processes.find((p) => p.taskId === task.id && p.alive);
  const assessment = task.result?.assessment;
  const dependencyTasks = tasks.filter((t) => task.dependsOn.includes(t.id));

  const hasAssessment = !!assessment;
  const hasDeps = task.dependsOn.length > 0;
  const hasExpectations = task.expectations.length > 0;

  const depsResolved = dependencyTasks.filter((d) => d.status === "done").length;
  const checksPass = assessment ? assessment.checks.filter((c) => c.passed).length : 0;
  const checksTotal = assessment ? assessment.checks.length : 0;

  const handleKill = async () => {
    try { await killTask(); toast.success("Task killed"); }
    catch (e) { toast.error((e as Error).message); }
  };
  const handleRetry = async () => {
    try { await retryTask(); toast.success("Task retried"); }
    catch (e) { toast.error((e as Error).message); }
  };
  const handleReassess = async () => {
    try { await reassessTask(); toast.success("Reassessing task…"); }
    catch (e) { toast.error((e as Error).message); }
  };
  const handleDelete = async () => {
    try {
      await deleteTask();
      toast.success("Task deleted");
      router.push(`/projects/${params.projectId}/tasks`);
    } catch (e) { toast.error((e as Error).message); }
    setDeleteOpen(false);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="mb-2 -ml-2 text-muted-foreground"
          onClick={() => router.push(`/projects/${params.projectId}/tasks`)}
        >
          <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Tasks
        </Button>

        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <span
                className={cn(
                  "h-3 w-3 rounded-full shrink-0",
                  STATUS_DOT_COLORS[task.status],
                  (task.status === "in_progress" || task.status === "assigned") &&
                    "animate-pulse"
                )}
              />
              <h1 className="text-2xl font-bold tracking-tight">{task.title}</h1>
            </div>
            <div className="flex items-center gap-3 mt-1 ml-6">
              <TaskStatusBadge status={task.status} />
              <span className="text-xs text-muted-foreground font-mono">{task.id}</span>
            </div>
          </div>
          <div className="flex gap-2 shrink-0">
            {(task.status === "in_progress" || task.status === "assigned") && (
              <Button variant="destructive" size="sm" onClick={handleKill}>
                <Square className="mr-1.5 h-3.5 w-3.5" /> Kill
              </Button>
            )}
            {task.status === "failed" && (
              <Button variant="outline" size="sm" onClick={handleRetry}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Retry
              </Button>
            )}
            {(task.status === "done" || task.status === "failed") && (
              <Button variant="outline" size="sm" onClick={handleReassess}>
                <ClipboardCheck className="mr-1.5 h-3.5 w-3.5" /> Reassess
              </Button>
            )}
            {(task.status === "done" || task.status === "failed" || task.status === "pending") && (
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Two-column: left (micro dashboard + tabs) | right (sidebar) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_280px]">
        {/* ── Left column ── */}
        <div className="space-y-6 min-w-0">
          {/* Micro dashboard */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {/* Score card */}
            <Card className={cn(
              "relative overflow-hidden",
              hasAssessment && (assessment.passed ? "border-status-done/30" : "border-status-failed/30")
            )}>
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground mb-1">Score</div>
                {hasAssessment ? (
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      "text-2xl font-bold tabular-nums",
                      assessment.passed ? "text-status-done" : "text-status-failed"
                    )}>
                      {formatScore(assessment.globalScore)}
                    </span>
                    {assessment.passed ? (
                      <CheckCircle2 className="h-4 w-4 text-status-done" />
                    ) : (
                      <XCircle className="h-4 w-4 text-status-failed" />
                    )}
                  </div>
                ) : (
                  <span className="text-2xl font-bold text-muted-foreground/40">—</span>
                )}
              </CardContent>
            </Card>

            {/* Checks card */}
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground mb-1">Checks</div>
                {checksTotal > 0 ? (
                  <>
                    <div className="text-2xl font-bold tabular-nums">
                      {checksPass}<span className="text-sm text-muted-foreground font-normal">/{checksTotal}</span>
                    </div>
                    <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className={cn(
                          "h-full rounded-full transition-all",
                          checksPass === checksTotal ? "bg-status-done" : "bg-status-failed"
                        )}
                        style={{ width: `${(checksPass / checksTotal) * 100}%` }}
                      />
                    </div>
                  </>
                ) : (
                  <span className="text-2xl font-bold text-muted-foreground/40">—</span>
                )}
              </CardContent>
            </Card>

            {/* Duration card */}
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                  <Timer className="h-3 w-3" /> Duration
                </div>
                <div className="text-2xl font-bold tabular-nums">
                  {task.result?.duration
                    ? formatDuration(task.result.duration)
                    : <span className="text-muted-foreground/40">—</span>}
                </div>
              </CardContent>
            </Card>

            {/* Retries card */}
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                  <RefreshCw className="h-3 w-3" /> Retries
                </div>
                <div className="text-2xl font-bold tabular-nums">
                  {task.retries}<span className="text-sm text-muted-foreground font-normal">/{task.maxRetries}</span>
                </div>
                {task.retries > 0 && (
                  <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-status-running transition-all"
                      style={{ width: `${(task.retries / task.maxRetries) * 100}%` }}
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Live agent activity banner */}
          {proc && (
            <div className="flex items-center gap-4 rounded-lg border border-status-running/30 bg-status-running/5 px-4 py-3">
              <Activity className="h-4 w-4 text-status-running shrink-0" />
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">{proc.agentName}</span>
                <span className="h-1.5 w-1.5 rounded-full bg-status-running animate-pulse" />
              </div>
              {proc.activity?.lastTool && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Wrench className="h-3 w-3" />
                  <span>{proc.activity.lastTool}</span>
                </div>
              )}
              {proc.activity?.lastFile && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
                  <FileText className="h-3 w-3 shrink-0" />
                  <span className="font-mono truncate">{proc.activity.lastFile}</span>
                </div>
              )}
              {proc.activity && proc.activity.toolCalls > 0 && (
                <span className="text-xs text-muted-foreground ml-auto tabular-nums shrink-0">
                  {proc.activity.toolCalls} tool calls
                </span>
              )}
            </div>
          )}

          {/* Tabs */}
          <Tabs defaultValue="overview">
            <TabsList variant="line">
              <TabsTrigger value="overview">
                <FileText className="h-4 w-4" /> Overview
              </TabsTrigger>
              {hasAssessment && (
                <TabsTrigger value="assessment">
                  <ClipboardCheck className="h-4 w-4" /> Assessment
                </TabsTrigger>
              )}
              {(hasDeps || hasExpectations) && (
                <TabsTrigger value="config">
                  <Target className="h-4 w-4" /> Config
                </TabsTrigger>
              )}
            </TabsList>

            {/* ── Overview ── */}
            <TabsContent value="overview" className="mt-6">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <FileText className="h-4 w-4" /> Description
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="prose prose-sm dark:prose-invert max-w-none">
                    <MessageResponse>{task.description}</MessageResponse>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ── Assessment ── */}
            {hasAssessment && (
              <TabsContent value="assessment" className="mt-6 space-y-5">
                {/* ① Verdict banner */}
                {(() => {
                  const failedChecks = assessment.checks.filter(c => !c.passed);
                  const failedMetrics = assessment.metrics.filter(m => !m.passed);
                  const failedNonLlm = failedChecks.filter(c => c.type !== "llm_review");
                  const scoreCheck = assessment.checks.find(c => c.type === "llm_review");
                  const scoreBelowThreshold = scoreCheck && !scoreCheck.passed;

                  // Build failure reason
                  let failureReason = "";
                  if (!assessment.passed) {
                    const reasons: string[] = [];
                    if (failedNonLlm.length > 0) {
                      reasons.push(`${failedNonLlm.length} check${failedNonLlm.length > 1 ? "s" : ""} failed (${failedNonLlm.map(c => c.type).join(", ")})`);
                    }
                    if (scoreBelowThreshold) {
                      reasons.push(`quality score below threshold`);
                    }
                    if (failedMetrics.length > 0) {
                      reasons.push(`${failedMetrics.length} metric${failedMetrics.length > 1 ? "s" : ""} below threshold`);
                    }
                    failureReason = reasons.join(" · ");
                  }

                  return (
                    <div className={cn(
                      "rounded-lg border p-5",
                      assessment.passed
                        ? "bg-status-done/5 border-status-done/30"
                        : "bg-status-failed/5 border-status-failed/30"
                    )}>
                      <div className="flex items-center gap-4">
                        {assessment.passed ? (
                          <CheckCircle2 className="h-8 w-8 text-status-done shrink-0" />
                        ) : (
                          <XCircle className="h-8 w-8 text-status-failed shrink-0" />
                        )}
                        <div className="flex-1">
                          <div className="text-lg font-bold">
                            {assessment.passed ? "Assessment Passed" : "Assessment Failed"}
                          </div>
                          {assessment.passed ? (
                            <p className="text-sm text-muted-foreground mt-0.5">
                              {checksTotal > 0 && `All ${checksTotal} criteria passed`}
                              {assessment.scores && assessment.scores.length > 0 && (
                                <span>{checksTotal > 0 ? " · " : ""}Quality score: {formatScore(assessment.globalScore)}/5</span>
                              )}
                            </p>
                          ) : (
                            <div className="mt-1 space-y-1">
                              <p className="text-sm font-medium text-status-failed">{failureReason}</p>
                              {failedNonLlm.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 mt-1">
                                  {failedNonLlm.map((c, i) => (
                                    <span key={i} className="inline-flex items-center gap-1 text-xs text-status-failed bg-status-failed/10 rounded px-2 py-0.5">
                                      <XCircle className="h-3 w-3" />
                                      {c.message.length > 60 ? c.message.slice(0, 57) + "…" : c.message}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        {assessment.globalScore !== undefined && (
                          <div className="text-right shrink-0">
                            <div className={cn(
                              "text-3xl font-bold tabular-nums",
                              assessment.passed ? "text-status-done" : (scoreBelowThreshold ? "text-status-failed" : "text-status-done")
                            )}>
                              {formatScore(assessment.globalScore)}
                            </div>
                            {!assessment.passed && !scoreBelowThreshold && assessment.globalScore !== undefined && (
                              <span className="text-[10px] text-muted-foreground">score OK — checks failed</span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* ② Acceptance Criteria (checks) */}
                {checksTotal > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold flex items-center gap-2">
                      <Target className="h-4 w-4" /> Acceptance Criteria
                    </h3>
                    <div className="space-y-2">
                      {assessment.checks.map((check, i) => (
                        <div
                          key={i}
                          className={cn(
                            "flex items-start gap-3 rounded-lg border p-3",
                            check.passed
                              ? "border-status-done/20"
                              : "border-status-failed/20"
                          )}
                        >
                          <div className="pt-0.5 shrink-0">
                            {check.passed ? (
                              <CheckCircle2 className="h-4 w-4 text-status-done" />
                            ) : (
                              <XCircle className="h-4 w-4 text-status-failed" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-medium">{check.message}</span>
                              <Badge variant="outline" className="text-[10px] shrink-0">{check.type}</Badge>
                            </div>
                            {check.details && (
                              <pre className="mt-1.5 text-xs text-muted-foreground whitespace-pre-wrap font-mono bg-muted/30 rounded px-2 py-1.5 overflow-x-auto">
                                {check.details}
                              </pre>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ③ Quality Scores (G-Eval dimensions) */}
                {assessment.scores && assessment.scores.length > 0 && (
                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold flex items-center gap-2">
                      <BarChart3 className="h-4 w-4" /> Quality Scores
                      <span className="text-xs font-normal text-muted-foreground ml-auto">G-Eval LLM-as-Judge (1-5)</span>
                    </h3>
                    <Card>
                      <CardContent className="p-4 space-y-4">
                        {assessment.scores.map((dim) => (
                          <div key={dim.dimension} className="space-y-1.5">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium capitalize">
                                  {dim.dimension.replace(/_/g, " ")}
                                </span>
                                <span className="text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-muted tabular-nums">
                                  weight {(dim.weight * 100).toFixed(0)}%
                                </span>
                              </div>
                              <span className={cn(
                                "text-sm font-bold tabular-nums",
                                dim.score >= 4 ? "text-status-done"
                                  : dim.score >= 3 ? "text-status-running"
                                  : "text-status-failed"
                              )}>
                                {dim.score}/5
                              </span>
                            </div>
                            <div className="h-2 rounded-full bg-muted overflow-hidden">
                              <div
                                className={cn(
                                  "h-full rounded-full transition-all duration-500",
                                  dim.score >= 4 ? "bg-status-done"
                                    : dim.score >= 3 ? "bg-status-running"
                                    : "bg-status-failed"
                                )}
                                style={{ width: `${(dim.score / 5) * 100}%` }}
                              />
                            </div>
                            {dim.reasoning && (
                              <p className="text-xs text-muted-foreground leading-relaxed">
                                {dim.reasoning}
                              </p>
                            )}
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  </div>
                )}

                {/* ④ Metrics (custom thresholds) */}
                {assessment.metrics.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold flex items-center gap-2">
                      <Gauge className="h-4 w-4" /> Metrics
                    </h3>
                    <div className="space-y-2">
                      {assessment.metrics.map((metric) => (
                        <div
                          key={metric.name}
                          className={cn(
                            "flex items-center gap-3 rounded-lg border p-3",
                            metric.passed ? "border-status-done/20" : "border-status-failed/20"
                          )}
                        >
                          {metric.passed ? (
                            <CheckCircle2 className="h-4 w-4 text-status-done shrink-0" />
                          ) : (
                            <XCircle className="h-4 w-4 text-status-failed shrink-0" />
                          )}
                          <span className="text-sm font-medium flex-1">{metric.name}</span>
                          <div className="text-right shrink-0">
                            <span className="text-sm font-bold tabular-nums">{metric.value}</span>
                            <span className="text-xs text-muted-foreground ml-1">/ {metric.threshold}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ⑤ LLM Review (detailed reasoning) */}
                {assessment.llmReview && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold flex items-center gap-2">
                      <MessageSquareText className="h-4 w-4" /> Review
                    </h3>
                    <Card>
                      <CardContent className="p-4">
                        <div className="prose prose-sm dark:prose-invert max-w-none">
                          <MessageResponse>{assessment.llmReview}</MessageResponse>
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                )}
              </TabsContent>
            )}

            {/* ── Config ── */}
            {(hasDeps || hasExpectations) && (
              <TabsContent value="config" className="mt-6">
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                  {hasDeps && (
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm flex items-center gap-2">
                          <Link2 className="h-4 w-4" /> Dependencies
                          <span className="ml-auto text-xs font-normal text-muted-foreground tabular-nums">
                            {depsResolved}/{dependencyTasks.length} done
                          </span>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-1.5">
                        {dependencyTasks.map((dep) => (
                          <Button
                            key={dep.id}
                            variant="ghost"
                            className="w-full justify-start h-auto py-2 px-3"
                            onClick={() =>
                              router.push(`/projects/${params.projectId}/tasks/${dep.id}`)
                            }
                          >
                            <span className={cn("h-2 w-2 rounded-full mr-2 shrink-0", STATUS_DOT_COLORS[dep.status])} />
                            <span className="text-sm truncate flex-1 text-left">{dep.title}</span>
                            <TaskStatusBadge status={dep.status} />
                          </Button>
                        ))}
                        {task.dependsOn
                          .filter((id) => !dependencyTasks.find((t) => t.id === id))
                          .map((id) => (
                            <div key={id} className="text-xs text-muted-foreground font-mono px-3 py-2">
                              {id} (not found)
                            </div>
                          ))}
                      </CardContent>
                    </Card>
                  )}

                  {hasExpectations && (
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm flex items-center gap-2">
                          <Target className="h-4 w-4" /> Expectations
                          <span className="ml-auto text-xs font-normal text-muted-foreground tabular-nums">
                            {task.expectations.length} rule{task.expectations.length !== 1 ? "s" : ""}
                          </span>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {task.expectations.map((exp, i) => {
                          const hasContent = exp.command || exp.criteria || (exp.paths && exp.paths.length > 0);
                          return (
                            <div key={i} className="flex items-start gap-2.5 rounded-lg border bg-muted/20 p-3">
                              <Badge variant="outline" className="text-[10px] shrink-0 mt-0.5">{exp.type}</Badge>
                              <div className="flex-1 min-w-0">
                                {exp.command && (
                                  <pre className="font-mono text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1 whitespace-pre-wrap overflow-x-auto">
                                    {exp.command}
                                  </pre>
                                )}
                                {exp.paths && exp.paths.length > 0 && (
                                  <p className="font-mono text-xs text-muted-foreground">
                                    {exp.paths.join(", ")}
                                  </p>
                                )}
                                {exp.criteria && (
                                  <p className="text-xs text-muted-foreground">{exp.criteria}</p>
                                )}
                                {exp.threshold && (
                                  <span className="text-[10px] text-muted-foreground/60">
                                    threshold: {exp.threshold}/5
                                  </span>
                                )}
                                {!hasContent && (
                                  <span className="text-xs text-muted-foreground/40 italic">default config</span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </CardContent>
                    </Card>
                  )}
                </div>
              </TabsContent>
            )}
          </Tabs>
        </div>

        {/* ── Right sidebar ── */}
        <div className="space-y-4">
          {/* Metadata */}
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="space-y-3 text-sm">
                <div>
                  <span className="text-xs text-muted-foreground block">Agent</span>
                  <span className="font-medium">{task.assignTo || "—"}</span>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground block">Group</span>
                  {task.group ? (
                    <Button
                      variant="link"
                      className="h-auto p-0 text-sm"
                      onClick={() => router.push(`/projects/${params.projectId}/plans`)}
                    >
                      {task.group}
                    </Button>
                  ) : (
                    <span className="font-medium">—</span>
                  )}
                </div>
                <div>
                  <span className="text-xs text-muted-foreground block">Status</span>
                  <TaskStatusBadge status={task.status} />
                </div>
                <div>
                  <span className="text-xs text-muted-foreground block">Duration</span>
                  <span className="font-medium tabular-nums">
                    {task.result?.duration ? formatDuration(task.result.duration) : "—"}
                  </span>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground block">Retries</span>
                  <span className="font-medium tabular-nums">{task.retries}/{task.maxRetries}</span>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground block">Created</span>
                  <span className="font-medium">{formatTimeAgo(task.createdAt)}</span>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground block">Updated</span>
                  <span className="font-medium">{formatTimeAgo(task.updatedAt)}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Live agent */}
          {proc && (
            <Card className="border-status-running/30">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Activity className="h-4 w-4 text-status-running" /> Live Agent
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{proc.agentName}</span>
                  <span className="h-1.5 w-1.5 rounded-full bg-status-running animate-pulse" />
                </div>
                {proc.activity?.lastTool && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Wrench className="h-3 w-3" />
                    <span>{proc.activity.lastTool}</span>
                  </div>
                )}
                {proc.activity?.lastFile && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <FileText className="h-3 w-3 shrink-0" />
                    <span className="font-mono truncate">{proc.activity.lastFile}</span>
                  </div>
                )}
                {proc.activity && proc.activity.toolCalls > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {proc.activity.toolCalls} tool calls
                  </span>
                )}
              </CardContent>
            </Card>
          )}

          {/* Quick deps summary in sidebar */}
          {hasDeps && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Link2 className="h-4 w-4" /> Dependencies
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {dependencyTasks.map((dep) => (
                  <div
                    key={dep.id}
                    className="flex items-center gap-2 text-xs cursor-pointer hover:text-foreground text-muted-foreground py-0.5"
                    onClick={() => router.push(`/projects/${params.projectId}/tasks/${dep.id}`)}
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", STATUS_DOT_COLORS[dep.status])} />
                    <span className="truncate">{dep.title}</span>
                  </div>
                ))}
                <div className="text-[10px] text-muted-foreground mt-1 tabular-nums">
                  {depsResolved}/{dependencyTasks.length} resolved
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Delete Task Confirmation */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete task?</DialogTitle>
            <DialogDescription>
              This will permanently delete <strong>&ldquo;{task.title}&rdquo;</strong>. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
