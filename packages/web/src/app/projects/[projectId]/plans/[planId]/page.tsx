"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { usePlan, useTasks } from "@orchestra/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PlanYamlCode } from "@/components/plans/plan-yaml-view";
import { PlanTeamStrip } from "@/components/plans/plan-team-strip";
import { PlanTaskList } from "@/components/plans/plan-task-list";
import { PLAN_STATUS_COLORS, formatTimeAgo } from "@/lib/orchestra";
import { cn } from "@/lib/utils";
import { ArrowLeft, Play, Pause, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";

export default function PlanDetailPage() {
  const params = useParams<{ projectId: string; planId: string }>();
  const router = useRouter();
  const { plan, executePlan, resumePlan, abortPlan, deletePlan } = usePlan(params.planId);
  const { tasks } = useTasks();
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (!plan) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        Loading plan…
      </div>
    );
  }

  const planTasks = tasks.filter((t) => t.group === plan.name);
  const done = planTasks.filter((t) => t.status === "done").length;
  const failed = planTasks.filter((t) => t.status === "failed").length;
  const running = planTasks.filter(
    (t) => t.status === "in_progress" || t.status === "assigned"
  ).length;
  const pending = planTasks.filter((t) => t.status === "pending").length;
  const total = planTasks.length;
  const pct = total > 0 ? Math.round(((done + failed) / total) * 100) : 0;

  const handleExecute = async () => {
    try {
      const result = await executePlan();
      toast.success(`Launched ${result.tasks.length} tasks`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const handleResume = async () => {
    try {
      const result = await resumePlan({ retryFailed: true });
      toast.success(`Resumed: ${result.retried} retried`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const handleAbort = async () => {
    try {
      const result = await abortPlan();
      toast.success(`Aborted ${result.aborted} tasks`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const handleDelete = async () => {
    try {
      await deletePlan();
      toast.success("Plan deleted");
      router.push(`/projects/${params.projectId}/plans`);
    } catch (e) {
      toast.error((e as Error).message);
    }
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
          onClick={() => router.push(`/projects/${params.projectId}/plans`)}
        >
          <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Plans
        </Button>

        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight">{plan.name}</h1>
              <Badge
                variant="outline"
                className={cn("text-xs", PLAN_STATUS_COLORS[plan.status])}
              >
                {plan.status}
              </Badge>
            </div>
            <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
              <span>Created {formatTimeAgo(plan.createdAt)}</span>
              {total > 0 && (
                <>
                  <span>·</span>
                  <span>
                    {done}/{total} done
                    {failed > 0 && (
                      <span className="text-status-failed ml-1">
                        ({failed} failed)
                      </span>
                    )}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            {plan.status === "draft" && (
              <Button size="sm" onClick={handleExecute}>
                <Play className="mr-1.5 h-3.5 w-3.5" /> Execute
              </Button>
            )}
            {plan.status === "active" && (
              <Button variant="destructive" size="sm" onClick={handleAbort}>
                <Pause className="mr-1.5 h-3.5 w-3.5" /> Abort
              </Button>
            )}
            {(plan.status === "failed" || plan.status === "completed") && (
              <Button variant="outline" size="sm" onClick={handleResume}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Resume
              </Button>
            )}
            {(plan.status === "draft" || plan.status === "completed" || plan.status === "failed") && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Progress bar */}
      {total > 0 && (
        <div className="space-y-2">
          <div className="flex h-2 rounded-full bg-muted overflow-hidden">
            {done > 0 && (
              <div
                className="bg-status-done transition-all duration-500"
                style={{ width: `${(done / total) * 100}%` }}
              />
            )}
            {running > 0 && (
              <div
                className="bg-status-running transition-all duration-500"
                style={{ width: `${(running / total) * 100}%` }}
              />
            )}
            {failed > 0 && (
              <div
                className="bg-status-failed transition-all duration-500"
                style={{ width: `${(failed / total) * 100}%` }}
              />
            )}
          </div>
          <div className="flex items-center gap-3 text-xs tabular-nums">
            <span className="text-status-done">{done} done</span>
            {running > 0 && (
              <span className="text-status-running">{running} running</span>
            )}
            {pending > 0 && (
              <span className="text-muted-foreground">{pending} pending</span>
            )}
            {failed > 0 && (
              <span className="text-status-failed">{failed} failed</span>
            )}
            <span className="font-medium ml-auto">{pct}%</span>
          </div>
        </div>
      )}

      {/* Team strip */}
      <PlanTeamStrip planName={plan.name} />

      <Separator />

      {/* Tabs: Tasks + YAML */}
      <Tabs defaultValue="tasks">
        <TabsList>
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
          <TabsTrigger value="yaml">YAML</TabsTrigger>
        </TabsList>
        <TabsContent value="tasks">
          <PlanTaskList planName={plan.name} planStatus={plan.status} />
        </TabsContent>
        <TabsContent value="yaml">
          <PlanYamlCode yaml={plan.yaml} />
        </TabsContent>
      </Tabs>

      {/* Delete Plan Confirmation */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete plan?</DialogTitle>
            <DialogDescription>
              This will permanently delete the plan <strong>&ldquo;{plan.name}&rdquo;</strong>
              {total > 0 && ` and its ${total} associated task${total > 1 ? "s" : ""}`}.
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete Plan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
