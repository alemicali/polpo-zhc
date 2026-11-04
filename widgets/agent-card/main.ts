/**
 * Polpo agent card: an MCP App (https://modelcontextprotocol.io/extensions/apps/overview) shown by
 * the `show_agent` tool in Claude, ChatGPT and other hosts.
 *
 * - Inline: a compact card (status, the task at hand, today, what is next, the main goal) with two
 *   actions, Open (full screen) and Ask for an update (a chat message, so Claude talks to the agent).
 * - Full screen: tabs for overview, tasks, goals and routine; the agent's proposals can be confirmed
 *   or cancelled here. The tab in view is told to the model (updateModelContext).
 * - Styled with the host's variables (light and dark), skeleton while loading, safe areas on mobile.
 * - Several cards of the same agent in a conversation: the newest (by the server's key) stays live,
 *   older ones grey out (BroadcastChannel), as Claude's guidelines suggest.
 *
 * Built by widgets/build.mjs into one HTML file (src/server/mcp-widgets.generated.ts).
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { AgentCard, AgentCardRoutineItem } from "../../src/server/mcp-agent-card.js";

// ── Text ─────────────────────────────────────────────────────────────────

const STRINGS = {
  en: {
    working: "Working", idle: "Free", waiting: "Waiting for you",
    workingOn: "Working on", lastDone: "Last finished", noTask: "No tasks yet",
    today: "Today", done: "done", failed: "failed", toApprove: "to approve",
    next: "Next", nothingPlanned: "Nothing planned", toConfirm: "to confirm",
    goal: "Main goal", noGoal: "No goals yet", driveOff: "Goals and initiative are off",
    open: "Open", askUpdate: "Ask for an update", askUpdateText: (n: string) => `Ask ${n} how it's going and what it's working on.`,
    overview: "Overview", tasks: "Tasks", goals: "Goals", routine: "Routine",
    all: "All", active: "In progress", doneF: "Done", failedF: "Failed",
    portrait: "Self-portrait", reflections: "Latest reflections", noItems: "Nothing here yet",
    confirm: "Confirm", cancel: "Cancel", recurring: "Repeats", once: "Once", refresh: "Refresh", updated: "Updated",
    superseded: "There is a newer card for this agent below",
    horizon: { long: "6–12 months", quarter: "Quarter", month: "Month", week: "Week", day: "Today" } as Record<string, string>,
    status: { pending: "Pending", assigned: "Assigned", in_progress: "In progress", review: "In review", done: "Done", failed: "Failed", awaiting_approval: "To approve", draft: "Draft" } as Record<string, string>,
    error: "Could not load the agent",
  },
  it: {
    working: "Al lavoro", idle: "Libero", waiting: "In attesa di te",
    workingOn: "Sta lavorando a", lastDone: "Ultimo concluso", noTask: "Ancora nessun task",
    today: "Oggi", done: "fatti", failed: "falliti", toApprove: "da approvare",
    next: "Prossimo", nothingPlanned: "Niente in programma", toConfirm: "da confermare",
    goal: "Obiettivo principale", noGoal: "Ancora nessun obiettivo", driveOff: "Obiettivi e iniziativa spenti",
    open: "Apri", askUpdate: "Chiedi un aggiornamento", askUpdateText: (n: string) => `Chiedi a ${n} come sta andando e a cosa sta lavorando.`,
    overview: "Panoramica", tasks: "Task", goals: "Obiettivi", routine: "Routine",
    all: "Tutti", active: "In corso", doneF: "Fatti", failedF: "Falliti",
    portrait: "Autoritratto", reflections: "Ultime riflessioni", noItems: "Ancora niente qui",
    confirm: "Conferma", cancel: "Annulla", recurring: "Si ripete", once: "Una volta", refresh: "Aggiorna", updated: "Aggiornato",
    superseded: "C'è una scheda più recente di questo agente più sotto",
    horizon: { long: "6–12 mesi", quarter: "Trimestre", month: "Mese", week: "Settimana", day: "Oggi" } as Record<string, string>,
    status: { pending: "In coda", assigned: "Assegnato", in_progress: "In corso", review: "In verifica", done: "Fatto", failed: "Fallito", awaiting_approval: "Da approvare", draft: "Bozza" } as Record<string, string>,
    error: "Non riesco a caricare l'agente",
  },
};
type Strings = typeof STRINGS.en;

// ── State ────────────────────────────────────────────────────────────────

type Tab = "overview" | "tasks" | "goals" | "routine";
type TaskFilter = "all" | "active" | "done" | "failed";

const app = new App({ name: "polpo-agent-card", version: "1.0.0" }, { availableDisplayModes: ["inline", "fullscreen"] });
const root = document.getElementById("root")!;

let ctx: McpUiHostContext = {};
let card: AgentCard | undefined;
let pendingName: string | undefined;
let error: string | undefined;
let tab: Tab = "overview";
let taskFilter: TaskFilter = "all";
let busy = new Set<string>();
let superseded = false;

const t = (): Strings => ((ctx.locale ?? navigator.language ?? "en").toLowerCase().startsWith("it") ? STRINGS.it : STRINGS.en) as Strings;
const fullscreen = () => ctx.displayMode === "fullscreen";
const canFullscreen = () => (ctx.availableDisplayModes ?? []).includes("fullscreen");

// ── DOM helpers (text only through textContent: nothing is parsed as HTML) ──

type Child = Node | string | false | null | undefined;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false || v === null) continue;
    if (k === "class") el.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== false && c !== null && c !== undefined) el.append(c);
  return el;
}

function formatTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const locale = ctx.locale ?? navigator.language;
  const timeZone = ctx.timeZone;
  const sameDay = (a: Date, b: Date) => a.toLocaleDateString("en-CA", { timeZone }) === b.toLocaleDateString("en-CA", { timeZone });
  const now = new Date();
  const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", timeZone });
  if (sameDay(d, now)) return time;
  const tomorrow = new Date(now.getTime() + 86_400_000);
  const day = sameDay(d, tomorrow)
    ? (locale.startsWith("it") ? "domani" : "tomorrow")
    : d.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", timeZone });
  return `${day} ${time}`;
}

function initials(name: string): string {
  const parts = name.replace(/[-_]+/g, " ").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

const statusTone = (s: string) => (s === "done" ? "success" : s === "failed" ? "danger" : s === "awaiting_approval" ? "warning" : s === "in_progress" || s === "assigned" || s === "review" ? "info" : "neutral");

function progressBar(value: number | undefined, label: string): HTMLElement {
  if (value === undefined) return h("span");
  return h("div", { class: "bar", role: "progressbar", "aria-valuenow": value, "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": label },
    h("div", { class: "bar-fill", style: { width: `${Math.min(100, Math.max(0, value))}%` } }));
}

// ── Rendering ────────────────────────────────────────────────────────────

function header(c: AgentCard, s: Strings): HTMLElement {
  const name = c.agent.displayName ?? c.agent.name;
  return h("div", { class: "head" },
    h("div", { class: "avatar", "aria-hidden": "true" }, initials(name)),
    h("div", { class: "who" },
      h("div", { class: "name" }, name),
      h("div", { class: "role" }, [c.agent.role, c.agent.displayName ? c.agent.name : undefined].filter(Boolean).join(" · "))),
    h("span", { class: `chip chip-${c.status === "working" ? "info" : c.status === "waiting" ? "warning" : "neutral"}` }, s[c.status]));
}

function inlineCard(c: AgentCard, s: Strings): HTMLElement {
  const nextText = (n: AgentCardRoutineItem) => `${formatTime(n.at)} · ${n.text}`;
  const rows: Array<[string, Node | string]> = [
    [c.current?.active ? s.workingOn : s.lastDone, c.current ? c.current.title : s.noTask],
    [s.today, `${c.today.done} ${s.done} · ${c.today.failed} ${s.failed} · ${c.today.waiting} ${s.toApprove}`],
    [s.next, c.next ? h("span", {}, nextText(c.next), c.next.proposed ? h("span", { class: "chip chip-warning chip-sm" }, s.toConfirm) : null) : s.nothingPlanned],
    [s.goal, c.goal
      ? h("div", { class: "goal" }, h("span", {}, c.goal.title, c.goal.progress !== undefined ? h("span", { class: "muted" }, ` ${c.goal.progress}%`) : null), progressBar(c.goal.progress, s.goal))
      : (c.drive ? s.noGoal : s.driveOff)],
  ];
  return h("div", { class: "card" },
    header(c, s),
    h("dl", { class: "facts" }, ...rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
    h("div", { class: "actions" },
      canFullscreen() ? h("button", { class: "btn btn-primary", disabled: superseded, onclick: openFull }, s.open) : null,
      h("button", { class: "btn", disabled: superseded, onclick: askUpdate }, s.askUpdate)));
}

function tabs(s: Strings): HTMLElement {
  const items: Array<[Tab, string]> = [["overview", s.overview], ["tasks", s.tasks], ["goals", s.goals], ["routine", s.routine]];
  return h("div", { class: "seg", role: "tablist" }, ...items.map(([id, label]) =>
    h("button", { class: `seg-btn${tab === id ? " on" : ""}`, role: "tab", "aria-selected": tab === id ? "true" : "false", onclick: () => setTab(id) }, label)));
}

function empty(s: Strings) { return h("p", { class: "muted empty" }, s.noItems); }

function overviewTab(c: AgentCard, s: Strings): HTMLElement {
  const top = c.goals.filter((g) => !g.parentId && (g.status === "todo" || g.status === "doing")).slice(0, 4);
  return h("div", { class: "stack" },
    inlineFacts(c, s),
    c.portrait ? h("section", {}, h("h3", {}, s.portrait), h("p", { class: "prose" }, c.portrait)) : null,
    top.length ? h("section", {}, h("h3", {}, s.goals), ...top.map((g) => goalRow(g, s))) : null,
    c.journal.length ? h("section", {}, h("h3", {}, s.reflections), ...c.journal.map((j) => h("div", { class: "row" }, h("div", { class: "row-main" }, h("div", { class: "prose" }, j.summary)), h("div", { class: "muted small" }, formatTime(j.at))))) : null);
}

function inlineFacts(c: AgentCard, s: Strings): HTMLElement {
  return h("div", { class: "kpis" },
    h("div", { class: "kpi" }, h("div", { class: "kpi-n" }, String(c.today.done)), h("div", { class: "muted small" }, `${s.today} · ${s.done}`)),
    h("div", { class: "kpi" }, h("div", { class: "kpi-n" }, String(c.today.failed)), h("div", { class: "muted small" }, s.failed)),
    h("div", { class: "kpi" }, h("div", { class: "kpi-n" }, String(c.today.waiting)), h("div", { class: "muted small" }, s.toApprove)));
}

function tasksTab(c: AgentCard, s: Strings): HTMLElement {
  const filters: Array<[TaskFilter, string]> = [["all", s.all], ["active", s.active], ["done", s.doneF], ["failed", s.failedF]];
  const shown = c.tasks.filter((x) => taskFilter === "all" || (taskFilter === "active" ? ["assigned", "in_progress", "review", "pending", "awaiting_approval"].includes(x.status) : x.status === taskFilter));
  return h("div", { class: "stack" },
    h("div", { class: "chips" }, ...filters.map(([id, label]) => h("button", { class: `chip-btn${taskFilter === id ? " on" : ""}`, "aria-pressed": taskFilter === id ? "true" : "false", onclick: () => { taskFilter = id; render(); } }, label))),
    shown.length ? h("div", {}, ...shown.map((x) => h("div", { class: "row" },
      h("div", { class: "row-main" }, h("div", {}, x.title), h("div", { class: "muted small" }, `${x.id} · ${formatTime(x.updatedAt)}`)),
      h("span", { class: `chip chip-sm chip-${statusTone(x.status)}` }, s.status[x.status] ?? x.status)))) : empty(s));
}

function goalRow(g: AgentCard["goals"][number], s: Strings): HTMLElement {
  return h("div", { class: `row${g.parentId ? " indent" : ""}` },
    h("div", { class: "row-main" },
      h("div", {}, g.title),
      h("div", { class: "muted small" }, [g.horizon ? s.horizon[g.horizon] ?? g.horizon : "", g.measure, g.due ? formatTime(g.due) : ""].filter(Boolean).join(" · ")),
      progressBar(g.progress, g.title)),
    g.progress !== undefined ? h("span", { class: "muted small" }, `${g.progress}%`) : null);
}

function goalsTab(c: AgentCard, s: Strings): HTMLElement {
  if (!c.goals.length) return h("div", { class: "stack" }, empty(s), !c.drive ? h("p", { class: "muted" }, s.driveOff) : null);
  // each goal followed by the goals that serve it
  const byParent = new Map<string | undefined, AgentCard["goals"]>();
  for (const g of c.goals) byParent.set(g.parentId, [...(byParent.get(g.parentId) ?? []), g]);
  const ids = new Set(c.goals.map((g) => g.id));
  const out: HTMLElement[] = [];
  const walk = (parent: string | undefined, depth: number) => {
    for (const g of byParent.get(parent) ?? []) {
      if (depth > 6) return;
      const row = goalRow(g, s);
      row.style.paddingInlineStart = `${Math.min(depth, 4) * 16}px`;
      out.push(row);
      walk(g.id, depth + 1);
    }
  };
  walk(undefined, 0);
  // goals whose parent is not a goal (a step, or dropped)
  for (const g of c.goals) if (g.parentId && !ids.has(g.parentId)) out.push(goalRow(g, s));
  return h("div", {}, ...out);
}

function routineTab(c: AgentCard, s: Strings): HTMLElement {
  if (!c.routine.length) return empty(s);
  return h("div", {}, ...c.routine.map((r) => h("div", { class: "row" },
    h("div", { class: "row-main" },
      h("div", {}, r.text, r.proposed ? h("span", { class: "chip chip-warning chip-sm" }, s.toConfirm) : null),
      h("div", { class: "muted small" }, `${formatTime(r.at)} · ${r.recurring ? s.recurring : s.once}`)),
    h("div", { class: "row-actions" },
      r.proposed ? h("button", { class: "btn btn-primary btn-sm", disabled: superseded || busy.has(r.id), onclick: () => decide(r.id, "confirm") }, s.confirm) : null,
      h("button", { class: "btn btn-sm", disabled: superseded || busy.has(r.id), onclick: () => decide(r.id, "cancel") }, s.cancel)))));
}

function fullView(c: AgentCard, s: Strings): HTMLElement {
  const body = tab === "overview" ? overviewTab(c, s) : tab === "tasks" ? tasksTab(c, s) : tab === "goals" ? goalsTab(c, s) : routineTab(c, s);
  return h("div", { class: "full" },
    h("div", { class: "full-top" }, header(c, s),
      h("button", { class: "btn btn-sm", disabled: busy.has("refresh"), onclick: refresh }, s.refresh)),
    tabs(s),
    h("div", { class: "full-body" }, body),
    h("p", { class: "muted small foot" }, `${s.updated} ${formatTime(c.generatedAt)}`));
}

function skeleton(): HTMLElement {
  return h("div", { class: "card", "aria-busy": "true" },
    h("div", { class: "head" }, h("div", { class: "avatar sk" }), h("div", { class: "who" },
      pendingName ? h("div", { class: "name" }, pendingName) : h("div", { class: "sk sk-line w40" }),
      h("div", { class: "sk sk-line w25" }))),
    h("div", { class: "facts" }, ...[70, 55, 80, 60].map((w) => h("div", { class: `sk sk-line w${w}` }))));
}

function render(): void {
  const s = t();
  root.replaceChildren(
    superseded ? h("div", { class: "banner" }, s.superseded) : "",
    error && !card ? h("div", { class: "card" }, h("p", { class: "danger" }, `${s.error}: ${error}`)) : card ? (fullscreen() ? fullView(card, s) : inlineCard(card, s)) : skeleton(),
  );
  root.classList.toggle("is-superseded", superseded);
  root.classList.toggle("is-full", fullscreen());
}

// ── Actions ──────────────────────────────────────────────────────────────

async function openFull(): Promise<void> {
  if (superseded) return;
  await app.requestDisplayMode({ mode: "fullscreen" }).catch(() => {});
}

async function askUpdate(): Promise<void> {
  if (superseded || !card) return;
  await app.sendMessage({ role: "user", content: [{ type: "text", text: t().askUpdateText(card.agent.displayName ?? card.agent.name) }] }).catch(() => {});
}

function setTab(next: Tab): void {
  tab = next;
  render();
  tellModel();
}

/** What the person sees, for the model's next turn (only the live card speaks). */
function tellModel(): void {
  if (superseded || !card || !fullscreen()) return;
  const c = card;
  const lines = tab === "tasks" ? c.tasks.slice(0, 15).map((x) => `- ${x.id} [${x.status}] ${x.title}`)
    : tab === "goals" ? c.goals.slice(0, 15).map((g) => `- ${g.id} (${g.horizon ?? "step"}, ${g.status}${g.progress !== undefined ? `, ${g.progress}%` : ""}) ${g.title}`)
    : tab === "routine" ? c.routine.map((r) => `- ${r.id} ${r.at}${r.proposed ? " (proposed)" : ""} ${r.text}`)
    : [`status ${c.status}; today ${c.today.done} done, ${c.today.failed} failed, ${c.today.waiting} waiting`];
  void app.updateModelContext({
    content: [{ type: "text", text: `The person is looking at the ${tab} tab of ${c.agent.name}'s card in Polpo:\n${lines.join("\n") || "(empty)"}` }],
  }).catch(() => {});
}

