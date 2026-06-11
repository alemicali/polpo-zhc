import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import type { PolpoFileConfig, PolpoFileConfigRaw, PolpoSettings, PolpoConfig, ProviderConfig, ModelConfig, Team } from "./types.js";
import { getPolpoDir } from "./constants.js";

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
    return migrateConfig(raw);
  } catch { return undefined; }
}

/** Migrate old singular `team` config to new `teams` array. */
function migrateConfig(raw: PolpoFileConfigRaw): PolpoFileConfig {
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
    project: raw.project ?? "",
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

    validateAgentLoops(agent);
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

function validateAgentLoops(agent: any): void {
  const prefix = `Agent "${agent.name}"`;

  if (agent.runtime !== undefined && (typeof agent.runtime !== "string" || agent.runtime.trim() === "")) {
    throw new Error(`${prefix}: runtime must be a non-empty string`);
  }

  if (agent.loops !== undefined) {
    if (!agent.loops || typeof agent.loops !== "object" || Array.isArray(agent.loops)) {
      throw new Error(`${prefix}: loops must be an object keyed by loop name`);
    }

    for (const [loopName, loop] of Object.entries(agent.loops)) {
      if (!loopName.trim()) {
        throw new Error(`${prefix}: loop names must be non-empty`);
      }
      if (!loop || typeof loop !== "object" || Array.isArray(loop)) {
        throw new Error(`${prefix}: loop "${loopName}" must be an object`);
      }
      const cfg = loop as Record<string, unknown>;
      if (cfg.name !== undefined && (typeof cfg.name !== "string" || cfg.name.trim() === "")) {
        throw new Error(`${prefix}: loop "${loopName}" name must be a non-empty string`);
      }
      if (cfg.tools !== undefined) {
        if (!Array.isArray(cfg.tools) || cfg.tools.some((tool) => typeof tool !== "string" || tool.trim() === "")) {
          throw new Error(`${prefix}: loop "${loopName}" tools must be an array of non-empty strings`);
        }
      }
      const maxTurns = cfg.maxTurns;
      if (maxTurns !== undefined && (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns <= 0)) {
        throw new Error(`${prefix}: loop "${loopName}" maxTurns must be a positive integer`);
      }
      if (cfg.stopWhen !== undefined) {
        validateCondition(cfg.stopWhen, `${prefix}: loop "${loopName}" stopWhen`);
      }
    }
  }

  if (agent.pipeline !== undefined) {
    if (!agent.pipeline || typeof agent.pipeline !== "object" || Array.isArray(agent.pipeline)) {
      throw new Error(`${prefix}: pipeline must be an object`);
    }
    const pipeline = agent.pipeline as Record<string, unknown>;
    if (pipeline.mode !== undefined && pipeline.mode !== "sequential" && pipeline.mode !== "parallel") {
      throw new Error(`${prefix}: pipeline.mode must be "sequential" or "parallel"`);
    }
    if (pipeline.context !== undefined && pipeline.context !== "shared") {
      throw new Error(`${prefix}: pipeline.context must be "shared"`);
    }
    if (!Array.isArray(pipeline.steps) || pipeline.steps.length === 0) {
      throw new Error(`${prefix}: pipeline.steps must contain at least one step`);
    }

    const loopNames = new Set<string>(agent.loops && typeof agent.loops === "object" && !Array.isArray(agent.loops)
      ? Object.keys(agent.loops)
      : []);
    pipeline.steps.forEach((step, index) => validatePipelineStep(step, `${prefix}: pipeline.steps[${index}]`, loopNames));
  }
}

function validateCondition(condition: unknown, path: string): void {
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
    throw new Error(`${path} must be an object`);
  }
  const expression = (condition as Record<string, unknown>).expression;
  if (typeof expression !== "string" || expression.trim() === "") {
    throw new Error(`${path}.expression must be a non-empty string`);
  }
}

function validateOptionalWhen(step: Record<string, unknown>, path: string): void {
  if (step.when !== undefined && (typeof step.when !== "string" || step.when.trim() === "")) {
    throw new Error(`${path}.when must be a non-empty string`);
  }
}

