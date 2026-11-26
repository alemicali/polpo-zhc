/**
 * Progressive tool discovery: a run starts with its essential tools plus two meta tools,
 * `tools_search` and `tools_load`; the rest (connector tools, large optional groups) stays
 * out of the request until the model loads it.
 *
 * Loaded tools reach the model as a system message with `toolsAdded` (pi-ai transcripts):
 * pi-ai sends it natively where the provider supports mid-conversation tool changes
 * (Anthropic inline tool additions, OpenAI Responses `additional_tools` / tool search,
 * Kimi), so the cached prompt prefix survives; other models get the current tool list at the
 * top level of the request.
 *
 * Nothing here talks to a provider: the engine (tasks), the chat completions route and the
 * channel gateway use this to decide what to send and to answer the meta tools.
 */

import { idfTable, indexTool, prepareQuery, scoreTool, stripConnectorTag, synonymsOf, tokenize, type IndexedTool } from "./tool-search.js";

/** Per-agent (and instance default) switch. */
export type ProgressiveToolsMode = "auto" | "always" | "never";

/** `settings.tools` in polpo.json. */
export interface ToolsSettings {
  /** Runs with more tools than this get progressive discovery in "auto" mode. Default 30. */
  progressiveThreshold?: number;
  /** Default mode for Polpo and for agents without `progressiveTools`. Default "auto". */
  progressive?: ProgressiveToolsMode;
}

export const DEFAULT_PROGRESSIVE_THRESHOLD = 30;
export const TOOLS_SEARCH = "tools_search";
export const TOOLS_LOAD = "tools_load";
export const META_TOOL_NAMES: readonly string[] = [TOOLS_SEARCH, TOOLS_LOAD];

/** What a tool needs to be searched and declared to a model. */
export interface ToolLike {
  name: string;
  description?: string;
  parameters?: unknown;
  /** Display title (pi-agent-core `label`; connector tools: "<connector>: <title>"). Searched. */
  label?: string;
  title?: string;
}

/** A tool declaration as pi-ai expects it in `toolsAdded` (no executor). */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: unknown;
}

/** A system message announcing tools (pi-ai `SystemMessage`). */
export interface ToolAnnouncement {
  role: "system";
  content: string;
  toolsAdded: ToolDeclaration[];
  timestamp: number;
}

/** A group of tools that can be deferred: matched by name. */
export interface ToolGroupRule {
  id: string;
  label: string;
  prefixes?: string[];
  names?: string[];
}

/** Optional tool families of agents (src/tools): deferred when progressive discovery is on. */
export const AGENT_TOOL_GROUPS: ToolGroupRule[] = [
  { id: "browser", label: "Browser", prefixes: ["browser_"] },
  { id: "email", label: "Email", prefixes: ["email_"], names: ["list_email_accounts"] },
  { id: "media", label: "Images, video and audio", prefixes: ["image_", "video_", "audio_"] },
  { id: "documents", label: "Excel, PDF and Word files", prefixes: ["excel_", "pdf_", "docx_"] },
  { id: "whatsapp", label: "WhatsApp", prefixes: ["whatsapp_"] },
  { id: "whatsapp-business", label: "WhatsApp Business (Meta Cloud API): channel status, webhook events, templates, a contact's conversation and 24-hour window, opt-in / opt-out and erasure (GDPR), sends, approving queued templates", prefixes: ["wabiz_"] },
  { id: "phone", label: "Phone calls", prefixes: ["phone_"] },
  { id: "ink", label: "Ink Hub (skills and packages)", prefixes: ["ink_"] },
  { id: "data", label: "Data sources and views", prefixes: ["data_"] },
  { id: "brain", label: "Company brain", prefixes: ["brain_"] },
  { id: "storage", label: "Storage buckets", prefixes: ["storage_"] },
];

