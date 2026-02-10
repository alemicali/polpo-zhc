"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { usePlans, useTasks } from "@orchestra/react";
import { PLAN_STATUS_COLORS } from "@/lib/orchestra";
import { cn } from "@/lib/utils";

export function PlanProgress() {
  const { plans } = usePlans();
  const { tasks } = useTasks();

  const activePlans = plans.filter((p) => p.status === "active");

  if (activePlans.length === 0 && plans.length === 0) {
    return null;
  }

  const displayPlans = activePlans.length > 0 ? activePlans : plans.slice(0, 3);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Plans</CardTitle>
        <CardDescription>
          {activePlans.length > 0
            ? `${activePlans.length} active plan${activePlans.length !== 1 ? "s" : ""}`
            : `${plans.length} total`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {displayPlans.map((plan) => {
          const planTasks = tasks.filter((t) => t.group === plan.name);
          const total = planTasks.length || 1;
          const done = planTasks.filter((t) => t.status === "done").length;
          const failed = planTasks.filter((t) => t.status === "failed").length;
          const pct = Math.round(((done + failed) / total) * 100);

          return (
            <div key={plan.id} className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium truncate">{plan.name ?? plan.id}</span>
                <Badge
                  variant="outline"
                  className={cn("text-[10px] h-5", PLAN_STATUS_COLORS[plan.status])}
                >
                  {plan.status}
                </Badge>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-status-done transition-all duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {done}/{planTasks.length}
                </span>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
