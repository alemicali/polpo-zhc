/**
 * The agent edit form: its values from an agent, and the PATCH /agents/:name request for what
 * changed. Text fields left empty are sent as "" and the server removes them (e.g. model "" =
 * use the project default).
 */
import type { AgentConfig, UpdateAgentRequest } from "@polpo-ai/react";

/**
 * Built-in file and shell tools. When `allowedTools` is set, only the ones listed stay
 * available, so the form always lists them explicitly next to the tool categories.
 */
export const CORE_TOOLS = ["read", "write", "edit", "bash", "glob", "grep", "ls"] as const;

export const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export const VOICE_REPLIES = ["off", "voice", "always"] as const;

export interface AgentForm {
  role: string;
  team: string;
  reportsTo: string;
  model: string;
  /** "" = the project default. */
  reasoning: string;
  maxTurns: string;
  maxConcurrency: string;
  systemPrompt: string;
  coreTools: string[];
  /** Category prefixes ("browser_") enabled with a wildcard ("browser_*"). */
  categories: string[];
  /** Other allowedTools entries (specific tools, other wildcards), comma separated. */
  otherTools: string;
  skills: string[];
  displayName: string;
  title: string;
  company: string;
  email: string;
  timezone: string;
  tone: string;
  personality: string;
  bio: string;
  /** One per line; null when structured responsibilities make it not editable here. */
  responsibilities: string | null;
  /** One per line. */
  allowedPaths: string;
  /** Comma separated. */
  emailAllowedDomains: string;
  browserProfile: string;
  voiceReplies: string;
}

const list = (value: string, separator: RegExp): string[] =>
  value.split(separator).map((v) => v.trim()).filter(Boolean);

const sameList = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

export function formFromAgent(agent: AgentConfig & { voiceReplies?: string }, teamName: string | null, categoryPrefixes: string[]): AgentForm {
  const tools = agent.allowedTools;
  const lower = (tools ?? []).map((t) => t.toLowerCase());
  const categories = tools ? categoryPrefixes.filter((p) => lower.includes(`${p}*`)) : [];
  const known = new Set<string>([...CORE_TOOLS, ...categories.map((p) => `${p}*`)]);
  const identity = agent.identity ?? {};
  const responsibilities = identity.responsibilities ?? [];
  return {
    role: agent.role ?? "",
    team: teamName ?? "",
    reportsTo: agent.reportsTo ?? "",
    model: agent.model ?? "",
    reasoning: agent.reasoning ?? "",
    maxTurns: agent.maxTurns !== undefined ? String(agent.maxTurns) : "",
    maxConcurrency: agent.maxConcurrency !== undefined ? String(agent.maxConcurrency) : "",
    systemPrompt: agent.systemPrompt ?? "",
    coreTools: tools ? CORE_TOOLS.filter((t) => lower.includes(t)) : [...CORE_TOOLS],
    categories,
    otherTools: (tools ?? []).filter((t) => !known.has(t.toLowerCase())).join(", "),
    skills: agent.skills ?? [],
    displayName: identity.displayName ?? "",
    title: identity.title ?? "",
    company: identity.company ?? "",
    email: identity.email ?? "",
    timezone: identity.timezone ?? "",
    tone: identity.tone ?? "",
    personality: identity.personality ?? "",
    bio: identity.bio ?? "",
    responsibilities: responsibilities.every((r) => typeof r === "string") ? (responsibilities as string[]).join("\n") : null,
    allowedPaths: (agent.allowedPaths ?? []).join("\n"),
    emailAllowedDomains: (agent.emailAllowedDomains ?? []).join(", "),
    browserProfile: agent.browserProfile ?? "",
    voiceReplies: agent.voiceReplies ?? "",
  };
}

/** The tools the form describes, as an allowedTools list. */
export function allowedToolsOf(form: AgentForm): string[] {
  return [...form.coreTools, ...form.categories.map((p) => `${p}*`), ...list(form.otherTools, /,/)];
}

export type AgentUpdate = UpdateAgentRequest & { voiceReplies?: string };

/** The request for the fields that changed, or the problems that block saving. */
export function agentUpdateFrom(initial: AgentForm, form: AgentForm): { update: AgentUpdate; errors: string[] } {
  const update: AgentUpdate = {};
  const errors: string[] = [];

  const text = (key: "role" | "model" | "systemPrompt" | "reasoning" | "browserProfile" | "voiceReplies") => {
    if (form[key].trim() !== initial[key].trim()) (update as Record<string, string>)[key] = form[key].trim();
  };
  text("role");
  text("model");
  text("reasoning");
  text("browserProfile");
  if (form.systemPrompt !== initial.systemPrompt) update.systemPrompt = form.systemPrompt.trim();
  if (form.voiceReplies !== initial.voiceReplies && form.voiceReplies) update.voiceReplies = form.voiceReplies;

  if (form.team !== initial.team && form.team) update.team = form.team;
  if (form.reportsTo !== initial.reportsTo) update.reportsTo = form.reportsTo;

  for (const key of ["maxTurns", "maxConcurrency"] as const) {
    const value = form[key].trim();
    if (value === initial[key].trim()) continue;
    const label = key === "maxTurns" ? "Max turns" : "Max parallel tasks";
    if (value === "") { errors.push(`${label} cannot be removed here once set; enter a number.`); continue; }
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) { errors.push(`${label} must be a whole number of 1 or more.`); continue; }
    update[key] = n;
  }

  const tools = allowedToolsOf(form);
  if (!sameList(tools, allowedToolsOf(initial))) update.allowedTools = tools;

  if (!sameList(form.skills, initial.skills)) update.skills = form.skills;

  const identity: Record<string, unknown> = {};
  for (const key of ["displayName", "title", "company", "email", "timezone", "tone", "personality", "bio"] as const) {
    if (form[key].trim() !== initial[key].trim()) identity[key] = form[key].trim();
  }
  if (form.responsibilities !== null && form.responsibilities !== initial.responsibilities) {
    identity.responsibilities = list(form.responsibilities, /\n/);
  }
  if (Object.keys(identity).length > 0) update.identity = identity as AgentUpdate["identity"];

  const paths = list(form.allowedPaths, /\n/);
  if (!sameList(paths, list(initial.allowedPaths, /\n/))) update.allowedPaths = paths;
  const domains = list(form.emailAllowedDomains, /,/);
  if (!sameList(domains, list(initial.emailAllowedDomains, /,/))) update.emailAllowedDomains = domains;

  return { update, errors };
}