function validatePipelineStep(step: unknown, path: string, loopNames: Set<string>): void {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    throw new Error(`${path} must be an object`);
  }
  const s = step as Record<string, unknown>;
  const kinds = ["loop", "parallel", "switch", "human"].filter((kind) => s[kind] !== undefined);
  if (kinds.length !== 1) {
    throw new Error(`${path} must define exactly one of loop, parallel, switch, or human`);
  }
  validateOptionalWhen(s, path);

  if (typeof s.loop === "string") {
    if (s.loop.trim() === "") {
      throw new Error(`${path}.loop must be a non-empty string`);
    }
    if (!loopNames.has(s.loop)) {
      throw new Error(`${path}.loop references unknown loop "${s.loop}"`);
    }
    return;
  }

  if (s.parallel !== undefined) {
    if (!Array.isArray(s.parallel) || s.parallel.length === 0) {
      throw new Error(`${path}.parallel must contain at least one step`);
    }
    if (s.join !== undefined && s.join !== "all" && s.join !== "any" && (!Number.isInteger(s.join) || (s.join as number) <= 0)) {
      throw new Error(`${path}.join must be "all", "any", or a positive integer`);
    }
    s.parallel.forEach((child, index) => validatePipelineStep(child, `${path}.parallel[${index}]`, loopNames));
    return;
  }

  if (s.switch !== undefined) {
    if (!s.switch || typeof s.switch !== "object" || Array.isArray(s.switch)) {
      throw new Error(`${path}.switch must be an object`);
    }
    const sw = s.switch as Record<string, unknown>;
    if (!Array.isArray(sw.cases) || sw.cases.length === 0) {
      throw new Error(`${path}.switch.cases must contain at least one case`);
    }
    sw.cases.forEach((rawCase, index) => {
      if (!rawCase || typeof rawCase !== "object" || Array.isArray(rawCase)) {
        throw new Error(`${path}.switch.cases[${index}] must be an object`);
      }
      const switchCase = rawCase as Record<string, unknown>;
      if (typeof switchCase.when !== "string" || switchCase.when.trim() === "") {
        throw new Error(`${path}.switch.cases[${index}].when must be a non-empty string`);
      }
      if (!Array.isArray(switchCase.steps) || switchCase.steps.length === 0) {
        throw new Error(`${path}.switch.cases[${index}].steps must contain at least one step`);
      }
      switchCase.steps.forEach((child, childIndex) =>
        validatePipelineStep(child, `${path}.switch.cases[${index}].steps[${childIndex}]`, loopNames),
      );
    });
    if (sw.default !== undefined) {
      if (!sw.default || typeof sw.default !== "object" || Array.isArray(sw.default)) {
        throw new Error(`${path}.switch.default must be an object`);
      }
      const defaultSteps = (sw.default as Record<string, unknown>).steps;
      if (!Array.isArray(defaultSteps) || defaultSteps.length === 0) {
        throw new Error(`${path}.switch.default.steps must contain at least one step`);
      }
      defaultSteps.forEach((child, index) => validatePipelineStep(child, `${path}.switch.default.steps[${index}]`, loopNames));
    }
    return;
  }

  if (typeof s.human === "string") {
    if (s.human.trim() === "") {
      throw new Error(`${path}.human must be a non-empty string`);
    }
    if (s.notify !== undefined && (!Array.isArray(s.notify) || s.notify.some((target) => typeof target !== "string" || target.trim() === ""))) {
      throw new Error(`${path}.notify must be an array of non-empty strings`);
    }
  }
}

