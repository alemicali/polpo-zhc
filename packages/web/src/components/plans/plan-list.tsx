"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { usePlans, useTasks } from "@orchestra/react";
import { PLAN_STATUS_COLORS, formatTimeAgo } from "@/lib/orchestra";
import { cn } from "@/lib/utils";
import { Plus, ExternalLink } from "lucide-react";
import { toast } from "sonner";

export function PlanList() {
  const { plans, createPlan } = usePlans();
  const { tasks } = useTasks();
  const params = useParams<{ projectId: string }>();

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newYaml, setNewYaml] = useState("");

  const handleCreate = async () => {
    if (!newYaml.trim()) return;
    try {
      await createPlan({ yaml: newYaml, name: newName || undefined });
      setCreateOpen(false);
      setNewName("");
      setNewYaml("");
      toast.success("Plan created");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      {/* Create button */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogTrigger asChild>
          <Button size="sm">
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            New Plan
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create Plan</DialogTitle>
            <DialogDescription>
              Paste a YAML plan definition
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="Plan name (optional)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <Textarea
              placeholder="# plan.yaml&#10;tasks:&#10;  - title: ..."
              value={newYaml}
              onChange={(e) => setNewYaml(e.target.value)}
              rows={14}
              className="font-mono text-xs"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={!newYaml.trim()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Plan grid */}
      {plans.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No plans yet. Create one to orchestrate tasks.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {plans.map((plan) => {
            const planTasks = tasks.filter((t) => t.group === plan.name);
            const done = planTasks.filter((t) => t.status === "done").length;
            const failed = planTasks.filter((t) => t.status === "failed").length;
            const running = planTasks.filter(
              (t) => t.status === "in_progress" || t.status === "assigned"
            ).length;
            const total = planTasks.length;
            const pct =
              total > 0 ? Math.round(((done + failed) / total) * 100) : 0;

            return (
              <Link
                key={plan.id}
                href={`/projects/${params.projectId}/plans/${plan.id}`}
              >
                <Card className="cursor-pointer transition-colors hover:border-primary/40 h-full">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm">{plan.name}</CardTitle>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px]",
                          PLAN_STATUS_COLORS[plan.status]
                        )}
                      >
                        {plan.status}
                      </Badge>
                    </div>
                    <CardDescription className="text-xs">
                      {formatTimeAgo(plan.createdAt)}
                      {total > 0 && ` · ${total} tasks`}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {total > 0 && (
                      <>
                        {/* Multi-color progress bar */}
                        <div className="flex h-1.5 rounded-full bg-muted overflow-hidden">
                          {done > 0 && (
                            <div
                              className="bg-status-done transition-all"
                              style={{ width: `${(done / total) * 100}%` }}
                            />
                          )}
                          {running > 0 && (
                            <div
                              className="bg-status-running transition-all"
                              style={{ width: `${(running / total) * 100}%` }}
                            />
                          )}
                          {failed > 0 && (
                            <div
                              className="bg-status-failed transition-all"
                              style={{ width: `${(failed / total) * 100}%` }}
                            />
                          )}
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground tabular-nums">
                          <span>
                            {done} done
                            {failed > 0 && (
                              <span className="text-status-failed ml-1">
                                · {failed} failed
                              </span>
                            )}
                            {running > 0 && (
                              <span className="text-status-running ml-1">
                                · {running} running
                              </span>
                            )}
                          </span>
                          <span className="font-medium">{pct}%</span>
                        </div>
                      </>
                    )}

                    <div className="flex items-center justify-end">
                      <ExternalLink className="h-3 w-3 text-muted-foreground" />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
