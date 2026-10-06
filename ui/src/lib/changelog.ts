/**
 * "Novità" — what changed in the app, newest first.
 *
 * Shown on /changelog and, for `highlight` entries the person has not seen
 * yet, in the What's new banner (Dashboard, empty chat). Seen state is kept
 * per entry id (see hooks/use-whats-new.ts), so ids must never change once
 * shipped. Add new entries at the top.
 */

export type ChangelogKind = "new" | "improved" | "fixed";

export interface ChangelogEntry {
  /** Stable id — used to remember what the person has already seen. */
  id: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  kind: ChangelogKind;
  title: string;
  /** One line, shown in the banner. */
  summary: string;
  /** Markdown, shown on the changelog page. */
  body: string;
  /** Promote in the What's new banner until seen. */
  highlight?: boolean;
  cta?: { label: string; to: string };
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    id: "2026-10-06-events",
    date: "2026-10-06",
    kind: "improved",
    title: "Activity e Logs diventano Events",
    summary: "Una sola pagina per tutto quello che succede: Live e History.",
    body: [
      "Polpo funziona a **eventi**: ogni cosa che succede (un task che cambia stato, un agente che parte o finisce, una missione, un'approvazione, una notifica…) è un evento.",
      "",
      "- **Events → Live**: gli eventi mentre succedono.",
      "- **Events → History**: gli eventi salvati, una sessione per ogni avvio del server.",
      "- I messaggi testuali del server ora si chiamano **System**.",
      "- Nel dettaglio di un task, quello che ha fatto l'agente passo per passo è la scheda **Execution**.",
      "",
      "La trovi nel menu, sotto System.",
    ].join("\n"),
    cta: { label: "Apri Events", to: "/events" },
  },
  {
    id: "2026-10-06-group-chats",
    date: "2026-10-06",
    kind: "new",
    highlight: true,
    title: "Chat di gruppo con più agenti",
    summary: "Una sola conversazione con te e più agenti: rispondono quando il messaggio è per loro.",
    body: [
      "Ora puoi aprire una conversazione con te e **più agenti insieme**, direttamente dalla Chat.",
      "",
      "- Un agente risponde se lo **menzioni con @nome**, oppure quando il messaggio è per lui: un classificatore veloce decide chi deve rispondere.",
      "- Gli agenti possono rispondere **tutti insieme** o **uno dopo l'altro**, ognuno vedendo la risposta precedente.",
      "- Tutto si regola dalle **impostazioni del gruppo** (l'ingranaggio in alto nella conversazione).",
      "",
      "Per iniziare: nella Chat apri il menu dell'agente (\"Chat with …\") e scegli **Group chat…**, oppure premi **+ → New group** nell'elenco delle conversazioni. I gruppi compaiono in cima allo stesso elenco.",
    ].join("\n"),
    cta: { label: "Crea un gruppo", to: "/chat?newGroup=1" },
  },
  {
    id: "2026-10-06-agent-to-agent",
    date: "2026-10-06",
    kind: "new",
    highlight: true,
    title: "Gli agenti si parlano tra loro",
    summary: "Un agente può chiedere a un altro con @nome e quello risponde, sul web e nei gruppi Telegram.",
    body: [
      "Un agente può rivolgersi a un collega scrivendo **@nome**: l'altro agente risponde nella stessa conversazione, sia nei gruppi sul web sia nei **gruppi Telegram**.",
      "",
      "Ci sono dei freni per evitare discussioni infinite:",
      "",
      "- al massimo **3 passaggi** tra agenti dopo ogni tuo messaggio (si può cambiare nelle impostazioni del gruppo);",
      "- **un tuo messaggio ferma la catena** e si riparte da quello che hai scritto.",
    ].join("\n"),
  },
  {
    id: "2026-10-06-ink-hub",
    date: "2026-10-06",
    kind: "new",
    title: "Polpo Ink Hub è di nuovo attivo",
    summary: "Il catalogo dei template (agenti, playbook, company) ora gira sul nostro server.",
    body: [
      "Il catalogo **Polpo Ink Hub** è tornato: lo trovi dal link nel menu laterale.",
      "",
      "- Elenca tutti i template del nostro registry privato: **agenti**, **playbook** e **company** (configurazioni complete con team e skill).",
      "- Gli agenti e Polpo possono cercarli e installarli con gli strumenti Ink, e nuovi template compaiono da soli quando vengono aggiunti al registry.",
      "- Per ora è raggiungibile solo dalla rete interna (Tailscale).",
    ].join("\n"),
  },
  {
    id: "2026-10-06-telegram-intent",
    date: "2026-10-06",
    kind: "new",
    title: "Telegram: risposte per intento",
    summary: "Nei gruppi Telegram gli agenti rispondono anche senza menzione quando il messaggio è per loro.",
    body: [
      "Nei gruppi Telegram non serve più menzionare sempre l'agente: risponde anche **senza @** quando il messaggio è chiaramente per lui.",
      "",
      "- La **soglia** con cui l'agente decide di rispondere è configurabile.",
      "- Serve la **privacy mode disattivata** nel bot (BotFather → /setprivacy → Disable), altrimenti il bot vede solo comandi e risposte.",
      "- Se nel gruppo ci sei **solo tu e un agente**, l'agente risponde sempre.",
    ].join("\n"),
  },
  {
    id: "2026-10-06-telegram-memory",
    date: "2026-10-06",
    kind: "improved",
    title: "Telegram: i gruppi ricordano la conversazione",
    summary: "Un unico trascritto per gruppo: ogni agente sa cosa hanno risposto gli altri.",
    body: [
      "Ogni gruppo Telegram ha ora **un unico trascritto salvato**, condiviso da tutti gli agenti del gruppo.",
      "",
      "Così ogni agente sa **cosa hanno già risposto gli altri** e **chi c'è nel gruppo**, e non ripete cose già dette.",
    ].join("\n"),
  },
  {
    id: "2026-10-05-models-pi-1-0-4",
    date: "2026-10-05",
    kind: "improved",
    title: "Nuovi modelli",
    summary: "Aggiornato il motore dei modelli: disponibili Claude Opus 5.5 e GPT-6 Sol tra gli altri.",
    body: [
      "Abbiamo aggiornato il motore dei modelli (**pi 1.0.4**).",
      "",
      "Tra le novità sono disponibili **Claude Opus 5.5** e **GPT-6 Sol**: li trovi nella scelta del modello di ogni agente.",
    ].join("\n"),
  },
];