function adopt(next: unknown): void {
  const c = next as AgentCard | undefined;
  if (!c || typeof c !== "object" || !c.agent) return;
  // keep this card's place in the order: refreshes carry newer keys
  card = card ? { ...c, key: card.key } : c;
  error = undefined;
}

async function refresh(): Promise<void> {
  if (!card || busy.has("refresh")) return;
  busy.add("refresh");
  render();
  try {
    const res = await app.callServerTool({ name: "agent_card_refresh", arguments: { agent: card.agent.name } });
    if (res.isError) throw new Error(res.content?.map((x) => ("text" in x ? x.text : "")).join(" ") || "error");
    adopt(res.structuredContent);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    busy.delete("refresh");
    render();
  }
}

async function decide(id: string, action: "confirm" | "cancel"): Promise<void> {
  if (superseded || !card || busy.has(id)) return;
  busy.add(id);
  render();
  try {
    const res = await app.callServerTool({ name: "agent_intention_decide", arguments: { agent: card.agent.name, id, action } });
    if (!res.isError) adopt(res.structuredContent);
  } finally {
    busy.delete(id);
    render();
    tellModel();
  }
}

// ── Newest card wins (per agent, within the conversation) ─────────────────

let channel: BroadcastChannel | undefined;
const instanceId = Math.random().toString(36).slice(2);
const peers = new Map<string, { createdAt: number; seq: number; instanceId: string }>();

