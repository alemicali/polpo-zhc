/**
 * The coding chat card's view: DOM from a card (src/server/mcp-coding-card.ts) with no host wiring,
 * so it can be tested in a DOM (ui/tests/mcp-coding-card.test.ts). main.ts connects it to the host.
 *
 *   header      the session's title, the program and model, status, worktree and tokens
 *   transcript  the latest messages: the person's, the program's text, one line per tool call
 *   approvals   risky actions waiting: approve / deny (the owner's call)
 */
import type { CodingCard, CodingCardApproval, CodingCardMessage } from "../../src/server/mcp-coding-card.js";

export const STRINGS = {
  en: {
    open: "Open", refresh: "Refresh", ask: "Ask about it", approve: "Approve", deny: "Deny", you: "You", whileWorking: "while it worked",
    working: "Working…", earlier: (n: number) => `${n} earlier message${n === 1 ? "" : "s"}`, waiting: "Waiting for your approval",
    status: { idle: "Idle", running: "Running", "awaiting-approval": "Needs approval", error: "Error" } as Record<string, string>,
    tokens: (n: number) => `${n.toLocaleString()} tokens`, turns: (n: number) => `${n} turn${n === 1 ? "" : "s"}`,
    error: "Could not load the card", superseded: "There is a newer card for this below", empty: "No messages yet",
    askAbout: (title: string) => `Summarize the coding session "${title}": what did it change, and what is left?`,
  },
  it: {
    open: "Apri", refresh: "Aggiorna", ask: "Chiedi", approve: "Approva", deny: "Rifiuta", you: "Tu", whileWorking: "mentre lavorava",
    working: "Sta lavorando…", earlier: (n: number) => `${n} messagg${n === 1 ? "io" : "i"} precedent${n === 1 ? "e" : "i"}`, waiting: "In attesa della tua approvazione",
    status: { idle: "In attesa", running: "In corso", "awaiting-approval": "Da approvare", error: "Errore" } as Record<string, string>,
    tokens: (n: number) => `${n.toLocaleString()} token`, turns: (n: number) => `${n} turn${n === 1 ? "o" : "i"}`,
    error: "Non riesco a caricare la scheda", superseded: "C'è una scheda più recente più sotto", empty: "Ancora nessun messaggio",
    askAbout: (title: string) => `Riassumi la sessione di coding "${title}": cosa ha cambiato e cosa resta da fare?`,
  },
};
export type Strings = typeof STRINGS.en;
export const stringsFor = (locale: string | undefined): Strings => ((locale ?? "en").toLowerCase().startsWith("it") ? STRINGS.it : STRINGS.en) as Strings;

export interface ViewEnv {
  card?: CodingCard;
  pending?: string;
  error?: string;
  locale?: string;
  full: boolean;
  canFullscreen: boolean;
  busy: boolean;
  superseded: boolean;
  onOpen?: () => void;
  onAsk?: () => void;
  onRefresh?: () => void;
  /** Answer an approval waiting. */
  onDecide?: (approvalId: string, decision: "approve" | "deny") => void;
}

let env: ViewEnv = { full: false, canFullscreen: false, busy: false, superseded: false };

type Child = Node | string | false | null | undefined;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false || v === null) continue;
    if (k === "class") el.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== false && c !== null && c !== undefined) el.append(c);
  return el;
}

const STATUS_CHIP: Record<string, string> = { running: "chip-info", "awaiting-approval": "chip-warning", error: "chip-danger" };