/** Optional areas of Polpo's own tools (src/llm/orchestrator-tools.ts): everything else stays on. */
export const POLPO_TOOL_GROUPS: ToolGroupRule[] = [
  {
    id: "mission-editing", label: "Mission editing, step by step (tasks, checkpoints, delays, quality gates, team, notifications of an existing mission), and waiting for a mission to finish",
    prefixes: ["add_mission_", "remove_mission_"],
    names: ["update_mission_task", "update_mission_checkpoint", "update_mission_delay", "update_mission_quality_gate",
      "update_mission_team_member", "update_mission_notifications", "reorder_mission_tasks", "mission_wait"],
  },
  {
    id: "apps", label: "Apps (registry, services, deployments, domains)",
    prefixes: ["configure_app_", "control_app"],
    names: ["list_app_previews", "list_apps", "get_app", "register_app", "update_app_registry", "tag_app", "remove_app_registry",
      "run_app_deployment", "capture_app_screenshot"],
  },
  { id: "data", label: "Data sources and views", prefixes: ["data_"] },
  { id: "brain", label: "Company brain", prefixes: ["brain_"] },
  { id: "storage", label: "Storage buckets", prefixes: ["storage_"] },
  {
    id: "skills", label: "Skills and playbooks",
    names: ["list_orchestrator_skills", "create_orchestrator_skill", "update_orchestrator_skill", "remove_orchestrator_skill",
      "install_orchestrator_skill", "list_agent_skills", "create_agent_skill", "install_agent_skill", "remove_agent_skill",
      "search_skills", "get_skill", "tag_skill", "skill_update",
      "skill_upload_prepare", "skill_upload_finalize", "skill_files", "skill_file_read", "skill_versions", "skill_version_diff", "skill_restore", "list_playbooks", "get_playbook", "create_playbook", "instantiate_playbook",
      "run_playbook", "delete_playbook"],
  },
  { id: "ink", label: "Ink Hub (skills and packages)", prefixes: ["ink_"] },
  { id: "artifact-uploads", label: "Large artifact contents: upload from a public URL, a file of the instance or base64 parts, then create an artifact or replace one's content (a file in the workspace: artifact_from_file)", names: ["artifact_upload_prepare", "artifact_upload_finalize"] },
  { id: "phone", label: "Phone calls", prefixes: ["phone_"] },
  { id: "whatsapp", label: "WhatsApp", prefixes: ["whatsapp_"] },
  {
    id: "browser", label: "Browser and browser profiles",
    prefixes: ["browser_"], names: ["egress_status"],
  },
  {
    id: "computers", label: "Computers (persistent machines: create or change with lifecycle, network, egress; start, stop, restart, reset, delete; hibernation) and sandboxes",
    prefixes: ["computer_"], names: ["computers_list", "sandbox_status"],
  },
  {
    id: "harnesses", label: "Agent harnesses: Claude Code and Codex settings (enable, auth: API key, Bedrock, Vertex, Vercel AI Gateway, custom model gateways such as Cloudflare, OpenRouter, LiteLLM, Portkey; credentials via the setup link harnesses_update returns, never in chat), connection test, and their sessions (list, stop, reset). For any question on harness models, auth or gateways: harnesses_get first, then describe the current setup (engine, auth, model per agent)",
    names: ["harnesses_get", "harnesses_update", "harness_sessions_list", "harness_session_control"],
  },
  {
    id: "connectors", label: "Connectors: catalog search, settings (name, on/off, tool policy allow/ask/off, access), test, sign out",
    names: ["connector_catalog", "connector_update", "connector_test", "connector_disconnect"],
  },
  {
    id: "hosted-servers", label: "Hosted MCP servers Polpo builds and serves (each becomes a connector): create from a template (Printful) or draft from an API / a description, test, publish, deploy, roll back, visibility, logs",
    prefixes: ["mcp_server"],
  },
  {
    id: "channels", label: "Channels end to end: Telegram, WhatsApp, Slack, email… setup (secrets via setup link), test, routes, who may write (DM policy, allowFrom), Telegram verify, invites, pairing, peers, allowlist, presence and linked identities, Slack connection status, notification history and counts, WhatsApp QR sign-in",
    prefixes: ["channel_"], names: ["channels_list"],
  },
  {
    id: "appearance", label: "Appearance and branding: product name, tagline, logos (light, dark, frame), theme, palette, design tokens, fonts; agent avatars",
    names: ["branding_get", "branding_update", "agent_avatar_set"],
  },
  {
    id: "settings", label: "Settings: general (orchestrator name, Polpo's model, egress proxies…), LLM providers and custom ones, sandbox, policies and approval gates",
    names: ["config_update", "providers_list", "provider_disconnect", "custom_providers_list", "custom_provider_save", "custom_provider_remove",
      "sandbox_get", "sandbox_update", "sandbox_provider_test", "policies_get", "policies_update", "approval_gate_save", "approval_gate_delete"],
  },
  {
    id: "access", label: "Members (invite, remove) and MCP access (who is connected to Polpo's MCP server, revoke)",
    names: ["members_list", "members_invite", "members_remove", "mcp_access_list", "mcp_grant_revoke"],
  },
  { id: "whatsapp-business", label: "WhatsApp Business (official number, Meta Cloud API): status, webhook events, templates, a contact's conversation and 24-hour window, opt-in / opt-out and erasure (GDPR), sends, approving queued templates", prefixes: ["wabiz_"] },
  { id: "sync", label: "Cloud sync (R2 backup of the instance): status, settings, test, run, disconnect", prefixes: ["sync_"] },
  { id: "rooms", label: "Rooms: group chats of people and agents (list, create, change, delete, read, post, wait for replies)", prefixes: ["room_"], names: ["rooms_list"] },
  { id: "chats", label: "Search everything (chat messages, tasks, missions, agents, artifacts, files, data, skills, memory… as ⌘K) and chat sessions: list, read, rename, star, delete", prefixes: ["chat_"], names: ["search"] },
  { id: "automation", label: "Automation extras: run a schedule now, change or delete a recurring check", names: ["schedule_run", "check_update", "check_delete"] },
  {
    id: "triggers", label: "Triggers: public endpoints (POST /hooks/{id}) receiving form submissions and webhooks, with actions on each accepted delivery (run a playbook, start a mission, create a task, an agent turn, a notification) — create, change, delete, deliveries and their action runs, re-run actions, test / validate / infer a schema / replay / preview actions, secrets, HMAC and IP allowlist",
    prefixes: ["trigger_"], names: ["triggers_list"],
  },
  {
    id: "decisions", label: "Decisions: typed judgments with probabilities from the decision model (yes/no, choice, score, rank), the decision log, mission decision nodes waiting for a person",
    prefixes: ["decision_"], names: ["decide", "decisions"],
  },
  {
    id: "learning", label: "Agent learning and drive; the org chart and the agents' communication lines (who may talk to whom)",
    names: ["get_agent_learning", "review_agent_learning", "revert_agent_learning", "get_agent_drive", "reflect_agent", "agent_lines"],
  },
  {
    id: "agent-versions", label: "Agent versions, tests and suites: list and read versions, diff two, rebase or discard the draft, publish it, deploy to production, roll back, deploy history; test an agent (engine, tools, connectors, vault, skills, computer, channels, smoke run) and fix what fails; agent suites (test and eval cases with tool and model mocks, datasets, assertions, scorers — exact, numeric, similarity, LLM judge…): list, read, save, delete, run against a version (with repetitions), read run reports, scores and traces, mark a baseline and see regressions, trends over versions, explain a run (AI review); record a case live or from a real chat or task into a cassette and replay it offline, edit cassettes; generate cases with AI (reviewed before saving); suites of hosted MCP servers (their saved tests, HTTP mocked) and missions (every agent mocked); benchmarks (suites × variants × repetitions with a cost estimate and a budget cap: leaderboard, Pareto front, case × variant matrix, one case side by side) and the Playground (compare variants on a message, save an exchange as a test case, promote a variant to the draft)",
    names: ["agent_versions", "agent_version_get", "agent_version_diff", "agent_draft", "agent_publish", "agent_deploy", "agent_deploy_gates", "agent_rollback", "agent_deploys", "agent_test",
      "agent_suite_list", "agent_suite_get", "agent_suite_save", "agent_suite_delete", "agent_suite_run", "agent_suite_run_get",
      "agent_suite_trend", "agent_suite_baseline", "agent_suite_review",
      "agent_suite_record", "agent_suite_replay", "agent_suite_cassette", "agent_suite_cassette_edit", "agent_suite_generate", "target_suites", "target_suite_save", "target_suite_run",
      "benchmark_save", "benchmark_delete", "benchmark_run", "benchmark_get", "benchmark_leaderboard", "benchmark_compare", "playground_send", "playground_promote"],
  },
];

