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
  { id: "phone", label: "Phone calls", prefixes: ["phone_"] },
  { id: "ink", label: "Ink Hub (skills and packages)", prefixes: ["ink_"] },
  { id: "data", label: "Data sources and views", prefixes: ["data_"] },
  { id: "brain", label: "Company brain", prefixes: ["brain_"] },
  { id: "storage", label: "Storage buckets", prefixes: ["storage_"] },
];

/** Optional areas of Polpo's own tools (src/llm/orchestrator-tools.ts): everything else stays on. */
export const POLPO_TOOL_GROUPS: ToolGroupRule[] = [
  {
    id: "mission-editing", label: "Mission editing, step by step (tasks, checkpoints, delays, quality gates, team, notifications of an existing mission)",
    prefixes: ["add_mission_", "remove_mission_"],
    names: ["update_mission_task", "update_mission_checkpoint", "update_mission_delay", "update_mission_quality_gate",
      "update_mission_team_member", "update_mission_notifications", "reorder_mission_tasks"],
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
      "search_skills", "get_skill", "tag_skill", "list_playbooks", "get_playbook", "create_playbook", "instantiate_playbook",
      "run_playbook", "delete_playbook"],
  },
  { id: "ink", label: "Ink Hub (skills and packages)", prefixes: ["ink_"] },
  { id: "phone", label: "Phone calls", prefixes: ["phone_"] },
  { id: "whatsapp", label: "WhatsApp", prefixes: ["whatsapp_"] },
  {
    id: "browser", label: "Browser and browser profiles",
    prefixes: ["browser_"], names: ["egress_status"],
  },
  {
    id: "computers", label: "Computers and sandboxes",
    prefixes: ["computer_"], names: ["computers_list", "sandbox_status"],
  },
  {
    id: "learning", label: "Agent learning and drive",
    names: ["get_agent_learning", "review_agent_learning", "revert_agent_learning", "get_agent_drive", "reflect_agent"],
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
  /** Tools loaded earlier in the conversation: on from the start. */
  loaded?: Iterable<string>;
  /** Never deferred, whatever their group. */
  alwaysOn?: Iterable<string>;
}

export interface SearchHit {
  name: string;
  group: string;
  description: string;
  loaded: boolean;
  score: number;
}

const STOP_WORDS = new Set([
  "a", "an", "the", "to", "of", "for", "in", "on", "and", "or", "with", "by", "from", "at", "is", "it", "my", "me",
  "tool", "tools", "use", "using", "how", "can", "i", "do", "some", "this", "that", "into", "about",
]);

function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token))
    .map(stem);
}

