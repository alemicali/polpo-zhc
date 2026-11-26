/**
 * Ask Polpo from the search palette (⌘K → Enter on "Ask Polpo", or ⌘/Ctrl ↵): what the dashboard
 * decides on its own, before and after the server (POST /api/v1/search/ask, useSearchAsk).
 *
 * - the fast path: "vai agli artefatti", "apri le impostazioni dei canali", "go to tasks" name a
 *   page exactly → opened at once, no model (the server has the same rule for API callers);
 * - which palette commands only change the view (run at once when Polpo picks them) and which
 *   change data or send a message (only ever a button the person clicks);
 * - which intents run at once: navigation to a dashboard route, a view command. Nothing else.
 */
import type { SearchAskCommand, SearchAskIntent, SearchAskPage } from "@polpo-ai/react";
import { foldText, type PageEntry } from "@/lib/global-search";

// ── Fast path ───────────────────────────────────────────────────────────

const NAV_VERB = /^(?:vai|va|andiamo|portami|apri|aprimi|mostra|mostrami|fammi vedere|go|goto|open|show|show me|take me|navigate)\b\s*/;
const FILLER = new Set(["a", "ad", "al", "allo", "alla", "alle", "ai", "agli", "all", "in", "nel", "nella", "nelle", "nei", "negli", "su", "sul", "sulla", "sulle", "sui", "sugli",
  "il", "lo", "la", "le", "i", "gli", "l", "un", "una", "pagina", "sezione", "di", "dei", "delle", "degli", "del", "della", "mie", "miei", "mio", "mia",
  "to", "the", "my", "page", "section", "of", "into", "up", "me"]);
const ALIASES: Record<string, string> = {
  artefatti: "artifacts", artifatti: "artifacts", artefatto: "artifacts", artifacts: "artifacts", artifact: "artifacts",
  attivita: "tasks", compiti: "tasks", task: "tasks", missioni: "missions", missione: "missions", mission: "missions",
  agenti: "agents", agente: "agents", agent: "agents", pianificazioni: "schedules", programmazioni: "schedules", schedule: "schedules", webhook: "triggers", webhooks: "triggers", trigger: "triggers", decisioni: "decisions", decisione: "decisions", decision: "decisions", immagini: "media", immagine: "media", images: "media", image: "media",
  eventi: "events", approvazioni: "approvals", approvazione: "approvals", abilita: "skills", competenze: "skills", skill: "skills",
  memoria: "memory", dati: "data", cervello: "brain", aziendale: "company", strumenti: "tools", calcolatori: "computers",
  impostazioni: "settings", configurazione: "settings", config: "settings", preferenze: "settings",
  canali: "channels", canale: "channels", connettori: "connectors", connettore: "connectors", notifiche: "notifications",
  fornitori: "providers", modelli: "providers", membri: "members", aspetto: "appearance", tema: "appearance", generale: "general", generali: "general",
  criteri: "policies", regole: "rules", sincronizzazione: "sync", conversazioni: "chat", chats: "chat", novita: "what s new",
  computer: "computers", orchestratore: "orchestrator", polpo: "orchestrator", cruscotto: "dashboard", home: "dashboard", files: "files", file: "files",
};

const folded = (s: string) => foldText(s).replace(/['’]/g, " ").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
const normalWords = (s: string) => folded(s).split(" ").filter((w) => w && !FILLER.has(w)).map((w) => ALIASES[w] ?? w).join(" ");
const isSettingsPage = (p: Pick<PageEntry, "to" | "section">) => p.to.startsWith("/config") || /^settings/i.test(p.section ?? "");

/** The page an obvious "go to X" / "vai a X" names exactly, or null (then Polpo's model decides). */
export function matchNavigation<P extends Pick<PageEntry, "label" | "to" | "section">>(q: string, pages: P[]): P | null {
  const text = folded(q);
  const verb = NAV_VERB.exec(text);
  if (!verb) return null;
  const target = normalWords(text.slice(verb[0].length));
  if (!target) return null;
  const hits = pages.filter((p) => {
    const label = normalWords(p.label);
    return target === label || (isSettingsPage(p) && (target === `${label} settings` || target === `settings ${label}`));
  });
  if (!hits.length) return null;
  return hits.find((p) => !isSettingsPage(p) || /settings/.test(target)) ?? hits[0]!;
}

/** Reads like a request for Polpo (a question, a sentence, "go to…") rather than words to find. */
export function looksLikeRequest(q: string): boolean {
  const t = q.trim();
  if (!t) return false;
  if (/\?$/.test(t)) return true;
  if (NAV_VERB.test(folded(t))) return true;
  if (/^(come|dove|quale|quali|quando|perche|chi|cosa|che|mostrami|trova|cerca|how|where|which|what|when|why|who|find|show|list|can you|puoi)\b/i.test(folded(t))) return true;
  return t.split(/\s+/).length >= 4;
}

// ── Commands ────────────────────────────────────────────────────────────

/** Palette commands that only change the view (or this browser): Polpo may run them at once. */
const VIEW_COMMANDS = new Set(["theme", "theme-system", "sidebar", "whats-new", "new-group", "clear-recents"]);

export function isViewCommand(id: string): boolean {
  return VIEW_COMMANDS.has(id) || id.startsWith("settings-");
}

/** The palette's commands as the assistant sees them (those that change data: confirm). */
export function askCommands(actions: Array<{ id: string; label: string; hint?: string; argument?: unknown }>): SearchAskCommand[] {
  return actions.map((a) => ({ id: a.id, label: a.label, ...(a.hint ? { hint: a.hint } : {}), ...(a.argument ? { argument: true } : {}), ...(isViewCommand(a.id) ? {} : { confirm: true }) }));
}

export function askPages(pages: PageEntry[]): SearchAskPage[] {
  return pages.map((p) => ({ id: p.id, label: p.label, to: p.to, section: p.section }));
}

// ── Intents ─────────────────────────────────────────────────────────────

/** A dashboard route (relative, no scheme or other host). */
export function isDashboardRoute(route: unknown): route is string {
  return typeof route === "string" && route.startsWith("/") && !route.startsWith("//") && !/[\\\s]/.test(route) && !/^\/[^/?#]*:/.test(route);
}

/**
 * The intent to run at once after an answer, if any: the first navigation (to a dashboard route)
 * or view-only command. Anything else waits for a click, whatever the server said.
 */
export function automaticIntent(intents: SearchAskIntent[]): SearchAskIntent | null {
  for (const i of intents) {
    if (!i.auto) continue;
    if ((i.kind === "navigate" || i.kind === "open") && isDashboardRoute(i.route)) return i;
    if (i.kind === "command" && isViewCommand(i.id)) return i;
  }
  return null;
}
