"use client";

import { PlanList } from "@/components/plans/plan-list";

export default function PlansPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Plans</h1>
        <p className="text-sm text-muted-foreground">
          Create, manage, and execute orchestration plans
        </p>
      </div>

      <PlanList />
    </div>
  );
}
