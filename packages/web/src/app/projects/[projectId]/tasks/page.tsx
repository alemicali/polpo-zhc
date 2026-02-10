"use client";

import { TaskTable } from "@/components/tasks/task-table";

export default function TasksPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Tasks</h1>
        <p className="text-sm text-muted-foreground">
          Manage and monitor all tasks
        </p>
      </div>

      <TaskTable />
    </div>
  );
}
