/**
 * Deterministic, dependency-free ranking for `tools_search` (progressive tool discovery).
 *
 * Every deferred tool is indexed once per run: its name (snake / camel / kebab split), title,
 * description, parameter names and the group or connector it belongs to. Query words are
 * normalised the same way (English plurals, a few Italian forms) and expanded with the verbs and
 * nouns tools are usually named with (send/post/invia, list/search/cerca, delete/remove/elimina,
 * update/edit/modifica…): an exact word counts more than a synonym, a name more than a description.
 * No LLM, no embeddings: the same query always gives the same order.
 */

const STOP_WORDS = new Set([
  // English
  "a", "an", "the", "to", "of", "for", "in", "on", "and", "or", "with", "by", "from", "at", "is", "it", "my", "me",
  "tool", "tools", "use", "using", "how", "can", "i", "do", "some", "this", "that", "into", "about", "please", "want",
  "need", "would", "like", "be", "are", "via", "your", "our", "their", "its", "as", "which", "what", "all", "any",
  // Italian
  "un", "uno", "una", "il", "lo", "la", "gli", "le", "di", "da", "per", "con", "su", "sul", "sulla", "nel", "nella",
  "del", "della", "dei", "degli", "delle", "al", "alla", "ai", "agli", "alle", "dal", "dalla", "e", "ed", "o", "mio",
  "mia", "miei", "mie", "che", "come", "voglio", "vorrei", "posso", "puoi", "tutti", "tutte", "tutto", "questo",
  "questa", "quello", "quella", "mi", "ti", "ci", "si", "strumento", "strumenti", "tool",
]);

/**
 * Words that mean the same thing in tool names: each line is one concept, its first word the
 * canonical form. A word may sit in several lines ("post": send and create).
 */
const SYNONYM_GROUPS: string[][] = [
  // verbs
  ["send", "post", "publish", "deliver", "invia", "inviare", "manda", "mandare", "spedisci", "spedire", "pubblica", "pubblicare"],
  ["reply", "respond", "answer", "rispondi", "rispondere", "risposta"],
  ["forward", "inoltra", "inoltrare"],
  ["create", "add", "new", "make", "insert", "post", "open", "start", "save", "crea", "creare", "aggiungi", "aggiungere", "nuovo", "nuova", "apri", "aprire", "inserisci"],
  ["list", "enumerate", "browse", "index", "elenca", "elencare", "lista", "mostra", "mostrare"],
  ["search", "find", "query", "lookup", "look", "filter", "cerca", "cercare", "trova", "trovare", "ricerca", "filtra"],
  ["get", "read", "fetch", "retrieve", "show", "view", "detail", "info", "describe", "leggi", "leggere", "ottieni", "recupera", "vedi", "visualizza", "dettaglio", "dettagli"],
  ["delete", "remove", "trash", "destroy", "erase", "drop", "elimina", "eliminare", "cancella", "cancellare", "rimuovi", "rimuovere", "togli"],
  ["update", "edit", "modify", "change", "set", "patch", "rename", "save", "modifica", "modificare", "aggiorna", "aggiornare", "cambia", "cambiare", "rinomina", "imposta", "salva"],
  ["upload", "attach", "carica", "caricare", "allega"],
  ["download", "export", "scarica", "scaricare", "esporta"],
  ["assign", "assegna", "assegnare"],
  ["close", "resolve", "complete", "finish", "done", "chiudi", "chiudere", "completa", "risolvi"],
  ["archive", "archivia"],
  ["invite", "invita"],
  ["schedule", "book", "pianifica", "programma", "prenota"],
  ["move", "transfer", "sposta", "spostare"],
  ["copy", "duplicate", "clone", "copia", "duplica"],
  ["merge", "unisci"],
  ["comment", "note", "commento", "commenta", "nota"],
  // nouns
  ["email", "mail", "gmail", "inbox", "posta", "mailbox", "casella"],
  ["message", "msg", "chat", "dm", "messaggio", "messaggi"],
  ["thread", "conversation", "conversazione", "discussione"],
  ["issue", "ticket", "bug", "problema", "segnalazione"],
  ["pr", "pull", "mr"],
  ["repository", "repo", "repositorio"],
  ["event", "meeting", "appointment", "evento", "eventi", "riunione", "appuntamento"],
  ["calendar", "calendario", "agenda"],
  ["document", "doc", "documento", "documenti"],
  ["file", "attachment", "allegato", "allegati"],
  ["folder", "directory", "dir", "cartella", "cartelle"],
  ["channel", "canale", "canali"],
  ["user", "member", "person", "people", "utente", "utenti", "membro", "membri", "persona", "persone"],
  ["contact", "contatto", "contatti", "rubrica"],
  ["project", "progetto", "progetti"],
  ["task", "todo", "attivita", "compito", "compiti"],
  ["label", "tag", "etichetta", "etichette"],
  ["draft", "bozza", "bozze"],
  ["sheet", "spreadsheet", "foglio", "fogli"],
  ["page", "pagina", "pagine"],
  ["team", "squadra"],
  ["status", "state", "stato"],
  ["image", "picture", "photo", "immagine", "immagini", "foto"],
  ["customer", "client", "cliente", "clienti"],
  ["invoice", "fattura", "fatture"],
  ["payment", "pagamento", "pagamenti"],
  ["order", "ordine", "ordini"],
  ["product", "prodotto", "prodotti"],
];