export const CHANGELOG_KIND_LABEL: Record<ChangelogKind, string> = {
  new: "Nuovo",
  improved: "Migliorato",
  fixed: "Corretto",
};

/** Entries the person has not seen yet, newest first. */
export function unseenEntries(entries: ChangelogEntry[], seen: ReadonlySet<string>): ChangelogEntry[] {
  return entries.filter((entry) => !seen.has(entry.id));
}

/** Highlighted entries the person has not seen yet, newest first. */
export function unseenHighlights(entries: ChangelogEntry[], seen: ReadonlySet<string>): ChangelogEntry[] {
  return entries.filter((entry) => entry.highlight && !seen.has(entry.id));
}

/** "2026-10-06" → a local Date (no timezone shift). */
export function changelogDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d) : new Date(iso);
}

const DATE_FORMAT = new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "long", year: "numeric" });

/** "6 ottobre 2026" */
export function formatChangelogDate(iso: string): string {
  const date = changelogDate(iso);
  return Number.isNaN(date.getTime()) ? iso : DATE_FORMAT.format(date);
}

/** Entries grouped by date, newest date first (keeps the order inside a day). */
export function groupChangelogByDate(entries: ChangelogEntry[]): { date: string; entries: ChangelogEntry[] }[] {
  const groups: { date: string; entries: ChangelogEntry[] }[] = [];
  for (const entry of [...entries].sort((a, b) => b.date.localeCompare(a.date))) {
    const last = groups.at(-1);
    if (last?.date === entry.date) last.entries.push(entry);
    else groups.push({ date: entry.date, entries: [entry] });
  }
  return groups;
}
