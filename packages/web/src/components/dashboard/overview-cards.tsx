"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useStats, useTasks } from "@orchestra/react";
import { cn } from "@/lib/utils";

const CARDS = [
  {
    label: "Running",
    key: "running" as const,
    color: "text-status-running",
    dot: "bg-status-running animate-pulse",
  },
  {
    label: "Pending",
    key: "pending" as const,
    color: "text-foreground",
    dot: "bg-status-pending",
  },
  {
    label: "Done",
    key: "done" as const,
    color: "text-status-done",
    dot: "bg-status-done",
  },
  {
    label: "Failed",
    key: "failed" as const,
    color: "text-status-failed",
    dot: "bg-status-failed",
  },
];

export function OverviewCards() {
  const stats = useStats();
  const { tasks } = useTasks();
  const total = tasks.length || 1;
  const doneAndFailed = (stats?.done ?? 0) + (stats?.failed ?? 0);
  const completionPct = Math.round((doneAndFailed / total) * 100);

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {CARDS.map((card) => {
        const value = stats?.[card.key] ?? 0;
        return (
          <Card key={card.key}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {card.label}
              </CardTitle>
              <span className={cn("h-2 w-2 rounded-full", card.dot)} />
            </CardHeader>
            <CardContent>
              <div className={cn("text-3xl font-bold tabular-nums", card.color)}>
                {value}
              </div>
            </CardContent>
          </Card>
        );
      })}

      {stats && (
        <div className="col-span-2 lg:col-span-4">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>Completion</span>
            <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-status-done transition-all duration-500"
                style={{ width: `${completionPct}%` }}
              />
            </div>
            <span className="tabular-nums font-medium text-foreground">
              {completionPct}%
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