const MCP_PREFIX = "mcp__";

/** The connector id of an `mcp__<connector>__<tool>` name. */
export function connectorIdOf(name: string): string | undefined {
  if (!name.startsWith(MCP_PREFIX)) return undefined;
  const rest = name.slice(MCP_PREFIX.length);
  const end = rest.indexOf("__");
  return end > 0 ? rest.slice(0, end) : undefined;
}

export interface ToolGroup {
  /** "mcp__<connector>" for a connector, else the rule id. */
  id: string;
  label: string;
  kind: "connector" | "group";
  tools: string[];
  /** A connector's app (catalog id, e.g. "gmail" for gmail-2), when known. */
  app?: string;
}

/** Whether progressive discovery is on for a run of `toolCount` tools. */
export function progressiveEnabled(
  toolCount: number,
  deferrableCount: number,
  mode: ProgressiveToolsMode | undefined,
  threshold: number | undefined,
): boolean {
  if (deferrableCount === 0 || mode === "never") return false;
  if (mode === "always") return true;
  const limit = typeof threshold === "number" && threshold >= 0 ? threshold : DEFAULT_PROGRESSIVE_THRESHOLD;
  return toolCount > limit;
}

export interface ProgressiveToolSetOptions<T extends ToolLike> {
  /** Every tool the run may use (already filtered by allowedTools / connector access). */
  tools: T[];
  mode?: ProgressiveToolsMode;
  threshold?: number;
  /** Optional groups deferred besides connectors. */
  groups?: ToolGroupRule[];
  /** Display names of connectors by id (else the id). */
  connectorNames?: Record<string, string>;
  /** Catalog app of connectors by id (`gmail-2` → `gmail`): a filter or load by app covers all its accounts. */
  connectorApps?: Record<string, string>;
  /** Tools loaded earlier in the conversation: on from the start. */
  loaded?: Iterable<string>;
  /** Never deferred, whatever their group. */
  alwaysOn?: Iterable<string>;
}

export interface SearchHit {
  name: string;
  /** The group's label (a connector's name and account). */
  group: string;
  /** "mcp__<connector>" for a connector, else the group id. */
  groupId: string;
  kind: "connector" | "group";
  description: string;
  loaded: boolean;
  score: number;
}

/** What `tools_search` takes. */
export interface ToolSearchRequest {
  query?: string;
  /** Results per page: default 8 for a search (max 25), 50 for a list (max 100). */
  limit?: number;
  /** Skip this many results (paging). */
  offset?: number;
  /** Only these connectors: ids (`gmail-2`), names / accounts, or an app (`gmail`: all its accounts). */
  connectors?: string[];
  /** Only these groups (ids such as `browser`, `documents`). */
  groups?: string[];
  /** Every loadable tool in scope, not ranked (compact, paged). */
  list?: boolean;
}

/** One connector or group in a search result, with how many of its tools matched. */
export interface ToolSearchGroupCount {
  id: string;
  /** The value for the `connectors` / `groups` filter (a connector's id without `mcp__`). */
  filter: string;
  label: string;
  kind: "connector" | "group";
  tools: number;
  loaded: number;
  matches: number;
}

/** The structured answer of `tools_search` (also the `details` of the meta tool, for UIs). */
export interface ToolSearchResult {
  /** "search": ranked; "list": every tool in scope; "summary": the connectors and groups only. */
  mode: "search" | "list" | "summary";
  query: string;
  /** The page shown. */
  hits: SearchHit[];
  /** Matches (search) or tools in scope (list) across every page. */
  total: number;
  offset: number;
  limit: number;
  more: boolean;
  nextOffset?: number;
  /** Connectors and groups in scope (summary, list) or with matches (search). */
  counts: ToolSearchGroupCount[];
  /** Group ids the filters resolved to (empty: no filter). */
  scope: string[];
  /** How filters were resolved, unknown values with the valid ones. */
  notes: string[];
}

/** What `tools_load` did. */
export interface ToolLoadResult {
  loaded: string[];
  already: string[];
  unknown: string[];
  /** Whole connectors / groups loaded, by the value asked for. */
  groups: Array<{ asked: string; id: string; label: string; tools: number }>;
  /** Close names for unknown ones. */
  suggestions: Record<string, string[]>;
  notes: string[];
}

function firstSentence(text: string | undefined, max = 200): string {
  const clean = stripConnectorTag(text).replace(/\s+/g, " ").trim();
  const end = clean.search(/[.!?](\s|$)/);
  const sentence = end > 0 ? clean.slice(0, end + 1) : clean;
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1)}…`;
}

function declarationOf(tool: ToolLike): ToolDeclaration {
  return { name: tool.name, description: tool.description ?? "", parameters: tool.parameters ?? { type: "object", properties: {} } };
}

const SEARCH_LIMIT = { default: 8, max: 25 };
const LIST_LIMIT = { default: 50, max: 100 };
/** Matches below this share of the best score are noise, not results. */
const RELATIVE_CUTOFF = 0.3;
/** Matches at least this share of the best score are strong: a tie at the page edge keeps them together. */
const STRONG_SHARE = 0.75;
/** Below this a match is a stray word in a description, not a result. */
const MIN_SCORE = 1;

const SEARCH_PARAMETERS = {
  type: "object",
  properties: {
    query: { type: "string", description: "What you want to do, an app or a tool name (e.g. \"create a Linear issue\", \"send email\", \"pdf\"). Empty with no filter: the connectors and groups you can load." },
    connectors: {
      type: "array", items: { type: "string" }, maxItems: 20,
      description: "Only these connectors (hard filter): an id such as \"gmail-2\", a connector's name or account, or an app such as \"gmail\" for all its accounts.",
    },
    groups: { type: "array", items: { type: "string" }, maxItems: 20, description: "Only these tool groups (hard filter), by id (e.g. \"browser\", \"documents\")." },
    list: { type: "boolean", description: "List every loadable tool in scope (name and what it does), not just the best matches: use it when unsure, so nothing is missed." },
    limit: { type: "integer", minimum: 1, maximum: 100, description: "Results per page (default 8 for a search, 50 for a list)." },
    offset: { type: "integer", minimum: 0, description: "Skip this many results: the next page of a search or list." },
  },
  additionalProperties: false,
};

const LOAD_PARAMETERS = {
  type: "object",
  properties: {
    names: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: { type: "string" },
      description: "Exact tool names from tools_search, or a connector (id such as \"gmail-2\", its name, \"mcp__gmail__*\") or group id to load all of its tools.",
    },
  },
  required: ["names"],
  additionalProperties: false,
};

/** A meta tool shaped like a pi-agent-core AgentTool (plain JSON Schema parameters). */
export interface ProgressiveMetaTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, params: unknown) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

function stringList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(raw.map((item) => String(item ?? "").trim()).filter(Boolean))];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : /(s|x|ch|sh)$/.test(word) ? "es" : "s"}`;
}

