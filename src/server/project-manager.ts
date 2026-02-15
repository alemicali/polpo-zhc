import { resolve, basename } from "node:path";
import { Orchestrator } from "../core/orchestrator.js";
import type { Team } from "../core/types.js";
import type { ProjectEntry, ProjectInfo } from "./types.js";
import { SSEBridge } from "./sse-bridge.js";

interface ManagedProject {
  id: string;
  workDir: string;
  orchestrator: Orchestrator;
  sseBridge: SSEBridge;
  started: boolean;
}

/**
 * Manages multiple Orchestrator instances, one per registered project.
 * Each project gets its own Orchestrator, TaskStore, RunStore, and SSEBridge.
 */
export class ProjectManager {
  private projects = new Map<string, ManagedProject>();

  /** Register and initialize a project. Does NOT start the supervisor loop. */
  async register(entry: ProjectEntry): Promise<Orchestrator> {
    if (this.projects.has(entry.id)) {
      return this.projects.get(entry.id)!.orchestrator;
    }

    const workDir = resolve(entry.workDir);
    const orchestrator = new Orchestrator(workDir);

    // Default team fallback (initInteractive will load from .polpo/polpo.json if available)
    const defaultTeam: Team = {
      name: "default",
      agents: [{ name: "dev-1", role: "developer" }],
    };

    await orchestrator.initInteractive(basename(workDir), defaultTeam);

    // Create SSE bridge and start listening to events
    const sseBridge = new SSEBridge(orchestrator);
    sseBridge.start();

    const managed: ManagedProject = {
      id: entry.id,
      workDir,
      orchestrator,
      sseBridge,
      started: false,
    };
    this.projects.set(entry.id, managed);

    return orchestrator;
  }

  /** Start the supervisor loop for a project. */
  async start(projectId: string): Promise<void> {
    const managed = this.projects.get(projectId);
    if (!managed) throw new Error(`Project not found: ${projectId}`);
    if (managed.started) return;
    managed.started = true;
    // Fire and forget — runs until stopped
    managed.orchestrator.run().catch((err) => {
      console.error(`[ProjectManager] Supervisor loop crashed for ${projectId}:`, err instanceof Error ? err.message : err);
      managed.started = false;
    });
  }

  /** Get orchestrator for a project. */
  get(projectId: string): Orchestrator | undefined {
    return this.projects.get(projectId)?.orchestrator;
  }

  /** Get SSE bridge for a project. */
  getSSEBridge(projectId: string): SSEBridge | undefined {
    return this.projects.get(projectId)?.sseBridge;
  }

  /** Check if a project's supervisor is running. */
  isRunning(projectId: string): boolean {
    return this.projects.get(projectId)?.started ?? false;
  }

  /** List all registered projects with summary info. */
  list(): ProjectInfo[] {
    return [...this.projects.values()].map(m => {
      const tasks = m.orchestrator.getStore().getAllTasks();
      return {
        id: m.id,
        name: m.orchestrator.getConfig()?.project || m.id,
        workDir: m.workDir,
        status: m.started ? "running" : "idle",
        taskCount: tasks.length,
        agentCount: m.orchestrator.getAgents().length,
      };
    });
  }

  /** Graceful shutdown all projects. */
  async shutdownAll(timeoutMs = 5000): Promise<void> {
    const promises = [...this.projects.values()]
      .filter(m => m.started)
      .map(async (m) => {
        m.sseBridge.dispose();
        await m.orchestrator.gracefulStop(timeoutMs);
      });
    await Promise.allSettled(promises);
  }
}
