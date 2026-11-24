/**
 * Ask Polpo from the search palette (POST /api/v1/search/ask, polpo_search_ask, ⌘K → Enter).
 *
 * The question goes to the orchestrator's model (settings.orchestratorModel, the same provider,
 * auth and gateway as Polpo's chat) with a few tools of its own:
 *
 *   search(query, types?)        the global search (the same engine as ⌘K)
 *   suggest_results(keys)        the results worth showing, best first
 *   navigate(route)              open a dashboard page          → ends the turn, runs at once
 *   open_result(key)             open a result                  → ends the turn, runs at once
 *   run_command(id, argument?)   one of the palette's commands  → runs at once only when it only
 *                                                                  changes the view; else a suggestion
 *   suggest_action(label, text)  anything that changes data: a button that hands the text to a new
 *                                Polpo chat (never run without a click)
 *
 * The server never navigates or runs anything: it returns intents, and the dashboard executes the
 * automatic ones (navigation, view-only commands). An obvious "go to X" / "vai a X" naming a page
 * is answered without the model (the fast path).
 *
 * Bounded: a few model rounds, a few searches, a small output budget per round and a deadline.
 * Secrets never reach the model: the question and every tool result go through maskSecrets.
 */
import type { SearchResponse, SearchResult, SearchType } from "./engine.js";
import { SEARCH_TYPES, isSearchType } from "./engine.js";
import { fold, maskSecrets } from "./text.js";

// ── Request / answer ────────────────────────────────────────────────────

/** A dashboard page the assistant may open. */
export interface AskPage {
  id?: string;
  label: string;
  to: string;
  /** Where it sits ("Work", "Settings · Integrations"). */
  section?: string;
}

/** A palette command the assistant may run (or suggest). */
export interface AskCommand {
  id: string;
  label: string;
  hint?: string;
  /** It takes words (what the task is about, the first message…). */
  argument?: boolean;
  /** It changes data or sends a message: only ever suggested, never run without a click. */
  confirm?: boolean;
}

export interface AskRequest {
  q: string;
  /** The page the person is on (context only). */
  route?: string;
  /** The dashboard's pages (default: DEFAULT_ASK_PAGES). */
  pages?: AskPage[];
  /** The palette's commands (default: none). */
  commands?: AskCommand[];
}

export type AskIntent =
  | { kind: "navigate"; route: string; label: string; auto: boolean }
  | { kind: "open"; route: string; label: string; key: string; auto: boolean }
  | { kind: "command"; id: string; label: string; argument?: string; auto: boolean }
  | { kind: "handoff"; label: string; message: string; auto: false };

export interface AskUsage {
  provider?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
}

export interface AskOutcome {
  answer: string;
  /** The results worth opening, best first. */
  items: SearchResult[];
  /** What to do: the automatic ones (auto) run at once in the dashboard, the others are buttons. */
  intents: AskIntent[];
  /** Answered without the model (an obvious "go to X"). */
  fastPath: boolean;
  /** Model rounds used. */
  rounds: number;
  usage?: AskUsage;
}

export type AskEvent =
  | { type: "status"; text: string }
  | { type: "delta"; text: string }
  | { type: "results"; items: SearchResult[] }
  | { type: "intent"; intent: AskIntent }
  | { type: "done"; result: AskOutcome }
  | { type: "error"; error: string; code?: string };

// ── The model, as the loop needs it ─────────────────────────────────────

export interface AskToolCall { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
export type AskContent = { type: "text"; text: string } | { type: "thinking"; thinking: string } | AskToolCall;
export interface AskAssistantMessage {
  role: "assistant";
  content: AskContent[];
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost?: { total: number } };
  stopReason?: string;
  errorMessage?: string;
  [k: string]: unknown;
}
export type AskMessage =
  | { role: "user"; content: string; timestamp: number }
  | AskAssistantMessage
  | { role: "toolResult"; toolCallId: string; toolName: string; content: Array<{ type: "text"; text: string }>; isError: boolean; timestamp: number };

export interface AskToolDef { name: string; description: string; parameters: Record<string, unknown> }

