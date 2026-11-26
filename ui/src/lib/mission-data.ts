// Parsed mission shape + parser, shared by the mission and playbook pages.

// ── Parsed mission shape ──

export interface MissionTaskDef {
  title: string;
  description?: string;
  assignTo?: string;
  dependsOn?: string[];
  group?: string;
  expectations?: {
    type: string;
    command?: string;
    criteria?: string;
    paths?: string[];
    threshold?: number;
    confidence?: string;
    dimensions?: { name: string; description: string; weight: number }[];
  }[];
  metrics?: { name: string; command: string; threshold: number }[];
  maxRetries?: number;
  maxDuration?: number;
  retryPolicy?: { escalateAfter?: number; fallbackAgent?: string; escalateModel?: string };
}

export interface MissionCheckpointDef {
  name: string;
  afterTasks: string[];
  blocksTasks: string[];
  message?: string;
  notifyChannels?: string[];
}

export interface MissionDelayDef {
  name: string;
  afterTasks: string[];
  blocksTasks: string[];
  duration: string;
  message?: string;
  notifyChannels?: string[];
}

/** A decision node: a typed decision on the after tasks' results picks the branch that runs. */
export interface MissionDecisionDef {
  name: string;
  afterTasks: string[];
  state?: string;
  question: { type: "predicate" | "choice" | "score" | "rank"; instructions: string; choices?: Array<{ value: string; description?: string }>; levels?: Array<string | { label: string }>; items?: unknown };
  /** Answer → the task titles it starts. */
  branches: Record<string, string[]>;
  threshold?: number;
  onUncertain?: "human" | { branch: string };
}

export interface ParsedMission {
  name?: string;
  tasks: MissionTaskDef[];
  checkpoints?: MissionCheckpointDef[];
  delays?: MissionDelayDef[];
  decisions?: MissionDecisionDef[];
}

/** Valid decision nodes of a document (strict: name, afterTasks[], question, branches). */
export function parseMissionDecisions(raw: unknown): MissionDecisionDef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const valid = raw.filter((d): d is MissionDecisionDef => {
    const x = d as Record<string, unknown> | null;
    return !!x && typeof x === "object" && typeof x.name === "string" && Array.isArray(x.afterTasks)
      && !!x.question && typeof x.question === "object" && !!x.branches && typeof x.branches === "object";
  });
  return valid.length > 0 ? valid : undefined;
}

export function parseMissionData(data: string): ParsedMission | null {
  try {
    const parsed = JSON.parse(data);
    // Filter valid checkpoints (strict: requires name, afterTasks[], blocksTasks[])
    let checkpoints: MissionCheckpointDef[] | undefined;
    if (Array.isArray(parsed.checkpoints)) {
      const valid = parsed.checkpoints.filter(
        (cp: unknown): cp is MissionCheckpointDef =>
          typeof cp === "object" && cp !== null &&
          typeof (cp as Record<string, unknown>).name === "string" &&
          Array.isArray((cp as Record<string, unknown>).afterTasks) &&
          Array.isArray((cp as Record<string, unknown>).blocksTasks),
      );
      if (valid.length > 0) checkpoints = valid;
    }
    // Filter valid delays (strict: requires name, afterTasks[], blocksTasks[], duration)
    let delays: MissionDelayDef[] | undefined;
    if (Array.isArray(parsed.delays)) {
      const valid = parsed.delays.filter(
        (dl: unknown): dl is MissionDelayDef =>
          typeof dl === "object" && dl !== null &&
          typeof (dl as Record<string, unknown>).name === "string" &&
          Array.isArray((dl as Record<string, unknown>).afterTasks) &&
          Array.isArray((dl as Record<string, unknown>).blocksTasks) &&
          typeof (dl as Record<string, unknown>).duration === "string",
      );
      if (valid.length > 0) delays = valid;
    }
    return {
      name: parsed.name,
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      checkpoints,
      delays,
      decisions: parseMissionDecisions(parsed.decisions),
    };
  } catch {
    return null;
  }
}