/**
 * The tool set of one run (a task run, a chat turn): what is on now, what can be loaded, and
 * the two meta tools. When progressive discovery is off it is a pass-through: `active()` is
 * every tool and no meta tool exists.
 */
export class ProgressiveToolSet<T extends ToolLike> {
  readonly enabled: boolean;
  private readonly byName = new Map<string, T>();
  private readonly groupOf = new Map<string, ToolGroup>();
  private readonly groupList: ToolGroup[] = [];
  private readonly loadedSet = new Set<string>();
  private readonly initial: string[];
  private pending: string[] = [];
  private searchIndex?: { tools: Map<string, IndexedTool>; idf: Map<string, number>; appNames: Set<string> };
  readonly metaTools: ProgressiveMetaTool[];

  constructor(private readonly opts: ProgressiveToolSetOptions<T>) {
    const alwaysOn = new Set([...(opts.alwaysOn ?? []), ...META_TOOL_NAMES]);
    for (const tool of opts.tools) if (!this.byName.has(tool.name)) this.byName.set(tool.name, tool);
    const groups = new Map<string, ToolGroup>();
    for (const name of this.byName.keys()) {
      if (alwaysOn.has(name)) continue;
      const group = this.classify(name);
      if (!group) continue;
      let entry = groups.get(group.id);
      if (!entry) {
        entry = { ...group, tools: [] };
        groups.set(group.id, entry);
      }
      entry.tools.push(name);
      this.groupOf.set(name, entry);
    }
    this.groupList = [...groups.values()];
    this.enabled = progressiveEnabled(this.byName.size, this.groupOf.size, opts.mode, opts.threshold);
    if (this.enabled) {
      for (const name of opts.loaded ?? []) {
        if (this.groupOf.has(name)) this.loadedSet.add(name);
        // a connector or group loaded whole, resolved as tools_load did
        else for (const group of this.byName.has(name) ? [] : this.resolveTarget(name)) for (const tool of group.tools) this.loadedSet.add(tool);
      }
    }
    this.initial = this.enabled
      ? [...this.byName.keys()].filter((name) => !this.groupOf.has(name) || this.loadedSet.has(name))
      : [...this.byName.keys()];
    this.metaTools = this.enabled ? this.buildMetaTools() : [];
  }

  private classify(name: string): Omit<ToolGroup, "tools"> | undefined {
    const connector = connectorIdOf(name);
    if (connector) {
      const app = this.opts.connectorApps?.[connector];
      return { id: `${MCP_PREFIX}${connector}`, label: this.opts.connectorNames?.[connector] ?? connector, kind: "connector", ...(app ? { app } : {}) };
    }
    for (const rule of this.opts.groups ?? []) {
      if (rule.names?.includes(name) || rule.prefixes?.some((prefix) => name.startsWith(prefix))) {
        return { id: rule.id, label: rule.label, kind: "group" };
      }
    }
    return undefined;
  }

  /**
   * The meta tools: executable (pi-agent-core AgentTool shape), or as plain declarations for
   * loops that answer them with `run()` (and may clone the tool list).
   */
  private meta(plain: boolean): Array<ProgressiveMetaTool | ToolDeclaration> {
    return plain ? this.metaTools.map(declarationOf) : this.metaTools;
  }

  /** Every tool of the run, meta tools included (for argument validation and execution). */
  all(opts: { plainMeta?: boolean } = {}): Array<T | ProgressiveMetaTool | ToolDeclaration> {
    return [...this.byName.values(), ...this.meta(!!opts.plainMeta)];
  }

  /** What the request starts with: essential tools, tools loaded earlier, and the meta tools. */
  initialTools(opts: { plainMeta?: boolean } = {}): Array<T | ProgressiveMetaTool | ToolDeclaration> {
    return [...this.initial.map((name) => this.byName.get(name)!), ...this.meta(!!opts.plainMeta)];
  }

  /** Every tool on now (initial + loaded during the run). */
  activeTools(): Array<T | ProgressiveMetaTool> {
    const names = new Set(this.initial);
    for (const name of this.loadedSet) names.add(name);
    return [...[...names].map((name) => this.byName.get(name)!), ...this.metaTools];
  }

