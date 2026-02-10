"use client";

import { useState, useEffect } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useOrchestra, useStats, useTasks } from "@orchestra/react";
import { Radio } from "lucide-react";

export function SettingsForm() {
  const { client, connectionStatus } = useOrchestra();
  const stats = useStats();
  const { tasks } = useTasks();
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);

  // Fetch config
  useEffect(() => {
    client.getConfig().then((c) => setConfig(c as unknown as Record<string, unknown>)).catch(() => {});
  }, [client]);

  const settings = (config as any)?.settings ?? {};

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Connection Status */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Radio className="h-4 w-4" /> Connection
          </CardTitle>
          <CardDescription>Server connection and project info</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <span
              className={
                connectionStatus === "connected"
                  ? "h-2 w-2 rounded-full bg-status-done"
                  : connectionStatus === "reconnecting"
                    ? "h-2 w-2 rounded-full bg-status-running animate-pulse"
                    : "h-2 w-2 rounded-full bg-status-failed"
              }
            />
            <span className="capitalize font-medium">{connectionStatus}</span>
          </div>
          {config && (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <span className="text-muted-foreground">Project</span>
              <span className="font-medium">{(config as any)?.project || "—"}</span>
              <span className="text-muted-foreground">Team</span>
              <span className="font-medium">{(config as any)?.team?.name || "—"}</span>
            </div>
          )}
          {stats && (
            <div className="flex gap-3 text-xs pt-2 border-t">
              <Badge variant="outline">{tasks.length} tasks</Badge>
              <Badge variant="outline" className="text-status-running">{stats.running} running</Badge>
              <Badge variant="outline" className="text-status-done">{stats.done} done</Badge>
              <Badge variant="outline" className="text-status-failed">{stats.failed} failed</Badge>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Orchestrator Config */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Orchestrator Config</CardTitle>
          <CardDescription>
            Current orchestrator settings (read-only from server)
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <div>
              <span className="text-xs text-muted-foreground block">Orchestrator Model</span>
              <span className="font-mono text-xs">
                {settings.orchestratorModel || "default"}
              </span>
            </div>
            <div>
              <span className="text-xs text-muted-foreground block">Judge Model</span>
              <span className="font-mono text-xs">
                {settings.judgeModel || "default"}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">Task Preparation</span>
              <Switch checked={settings.taskPrep !== false} disabled />
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">Volatile Teams</span>
              <Switch checked={settings.volatileTeams !== false} disabled />
            </div>
            <div>
              <span className="text-xs text-muted-foreground block">Tick Interval</span>
              <span className="font-mono text-xs">
                {settings.tickInterval ?? 2000}ms
              </span>
            </div>
            <div>
              <span className="text-xs text-muted-foreground block">Health Check Timeout</span>
              <span className="font-mono text-xs">
                {settings.healthCheckTimeout ? `${Math.round(settings.healthCheckTimeout / 60000)}min` : "10min"}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
