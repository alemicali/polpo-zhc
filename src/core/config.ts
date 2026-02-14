import { readFile } from "node:fs/promises";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { OrchestraConfig, OrchestraSettings, PolpoConfig, ProviderConfig } from "./types.js";
import { sanitizeExpectations } from "./schemas.js";

const DEFAULT_SETTINGS: OrchestraSettings = {
  maxRetries: 3,
  workDir: ".",
  logLevel: "normal",
};

// --- .polpo/polpo.json (persistent project config) ---

export function loadPolpoConfig(polpoDir: string): PolpoConfig | undefined {
  const filePath = join(polpoDir, "polpo.json");
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as PolpoConfig;
  } catch { return undefined; }
}

export function savePolpoConfig(polpoDir: string, config: PolpoConfig): void {
  if (!existsSync(polpoDir)) mkdirSync(polpoDir, { recursive: true });
  writeFileSync(join(polpoDir, "polpo.json"), JSON.stringify(config, null, 2), "utf-8");
}

// --- Validation helpers ---

function validateAgents(agents: any[]): void {
  for (const agent of agents) {
    if (!agent.name || typeof agent.name !== "string") {
      throw new Error("Each agent must have a name");
    }
    if (!agent.adapter) agent.adapter = "native";
    if (typeof agent.adapter !== "string") {
      throw new Error(`Agent "${agent.name}": adapter must be a string`);
    }
    if (agent.adapter === "generic" && (!agent.command || typeof agent.command !== "string")) {
      throw new Error(`Agent "${agent.name}" uses generic adapter but has no command`);
    }
  }
}

function validateTasks(tasks: any[], defaultMaxRetries: number): void {
  for (const task of tasks) {
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
    task.maxRetries = task.maxRetries ?? defaultMaxRetries;
  }
}

function parseProviders(raw: Record<string, unknown>): Record<string, ProviderConfig> {
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, cfg] of Object.entries(raw)) {
    const pc: ProviderConfig = {};
    if (typeof cfg === "string") {
      pc.apiKey = cfg;
    } else if (cfg && typeof cfg === "object") {
      const c = cfg as Record<string, unknown>;
      if (typeof c.apiKey === "string") pc.apiKey = c.apiKey;
      if (typeof c.baseUrl === "string") pc.baseUrl = c.baseUrl;
    }
    if (pc.apiKey) {
      const envMatch = pc.apiKey.match(/^\$\{(\w+)\}$/);
      if (envMatch) {
        pc.apiKey = process.env[envMatch[1]] ?? "";
      }
    }
    providers[name] = pc;
  }
  return providers;
}

function parseSettings(raw: any): OrchestraSettings {
  const settings: OrchestraSettings = {
    maxRetries: raw?.maxRetries ?? DEFAULT_SETTINGS.maxRetries,
    workDir: raw?.workDir ?? DEFAULT_SETTINGS.workDir,
    logLevel: raw?.logLevel ?? DEFAULT_SETTINGS.logLevel,
  };
  if (raw?.taskTimeout != null) settings.taskTimeout = raw.taskTimeout;
  if (raw?.staleThreshold != null) settings.staleThreshold = raw.staleThreshold;
  if (raw?.orchestratorModel) settings.orchestratorModel = raw.orchestratorModel;
  if (raw?.enableVolatileTeams != null) settings.enableVolatileTeams = raw.enableVolatileTeams;
  if (raw?.volatileCleanup) settings.volatileCleanup = raw.volatileCleanup;
  if (raw?.maxFixAttempts != null) settings.maxFixAttempts = raw.maxFixAttempts;
  if (raw?.maxQuestionRounds != null) settings.maxQuestionRounds = raw.maxQuestionRounds;
  if (raw?.maxResolutionAttempts != null) settings.maxResolutionAttempts = raw.maxResolutionAttempts;
  if (raw?.autoCorrectExpectations != null) settings.autoCorrectExpectations = raw.autoCorrectExpectations;
  if (raw?.defaultRetryPolicy) settings.defaultRetryPolicy = raw.defaultRetryPolicy;

  if (!["quiet", "normal", "verbose"].includes(settings.logLevel)) {
    throw new Error(`Invalid logLevel "${settings.logLevel}": must be quiet, normal, or verbose`);
  }
  return settings;
}