function isNewer(other: { createdAt: number; seq: number; instanceId: string }): boolean {
  const mine = card!.key;
  if (other.createdAt !== mine.createdAt) return other.createdAt > mine.createdAt;
  if (other.seq !== mine.seq) return other.seq > mine.seq;
  return other.instanceId > instanceId;
}

function joinElection(): void {
  if (channel || !card || typeof BroadcastChannel === "undefined") return;
  channel = new BroadcastChannel(`polpo-agent-card:${card.agent.name}`);
  const me = () => ({ ...card!.key, instanceId });
  channel.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as { type?: string; createdAt?: number; seq?: number; instanceId?: string } | null;
    if (!msg || msg.instanceId === instanceId || typeof msg.createdAt !== "number" || typeof msg.seq !== "number" || !card) return;
    if (msg.type === "hello") channel!.postMessage({ type: "here", ...me() });
    peers.set(msg.instanceId!, { createdAt: msg.createdAt, seq: msg.seq, instanceId: msg.instanceId! });
    const was = superseded;
    superseded = [...peers.values()].some(isNewer);
    if (was !== superseded) render();
  };
  channel.postMessage({ type: "hello", ...me() });
}

// ── Host ─────────────────────────────────────────────────────────────────

function applyContext(next: Partial<McpUiHostContext>): void {
  const before = ctx.displayMode;
  ctx = { ...ctx, ...next };
  if (next.theme) applyDocumentTheme(next.theme);
  if (next.styles?.variables) applyHostStyleVariables(next.styles.variables);
  if (next.styles?.css?.fonts) applyHostFonts(next.styles.css.fonts);
  const inset = ctx.safeAreaInsets;
  if (inset) root.style.padding = `${inset.top}px ${inset.right}px ${inset.bottom}px ${inset.left}px`;
  if (next.displayMode && next.displayMode !== before && next.displayMode === "fullscreen") void refresh().then(tellModel);
}

app.addEventListener("hostcontextchanged", (changed) => { applyContext(changed); render(); });
app.addEventListener("toolinputpartial", (p) => { if (!card && typeof p.arguments?.agent === "string") { pendingName = p.arguments.agent; render(); } });
app.addEventListener("toolinput", (p) => { if (!card && typeof p.arguments?.agent === "string") { pendingName = p.arguments.agent; render(); } });
app.addEventListener("toolresult", (result) => {
  if (result.isError) {
    error = result.content?.map((x) => ("text" in x ? x.text : "")).join(" ") || "error";
  } else {
    card = undefined;
    adopt(result.structuredContent);
    joinElection();
  }
  render();
});

render();
await app.connect();
applyContext(app.getHostContext() ?? {});
render();