export interface AskLlmRequest {
  systemPrompt: string;
  messages: AskMessage[];
  tools: AskToolDef[];
  maxTokens: number;
  signal: AbortSignal;
  /** Text as it streams. */
  onDelta: (text: string) => void;
}

/** One model call (the orchestrator's model in production, a fake in tests). */
export type AskLlm = (req: AskLlmRequest) => Promise<AskAssistantMessage>;

export interface AskDeps {
  llm: AskLlm;
  search: (q: string, opts: { types?: SearchType[]; limit: number; signal: AbortSignal }) => Promise<SearchResponse>;
  /** provider / model id, for the usage record. */
  model?: { provider?: string; id?: string };
  now?: () => Date;
}

export const ASK_LIMITS = {
  /** Model calls per question. */
  rounds: 4,
  /** search() calls per question. */
  searches: 3,
  /** Output tokens per model call. */
  maxTokens: 700,
  /** Milliseconds for the whole answer. */
  deadlineMs: 25_000,
  /** Results a search() shows the model. */
  resultsPerSearch: 8,
  /** Results suggested to the person. */
  suggested: 6,
  questionChars: 500,
} as const;

// ── Pages known without the dashboard's list (API and MCP callers) ──────

export const DEFAULT_ASK_PAGES: AskPage[] = [
  { label: "Dashboard", to: "/dashboard" },
  { label: "Chat", to: "/chat" },
  { label: "Approvals", to: "/approvals" },
  { label: "Missions", to: "/missions", section: "Work" },
  { label: "Tasks", to: "/tasks", section: "Work" },
  { label: "Schedules", to: "/schedules", section: "Work" },
  { label: "Playbooks", to: "/playbooks", section: "Work" },
  { label: "Events", to: "/events", section: "Work" },
  { label: "Agents", to: "/agents", section: "Team" },
  { label: "Agent conversations", to: "/agent-talk", section: "Team" },
  { label: "Skills", to: "/skills", section: "Team" },
  { label: "Memory", to: "/memory", section: "Team" },
  { label: "Artifacts", to: "/artifacts", section: "Content" },
  { label: "Files", to: "/files", section: "Content" },
  { label: "Data", to: "/data", section: "Content" },
  { label: "Company Brain", to: "/brain", section: "Content" },
  { label: "Coding", to: "/coding", section: "Tools" },
  { label: "Terminal", to: "/terminal", section: "Tools" },
  { label: "Apps", to: "/apps", section: "Tools" },
  { label: "App Preview", to: "/browser", section: "Tools" },
  { label: "Browser Automation", to: "/agent-live", section: "Tools" },
  { label: "Computers", to: "/computers", section: "Tools" },
  { label: "General", to: "/config?section=general", section: "Settings · Workspace" },
  { label: "Appearance", to: "/config?section=appearance", section: "Settings · Workspace" },
  { label: "Members", to: "/config?section=members", section: "Settings · Workspace" },
  { label: "Cloud sync", to: "/config?section=sync", section: "Settings · Workspace" },
  { label: "Providers", to: "/config?section=providers", section: "Settings · Models & agents" },
  { label: "Harnesses", to: "/config?section=harnesses", section: "Settings · Models & agents" },
  { label: "Orchestrator", to: "/config?section=agent", section: "Settings · Models & agents" },
  { label: "Sandbox", to: "/config?section=sandbox", section: "Settings · Execution" },
  { label: "Computers", to: "/config?section=computers", section: "Settings · Execution" },
  { label: "Policies", to: "/config?section=policies", section: "Settings · Execution" },
  { label: "Rules", to: "/config?section=rules", section: "Settings · Execution" },
  { label: "Connectors", to: "/connectors", section: "Settings · Integrations" },
  { label: "Channels", to: "/config?section=channels", section: "Settings · Integrations" },
  { label: "MCP access", to: "/config?section=mcp", section: "Settings · Integrations" },
  { label: "Notifications", to: "/notifications", section: "Settings · Integrations" },
  { label: "What's new", to: "/changelog", section: "Help" },
];

// ── Fast path: "vai agli artefatti", "open channels settings", "go to tasks" ──

