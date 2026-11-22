/**
 * The task and mission cards' view: DOM from a card (src/server/mcp-work-card.ts), with no host
 * wiring, so it can be tested in a DOM (ui/tests/mcp-widgets.test.ts). main.ts connects it to the
 * MCP host.
 */
import type { CardTaskRef, MissionCard, TaskCard, WorkCard } from "../../src/server/mcp-work-card.js";
import type { RunView } from "../../src/server/mcp-run-view.js";
import { brandMark } from "../shared/brand.js";

// ── Text ─────────────────────────────────────────────────────────────────

export const STRINGS = {
  en: {
    open: "Open", refresh: "Refresh", updated: "Updated",
    askTask: (t: string, failed: boolean) => failed ? `Why did the task "${t}" fail, and what should change before it runs again?` : `How is the task "${t}" going?`,
    askMission: (n: string) => `How is the mission "${n}" going, and what has it cost so far?`,
    ask: "Ask about it", agent: "Agent", failed: "Failed", notRetried: "Not retried", notRetriedWhy: "a re-run would fail the same way",
    tools: "Tools", toolsRestricted: "Tools restricted", staleScope: "the agent no longer has",
    lastRun: "Latest run", runs: "Runs", noRuns: "Not run yet", dependsOn: "Depends on", result: "Result", outcomes: "Outcomes",
    cost: "Cost", budget: "Budget", noBudget: "No budget", overBudget: "Over budget", pausedBudget: "Paused: over budget",
    byEngine: "By engine", byAgent: "By agent", tasks: "Tasks", noTasks: "No tasks yet", runsN: (n: number) => `${n} run${n === 1 ? "" : "s"}`,
    egress: "egress", direct: "direct", resumed: "resumed session", newSession: "new session", via: "via", on: "on",
    of: "of", left: "left", partial: "older runs not counted", superseded: "There is a newer card for this below",
    kind: { model_access: "Model not enabled", auth: "Authentication", budget: "Spend limit", killed: "Stopped", assessment: "Review", error: "Error" } as Record<string, string>,
    status: { pending: "Pending", assigned: "Assigned", in_progress: "In progress", review: "In review", done: "Done", failed: "Failed", awaiting_approval: "To approve", draft: "Draft", missing: "Missing", running: "Running", completed: "Completed", killed: "Stopped", active: "Active", paused: "Paused", cancelled: "Cancelled", scheduled: "Scheduled", recurring: "Recurring" } as Record<string, string>,
    error: "Could not load the card",
  },
  it: {
    open: "Apri", refresh: "Aggiorna", updated: "Aggiornato",
    askTask: (t: string, failed: boolean) => failed ? `Perché il task "${t}" è fallito, e cosa va cambiato prima di rilanciarlo?` : `Come sta andando il task "${t}"?`,
    askMission: (n: string) => `Come sta andando la missione "${n}", e quanto è costata finora?`,
    ask: "Chiedi", agent: "Agente", failed: "Fallito", notRetried: "Non ritentato", notRetriedWhy: "un nuovo tentativo fallirebbe allo stesso modo",
    tools: "Strumenti", toolsRestricted: "Strumenti ristretti", staleScope: "l'agente non ha più",
    lastRun: "Ultima esecuzione", runs: "Esecuzioni", noRuns: "Non ancora eseguito", dependsOn: "Dipende da", result: "Risultato", outcomes: "Risultati",
    cost: "Costo", budget: "Budget", noBudget: "Nessun budget", overBudget: "Oltre il budget", pausedBudget: "In pausa: oltre il budget",
    byEngine: "Per motore", byAgent: "Per agente", tasks: "Task", noTasks: "Ancora nessun task", runsN: (n: number) => `${n} esecuzion${n === 1 ? "e" : "i"}`,
    egress: "uscita", direct: "diretta", resumed: "sessione ripresa", newSession: "nuova sessione", via: "via", on: "su",
    of: "di", left: "restanti", partial: "esecuzioni più vecchie non contate", superseded: "C'è una scheda più recente più sotto",
    kind: { model_access: "Modello non abilitato", auth: "Autenticazione", budget: "Limite di spesa", killed: "Fermato", assessment: "Verifica", error: "Errore" } as Record<string, string>,
    status: { pending: "In coda", assigned: "Assegnato", in_progress: "In corso", review: "In verifica", done: "Fatto", failed: "Fallito", awaiting_approval: "Da approvare", draft: "Bozza", missing: "Mancante", running: "In corso", completed: "Completata", killed: "Fermata", active: "Attiva", paused: "In pausa", cancelled: "Annullata", scheduled: "Programmata", recurring: "Ricorrente" } as Record<string, string>,
    error: "Non riesco a caricare la scheda",
  },
};
export type Strings = typeof STRINGS.en;