  /** The deferred groups (connectors first), with every tool each holds. */
  groups(): ToolGroup[] {
    return [...this.groupList].sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) || a.id.localeCompare(b.id) : a.kind === "connector" ? -1 : 1));
  }

  /** Names of the deferred tools loaded so far (earlier turns included). */
  loadedNames(): string[] {
    return [...this.loadedSet];
  }

  isDeferred(name: string): boolean {
    return this.enabled && this.groupOf.has(name);
  }

  isActive(name: string): boolean {
    return !this.enabled || !this.groupOf.has(name) || this.loadedSet.has(name) || META_TOOL_NAMES.includes(name);
  }

  isMetaTool(name: string): boolean {
    return this.enabled && META_TOOL_NAMES.includes(name);
  }

  // ── Search ──────────────────────────────────────────────────────────

  /** The index over the deferred tools: built once, on the first search. */
  private index(): { tools: Map<string, IndexedTool>; idf: Map<string, number>; appNames: Set<string> } {
    if (this.searchIndex) return this.searchIndex;
    const tools = new Map<string, IndexedTool>();
    for (const [name, group] of this.groupOf) {
      const tool = this.byName.get(name)!;
      const connector = connectorIdOf(name);
      const shortName = connector ? name.slice(`${MCP_PREFIX}${connector}__`.length) : name;
      const rawTitle = typeof tool.label === "string" ? tool.label : typeof tool.title === "string" ? tool.title : "";
      const title = rawTitle.startsWith(`${group.label}: `) ? rawTitle.slice(group.label.length + 2) : rawTitle;
      tools.set(name, indexTool({
        name, shortName, title, description: tool.description, parameters: tool.parameters,
        groupText: [group.label, group.id, connector ?? "", connector?.replace(/-\d+$/, "") ?? "", group.app ?? ""].join(" "),
      }));
    }
    // words that name a connector: its id (and its app's), catalog id, the first word of its name
    const appNames = new Set<string>();
    for (const group of this.groupList) {
      if (group.kind !== "connector") continue;
      const id = this.filterValue(group).toLowerCase();
      for (const word of [id, id.replace(/-\d+$/, ""), group.app?.toLowerCase(), tokenize(group.label)[0]]) {
        if (word && /^[a-z0-9]+$/.test(word) && word.length >= 3) appNames.add(word);
      }
    }
    this.searchIndex = { tools, idf: idfTable([...tools.values()]), appNames };
    return this.searchIndex;
  }

  private filterValue(group: ToolGroup): string {
    return group.kind === "connector" ? group.id.slice(MCP_PREFIX.length) : group.id;
  }

  private describeGroup(group: ToolGroup): string {
    return `${group.label} [${group.kind} ${this.filterValue(group)}]`;
  }

  /**
   * Connectors (accounts) a value names. `mcp__<id>` (or `mcp__<id>__*`) is that one account; an
   * app ("gmail": catalog id, or the id without its `-2` suffix) is every account of it; else an
   * id or a name, exactly; else names starting with the value's words.
   */
  private resolveConnector(value: string): { groups: ToolGroup[]; exact: boolean } {
    const connectors = this.groupList.filter((group) => group.kind === "connector");
    const lower = value.trim().toLowerCase();
    const prefixed = lower.startsWith(MCP_PREFIX);
    const v = lower.replace(/^mcp__/, "").replace(/__\*?$|\*$/, "").replace(/__$/, "");
    if (!v) return { groups: [], exact: false };
    const exact = connectors.filter((group) => this.filterValue(group).toLowerCase() === v || (!prefixed && group.label.toLowerCase() === lower));
    if (prefixed) return { groups: exact, exact: true };
    const byApp = connectors.filter((group) => group.app?.toLowerCase() === v || this.filterValue(group).toLowerCase().replace(/-\d+$/, "") === v);
    if (byApp.length > 1 || (byApp.length === 1 && exact.length === 0)) return { groups: byApp, exact: false };
    if (exact.length) return { groups: exact, exact: true };
    const words = tokenize(v).join(" ");
    const byName = words.length >= 3
      ? connectors.filter((group) => {
        const label = tokenize(group.label).join(" ");
        return label === words || label.startsWith(`${words} `) || group.label.toLowerCase().includes(lower);
      })
      : [];
    return { groups: byName, exact: false };
  }

  /** Groups a value names: exact id or label, else groups whose label has every word of it. */
  private resolveGroup(value: string): { groups: ToolGroup[]; exact: boolean } {
    const groups = this.groupList.filter((group) => group.kind === "group");
    const v = value.trim().toLowerCase().replace(/^group:/, "");
    if (!v) return { groups: [], exact: false };
    const exact = groups.filter((group) => group.id.toLowerCase() === v || group.label.toLowerCase() === v);
    if (exact.length) return { groups: exact, exact: true };
    const words = tokenize(v);
    if (words.length === 0) return { groups: [], exact: false };
    const partial = groups.filter((group) => {
      const label = new Set([...tokenize(group.label), ...tokenize(group.id)]);
      return words.every((word) => label.has(word) || [...synonymsOf(word)].some((syn) => label.has(syn)));
    });
    return { groups: partial, exact: false };
  }

  /** How a value resolved: every account of an app says how to pick one. */
  private resolutionNote(field: string, value: string, groups: ToolGroup[]): string {
    const accounts = groups.filter((group) => group.kind === "connector");
    const one = accounts.length > 1 ? ` (every account of the app; for one account use its id, e.g. "${MCP_PREFIX}${this.filterValue(accounts[0])}")` : "";
    return `${field}: "${value}" → ${groups.map((group) => this.describeGroup(group)).join(", ")}${one}`;
  }

  private validValues(): string {
    const connectors = this.groups().filter((group) => group.kind === "connector").map((group) => `${this.filterValue(group)} (${group.label})`);
    const groups = this.groups().filter((group) => group.kind === "group").map((group) => group.id);
    return [connectors.length ? `connectors: ${connectors.join(", ")}` : "", groups.length ? `groups: ${groups.join(", ")}` : ""].filter(Boolean).join("; ");
  }

  /** The groups `connectors` / `groups` filters select (union), with notes on how they resolved. */
  private resolveFilters(connectors: string[], groups: string[]): { scope?: Set<string>; notes: string[]; unknown: number } {
    if (connectors.length === 0 && groups.length === 0) return { notes: [], unknown: 0 };
    const scope = new Set<string>();
    const notes: string[] = [];
    const unknown: string[] = [];
    const take = (value: string, kind: "connector" | "group") => {
      const primary = kind === "connector" ? this.resolveConnector(value) : this.resolveGroup(value);
      const other = primary.groups.length ? undefined : kind === "connector" ? this.resolveGroup(value) : this.resolveConnector(value);
      const found = primary.groups.length ? primary : other!;
      if (found.groups.length === 0) { unknown.push(`${kind} "${value}"`); return; }
      for (const group of found.groups) scope.add(group.id);
      if (!found.exact || other) notes.push(this.resolutionNote(kind === "connector" ? "connectors" : "groups", value, found.groups));
    };
    for (const value of connectors) take(value, "connector");
    for (const value of groups) take(value, "group");
    if (unknown.length) notes.push(`Unknown ${unknown.join(", ")}. You can filter by ${this.validValues() || "nothing: no tool to load"}.`);
    return { scope, notes, unknown: unknown.length };
  }

  private hitOf(name: string, score: number): SearchHit {
    const group = this.groupOf.get(name)!;
    return {
      name, group: group.label, groupId: group.id, kind: group.kind,
      description: firstSentence(this.byName.get(name)!.description), loaded: this.loadedSet.has(name), score,
    };
  }

  private countsOf(names: Iterable<string>, groups: Iterable<ToolGroup>): ToolSearchGroupCount[] {
    const matches = new Map<string, number>();
    for (const name of names) {
      const id = this.groupOf.get(name)!.id;
      matches.set(id, (matches.get(id) ?? 0) + 1);
    }
    return [...groups].map((group) => ({
      id: group.id, filter: this.filterValue(group), label: group.label, kind: group.kind, tools: group.tools.length,
      loaded: group.tools.filter((name) => this.loadedSet.has(name)).length, matches: matches.get(group.id) ?? 0,
    }));
  }

  /**
   * `tools_search`: ranked matches (search), every tool in scope (list), or the connectors and
   * groups (summary: no query, no filter). Filters are hard; unknown filter values come back as
   * notes listing the valid ones.
   */
  find(request: ToolSearchRequest): ToolSearchResult {
    const query = (request.query ?? "").trim();
    const connectors = stringList(request.connectors);
    const groups = stringList(request.groups);
    const filtered = connectors.length > 0 || groups.length > 0;
    const listing = request.list === true || ((query === "" || query === "*") && filtered);
    const mode: ToolSearchResult["mode"] = listing ? "list" : query === "" || query === "*" ? "summary" : "search";
    const limits = mode === "search" ? SEARCH_LIMIT : LIST_LIMIT;
    const limit = clampInt(request.limit, 1, limits.max, limits.default);
    const offset = clampInt(request.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const { scope, notes, unknown } = this.resolveFilters(connectors, groups);
    const empty = (extra: Partial<ToolSearchResult> = {}): ToolSearchResult => ({
      mode, query, hits: [], total: 0, offset, limit, more: false, counts: [], scope: [...(scope ?? [])], notes, ...extra,
    });
    if (scope && scope.size === 0 && unknown > 0) return empty();
    const inScope = (name: string) => !scope || scope.has(this.groupOf.get(name)!.id);
    const scopeGroups = this.groups().filter((group) => !scope || scope.has(group.id));

    if (mode === "summary") {
      return empty({ counts: this.countsOf([], scopeGroups), total: scopeGroups.reduce((sum, group) => sum + group.tools.length, 0) });
    }

    if (mode === "list") {
      const names = scopeGroups.flatMap((group) => [...group.tools].sort((a, b) => a.localeCompare(b)));
      const page = names.slice(offset, offset + limit);
      const next = offset + page.length;
      return {
        ...empty(), hits: page.map((name) => this.hitOf(name, 0)), total: names.length,
        more: next < names.length, ...(next < names.length ? { nextOffset: next } : {}), counts: this.countsOf(names, scopeGroups),
      };
    }

    const { tools, idf, appNames } = this.index();
    const prepared = prepareQuery(query, appNames);
    const scored: Array<{ name: string; score: number }> = [];
    for (const [name, indexed] of tools) {
      if (!inScope(name)) continue;
      const score = scoreTool(indexed, prepared, idf);
      if (score > 0) scored.push({ name, score });
    }
    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const top = scored[0]?.score ?? 0;
    const relevant = scored.filter((hit) => hit.score >= Math.max(MIN_SCORE, top * RELATIVE_CUTOFF));
    let end = Math.min(relevant.length, offset + limit);
    // a tie of strong matches across the page edge: when it ends a few results later, show it whole
    const edge = relevant[end - 1];
    if (edge && edge.score >= top * STRONG_SHARE) {
      const cap = Math.min(end + Math.max(2, Math.ceil(limit / 2)), offset + SEARCH_LIMIT.max);
      let tieEnd = end;
      while (tieEnd < relevant.length && relevant[tieEnd].score === edge.score) tieEnd += 1;
      if (tieEnd <= cap) end = tieEnd;
    }
    const page = relevant.slice(offset, end);
    const more = end < relevant.length;
    return {
      ...empty(), hits: page.map((hit) => this.hitOf(hit.name, hit.score)), total: relevant.length, more,
      ...(more ? { nextOffset: end } : {}),
      counts: this.countsOf(relevant.map((hit) => hit.name), scopeGroups).filter((count) => count.matches > 0),
    };
  }

  /** Ranked text search over the deferred tools (names, titles, descriptions, parameters, connectors and groups). */
  search(query: string, limit = SEARCH_LIMIT.default, filters: Pick<ToolSearchRequest, "connectors" | "groups" | "offset"> = {}): SearchHit[] {
    if (!query.trim()) return [];
    return this.find({ ...filters, query, limit }).hits;
  }

  /** The text the model gets for a search result: grouped by connector / group, exact names to load. */
  formatSearch(result: ToolSearchResult): string {
    const lines: string[] = [];
    for (const note of result.notes) lines.push(`Note: ${note}`);
    if (result.scope.length === 0 && result.notes.some((note) => note.startsWith("Unknown")) && result.hits.length === 0 && result.counts.length === 0) {
      lines.push("Nothing searched: fix the filter (or drop it).");
      return lines.join("\n");
    }
    const quoted = JSON.stringify(result.query);
    if (result.mode === "summary") {
      const total = result.counts.reduce((sum, count) => sum + count.tools, 0);
      lines.push(`Tools you can load (${total}), by connector and group:`);
      for (const count of result.counts) {
        lines.push(`- ${count.label} [${count.kind} ${count.filter}]: ${plural(count.tools, "tool")}${count.loaded ? `, ${count.loaded} loaded` : ""}`);
      }
      lines.push("Search with tools_search { query, connectors: [...] }; see all of one with tools_search { list: true, connectors: [...] } (or groups: [...]); load a whole one with tools_load { names: [id] }.");
      return lines.join("\n");
    }
    if (result.hits.length === 0) {
      if (result.mode === "list") lines.push(result.total > 0 ? `No more tools after ${result.offset} (${result.total} in all).` : "No tool to load in this scope.");
      else {
        lines.push(`No tool to load matches ${quoted}${result.scope.length ? " in this scope" : ""}. Try other words, a list (tools_search { list: true${result.scope.length ? ", connectors / groups as before" : ""} }), or load a whole group with tools_load.`);
        lines.push(`Connectors and groups: ${this.groups().map((group) => `${group.label} (${this.filterValue(group)}, ${group.tools.length})`).join("; ")}.`);
      }
      return lines.join("\n");
    }
    const from = result.offset + 1;
    const to = result.offset + result.hits.length;
    const range = result.more || result.offset > 0
      ? ` (showing ${from}–${to}${result.more ? `; next page: offset ${result.nextOffset}` : ""})`
      : "";
    lines.push(result.mode === "list"
      ? `${plural(result.total, "tool")} to load${range}; load with tools_load:`
      : `${plural(result.total, "match")} for ${quoted}${range}; load with tools_load:`);
    // group the page by connector / group, in rank order
    const order: string[] = [];
    const byGroup = new Map<string, SearchHit[]>();
    for (const hit of result.hits) {
      if (!byGroup.has(hit.groupId)) { byGroup.set(hit.groupId, []); order.push(hit.groupId); }
      byGroup.get(hit.groupId)!.push(hit);
    }
    const countOf = new Map(result.counts.map((count) => [count.id, count]));
    const max = result.mode === "list" ? 110 : 160;
    for (const id of order) {
      const hits = byGroup.get(id)!;
      const count = countOf.get(id);
      const group = this.groupList.find((entry) => entry.id === id)!;
      const size = result.mode === "list" ? plural(group.tools.length, "tool") : plural(count?.matches ?? hits.length, "match");
      lines.push(`${this.describeGroup(group)} — ${size}:`);
      for (const hit of hits) {
        const description = hit.description.length > max ? `${hit.description.slice(0, max - 1)}…` : hit.description;
        lines.push(`- ${hit.name}${hit.loaded ? " (loaded)" : ""}${description ? ` — ${description}` : ""}`);
      }
    }
    if (result.mode === "search") {
      const elsewhere = result.counts.filter((count) => !byGroup.has(count.id));
      if (elsewhere.length) {
        lines.push(`Also matching on later pages: ${elsewhere.map((count) => `${count.label} [${count.filter}] ${count.matches}`).join(", ")} (filter with connectors / groups).`);
      }
    }
    return lines.join("\n");
  }

  // ── Load ────────────────────────────────────────────────────────────

  /**
   * Load tools by name, or every tool of a connector / group (its id, `mcp__<id>`, a connector's
   * name, or an app for all its accounts). Newly loaded tools are announced by
   * `takeAnnouncement()` / `takeNewlyLoaded()`. Only tools of the run can be loaded.
   */
  load(names: string[]): { loaded: string[]; already: string[]; unknown: string[] } {
    const { loaded, already, unknown } = this.loadDetailed(names);
    return { loaded, already, unknown };
  }

  loadDetailed(names: string[]): ToolLoadResult {
    const result: ToolLoadResult = { loaded: [], already: [], unknown: [], groups: [], suggestions: {}, notes: [] };
    const already = new Set<string>();
    const add = (name: string) => {
      if (this.loadedSet.has(name)) { already.add(name); return; }
      this.loadedSet.add(name);
      this.pending.push(name);
      result.loaded.push(name);
    };
    for (const raw of names) {
      const name = String(raw ?? "").trim();
      if (!name) continue;
      if (this.groupOf.has(name)) { add(name); continue; }
      if (this.byName.has(name)) { already.add(name); continue; }
      const groups = this.resolveTarget(name);
      if (groups.length) {
        for (const group of groups) {
          for (const tool of group.tools) add(tool);
          result.groups.push({ asked: name, id: group.id, label: group.label, tools: group.tools.length });
        }
        if (groups.length > 1) result.notes.push(this.resolutionNote("names", name, groups));
        continue;
      }
      result.unknown.push(name);
      // close names, in the same connector when the name says which
      const connector = connectorIdOf(name);
      const inConnector = connector && this.groupList.some((group) => group.id === `${MCP_PREFIX}${connector}`) ? [connector] : undefined;
      const close = this.search(connector ? name.slice(`${MCP_PREFIX}${connector}__`.length) : name, 3, { connectors: inConnector }).map((hit) => hit.name);
      if (close.length) result.suggestions[name] = close;
    }
    result.already = [...already];
    return result;
  }

  /** The connectors or groups a load value names (connectors first). */
  private resolveTarget(value: string): ToolGroup[] {
    const connector = this.resolveConnector(value);
    if (connector.groups.length) return connector.groups;
    return this.resolveGroup(value).groups;
  }

  /** Tools loaded since the last call (each returned once). */
  takeNewlyLoaded(): T[] {
    const names = this.pending;
    this.pending = [];
    return names.map((name) => this.byName.get(name)!).filter(Boolean);
  }

  /** The system message that declares the tools loaded since the last call, if any. */
  takeAnnouncement(): ToolAnnouncement | undefined {
    const tools = this.takeNewlyLoaded();
    if (tools.length === 0) return undefined;
    return { role: "system", content: "", toolsAdded: tools.map(declarationOf), timestamp: Date.now() };
  }

  private formatLoad(result: ToolLoadResult): string {
    const parts: string[] = [];
    if (result.loaded.length) {
      const whole = result.groups.length ? ` (all of ${result.groups.map((group) => `${group.label} [${group.id.replace(MCP_PREFIX, "")}]`).join(", ")})` : "";
      const shown = result.loaded.slice(0, 40).join(", ");
      const rest = result.loaded.length > 40 ? ` …and ${result.loaded.length - 40} more` : "";
      parts.push(`Loaded ${plural(result.loaded.length, "tool")}${whole}: ${shown}${rest}. You can call ${result.loaded.length === 1 ? "it" : "them"} from your next step on.`);
    }
    if (result.already.length) parts.push(`Already available: ${result.already.join(", ")}.`);
    if (result.unknown.length) {
      const hints = result.unknown.map((name) => result.suggestions[name]?.length ? `${name} (did you mean ${result.suggestions[name].join(", ")}?)` : name);
      parts.push(`Not found: ${hints.join(", ")} (use tools_search for the exact names).`);
    }
    for (const note of result.notes) parts.push(`Note: ${note}.`);
    const text = parts.join(" ");
    return result.loaded.length === 0 && result.already.length === 0 ? `Error: ${text}` : text;
  }

  /** Answer a meta tool call: the text the model gets back, and structured details for UIs. */
  runDetailed(name: string, args: Record<string, unknown> | undefined): { text: string; details?: ToolSearchResult | ToolLoadResult } {
    if (name === TOOLS_SEARCH) {
      const details = this.find({
        query: typeof args?.query === "string" ? args.query : "",
        limit: args?.limit as number | undefined,
        offset: args?.offset as number | undefined,
        connectors: stringList(args?.connectors),
        groups: stringList(args?.groups),
        list: args?.list === true || args?.list === "true",
      });
      return { text: this.formatSearch(details), details };
    }
    if (name === TOOLS_LOAD) {
      const names = stringList(args?.names);
      if (names.length === 0) return { text: "Error: give the names of the tools to load (names: [...])." };
      const details = this.loadDetailed(names);
      return { text: this.formatLoad(details), details };
    }
    return { text: `Error: Unknown tool "${name}"` };
  }

  /** Answer a meta tool call (the text the model gets back). */
  run(name: string, args: Record<string, unknown> | undefined): string {
    return this.runDetailed(name, args).text;
  }

  /** The prompt section that lists the deferred groups (stable for the conversation). */
  promptSection(): string {
    if (!this.enabled) return "";
    const lines = this.groups().map((group) => {
      const loaded = group.tools.filter((name) => this.loadedSet.has(name)).length;
      const what = group.kind === "connector" ? `Connector ${group.label} (\`${group.id}__*\`)` : `${group.label} (group \`${group.id}\`)`;
      return `- ${what}: ${group.tools.length} tool${group.tools.length === 1 ? "" : "s"}${loaded && loaded === group.tools.length ? ", loaded" : ""}`;
    });
    return [
      "## More tools on demand",
      "",
      "To keep your context small, these tools are available but not loaded. When you need one, call `tools_search` (what you want to do, an app or a name), then `tools_load` with the exact names you need (or a connector / group id to load all of it); loaded tools work from your next step on and stay for the rest of this conversation. Load only what you need.",
      "- When the request names an app or an account, filter: `tools_search { query: \"send email\", connectors: [\"gmail-2\"] }` (an app such as \"gmail\" covers all its accounts; `groups: [\"documents\"]` for a group).",
      "- Results come best first with the total; page with `offset`. When unsure, list everything in scope with `tools_search { list: true, connectors: [...] }` so you miss nothing.",
      ...lines,
    ].join("\n");
  }

  private buildMetaTools(): ProgressiveMetaTool[] {
    const reply = (value: { text: string; details?: unknown }) => ({ content: [{ type: "text" as const, text: value.text }], details: value.details });
    return [
      {
        name: TOOLS_SEARCH,
        label: "Search tools",
        description: "Search the tools you can load but do not have yet (connectors and the optional groups listed in your instructions): "
          + "by what you want to do, an app or a tool name; filter by connectors (id, account name, or an app for all its accounts) or groups. "
          + "Returns the best matches with the total (page with offset), grouped by connector, with the exact names to load. "
          + "list: true returns every tool in scope; no query and no filter, the connectors and groups. Then load what you need with tools_load.",
        parameters: SEARCH_PARAMETERS,
        execute: async (_id, params) => reply(this.runDetailed(TOOLS_SEARCH, params as Record<string, unknown>)),
      },
      {
        name: TOOLS_LOAD,
        label: "Load tools",
        description: "Load tools by exact name (from tools_search), or a whole connector or group by its id, so you can call them from your next step on. "
          + "Loaded tools stay available for the rest of this conversation. Load only what you need.",
        parameters: LOAD_PARAMETERS,
        execute: async (_id, params) => reply(this.runDetailed(TOOLS_LOAD, params as Record<string, unknown>)),
      },
    ];
  }
}