/** Verbs that only mean "take me there" (Italian and English). */
const NAV_VERB = /^(?:vai|va|andiamo|portami|apri|aprimi|mostra|mostrami|fammi vedere|go|goto|open|show|show me|take me|navigate)\b\s*/;
/** Little words between the verb and the page. */
const FILLER = new Set(["a", "ad", "al", "allo", "alla", "alle", "ai", "agli", "all", "in", "nel", "nella", "nelle", "nei", "negli", "su", "sul", "sulla", "sulle", "sui", "sugli",
  "il", "lo", "la", "le", "i", "gli", "l", "un", "una", "pagina", "sezione", "di", "dei", "delle", "degli", "del", "della", "mie", "miei", "mio", "mia",
  "to", "the", "my", "page", "section", "of", "into", "up", "me"]);
/** Italian (and a few other) names of the pages' words. */
const ALIASES: Record<string, string> = {
  artefatti: "artifacts", artifatti: "artifacts", artefatto: "artifacts", artifacts: "artifacts", artifact: "artifacts",
  attivita: "tasks", compiti: "tasks", task: "tasks", missioni: "missions", missione: "missions", mission: "missions",
  agenti: "agents", agente: "agents", agent: "agents", pianificazioni: "schedules", programmazioni: "schedules", schedule: "schedules",
  eventi: "events", approvazioni: "approvals", approvazione: "approvals", abilita: "skills", competenze: "skills", skill: "skills",
  memoria: "memory", dati: "data", cervello: "brain", aziendale: "company", strumenti: "tools", calcolatori: "computers",
  impostazioni: "settings", configurazione: "settings", config: "settings", preferenze: "settings",
  canali: "channels", canale: "channels", connettori: "connectors", connettore: "connectors", notifiche: "notifications",
  fornitori: "providers", modelli: "providers", membri: "members", aspetto: "appearance", tema: "appearance", generale: "general", generali: "general",
  criteri: "policies", regole: "rules", sincronizzazione: "sync", conversazioni: "chat", chats: "chat", novita: "what s new",
  computer: "computers", orchestratore: "orchestrator", polpo: "orchestrator", cruscotto: "dashboard", home: "dashboard", files: "files", file: "files",
};

