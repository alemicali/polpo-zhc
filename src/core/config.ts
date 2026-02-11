import { readFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import type { OrchestraConfig, OrchestraSettings } from "./types.js";
import { sanitizeExpectations } from "./schemas.js";

const DEFAULT_SETTINGS: OrchestraSettings = {
  maxRetries: 3,
  workDir: ".",
  logLevel: "normal",
};

export async function parseConfig(filePath: string): Promise<OrchestraConfig> {
  const raw = await readFile(filePath, "utf-8");
  const doc = parse(raw);

  if (!doc || typeof doc !== "object") {
    throw new Error(`Invalid config: ${filePath} is not a valid YAML object`);
  }

  if (!doc.version || typeof doc.version !== "string") {
    throw new Error("Config missing required field: version");
  }
  if (!doc.project || typeof doc.project !== "string") {
    throw new Error("Config missing required field: project");
  }
  if (!doc.team || typeof doc.team !== "object") {
    throw new Error("Config missing required field: team");
  }
  if (!doc.team.name || typeof doc.team.name !== "string") {
    throw new Error("Config missing required field: team.name");
  }
  if (!Array.isArray(doc.team.agents) || doc.team.agents.length === 0) {
    throw new Error("Config team.agents must be a non-empty array");
  }
  for (const agent of doc.team.agents) {
    if (!agent.name || typeof agent.name !== "string") {
      throw new Error("Each agent must have a name");
    }
    if (!agent.adapter || typeof agent.adapter !== "string") {
      throw new Error(`Agent "${agent.name}" missing required field: adapter (e.g. "claude-sdk", "generic")`);
    }
    if (agent.adapter === "generic" && (!agent.command || typeof agent.command !== "string")) {
      throw new Error(`Agent "${agent.name}" uses generic adapter but has no command`);
    }
  }
  if (!Array.isArray(doc.tasks) || doc.tasks.length === 0) {
    throw new Error("Config tasks must be a non-empty array");
  }
  for (const task of doc.tasks) {
    if (!task.id || typeof task.id !== "string") {
      throw new Error("Each task must have an id");
    }
    if (!task.title || typeof task.title !== "string") {
      throw new Error(`Task "${task.id}" missing required field: title`);
    }
    if (!task.description || typeof task.description !== "string") {
      throw new Error(`Task "${task.id}" missing required field: description`);
    }
    if (!task.assignTo || typeof task.assignTo !== "string") {
      throw new Error(`Task "${task.id}" missing required field: assignTo`);
    }
    task.dependsOn = task.dependsOn ?? [];
    const { valid, warnings } = sanitizeExpectations(task.expectations ?? []);
    if (warnings.length > 0) {
      console.warn(`[config] Task "${task.id}" has invalid expectations: ${warnings.join("; ")}`);
    }
    task.expectations = valid;
    task.metrics = task.metrics ?? [];
    task.maxRetries =
      task.maxRetries ?? doc.settings?.maxRetries ?? DEFAULT_SETTINGS.maxRetries;
  }

  const settings: OrchestraSettings = {
    maxRetries: doc.settings?.maxRetries ?? DEFAULT_SETTINGS.maxRetries,
    workDir: doc.settings?.workDir ?? DEFAULT_SETTINGS.workDir,
    logLevel: doc.settings?.logLevel ?? DEFAULT_SETTINGS.logLevel,
  };

  if (!["quiet", "normal", "verbose"].includes(settings.logLevel)) {
    throw new Error(
      `Invalid logLevel "${settings.logLevel}": must be quiet, normal, or verbose`
    );
  }

  return {
    version: doc.version,
    project: doc.project,
    team: doc.team,
    tasks: doc.tasks,
    settings,
  };
}

export function generateTemplate(): string {
  const template: OrchestraConfig = {
    version: "1",
    project: "my-project",
    team: {
      name: "default",
      description: "Default team",
      agents: [
        {
          name: "coder",
          adapter: "claude-sdk",
          role: "Implements features and fixes bugs",
        },
        {
          name: "reviewer",
          adapter: "claude-sdk",
          role: "Reviews code for quality and correctness",
        },
      ],
    },
    tasks: [
      {
        id: "task-1",
        title: "Implement feature",
        description: "Implement the main feature",
        assignTo: "coder",
        dependsOn: [],
        expectations: [
          {
            type: "test",
            command: "npm test",
          },
        ],
        metrics: [],
        maxRetries: 3,
      },
    ],
    settings: { ...DEFAULT_SETTINGS },
  };

  return stringify(template, { lineWidth: 0 });
}
