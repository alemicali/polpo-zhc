"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useOrchestra, useStats, useProcesses, OrchestraClient, type ProjectInfo } from "@orchestra/react";
import { ThemeToggle } from "./theme-toggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FolderOpen, ChevronsUpDown } from "lucide-react";
import { ORCHESTRA_URL, API_KEY } from "@/lib/orchestra";
import { cn } from "@/lib/utils";

export function ProjectHeader({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { connectionStatus } = useOrchestra();
  const stats = useStats();
  const { processes } = useProcesses();
  const activeCount = processes.filter((p) => p.alive).length;

  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  useEffect(() => {
    OrchestraClient.listProjects(ORCHESTRA_URL, API_KEY)
      .then(setProjects)
      .catch(() => {});
  }, []);

  const currentProject = projects.find((p) => p.id === projectId);

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur-sm">

      <div className="flex flex-1 items-center gap-4">
        {/* Project switcher */}
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent transition-colors text-left shrink-0">
            <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="min-w-0 max-w-[220px]">
              <span className="text-sm font-medium block truncate">
                {currentProject?.name || projectId}
              </span>
              {currentProject?.workDir && (
                <span className="text-[10px] text-muted-foreground block truncate font-mono">
                  {currentProject.workDir}
                </span>
              )}
            </div>
            <ChevronsUpDown className="h-3 w-3 text-muted-foreground shrink-0" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[240px]">
            {projects.map((p) => (
              <DropdownMenuItem
                key={p.id}
                onClick={() => router.push(`/projects/${p.id}`)}
                className={cn(p.id === projectId && "bg-accent")}
              >
                <FolderOpen className="mr-2 h-4 w-4 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{p.name}</div>
                  <div className="text-[10px] text-muted-foreground truncate font-mono">
                    {p.workDir}
                  </div>
                </div>
              </DropdownMenuItem>
            ))}
            {projects.length === 0 && (
              <DropdownMenuItem disabled>
                <span className="text-muted-foreground text-xs">No projects found</span>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="h-4 w-px bg-border" />

        {stats && (
          <div className="flex items-center gap-3 text-xs tabular-nums">
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-status-running animate-pulse" />
              <span className="font-medium">{stats.running}</span>
              <span className="text-muted-foreground">running</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-status-pending" />
              <span className="font-medium">{stats.pending}</span>
              <span className="text-muted-foreground">pending</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-status-done" />
              <span className="font-medium">{stats.done}</span>
              <span className="text-muted-foreground">done</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-status-failed" />
              <span className="font-medium">{stats.failed}</span>
              <span className="text-muted-foreground">failed</span>
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <kbd className="hidden sm:inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
          <span className="text-xs">⌘</span>K
        </kbd>
        {activeCount > 0 && (
          <span className="text-xs text-muted-foreground">
            {activeCount} agent{activeCount !== 1 ? "s" : ""} active
          </span>
        )}
        <div className="flex items-center gap-1.5 text-xs">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              connectionStatus === "connected"
                ? "bg-status-done"
                : connectionStatus === "reconnecting"
                  ? "bg-status-running animate-pulse"
                  : "bg-status-failed"
            )}
          />
          <span className="text-muted-foreground">{connectionStatus}</span>
        </div>
        <ThemeToggle />
      </div>
    </header>
  );
}
