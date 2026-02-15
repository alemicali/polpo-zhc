import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import type { PolpoFileConfig, PolpoSettings, PolpoConfig, ProviderConfig } from "./types.js";

const DEFAULT_SETTINGS: PolpoSettings = {
  maxRetries: 3,
  workDir: ".",
  logLevel: "normal",
};

// --- .polpo/polpo.json (persistent project config) ---

export function loadPolpoConfig(polpoDir: string): PolpoFileConfig | undefined {
  const filePath = join(polpoDir, "polpo.json");
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as PolpoFileConfig;
  } catch { return undefined; }
}

export function savePolpoConfig(polpoDir: string, config: PolpoFileConfig): void {
  if (!existsSync(polpoDir)) mkdirSync(polpoDir, { recursive: true });
  writeFileSync(join(polpoDir, "polpo.json"), JSON.stringify(config, null, 2), "utf-8");
}

// --- Validation helpers ---

export function validateAgents(agents: any[]): void {
  for (const agent of agents) {
    if (!agent.name || typeof agent.name !== "string") {
      throw new Error("Each agent must have a name");
    }
    if (agent.adapter !== undefined && typeof agent.adapter !== "string") {
      throw new Error(`Agent "${agent.name}": adapter must be a string`);
    }
    // Validate allowedPaths
    if (agent.allowedPaths !== undefined) {
      if (!Array.isArray(agent.allowedPaths)) {
        throw new Error(`Agent "${agent.name}": allowedPaths must be an array of strings`);
      }
      for (const p of agent.allowedPaths) {
        if (typeof p !== "string" || p.trim() === "") {
          throw new Error(`Agent "${agent.name}": each allowedPaths entry must be a non-empty string`);
        }
      }
    }
    // Validate MCP server configs
    if (agent.mcpServers) {
      if (typeof agent.mcpServers !== "object" || Array.isArray(agent.mcpServers)) {
        throw new Error(`Agent "${agent.name}": mcpServers must be an object`);
      }
      for (const [serverName, cfg] of Object.entries(agent.mcpServers)) {
        const config = cfg as Record<string, unknown>;
        const hasCommand = typeof config.command === "string";
        const hasUrl = typeof config.url === "string";
        if (!hasCommand && !hasUrl) {
          throw new Error(
            `Agent "${agent.name}": MCP server "${serverName}" must have either "command" (stdio) or "url" (http/sse)`,
          );
        }
        if (hasCommand && hasUrl) {
          throw new Error(
            `Agent "${agent.name}": MCP server "${serverName}" cannot have both "command" and "url"`,
          );
        }
      }
    }
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

function parseSettings(raw: any): PolpoSettings {
  const settings: PolpoSettings = {
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
  if (raw?.maxAssessmentRetries != null) settings.maxAssessmentRetries = raw.maxAssessmentRetries;
  if (raw?.maxConcurrency != null) settings.maxConcurrency = raw.maxConcurrency;

  // Extended settings: notifications, approval gates, escalation, SLA, scheduling, quality
  if (raw?.approvalGates) settings.approvalGates = raw.approvalGates;
  if (raw?.notifications) settings.notifications = raw.notifications;
  if (raw?.escalationPolicy) settings.escalationPolicy = raw.escalationPolicy;
  if (raw?.sla) settings.sla = raw.sla;
  if (raw?.enableScheduler != null) settings.enableScheduler = raw.enableScheduler;
  if (raw?.defaultQualityThreshold != null) settings.defaultQualityThreshold = raw.defaultQualityThreshold;

  if (!["quiet", "normal", "verbose"].includes(settings.logLevel)) {
    throw new Error(`Invalid logLevel "${settings.logLevel}": must be quiet, normal, or verbose`);
  }
  return settings;
}

// --- parseConfig: .polpo/polpo.json only ---

/**
 * Load config from workDir. Reads `.polpo/polpo.json` for project config.
 * Tasks are managed via plans and the task store — not in the config file.
 */
export async function parseConfig(workDir: string): Promise<PolpoConfig> {
  const polpoDir = resolve(workDir, ".polpo");
  const polpoConfig = loadPolpoConfig(polpoDir);

  if (!polpoConfig) {
    throw new Error(`No configuration found: missing .polpo/polpo.json in ${workDir}. Run 'polpo init' first.`);
  }

  if (polpoConfig.team?.agents) {
    validateAgents(polpoConfig.team.agents);
  }

  const settings = parseSettings(polpoConfig.settings ?? {});
  const providers = polpoConfig.providers
    ? parseProviders(polpoConfig.providers as Record<string, unknown>)
    : undefined;

  return {
    version: "1",
    project: polpoConfig.project,
    team: polpoConfig.team,
    tasks: [],
    settings,
    providers: providers && Object.keys(providers).length > 0 ? providers : undefined,
  };
}

// --- Default config generator ---

export function generatePolpoConfigDefault(projectName: string): PolpoFileConfig {
  return {
    project: projectName,
    team: {
      name: "default",
      description: "Default Polpo team",
      agents: [
        { name: "dev-1", role: "developer" },
      ],
    },
    settings: { ...DEFAULT_SETTINGS },
  };
}