/** Italian forms not covered by a synonym line, and irregular English plurals. */
const WORD_FORMS: Record<string, string> = {
  people: "person", children: "child", statuses: "status", aliases: "alias", indices: "index", indexes: "index",
};

/** Plural / inflection folding, conservative: "issues"→"issue", "replies"→"reply", "boxes"→"box". */
export function stem(token: string): string {
  const irregular = WORD_FORMS[token];
  if (irregular) return irregular;
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && /(ss|sh|ch|x|z)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !/(ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
}

/** Lowercase word tokens: splits snake_case, kebab-case, camelCase and digits; drops stop words; folds plurals. */
export function tokenize(text: string): string[] {
  return text
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token))
    .map(stem);
}

/**
 * Expansions of a word: the concepts' first words (the canonical English form: "invia" → "send")
 * count almost as the word itself; the other members of the same lines less.
 */
const CANONICAL_FACTOR = 0.85;
const SYNONYM_FACTOR = 0.6;

const EXPANSIONS: Map<string, Map<string, number>> = (() => {
  const map = new Map<string, Map<string, number>>();
  for (const line of SYNONYM_GROUPS) {
    const words = line.map(stem);
    const head = words[0];
    for (const word of words) {
      let entry = map.get(word);
      if (!entry) map.set(word, (entry = new Map()));
      for (const other of words) {
        if (other === word) continue;
        const factor = other === head ? CANONICAL_FACTOR : SYNONYM_FACTOR;
        entry.set(other, Math.max(entry.get(other) ?? 0, factor));
      }
    }
  }
  return map;
})();

const EMPTY_EXPANSION: ReadonlyMap<string, number> = new Map();

/** The other words that mean `token` (normalised), with how close they are (0..1). */
export function expansionsOf(token: string): ReadonlyMap<string, number> {
  return EXPANSIONS.get(token) ?? EMPTY_EXPANSION;
}

/** The other words that mean `token` (normalised), without `token` itself. */
export function synonymsOf(token: string): ReadonlySet<string> {
  return new Set(expansionsOf(token).keys());
}

/** Name words that mean one thing together: their parts are one word of the name. */
const COMPOUNDS: Array<[string[], string]> = [[["pull", "request"], "pr"], [["direct", "message"], "dm"], [["merge", "request"], "pr"]];

/** One indexed tool. */
export interface IndexedTool {
  name: string;
  nameTokens: Set<string>;
  /** Name words in order, compounds folded ("pull request" → "pr"): how much of the name a query covers. */
  nameList: string[];
  titleTokens: Set<string>;
  groupTokens: Set<string>;
  paramTokens: Set<string>;
  descTokens: Set<string>;
}