function messageView(str: Strings, m: CodingCardMessage, program: string): HTMLElement {
  if (m.role === "user") {
    return h("div", { class: "msg msg-user", "data-message": m.id },
      h("div", { class: "msg-who" }, m.steer ? `${str.you} · ${str.whileWorking}` : str.you),
      h("div", { class: "msg-text" }, m.text ?? ""));
  }
  return h("div", { class: "msg msg-assistant", "data-message": m.id },
    h("div", { class: "msg-who" }, m.streaming ? `${program} · ${str.working}` : program),
    ...(m.tools ?? []).map((t) => h("div", { class: `tool tool-${t.state}`, "data-tool": t.name },
      h("span", { class: "mono" }, t.summary),
      t.added !== undefined ? h("span", { class: "diffstat" }, h("span", { class: "add" }, `+${t.added}`), " ", h("span", { class: "del" }, `−${t.removed}`)) : null)),
    m.text ? h("div", { class: "msg-text" }, m.text) : null,
    m.error ? h("p", { class: "danger small" }, m.error) : null);
}

function approvalView(str: Strings, a: CodingCardApproval): HTMLElement {
  return h("section", { class: "approval", "data-approval": a.id },
    h("div", { class: "section-title" }, str.waiting),
    h("pre", { class: "code" }, a.summary),
    h("p", { class: "muted small" }, a.reason),
    h("div", { class: "actions" },
      h("button", { class: "btn btn-primary", disabled: env.superseded || env.busy, onclick: () => env.onDecide?.(a.id, "approve") }, str.approve),
      h("button", { class: "btn", disabled: env.superseded || env.busy, onclick: () => env.onDecide?.(a.id, "deny") }, str.deny)));
}

export function cardView(c: CodingCard, str: Strings): HTMLElement {
  const s = c.session;
  const program = s.kind === "claude" ? "Claude Code" : "Codex";
  return h("div", { class: env.full ? "full" : "card", "data-chat": s.id },
    h("div", { class: "head" },
      h("div", { class: "who" },
        h("div", { class: "name" }, s.title),
        h("div", { class: "role" }, [program, s.model, s.branch].filter(Boolean).join(" · "))),
      h("span", { class: `chip ${STATUS_CHIP[s.status] ?? ""}`, "data-status": s.status }, str.status[s.status] ?? s.status)),
    h("p", { class: "muted small mono" }, `${s.cwd} · ${str.turns(s.turns)} · ${str.tokens(s.totalTokens)}`),
    s.lastError ? h("p", { class: "danger small" }, s.lastError) : null,
    c.earlier ? h("p", { class: "muted small" }, str.earlier(c.earlier)) : null,
    c.messages.length ? h("div", { class: "transcript" }, ...c.messages.map((m) => messageView(str, m, program))) : h("p", { class: "muted empty" }, str.empty),
    ...c.approvals.map((a) => approvalView(str, a)),
    h("div", { class: "actions" },
      env.canFullscreen && !env.full ? h("button", { class: "btn", disabled: env.superseded, onclick: () => env.onOpen?.() }, str.open) : null,
      h("button", { class: "btn", disabled: env.superseded, onclick: () => env.onAsk?.() }, str.ask),
      h("button", { class: "btn", disabled: env.superseded || env.busy, onclick: () => env.onRefresh?.() }, str.refresh)));
}

function skeleton(): HTMLElement {
  return h("div", { class: "card", "aria-busy": "true" },
    h("div", { class: "head" }, h("div", { class: "who" }, h("div", { class: "sk sk-line w40" }), h("div", { class: "sk sk-line w60" }))),
    h("div", { class: "sk sk-line w80" }), h("div", { class: "sk sk-line w55" }));
}

/** Draw the card into root. */
export function renderView(root: HTMLElement, next: ViewEnv): void {
  env = next;
  const str = stringsFor(env.locale);
  root.className = env.superseded ? "is-superseded" : "";
  root.replaceChildren(
    env.superseded ? h("div", { class: "banner" }, str.superseded) : "",
    env.error && !env.card ? h("div", { class: "card" }, h("p", { class: "danger" }, `${str.error}: ${env.error}`)) : "",
    !env.card && !env.error ? skeleton() : "",
    env.card ? cardView(env.card, str) : "",
    env.card && env.error ? h("p", { class: "danger small" }, env.error) : "",
  );
}