/** What the view needs from the host and the card's state. */
export interface ViewEnv {
  card?: WorkCard;
  /** The id being loaded (skeleton). */
  pending?: string;
  error?: string;
  locale?: string;
  timeZone?: string;
  /** Full screen. */
  full: boolean;
  canFullscreen: boolean;
  busy: boolean;
  superseded: boolean;
  onOpen?: () => void;
  onAsk?: () => void;
  onRefresh?: () => void;
}

let env: ViewEnv = { full: false, canFullscreen: false, busy: false, superseded: false };

export const stringsFor = (locale: string | undefined): Strings => ((locale ?? "en").toLowerCase().startsWith("it") ? STRINGS.it : STRINGS.en) as Strings;

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
  const locale = env.locale ?? navigator.language;
  const sameDay = d.toLocaleDateString("en-CA", { timeZone: env.timeZone }) === new Date().toLocaleDateString("en-CA", { timeZone: env.timeZone });
  const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", timeZone: env.timeZone });
  return sameDay ? time : `${d.toLocaleDateString(locale, { day: "numeric", month: "short", timeZone: env.timeZone })} ${time}`;
}

const usd = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? "" : v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
const dur = (ms: number | undefined) => (ms === undefined ? "" : ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
const tone = (s: string) => (s === "done" || s === "completed" ? "success" : s === "failed" || s === "missing" || s === "killed" ? "danger" : s === "awaiting_approval" || s === "paused" ? "warning" : ["in_progress", "assigned", "review", "running", "active"].includes(s) ? "info" : "neutral");
const chip = (s: Strings, status: string, small = true) => h("span", { class: `chip${small ? " chip-sm" : ""} chip-${tone(status)}` }, s.status[status] ?? status);

function bar(used: number, label: string, over: boolean): HTMLElement {
  const pct = Math.round(used * 100);
  return h("div", { class: `bar${over ? " bar-over" : ""}`, role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": label },
    h("div", { class: "bar-fill", style: { width: `${Math.min(100, Math.max(0, pct))}%` } }));
}

// ── Pieces ───────────────────────────────────────────────────────────────

/** Engine + model, auth, computer and cost of a run, with their marks. */
function runLine(r: Pick<RunView, "engine" | "engineLabel" | "engineMark" | "modelLabel" | "computer"> & Partial<RunView>, s: Strings, detail = false): HTMLElement {
  const computer = r.computer;
  return h("div", { class: "run" },
    h("span", { class: "marks" }, brandMark(r.engineMark, 16), h("span", { class: "run-engine" }, r.engineLabel), r.modelLabel ? h("span", { class: "muted" }, r.modelLabel) : null),
    r.auth ? h("span", { class: "marks" }, h("span", { class: "muted" }, s.via), brandMark(r.auth.mark, 14), h("span", {}, `${r.auth.label}${r.auth.region ? ` (${r.auth.region})` : ""}`)) : null,
    h("span", { class: "marks" }, h("span", { class: "muted" }, s.on), brandMark(computer.mark, 14), h("span", {}, computer.label), computer.kindLabel !== "Host" ? h("span", { class: "muted" }, computer.kindLabel) : null),
    detail && r.egress ? h("span", { class: "marks" }, r.egress.tailscale ? brandMark("tailscale", 14) : null, h("span", { class: "muted" }, `${s.egress} ${r.egress.mode === "proxy" ? r.egress.label : s.direct}`)) : null,
    detail && r.session ? h("span", { class: "muted" }, `${r.session.resumed ? s.resumed : s.newSession}${r.session.bootstrapMs !== undefined ? ` (${dur(r.session.bootstrapMs)})` : ""}`) : null,
    r.costUsd !== undefined ? h("span", { class: "run-cost" }, `${usd(r.costUsd)}${r.budgetUsd ? ` ${s.of} $${r.budgetUsd}` : ""}`) : null,
    detail && r.durationMs !== undefined ? h("span", { class: "muted" }, dur(r.durationMs)) : null);
}

function failureBox(f: NonNullable<CardTaskRef["failure"]>, s: Strings): HTMLElement {
  return h("div", { class: "failure", role: "alert" },
    h("div", { class: "failure-head" },
      h("span", { class: "chip chip-sm chip-danger" }, s.kind[f.kind] ?? f.kind),
      !f.retryable ? h("span", { class: "chip chip-sm chip-warning", title: s.notRetriedWhy }, s.notRetried) : null),
    h("p", { class: "failure-text" }, f.reason));
}

function taskRow(x: CardTaskRef & { lastRun?: MissionCard["tasks"][number]["lastRun"]; costUsd?: number }, s: Strings): HTMLElement {
  return h("div", { class: "row" },
    h("div", { class: "row-main" },
      h("div", {}, x.title, x.toolScoped ? h("span", { class: "chip chip-sm chip-info" }, s.toolsRestricted) : null),
      h("div", { class: "muted small marks" },
        x.lastRun ? brandMark(x.lastRun.engineMark, 14) : null,
        [x.assignTo, x.lastRun ? `${x.lastRun.engineLabel}${x.lastRun.modelLabel ? ` ${x.lastRun.modelLabel}` : ""}` : "", x.lastRun ? x.lastRun.computer.label : "", usd(x.costUsd)].filter(Boolean).join(" · ")),
      x.failure ? h("div", { class: "small danger-text" }, `${x.failure.reason}${x.failure.retryable ? "" : ` (${s.notRetried.toLowerCase()})`}`) : null),
    chip(s, x.status));
}

function header(title: string, subtitle: string, status: string, s: Strings, extra?: Child): HTMLElement {
  return h("div", { class: "head" },
    h("div", { class: "who" }, h("div", { class: "name" }, title), h("div", { class: "role" }, subtitle)),
    extra, chip(s, status, false));
}

function actions(s: Strings): HTMLElement {
  return h("div", { class: "actions" },
    env.canFullscreen && !env.full ? h("button", { class: "btn btn-primary", disabled: env.superseded, onclick: () => env.onOpen?.() }, s.open) : null,
    h("button", { class: "btn", disabled: env.superseded, onclick: () => env.onAsk?.() }, s.ask),
    h("button", { class: "btn", disabled: env.superseded || env.busy, onclick: () => env.onRefresh?.() }, s.refresh));
}

// ── Task card ────────────────────────────────────────────────────────────

export function taskView(c: TaskCard, s: Strings, full: boolean): HTMLElement {
  const tk = c.task;
  const last = c.runs[0];
  const facts: Array<[string, Node | string]> = [];
  if (tk.assignTo) facts.push([s.agent, tk.assignTo]);
  if (c.toolScope) facts.push([s.tools, h("span", { class: "scope" }, c.toolScope.label, c.toolScope.stale?.length ? h("span", { class: "small danger-text" }, ` · ${s.staleScope}: ${c.toolScope.stale.join("; ")}`) : null)]);
  facts.push([s.lastRun, last ? runLine(last, s, full) : s.noRuns]);
  if (c.costUsd !== undefined) facts.push([s.cost, `${usd(c.costUsd)} · ${s.runsN(c.runs.length)}`]);
  if (c.dependencies.length) facts.push([s.dependsOn, h("div", { class: "deps" }, ...c.dependencies.map((d) => h("span", { class: "dep" }, d.title, chip(s, d.status))))]);
  return h("div", { class: full ? "full" : "card" },
    header(tk.title, [tk.id, tk.group].filter(Boolean).join(" · "), tk.status, s,
      c.toolScope ? h("span", { class: "chip chip-info", title: c.toolScope.label }, s.toolsRestricted) : null),
    tk.failure ? failureBox(tk.failure, s) : null,
    h("dl", { class: "facts" }, ...facts.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
    full && c.runs.length > 1 ? h("section", {}, h("h3", {}, s.runs), ...c.runs.map((r) => h("div", { class: "row" },
      h("div", { class: "row-main" }, runLine(r, s, true), h("div", { class: "muted small" }, `${r.runId} · ${formatTime(r.startedAt)}`)), chip(s, r.status)))) : null,
    full && c.result?.text ? h("section", {}, h("h3", {}, s.result), h("p", { class: "prose" }, c.result.text)) : null,
    full && c.outcomes.length ? h("section", {}, h("h3", {}, s.outcomes), ...c.outcomes.map((o) => h("div", { class: "row" }, h("div", { class: "row-main" }, h("div", {}, o.label), o.ref ? h("div", { class: "muted small" }, o.ref) : null), h("span", { class: "chip chip-sm" }, o.type)))) : null,
    actions(s),
    full ? h("p", { class: "muted small foot" }, `${s.updated} ${formatTime(c.generatedAt)}`) : null);
}

// ── Mission card ─────────────────────────────────────────────────────────

function costBlock(c: MissionCard, s: Strings, full: boolean): HTMLElement | null {
  const cost = c.cost;
  if (!cost) return null;
  const over = !!cost.overBudget;
  return h("div", { class: "cost" },
    h("div", { class: "cost-line" },
      h("span", { class: "cost-n" }, `${usd(cost.usd)}${cost.partial ? "+" : ""}`),
      cost.budgetUsd !== undefined
        ? h("span", { class: over ? "danger-text" : "muted" }, `${s.of} ${usd(cost.budgetUsd)}${over ? ` · ${s.overBudget}` : cost.remainingUsd !== undefined ? ` · ${usd(cost.remainingUsd)} ${s.left}` : ""}`)
        : h("span", { class: "muted" }, s.noBudget),
      h("span", { class: "muted small" }, s.runsN(cost.runs))),
    cost.budgetUsd !== undefined ? bar(cost.budgetUsed ?? 0, s.budget, over) : null,
    cost.byEngine.length ? h("div", { class: "chips" }, ...cost.byEngine.map((e) => h("span", { class: "chip marks" }, brandMark(e.mark, 14), `${e.label} ${usd(e.usd)}`))) : null,
    full && cost.byAgent.length ? h("section", {}, h("h3", {}, s.byAgent), ...cost.byAgent.map((a) => h("div", { class: "row" }, h("div", { class: "row-main" }, a.agent), h("span", { class: "muted small" }, `${usd(a.usd)} · ${s.runsN(a.runs)}`)))) : null,
    cost.partial ? h("p", { class: "muted small" }, `+ ${s.partial}`) : null);
}

export function missionView(c: MissionCard, s: Strings, full: boolean): HTMLElement {
  const m = c.mission;
  const counts = Object.entries(c.counts).map(([k, v]) => `${v} ${(s.status[k] ?? k).toLowerCase()}`).join(" · ");
  const tasks = full ? c.tasks : [...c.tasks.filter((x) => x.status === "failed"), ...c.tasks.filter((x) => x.status !== "failed")].slice(0, 6);
  return h("div", { class: full ? "full" : "card" },
    header(m.name, [m.id, counts].filter(Boolean).join(" · "), m.status, s,
      m.pauseReason === "budget" ? h("span", { class: "chip chip-warning" }, s.pausedBudget) : null),
    m.goal && full ? h("p", { class: "prose" }, m.goal) : null,
    costBlock(c, s, full),
    h("section", {}, h("h3", {}, s.tasks), tasks.length ? h("div", {}, ...tasks.map((x) => taskRow(x, s))) : h("p", { class: "muted empty" }, s.noTasks)),
    actions(s),
    full ? h("p", { class: "muted small foot" }, `${s.updated} ${formatTime(c.generatedAt)}`) : null);
}

// ── Render ───────────────────────────────────────────────────────────────

function skeleton(): HTMLElement {
  return h("div", { class: "card", "aria-busy": "true" },
    h("div", { class: "head" }, h("div", { class: "who" }, env.pending ? h("div", { class: "name" }, env.pending) : h("div", { class: "sk sk-line w40" }), h("div", { class: "sk sk-line w25" }))),
    h("div", { class: "facts" }, ...[70, 55, 80].map((w) => h("div", { class: `sk sk-line w${w}` }))));
}

/** Render the card (or its skeleton, or the error) into `root`. */
export function renderView(root: HTMLElement, next: ViewEnv): void {
  env = next;
  const s = stringsFor(env.locale ?? navigator.language);
  const c = env.card;
  root.replaceChildren(
    env.superseded ? h("div", { class: "banner" }, s.superseded) : "",
    env.error && !c ? h("div", { class: "card" }, h("p", { class: "danger" }, `${s.error}: ${env.error}`))
      : c ? (c.kind === "mission" ? missionView(c, s, env.full) : taskView(c, s, env.full)) : skeleton(),
  );
  root.classList.toggle("is-superseded", env.superseded);
  root.classList.toggle("is-full", env.full);
}
