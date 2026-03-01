import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import type { PolpoFileConfig, PolpoFileConfigRaw, PolpoSettings, PolpoConfig, ProviderConfig, ModelConfig, Team } from "./types.js";

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
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as PolpoFileConfigRaw;
    return migrateToMultiTeam(raw);
  } catch { return undefined; }
}

/** Migrate old singular `team` config to new `teams` array. */
function migrateToMultiTeam(raw: PolpoFileConfigRaw): PolpoFileConfig {
  let teams: Team[];
  if (raw.teams && raw.teams.length > 0) {
    teams = raw.teams;
  } else if (raw.team) {
    // Legacy: singular team → wrap in array
    teams = [raw.team];
  } else {
    teams = [{ name: "default", agents: [] }];
  }

  return {
    project: raw.project,
    teams,
    settings: raw.settings as PolpoSettings ?? { maxRetries: 3, workDir: ".", logLevel: "normal" },
    providers: raw.providers,
  };
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
    // Validate browser profile name
    if (agent.browserProfile !== undefined) {
      if (typeof agent.browserProfile !== "string" || !/^[a-zA-Z0-9_-]+$/.test(agent.browserProfile)) {
        throw new Error(`Agent "${agent.name}": browserProfile must contain only letters, numbers, hyphens, underscores`);
      }
    }
    // Vault credentials are now stored in .polpo/vault.enc (encrypted) — no longer inline.
    // Silently strip any leftover vault field from old configs.
    if ((agent as any).vault) delete (agent as any).vault;

    // Validate identity
    if (agent.identity) {
      if (agent.identity.responsibilities && !Array.isArray(agent.identity.responsibilities)) {
        throw new Error(`Agent "${agent.name}": identity.responsibilities must be an array`);
      }
    }
    // Validate reportsTo — self-reference
    if (agent.reportsTo === agent.name) {
      throw new Error(`Agent "${agent.name}": cannot report to itself`);
    }
  }

  // Second pass: validate reportsTo references existing agents
  const agentNames = new Set(agents.map((a: any) => a.name as string));
  for (const agent of agents) {
    if (agent.reportsTo && !agentNames.has(agent.reportsTo)) {
      throw new Error(`Agent "${agent.name}": reportsTo "${agent.reportsTo}" does not match any agent`);
    }
  }

  // Detect circular reportsTo chains
  for (const agent of agents) {
    if (!agent.reportsTo) continue;
    const visited = new Set<string>();
    let current = agent.name;
    while (current) {
      if (visited.has(current)) {
        throw new Error(`Agent "${agent.name}": circular reportsTo chain detected (${[...visited, current].join(" → ")})`);
      }
      visited.add(current);
      const next = agents.find((a: any) => a.name === current);
      current = next?.reportsTo;
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
      if (typeof c.api === "string") pc.api = c.api as ProviderConfig["api"];
      if (Array.isArray(c.models)) pc.models = c.models;
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

/** Parse orchestratorModel which can be string or ModelConfig */
function parseOrchestratorModel(raw: unknown): string | ModelConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const result: ModelConfig = {};
    if (typeof obj.primary === "string") result.primary = obj.primary;
    if (Array.isArray(obj.fallbacks)) {
      result.fallbacks = obj.fallbacks.filter((f): f is string => typeof f === "string");
    }
    return result;
  }
  return undefined;
}

function parseSettings(raw: any): PolpoSettings {
  const settings: PolpoSettings = {
    maxRetries: raw?.maxRetries ?? DEFAULT_SETTINGS.maxRetries,
    workDir: raw?.workDir ?? DEFAULT_SETTINGS.workDir,
    logLevel: raw?.logLevel ?? DEFAULT_SETTINGS.logLevel,
  };
  if (raw?.taskTimeout != null) settings.taskTimeout = raw.taskTimeout;
  if (raw?.staleThreshold != null) settings.staleThreshold = raw.staleThreshold;
  if (raw?.orchestratorModel) settings.orchestratorModel = parseOrchestratorModel(raw.orchestratorModel);
  if (raw?.imageModel && typeof raw.imageModel === "string") settings.imageModel = raw.imageModel;
  if (raw?.modelAllowlist && typeof raw.modelAllowlist === "object") settings.modelAllowlist = raw.modelAllowlist;
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

  // Validate all agents across all teams
  for (const team of polpoConfig.teams) {
    if (team.agents?.length) {
      validateAgents(team.agents);
    }
  }

  // Check for duplicate agent names across teams
  const allNames = new Set<string>();
  for (const team of polpoConfig.teams) {
    for (const agent of team.agents) {
      if (allNames.has(agent.name)) {
        throw new Error(`Duplicate agent name "${agent.name}" across teams. Agent names must be globally unique.`);
      }
      allNames.add(agent.name);
    }
  }

  const settings = parseSettings(polpoConfig.settings ?? {});
  const providers = polpoConfig.providers
    ? parseProviders(polpoConfig.providers as Record<string, unknown>)
    : undefined;

  return {
    version: "1",
    project: polpoConfig.project,
    teams: polpoConfig.teams,
    tasks: [],
    settings,
    providers: providers && Object.keys(providers).length > 0 ? providers : undefined,
  };
}

// --- Default config generator ---

export function generatePolpoConfigDefault(
  projectName: string,
  options?: { model?: string; teamName?: string; agentName?: string; agentRole?: string },
): PolpoFileConfig {
  const agent: Record<string, unknown> = {
    name: options?.agentName ?? "dev-1",
    role: options?.agentRole ?? "developer",
  };
  if (options?.model) {
    agent.model = options.model;
  }
  const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  if (options?.model) {
    settings.orchestratorModel = options.model;
  }
  return {
    project: projectName,
    teams: [{
      name: options?.teamName ?? "default",
      description: `${options?.teamName ?? "Default"} Polpo team`,
      agents: [agent as any],
    }],
    settings: settings as any,
  };
}