export interface IndexInput {
  name: string;
  /** The name without its `mcp__<connector>__` prefix. */
  shortName: string;
  title?: string;
  description?: string;
  parameters?: unknown;
  /** Group label, id and, for a connector, its app (catalog id). */
  groupText: string;
}

function parameterNames(parameters: unknown): string[] {
  const props = (parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  return props && typeof props === "object" ? Object.keys(props) : [];
}

/** Text a connector tool's description starts with ("[Gmail 2 – info@…] "): the group already says it. */
export function stripConnectorTag(text: string | undefined): string {
  return (text ?? "").replace(/^\s*\[[^\]]{1,120}\]\s*/, "");
}

function foldCompounds(tokens: string[]): { list: string[]; aliases: string[] } {
  const list: string[] = [];
  const aliases: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const compound = COMPOUNDS.find(([parts]) => parts.every((part, k) => tokens[i + k] === part));
    if (compound) {
      list.push(compound[1]);
      aliases.push(compound[1]);
      i += compound[0].length - 1;
    } else list.push(tokens[i]);
  }
  return { list, aliases };
}

/** "unlabel", "unassign"…: the name also says "remove label". */
const UNDO_BASES = new Set(["label", "tag", "assign", "archive", "pin", "star", "mute", "block", "watch", "follow", "subscribe", "share", "link", "lock", "publish", "schedule", "snooze"]);

function undoParts(token: string): string[] {
  return token.startsWith("un") && UNDO_BASES.has(token.slice(2)) ? [token.slice(2), "remove"] : [];
}

export function indexTool(input: IndexInput): IndexedTool {
  const raw = tokenize(input.shortName);
  const { list, aliases } = foldCompounds(raw);
  for (const part of raw.flatMap(undoParts)) if (!aliases.includes(part)) aliases.push(part);
  const groupTokens = new Set(tokenize(input.groupText));
  const titleTokens = new Set(tokenize(input.title ?? "").filter((t) => !groupTokens.has(t)));
  return {
    name: input.name,
    nameTokens: new Set([...raw, ...aliases]),
    nameList: list,
    titleTokens,
    groupTokens,
    paramTokens: new Set(parameterNames(input.parameters).flatMap(tokenize)),
    descTokens: new Set(tokenize(stripConnectorTag(input.description))),
  };
}

/** Weights: what a query word is worth where it is found (exact / synonym at factor 1 / prefix or typo). */
const W = {
  name: [6, 5, 2.5],
  title: [3, 2.5, 1.2],
  group: [3, 1.5, 1.5],
  param: [1.5, 1, 0],
  desc: [1.5, 1, 0.5],
} as const;