function firstSentence(text: string | undefined, max = 200): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  const end = clean.search(/[.!?](\s|$)/);
  const sentence = end > 0 ? clean.slice(0, end + 1) : clean;
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1)}…`;
}

function declarationOf(tool: ToolLike): ToolDeclaration {
  return { name: tool.name, description: tool.description ?? "", parameters: tool.parameters ?? { type: "object", properties: {} } };
}

const SEARCH_PARAMETERS = {
  type: "object",
  properties: {
    query: { type: "string", description: "What you want to do, an app or a tool name (e.g. \"create a Linear issue\", \"gmail\", \"pdf\")." },
    limit: { type: "integer", minimum: 1, maximum: 25, description: "Most results (default 8)." },
  },
  required: ["query"],
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
      description: "Tool names from tools_search, or a group name from your instructions to load all of its tools.",
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
  execute: (toolCallId: string, params: unknown) => Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }>;
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
        else for (const tool of this.findGroup(name)?.tools ?? []) this.loadedSet.add(tool);
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
      return { id: `${MCP_PREFIX}${connector}`, label: this.opts.connectorNames?.[connector] ?? connector, kind: "connector" };
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
    return [...this.groupList].sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === "connector" ? -1 : 1));
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

  /** Ranked text search over the deferred tools: names, descriptions and group (connector) names. */
  search(query: string, limit = 8): SearchHit[] {
    const terms = [...new Set(tokenize(query))];
    const phrase = query.trim().toLowerCase().replace(/\s+/g, "_");
    const hits: SearchHit[] = [];
    for (const [name, group] of this.groupOf) {
      const tool = this.byName.get(name)!;
      const lowerName = name.toLowerCase();
      const connector = connectorIdOf(name);
      const nameTokens = new Set(tokenize(connector ? name.slice(`${MCP_PREFIX}${connector}__`.length) : name));
      const groupTokens = new Set([...tokenize(group.label), ...tokenize(group.id)]);
      const descTokens = new Set(tokenize(tool.description ?? ""));
      let score = 0;
      let matched = 0;
      for (const term of terms) {
        let best = 0;
        if (nameTokens.has(term)) best = Math.max(best, 4);
        else if (term.length >= 3 && [...nameTokens].some((t) => t.startsWith(term) || (t.length >= 3 && term.startsWith(t)))) best = Math.max(best, 2);
        if (groupTokens.has(term)) best = Math.max(best, 3);
        else if (term.length >= 3 && [...groupTokens].some((t) => t.startsWith(term))) best = Math.max(best, 1.5);
        if (descTokens.has(term)) best = Math.max(best, 1);
        else if (term.length >= 4 && [...descTokens].some((t) => t.startsWith(term))) best = Math.max(best, 0.5);
        if (best > 0) matched += 1;
        score += best;
      }
      if (phrase && lowerName === phrase) score += 20;
      else if (phrase.length >= 3 && lowerName.includes(phrase)) score += 5;
      if (terms.length > 0) score *= matched / terms.length;
      if (score <= 0) continue;
      hits.push({ name, group: group.label, description: firstSentence(tool.description), loaded: this.loadedSet.has(name), score });
    }
    hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return hits.slice(0, Math.max(1, Math.min(25, Math.floor(limit) || 8)));
  }

  /**
   * Load tools by name, or every tool of a group (its id, or a connector's name). Newly loaded
   * tools are announced by `takeAnnouncement()` / `takeNewlyLoaded()`.
   */
  load(names: string[]): { loaded: string[]; already: string[]; unknown: string[] } {
    const loaded: string[] = [];
    const already: string[] = [];
    const unknown: string[] = [];
    const add = (name: string) => {
      if (this.loadedSet.has(name)) { already.push(name); return; }
      this.loadedSet.add(name);
      this.pending.push(name);
      loaded.push(name);
    };
    for (const raw of names) {
      const name = String(raw ?? "").trim();
      if (!name) continue;
      if (this.groupOf.has(name)) { add(name); continue; }
      if (this.byName.has(name)) { already.push(name); continue; }
      const group = this.findGroup(name);
      if (group) { for (const tool of group.tools) add(tool); continue; }
      unknown.push(name);
    }
    return { loaded, already: [...new Set(already)], unknown };
  }

  private findGroup(name: string): ToolGroup | undefined {
    const lower = name.toLowerCase().replace(/^group:/, "");
    return this.groupList.find((group) => group.id.toLowerCase() === lower
      || group.label.toLowerCase() === lower
      || (group.kind === "connector" && group.id.slice(MCP_PREFIX.length).toLowerCase() === lower));
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

  /** Answer a meta tool call (the text the model gets back). */
  run(name: string, args: Record<string, unknown> | undefined): string {
    if (name === TOOLS_SEARCH) {
      const query = typeof args?.query === "string" ? args.query : "";
      const limit = typeof args?.limit === "number" ? args.limit : 8;
      const hits = this.search(query, limit);
      if (hits.length === 0) {
        return `No tool to load matches "${query}". Groups: ${this.groupSummary()}. Try other words, or load a whole group with tools_load.`;
      }
      return [
        `${hits.length} tool${hits.length === 1 ? "" : "s"} (load with tools_load):`,
        ...hits.map((hit) => `- ${hit.name} [${hit.group}]${hit.loaded ? " (loaded)" : ""}${hit.description ? ` — ${hit.description}` : ""}`),
      ].join("\n");
    }
    if (name === TOOLS_LOAD) {
      const names = Array.isArray(args?.names) ? (args!.names as unknown[]).map(String)
        : typeof args?.names === "string" ? [args.names] : [];
      if (names.length === 0) return "Error: give the names of the tools to load (names: [...]).";
      const result = this.load(names);
      const parts: string[] = [];
      if (result.loaded.length) parts.push(`Loaded ${result.loaded.length} tool${result.loaded.length === 1 ? "" : "s"}: ${result.loaded.join(", ")}. You can call ${result.loaded.length === 1 ? "it" : "them"} from your next step on.`);
      if (result.already.length) parts.push(`Already available: ${result.already.join(", ")}.`);
      if (result.unknown.length) parts.push(`Not found: ${result.unknown.join(", ")} (use tools_search for the exact names).`);
      const text = parts.join(" ");
      return result.loaded.length === 0 && result.already.length === 0 ? `Error: ${text}` : text;
    }
    return `Error: Unknown tool "${name}"`;
  }

  private groupSummary(): string {
    return this.groups().map((group) => `${group.label} (${group.id}, ${group.tools.length})`).join("; ");
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
      "To keep your context small, these tools are available but not loaded. When you need one, call `tools_search` (what you want to do, an app or a name), then `tools_load` with the names you need (or a group name to load all of it); loaded tools work from your next step on and stay for the rest of this conversation. Load only what you need.",
      ...lines,
    ].join("\n");
  }

  private buildMetaTools(): ProgressiveMetaTool[] {
    const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });
    return [
      {
        name: TOOLS_SEARCH,
        label: "Search tools",
        description: "Search the tools you can load but do not have yet (connectors and the optional groups listed in your instructions): "
          + "by what you want to do, an app or a tool name. Returns tool names with what they do; then load the ones you need with tools_load.",
        parameters: SEARCH_PARAMETERS,
        execute: async (_id, params) => text(this.run(TOOLS_SEARCH, params as Record<string, unknown>)),
      },
      {
        name: TOOLS_LOAD,
        label: "Load tools",
        description: "Load tools by name (from tools_search), or a whole group by its name, so you can call them from your next step on. "
          + "Loaded tools stay available for the rest of this conversation. Load only what you need.",
        parameters: LOAD_PARAMETERS,
        execute: async (_id, params) => text(this.run(TOOLS_LOAD, params as Record<string, unknown>)),
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
