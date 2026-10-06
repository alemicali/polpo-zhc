/**
 * "Novità" — what changed in the app, newest first.
 *
 * Shown on /changelog and, for `highlight` entries the person has not seen
 * yet, in the What's new bar at the top. Seen state is kept
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
    id: "2026-10-06-context-compaction",
    date: "2026-10-06",
    kind: "improved",
    title: "Conversazioni lunghe: il contesto si compatta meglio",
    summary: "Chat e task lunghi restano nella finestra del modello senza perdere il filo. Scrivi /compact per farlo quando vuoi.",
    body: [
      "Quando una conversazione o un task si avvicina al limite del modello, Polpo ora **compatta il contesto** in modo più intelligente:",
      "",
      "- prima **svuota i vecchi risultati degli strumenti** (se erano stati salvati su file, resta il percorso);",
      "- poi fa **riassumere da un modello** la parte più vecchia, aggiornando il riassunto precedente invece di rifarlo da capo;",
      "- la **richiesta del task** non viene mai riassunta, e i **fatti importanti** finiscono nella memoria dell'agente.",
      "",
      "Il riassunto resta lo stesso tra una chiamata e l'altra, quindi la cache del modello funziona e si spende meno.",
      "",
      "Scrivi **/compact** in chat (anche su Telegram, con un agente) per compattare subito; puoi aggiungere su cosa concentrarsi, per esempio `/compact le decisioni sul prezzo`. Ogni compattazione compare in **Events**.",
      "",
      "Gli output molto grandi degli strumenti ora vengono **salvati su file** invece di essere tagliati: l'agente vede un'anteprima e il percorso per rileggerli.",
    ].join("\n"),
  },
  {
    id: "2026-10-06-events",
    date: "2026-10-06",
    kind: "improved",
    title: "Activity e Logs diventano Events",
    summary: "Una sola pagina per tutto quello che succede, Live e History, con filtri per tipo di evento e agente.",
    body: [
      "Polpo funziona a **eventi**: ogni cosa che succede (un task che cambia stato, un agente che parte o finisce, una missione, un'approvazione, una notifica…) è un evento.",
      "",
      "- **Events → Live**: gli eventi mentre succedono.",
      "- **Events → History**: gli eventi salvati, per periodo (ultima ora, 24 ore, 7 o 30 giorni) o per singolo avvio del server.",
      "- In entrambe puoi filtrare per **categoria**, **tipo di evento**, **agente**, **esito** (errori, avvisi…) e cercare nel testo.",
      "- I messaggi testuali del server ora si chiamano **System**.",
      "- Nel dettaglio di un task, quello che ha fatto l'agente passo per passo è la scheda **Execution**.",
      "",
      "La trovi nel menu, subito sotto Chat.",
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
    id: "2026-10-06-telegram-groups",
    date: "2026-10-06",
    kind: "new",
    highlight: true,
    title: "Telegram: gli agenti capiscono quando parli con loro",
    summary: "Nei gruppi Telegram gli agenti rispondono anche senza @ quando il messaggio è per loro, e ricordano la conversazione.",
    body: [
      "Nei gruppi Telegram non serve più menzionare sempre l'agente: risponde anche **senza @** quando il messaggio è chiaramente per lui. Un classificatore veloce legge la conversazione e decide chi deve rispondere.",
      "",
      "- Tiene conto del **contesto**: chi c'è nel gruppo, di cosa si stava parlando e chi era già coinvolto.",
      "- Se nel gruppo ci sei **solo tu e un agente**, l'agente risponde sempre.",
      "- Ogni gruppo ha **un unico trascritto**, condiviso da tutti gli agenti: ognuno sa cosa hanno già risposto gli altri e non ripete cose già dette.",
      "- La **soglia** con cui l'agente decide di rispondere è configurabile.",
      "",
      "Serve la **privacy mode disattivata** nel bot (BotFather → /setprivacy → Disable), altrimenti il bot vede solo comandi e risposte.",
    ].join("\n"),
  },
  {
    id: "2026-10-06-sandbox",
    date: "2026-10-06",
    kind: "new",
    title: "Sandbox: gli agenti eseguono i comandi in un ambiente isolato",
    summary: "Scegli dove girano i comandi degli agenti (e di Polpo): questa macchina o una gabbia che vede solo la cartella di lavoro, con rete libera, limitata o assente.",
    highlight: true,
    cta: { label: "Apri Sandbox", to: "/config?section=sandbox" },
    body: [
      "Gli agenti pensano sul server, ma i loro **comandi** (shell, ricerca nei file, script, `run_command` di Polpo) ora girano in una **sandbox**.",
      "",
      "- **Bubblewrap**: una gabbia su questa macchina. Vede solo la cartella di lavoro, i percorsi concessi e lo storage montato; non vede chiavi, vault, database o le cartelle delle altre istanze.",
      "- **Rete**: aperta, **solo i domini in elenco** (passando da un proxy) oppure nessuna.",
      "- **Limiti**: memoria, CPU e tempo massimo per comando.",
      "",
      "Si imposta a cascata: **istanza → agente → missione → task**. Istanza e agente li decidi tu (Impostazioni → Sandbox, scheda Sandbox dell'agente); missioni e task possono solo **restringere**. Una richiesta più larga viene ignorata e compare in **Events**.",
      "",
      "La sandbox è **opzionale**: di base i comandi girano sulla macchina come prima. Con l'interruttore **Isola gli agenti che leggono contenuti esterni** (Impostazioni → Sandbox), Polpo e gli agenti con strumenti web, email o messaggi girano almeno in bubblewrap, salvo eccezioni che decidi tu agente per agente.",
      "",
      "- **Rete aperta** ora passa da un proxy: internet sì, ma mai i servizi di questa macchina o le reti private. **Senza limiti** è l'opzione esplicita per chi ne ha davvero bisogno. Con la lista di domini funzionano anche git via ssh e le connessioni non HTTP.",
      "- I domini **rifiutati** compaiono in Events e in Impostazioni → Sandbox, con un clic per consentirli a un agente o a tutti.",
      "- **Sandbox remote**: collega **Daytona** o **E2B** in Impostazioni → Sandbox (chiave, test di connessione). I task possono girare in una VM remota: la cartella di lavoro ci viene copiata (senza node_modules, .polpo e i file esclusi da .gitignore, quindi i segreti nei .env restano qui) e i file modificati tornano alla fine.",
    ].join("\n"),
  },
  {
    id: "2026-10-06-storage",
    date: "2026-10-06",
    kind: "new",
    title: "Storage: bucket S3 e R2 come cartelle per gli agenti",
    summary: "Collega un bucket (Cloudflare R2, AWS S3, MinIO…): viene montato sul server e gli agenti lo vedono come una cartella.",
    body: [
      "Nella nuova pagina **Storage** puoi collegare un bucket **S3 compatibile**: Cloudflare R2, AWS S3, MinIO, Backblaze B2, Wasabi e altri.",
      "",
      "- Il bucket viene **montato sul server** e compare come cartella anche nella pagina **Files**.",
      "- Scegli **quali agenti** lo vedono, in **sola lettura** o anche in **scrittura**, ed eventualmente solo una sottocartella (prefisso).",
      "- Gli agenti con gli strumenti `storage_*` possono elencare, leggere, scrivere e cancellare file, e creare **link di download temporanei**.",
      "- Le **chiavi** stanno cifrate nel Vault: non vengono mai mostrate di nuovo né date agli agenti.",
      "",
      "Per le sandbox remote puoi aggiungere una **chiave dedicata e limitata**, separata da quella principale.",
    ].join("\n"),
    cta: { label: "Apri Storage", to: "/storage" },
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