/** One edit apart (insert, delete, substitute, swap): a typo in a long word. */
function oneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) {
    return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function fieldScore(tokens: Set<string>, term: string, expansions: ReadonlyMap<string, number>, weights: readonly [number, number, number], idf: number): number {
  if (tokens.size === 0) return 0;
  if (tokens.has(term)) return weights[0] * idf;
  let best = 0;
  for (const [word, factor] of expansions) if (tokens.has(word)) best = Math.max(best, weights[1] * factor * idf);
  if (best > 0) return best;
  if (weights[2] > 0 && term.length >= 3) {
    for (const token of tokens) {
      if ((token.length > term.length && token.startsWith(term))
        || (token.length >= 3 && term.length > token.length && term.startsWith(token) && term.length - token.length <= 3)
        || (term.length >= 5 && token.length >= 5 && oneEdit(term, token))) {
        return weights[2] * idf;
      }
    }
  }
  return 0;
}

/** A query, tokenised once. */
export interface PreparedQuery {
  terms: string[];
  /** The raw query as a tool name ("send email" → "send_email"). */
  phrase: string;
  /** Each word with what it expands to. */
  expansions: Map<string, ReadonlyMap<string, number>>;
  /** Every word the query covers (words and expansions): how much of a tool's name it covers. */
  covers: Set<string>;
  /**
   * Words that name a connector app ("linear", "slack"): a tool of another connector misses the
   * point of the query, whatever else matches.
   */
  appTerms: Set<string>;
}

/** `appNames`: words that name a connector (ids, apps, first word of names). */
export function prepareQuery(query: string, appNames: ReadonlySet<string> = new Set()): PreparedQuery {
  const terms = [...new Set(tokenize(query))];
  const expansions = new Map(terms.map((term) => [term, expansionsOf(term)] as const));
  const covers = new Set<string>();
  for (const [term, expansion] of expansions) {
    covers.add(term);
    for (const word of expansion.keys()) covers.add(word);
  }
  return {
    terms, expansions, covers,
    phrase: query.trim().toLowerCase().replace(/\s+/g, "_"),
    appTerms: new Set(terms.filter((term) => appNames.has(term))),
  };
}

/**
 * Inverse document frequency of each word over the indexed tools: a word every tool of a
 * connector has ("issue" in Linear) counts less than a rare one ("cycle").
 */
export function idfTable(tools: readonly IndexedTool[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const tool of tools) {
    const seen = new Set<string>([...tool.nameTokens, ...tool.titleTokens, ...tool.descTokens, ...tool.paramTokens]);
    for (const token of seen) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const n = Math.max(1, tools.length);
  const idf = new Map<string, number>();
  // dampened (0.6..1.4) so a common word still matters
  for (const [token, count] of df) idf.set(token, 0.6 + 0.8 * (Math.log((n + 1) / (count + 0.5)) / Math.log(n + 1.5)));
  return idf;
}

/** A name word the query covers (itself, a synonym, or one part of a folded compound). */
function covered(word: string, covers: ReadonlySet<string>): boolean {
  if (covers.has(word)) return true;
  const undo = undoParts(word);
  if (undo.length && covers.has(undo[0])) return true;
  const compound = COMPOUNDS.find(([, alias]) => alias === word);
  return !!compound && compound[0].some((part) => covers.has(part));
}

/** Score of one tool for a query; 0 when no query word matches. */
export function scoreTool(tool: IndexedTool, query: PreparedQuery, idf: ReadonlyMap<string, number>): number {
  const { terms, phrase } = query;
  const lowerName = tool.name.toLowerCase();
  let score = 0;
  let matched = 0;
  let nameHits = 0;
  for (const term of terms) {
    const expansions = query.expansions.get(term) ?? EMPTY_EXPANSION;
    const weight = Math.min(1.4, Math.max(0.6, idf.get(term) ?? 1.2));
    const name = fieldScore(tool.nameTokens, term, expansions, W.name, weight);
    const parts = [
      name,
      fieldScore(tool.titleTokens, term, expansions, W.title, weight),
      fieldScore(tool.groupTokens, term, expansions, W.group, 1),
      fieldScore(tool.paramTokens, term, expansions, W.param, weight),
      fieldScore(tool.descTokens, term, expansions, W.desc, weight),
    ];
    const best = Math.max(...parts);
    if (best <= 0) continue;
    matched += 1;
    if (name > 0) nameHits += 1;
    // the best field counts fully, the others a little (found in name and description > name only)
    score += best + 0.15 * (parts.reduce((sum, value) => sum + value, 0) - best);
  }
  if (phrase && lowerName === phrase) score += 25;
  else if (phrase.length >= 3 && lowerName.endsWith(`__${phrase}`)) score += 12;
  else if (phrase.length >= 4 && lowerName.includes(phrase)) score += 5;
  if (score <= 0) return 0;
  if (terms.length > 0) {
    const coverage = matched / terms.length;
    score *= coverage * Math.sqrt(coverage);
    if (nameHits > 0 && tool.nameList.length > 0) {
      // every word of the name asked for: "send email" → send_message over send_message_draft
      const missing = tool.nameList.filter((word) => !covered(word, query.covers)).length;
      score = missing === 0 ? score + 1.5 : Math.max(score * 0.5, score - 1.5 * missing);
    }
    // "… in Linear": tools of other connectors miss the point
    for (const app of query.appTerms) if (!tool.groupTokens.has(app)) score *= 0.35;
  }
  return Math.max(0, Math.round(score * 1000) / 1000);
}