// ── Transcript helpers ──────────────────────────────────────────────────

interface MessageLike {
  role?: string;
  content?: unknown;
  toolsAdded?: Array<{ name: string }>;
  toolsRemoved?: Array<{ name: string }>;
}

/** The tools the system messages of a transcript declare (replayed in order), by name. */
export function declaredTools(messages: readonly unknown[]): Map<string, { name: string }> {
  const declared = new Map<string, { name: string }>();
  for (const raw of messages) {
    const message = raw as MessageLike;
    if (message?.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) if (tool?.name) declared.set(tool.name, tool);
    for (const tool of message.toolsRemoved ?? []) if (tool?.name) declared.delete(tool.name);
  }
  return declared;
}

/**
 * Compaction summarizes old messages and drops their system messages, so tools loaded mid-run
 * would vanish from the model's view. When `projected` (what is sent) declares fewer tools than
 * `full` (the whole transcript), the missing ones are announced again right after the leading
 * system messages and the compaction checkpoint.
 */
export function restoreToolAnnouncements<M>(full: readonly M[], projected: M[]): M[] {
  const before = declaredTools(full);
  if (before.size === 0) return projected;
  const after = declaredTools(projected);
  const missing = [...before.entries()].filter(([name]) => !after.has(name)).map(([, tool]) => tool);
  if (missing.length === 0) return projected;
  let index = 0;
  while (index < projected.length && (projected[index] as MessageLike)?.role === "system") index += 1;
  const next = projected[index] as MessageLike | undefined;
  if (next?.role === "user" && typeof next.content === "string" && next.content.startsWith("[Context checkpoint")) index += 1;
  const announcement = { role: "system", content: "", toolsAdded: missing, timestamp: Date.now() } as unknown as M;
  return [...projected.slice(0, index), announcement, ...projected.slice(index)];
}

/**
 * Deferred tools loaded in earlier turns of a stored conversation: the names given to completed
 * `tools_load` calls (tool names or group names; the tool set resolves groups) and the tools it
 * called. Names that are not deferred are ignored by the tool set.
 */
export function loadedToolsFromHistory(messages: ReadonlyArray<{ toolCalls?: Array<{ name: string; arguments?: Record<string, unknown>; state?: string }> }>): string[] {
  const names = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (call.state === "error" || call.state === "interrupted" || call.state === "preparing") continue;
      if (call.name === TOOLS_SEARCH) continue;
      if (call.name !== TOOLS_LOAD) { names.add(call.name); continue; }
      const value = call.arguments?.names;
      if (Array.isArray(value)) for (const name of value) names.add(String(name));
      else if (typeof value === "string") names.add(value);
    }
  }
  return [...names];
}

/** The mode for a run: the agent's own, else the instance default, else "auto". */
export function progressiveModeFor(agent: { progressiveTools?: ProgressiveToolsMode } | undefined, settings: ToolsSettings | undefined): ProgressiveToolsMode {
  return agent?.progressiveTools ?? settings?.progressive ?? "auto";
}