// --- parseConfig: .polpo/polpo.json + polpo.yml ---

/**
 * Load config from workDir. Merges `.polpo/polpo.json` (persistent config) + `polpo.yml` (plan).
 * 
 * @param path - Either a directory path (looks for polpo.yml in that dir) or a file path (polpo.yml)
 */
export async function parseConfig(path: string): Promise<OrchestraConfig> {
  // Check if path is a file or directory
  const stats = await import("node:fs/promises").then(fs => fs.stat(path).catch(() => null));
  
  let workDir: string;
  let yamlPath: string;
  
  if (stats?.isFile()) {
    // Path is a file - use its directory as workDir
    workDir = resolve(path, "..");
    yamlPath = path;
  } else {
    // Path is a directory
    workDir = path;
    yamlPath = resolve(workDir, "polpo.yml");
  }

  const polpoDir = resolve(workDir, ".polpo");

  const polpoConfig = loadPolpoConfig(polpoDir);
  const hasYaml = existsSync(yamlPath);

  if (!hasYaml && !polpoConfig) {
    throw new Error(`No configuration found: missing both .polpo/polpo.json and polpo.yml in ${workDir}`);
  }

  if (hasYaml) {
    const raw = await readFile(yamlPath, "utf-8");
    const doc = parseYaml(raw);
    if (!doc || typeof doc !== "object") {
      throw new Error(`Invalid YAML: ${yamlPath}`);
    }

    const base: PolpoConfig = polpoConfig ?? {
      project: doc.project ?? "my-project",
      team: { name: "default", agents: [{ name: "dev-1", adapter: "native", role: "developer" }] },
      settings: DEFAULT_SETTINGS,
    };

    const tasks = doc.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new Error("polpo.yml must contain a non-empty tasks array");
    }

    const team = doc.team ?? base.team;
    if (team && Array.isArray(team.agents)) {
      validateAgents(team.agents);
    }

    const settings = parseSettings({ ...base.settings, ...(doc.settings ?? {}) });
    validateTasks(tasks, settings.maxRetries);

    const providers = {
      ...(base.providers ?? {}),
      ...(doc.providers ? parseProviders(doc.providers) : {}),
    };

    return {
      version: doc.version ?? "1",
      project: base.project,
      team,
      tasks,
      settings,
      providers: Object.keys(providers).length > 0 ? providers : undefined,
    };
  }

  // No YAML — interactive mode with just polpo.json
  return {
    version: "1",
    project: polpoConfig!.project,
    team: polpoConfig!.team,
    tasks: [],
    settings: polpoConfig!.settings ?? DEFAULT_SETTINGS,
    providers: polpoConfig!.providers ? parseProviders(polpoConfig!.providers as Record<string, unknown>) : undefined,
  };
}

// --- Template generators ---

export function generatePolpoConfigDefault(projectName: string): PolpoConfig {
  return {
    project: projectName,
    team: {
      name: "default",
      description: "Default Polpo team",
      agents: [
        { name: "dev-1", adapter: "native", role: "developer" },
      ],
    },
    settings: { ...DEFAULT_SETTINGS },
  };
}

export function generatePlanTemplate(): string {
  return stringifyYaml({
    version: "1",
    tasks: [
      {
        id: "task-1",
        title: "Example task",
        description: "Replace with your actual task description",
        assignTo: "dev-1",
        dependsOn: [],
        expectations: [{ type: "test", command: "npm test" }],
        metrics: [],
        maxRetries: 3,
      },
    ],
  }, { lineWidth: 0 });
}

/** Alias for generatePlanTemplate */
export const generateTemplate = generatePlanTemplate;