const folded = (s: string) => fold(s).replace(/['’]/g, " ").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
const normalWords = (s: string) => folded(s).split(" ").filter((w) => w && !FILLER.has(w)).map((w) => ALIASES[w] ?? w).join(" ");

/**
 * The page an obvious navigation request names, or null: a verb ("vai", "apri", "go to"…) then
 * exactly a page's name (articles and "settings"/"impostazioni" allowed, Italian names folded).
 */
export function matchNavigation(q: string, pages: AskPage[]): AskPage | null {
  const text = folded(q);
  const verb = NAV_VERB.exec(text);
  if (!verb) return null;
  const target = normalWords(text.slice(verb[0].length));
  if (!target) return null;
  const isSettingsPage = (p: AskPage) => p.to.startsWith("/config") || /^settings/i.test(p.section ?? "");
  const hits = pages.filter((p) => {
    const label = normalWords(p.label);
    if (target === label) return true;
    // "channels settings", "impostazioni canali", "settings channels": a Settings section
    return isSettingsPage(p) && (target === `${label} settings` || target === `settings ${label}`);
  });
  if (!hits.length) return null;
  // "vai ai computer": the page, not the Settings section of the same name
  return hits.find((p) => !isSettingsPage(p) || /settings/.test(target)) ?? hits[0]!;
}

// ── Routes the assistant may open ───────────────────────────────────────

const pathOf = (to: string) => to.split(/[?#]/)[0] ?? "";
const firstSegment = (to: string) => pathOf(to).split("/")[1] ?? "";

/**
 * The route if it is a dashboard route the assistant may open: relative ("/…", never "//" or a
 * scheme), plain characters, and under a known page or a result the search returned.
 */
export function safeRoute(route: unknown, known: Iterable<string>): string | null {
  if (typeof route !== "string") return null;
  const r = route.trim();
  if (!r.startsWith("/") || r.startsWith("//") || r.length > 300) return null;
  if (/[\\\s<>"'`]|[\u0000-\u001f]/.test(r) || /^\/[^/?#]*:/.test(r)) return null;
  const seg = firstSegment(r);
  for (const k of known) if (firstSegment(k) === seg) return r;
  return null;
}

// ── The loop ────────────────────────────────────────────────────────────

const str = (v: unknown, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");

const TOOLS: AskToolDef[] = [
  {
    name: "search",
    description: "Search the whole workspace (chats and their messages, agents, tasks, missions, artifacts, files, data, skills, memory, schedules, connectors, channels, events…). Returns results as `[key] Type · title — details`.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "A few keywords (not a sentence)" },
        types: { type: "array", items: { type: "string", enum: [...SEARCH_TYPES] }, description: "Only these types (optional)" },
      },
      required: ["query"],
    },
  },
  {
    name: "suggest_results",
    description: "Show these search results to the person, best first (keys from search).",
    parameters: { type: "object", properties: { keys: { type: "array", items: { type: "string" }, maxItems: 6 } }, required: ["keys"] },
  },
  {
    name: "navigate",
    description: "Open a dashboard page (a route from the pages list, or a result's route). Use it when the person asks to go somewhere. Ends your turn.",
    parameters: { type: "object", properties: { route: { type: "string" }, label: { type: "string", description: "The page's name" } }, required: ["route"] },
  },
  {
    name: "open_result",
    description: "Open one search result (its key). Ends your turn.",
    parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
  {
    name: "run_command",
    description: "Run one of the palette's commands by id (theme, sidebar, new group…). Commands marked [asks first] are shown as a button instead of running.",
    parameters: { type: "object", properties: { id: { type: "string" }, argument: { type: "string", description: "The words the command takes, if any" } }, required: ["id"] },
  },
  {
    name: "suggest_action",
    description: "Anything that creates or changes something (a task, a mission, an agent, a message, a setting): a button that opens a new chat with Polpo with this message. It is never done without the person's click.",
    parameters: { type: "object", properties: { label: { type: "string", description: "The button, e.g. 'Create the task'" }, message: { type: "string", description: "What Polpo should do, in the person's language" } }, required: ["label", "message"] },
  },
];

function systemPrompt(req: AskRequest, pages: AskPage[], commands: AskCommand[], now: Date): string {
  const pageLines = pages.slice(0, 120).map((p) => `- ${p.label}${p.section ? ` (${p.section})` : ""}: ${p.to}`).join("\n");
  const cmdLines = commands.slice(0, 60).map((c) => `- ${c.id}: ${c.label}${c.argument ? " (takes words)" : ""}${c.confirm ? " [asks first]" : ""}`).join("\n");
  return [
    "You are Polpo's search assistant inside the dashboard's ⌘K palette. Understand what the person wants and help them get there fast.",
    "Answer in the person's language (Italian or English), in at most two short sentences, plain text (no headings, no lists).",
    "- To find something, call search with a few keywords (translate them if useful), then suggest_results with the best keys and say in one line what you found.",
    "- To go somewhere, call navigate with a route (from the pages below or a result) or open_result; keep the text to a few words.",
    "- Commands that only change the view (theme, sidebar…) may be run with run_command.",
    "- Never claim you created, changed, sent or deleted anything: you cannot. For those requests call suggest_action with a clear message for Polpo; the person clicks it.",
    "- If nothing fits, say so briefly and suggest a search the person could try.",
    `Today: ${now.toISOString().slice(0, 10)}.${req.route ? ` The person is on ${maskSecrets(req.route).slice(0, 200)}.` : ""}`,
    `Pages:\n${pageLines}`,
    cmdLines ? `Commands:\n${cmdLines}` : "",
  ].filter(Boolean).join("\n");
}

const resultKey = (r: Pick<SearchResult, "type" | "id">) => `${r.type}:${r.id}`;

function resultLine(r: SearchResult): string {
  const meta = r.meta ?? {};
  const details = [r.subtitle, typeof meta.status === "string" ? meta.status : undefined, typeof meta.agent === "string" ? `agent ${meta.agent}` : undefined, r.updatedAt?.slice(0, 10)]
    .filter(Boolean).join(" · ");
  const snip = r.snippet?.text ? ` — “${r.snippet.text.replace(/\s+/g, " ").slice(0, 160)}”` : "";
  return maskSecrets(`[${resultKey(r)}] ${r.type} · ${r.title}${details ? ` (${details})` : ""} → ${r.url}${snip}`);
}

function addUsage(total: AskUsage, u: AskAssistantMessage["usage"]): void {
  if (!u) return;
  total.inputTokens += u.input ?? 0;
  total.outputTokens += u.output ?? 0;
  total.cacheReadTokens += u.cacheRead ?? 0;
  total.cacheWriteTokens += u.cacheWrite ?? 0;
  total.totalTokens += u.totalTokens ?? 0;
  total.cost += u.cost?.total ?? 0;
}

export class AskError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}

/**
 * Answer one question: the fast path, else the model with its tools (bounded). Events stream as
 * they happen; the outcome is also returned.
 */
export async function runSearchAsk(req: AskRequest, deps: AskDeps | null, emit: (e: AskEvent) => void = () => {}, signal?: AbortSignal): Promise<AskOutcome> {
  const q = maskSecrets(req.q.trim().slice(0, ASK_LIMITS.questionChars));
  const pages = req.pages?.length ? req.pages : DEFAULT_ASK_PAGES;
  const commands = req.commands ?? [];

  // the fast path: "vai a X" naming a page exactly
  const page = matchNavigation(q, pages);
  if (page) {
    const intent: AskIntent = { kind: "navigate", route: page.to, label: page.label, auto: true };
    emit({ type: "intent", intent });
    const result: AskOutcome = { answer: page.label, items: [], intents: [intent], fastPath: true, rounds: 0 };
    emit({ type: "done", result });
    return result;
  }
  if (!deps) throw new AskError("Polpo's model is not configured: set it in Settings → Orchestrator.", "NO_MODEL");

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), ASK_LIMITS.deadlineMs);
  const onAbort = () => deadline.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  const known = new Set(pages.map((p) => p.to));
  const seen = new Map<string, SearchResult>();
  const order: string[] = [];
  let suggested: string[] | null = null;
  const intents: AskIntent[] = [];
  const usage: AskUsage = { provider: deps.model?.provider, model: deps.model?.id, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 };
  const messages: AskMessage[] = [{ role: "user", content: q, timestamp: Date.now() }];
  const system = systemPrompt(req, pages, commands, deps.now?.() ?? new Date());
  let answer = "";
  let rounds = 0;
  let searches = 0;
  let ended = false;

  const addIntent = (intent: AskIntent) => { intents.push(intent); emit({ type: "intent", intent }); };

  const runTool = async (call: AskToolCall): Promise<{ text: string; isError?: boolean }> => {
    const args = call.arguments ?? {};
    switch (call.name) {
      case "search": {
        if (searches >= ASK_LIMITS.searches) return { text: "No more searches for this question: answer with what you have.", isError: true };
        searches++;
        const query = str(args.query, 200);
        if (!query) return { text: "query is required", isError: true };
        const types = Array.isArray(args.types) ? args.types.filter((t): t is SearchType => typeof t === "string" && isSearchType(t)) : undefined;
        emit({ type: "status", text: `Searching “${query}”…` });
        const res = await deps.search(query, { ...(types?.length ? { types } : {}), limit: ASK_LIMITS.resultsPerSearch, signal: deadline.signal });
        const items = res.items.slice(0, ASK_LIMITS.resultsPerSearch);
        for (const r of items) {
          const k = resultKey(r);
          if (!seen.has(k)) { seen.set(k, r); order.push(k); known.add(r.url); }
        }
        return { text: items.length ? items.map(resultLine).join("\n") : `Nothing found for "${query}".` };
      }
      case "suggest_results": {
        const keys = Array.isArray(args.keys) ? args.keys.filter((k): k is string => typeof k === "string" && seen.has(k)) : [];
        suggested = [...new Set([...(suggested ?? []), ...keys])].slice(0, ASK_LIMITS.suggested);
        emit({ type: "results", items: suggested.map((k) => seen.get(k)!) });
        return { text: keys.length ? `Shown: ${keys.join(", ")}` : "None of those keys came from search.", isError: !keys.length };
      }
      case "navigate": {
        const route = safeRoute(args.route, known);
        if (!route) return { text: `Not a dashboard route I can open: ${str(args.route, 120)}. Use a route from the pages list or a result.`, isError: true };
        const page = pages.find((p) => p.to === route);
        addIntent({ kind: "navigate", route, label: str(args.label, 80) || page?.label || route, auto: true });
        ended = true;
        return { text: "Opening it." };
      }
      case "open_result": {
        const r = seen.get(str(args.key, 200));
        if (!r) return { text: "Unknown key: use one returned by search.", isError: true };
        addIntent({ kind: "open", route: r.url, label: r.title, key: resultKey(r), auto: true });
        ended = true;
        return { text: "Opening it." };
      }
      case "run_command": {
        const cmd = commands.find((c) => c.id === str(args.id, 120));
        if (!cmd) return { text: `Unknown command. Commands: ${commands.map((c) => c.id).join(", ") || "none"}.`, isError: true };
        const argument = cmd.argument ? str(args.argument, 400) || undefined : undefined;
        const auto = !cmd.confirm;
        addIntent({ kind: "command", id: cmd.id, label: cmd.label, ...(argument ? { argument } : {}), auto });
        if (auto) ended = true;
        return { text: auto ? "Done." : "Shown as a button: the person decides." };
      }
      case "suggest_action": {
        const label = str(args.label, 80);
        const message = str(args.message, 1000);
        if (!label || !message) return { text: "label and message are required", isError: true };
        addIntent({ kind: "handoff", label, message: maskSecrets(message), auto: false });
        return { text: "Shown as a button: the person decides." };
      }
      default:
        return { text: `Unknown tool ${call.name}`, isError: true };
    }
  };

  try {
    while (rounds < ASK_LIMITS.rounds && !ended) {
      rounds++;
      let roundText = "";
      const msg = await deps.llm({
        systemPrompt: system,
        messages,
        // the last round answers with what it has
        tools: rounds < ASK_LIMITS.rounds ? TOOLS : [],
        maxTokens: ASK_LIMITS.maxTokens,
        signal: deadline.signal,
        onDelta: (text) => {
          // a new round's text starts a new line of the answer
          if (!roundText && answer) emit({ type: "delta", text: " " });
          roundText += text;
          emit({ type: "delta", text });
        },
      });
      addUsage(usage, msg.usage);
      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        if (deadline.signal.aborted) throw new AskError(signal?.aborted ? "Cancelled." : "Polpo took too long to answer.", signal?.aborted ? "ABORTED" : "TIMEOUT");
        throw new AskError(msg.errorMessage || "The model failed.", "LLM_ERROR");
      }
      const text = msg.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("").trim();
      if (text) answer = answer ? `${answer} ${text}` : text;
      const calls = msg.content.filter((c): c is AskToolCall => c.type === "toolCall");
      if (!calls.length) break;
      messages.push(msg);
      for (const call of calls) {
        let out: { text: string; isError?: boolean };
        try {
          out = await runTool(call);
        } catch (err) {
          if (deadline.signal.aborted) throw err;
          out = { text: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
        messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: maskSecrets(out.text) }], isError: !!out.isError, timestamp: Date.now() });
      }
    }
  } catch (err) {
    if (err instanceof AskError) throw err;
    if (deadline.signal.aborted) throw new AskError(signal?.aborted ? "Cancelled." : "Polpo took too long to answer.", signal?.aborted ? "ABORTED" : "TIMEOUT");
    throw new AskError(err instanceof Error ? err.message : String(err), "LLM_ERROR");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  const keys = suggested ?? order.slice(0, ASK_LIMITS.suggested);
  const items = keys.map((k) => seen.get(k)!).filter(Boolean);
  if (!suggested && items.length) emit({ type: "results", items });
  const result: AskOutcome = { answer: maskSecrets(answer), items, intents, fastPath: false, rounds, usage };
  emit({ type: "done", result });
  return result;
}