export function parseProviders(raw: Record<string, unknown>): Record<string, ProviderConfig> {
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, cfg] of Object.entries(raw)) {
    if (!cfg || typeof cfg !== "object") continue;
    const c = cfg as Record<string, unknown>;
    const pc: ProviderConfig = {};
    if (typeof c.baseUrl === "string") pc.baseUrl = c.baseUrl;
    if (typeof c.api === "string") pc.api = c.api as ProviderConfig["api"];
    if (Array.isArray(c.models)) pc.models = c.models;
    // Only include if there's actual custom config (not just an empty object)
    if (pc.baseUrl || pc.api || pc.models) {
      providers[name] = pc;
    }
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
  if (raw?.reasoning) settings.reasoning = raw.reasoning;
  if (raw?.orchestratorSkills) settings.orchestratorSkills = raw.orchestratorSkills;
  if (raw?.emailAllowedDomains) settings.emailAllowedDomains = raw.emailAllowedDomains;

  // Storage backend
  if (raw?.storage && ["file", "sqlite", "postgres"].includes(raw.storage)) {
    settings.storage = raw.storage;
  }
  if (raw?.databaseUrl && typeof raw.databaseUrl === "string") {
    settings.databaseUrl = raw.databaseUrl;
  }
  // Allow DATABASE_URL env var as fallback
  if (!settings.databaseUrl && process.env.DATABASE_URL) {
    settings.databaseUrl = process.env.DATABASE_URL;
  }
  // Validate: postgres requires databaseUrl
  if (settings.storage === "postgres" && !settings.databaseUrl) {
    throw new Error('storage: "postgres" requires a databaseUrl in settings or DATABASE_URL env var');
  }

  if (!["quiet", "normal", "verbose"].includes(settings.logLevel)) {
    throw new Error(`Invalid logLevel "${settings.logLevel}": must be quiet, normal, or verbose`);
  }
  return settings;
}

/** Load .polpo/.env into process.env (does NOT overwrite existing vars). */
export function loadEnvFile(polpoDir: string): void {
  const envPath = join(polpoDir, ".env");
  if (!existsSync(envPath)) return;
  try {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = val;
    }
  } catch { /* ignore */ }
}

// --- parseConfig: .polpo/polpo.json only ---

/**
 * Load config from workDir. Reads `.polpo/polpo.json` for project config.
 * Tasks are managed via plans and the task store — not in the config file.
 */
export async function parseConfig(workDir: string): Promise<PolpoConfig> {
  const polpoDir = getPolpoDir(workDir);

  // Load .polpo/.env relative to workDir (handles --dir correctly).
  // The CLI top-level only loads from cwd; this ensures the right .env is used
  // when workDir differs from cwd.
  loadEnvFile(polpoDir);

  const polpoConfig = loadPolpoConfig(polpoDir);

  if (!polpoConfig) {
    throw new Error(`No configuration found: missing .polpo/polpo.json in ${workDir}. Run 'polpo init' first.`);
  }

  // Teams/agents are no longer read from polpo.json.
  // They come exclusively from FileAgentStore/FileTeamStore (agents.json / teams.json).
  // polpo.json only contains: project, settings, providers.

  const settings = parseSettings(polpoConfig.settings ?? {});
  const providers = polpoConfig.providers
    ? parseProviders(polpoConfig.providers as Record<string, unknown>)
    : undefined;

  return {
    version: "1",
    project: polpoConfig.project,
    teams: [], // populated by syncConfigCache() from TeamStore/AgentStore
    tasks: [],
    settings,
    providers: providers && Object.keys(providers).length > 0 ? providers : undefined,
  };
}

// --- Default config generator ---

export function generatePolpoConfigDefault(
  projectName: string,
  options?: { model?: string; teamName?: string; agentName?: string; agentRole?: string; providers?: Record<string, ProviderConfig> },
): PolpoFileConfig {
  const agent: Record<string, unknown> = {
    name: options?.agentName ?? "agent-1",
    role: options?.agentRole ?? "founder",
  };
  if (options?.model) {
    agent.model = options.model;
  }
  const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  if (options?.model) {
    settings.orchestratorModel = options.model;
  }
  const config: PolpoFileConfig = {
    project: projectName,
    teams: [{
      name: options?.teamName ?? "default",
      description: `${options?.teamName ?? "Default"} Polpo team`,
      agents: [agent as any],
    }],
    settings: settings as any,
  };
  if (options?.providers && Object.keys(options.providers).length > 0) {
    config.providers = options.providers;
  }
  return config;
}
