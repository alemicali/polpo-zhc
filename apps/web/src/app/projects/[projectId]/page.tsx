"use client";

import { OverviewCards } from "@/components/dashboard/overview-cards";
import { ActiveAgents } from "@/components/dashboard/active-agents";
import { EventFeed } from "@/components/dashboard/event-feed";
import { PlanProgress } from "@/components/dashboard/plan-progress";

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Real-time mission control overview
        </p>
      </div>

      <OverviewCards />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <ActiveAgents />
          <PlanProgress />
        </div>
        <div>
          <EventFeed />
        </div>
      </div>
    </div>
  );
}
