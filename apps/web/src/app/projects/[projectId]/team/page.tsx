"use client";

import { AgentGrid } from "@/components/team/agent-grid";

export default function TeamPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Team</h1>
        <p className="text-sm text-muted-foreground">
          Agent configuration and live status
        </p>
      </div>

      <AgentGrid />
    </div>
  );
}
