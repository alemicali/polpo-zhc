"use client";

import { EventTimeline } from "@/components/logs/event-timeline";

export default function LogsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Logs</h1>
        <p className="text-sm text-muted-foreground">
          Event stream and session history
        </p>
      </div>

      <EventTimeline />
    </div>
  );
}
