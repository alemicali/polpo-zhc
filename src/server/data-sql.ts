/**
 * A small, conservative SQL classifier for the data tools (data_sql, data_transaction).
 *
 * It is not a parser: it strips comments, string literals, dollar-quoted bodies and quoted
 * identifiers into placeholders, then looks at keywords. It answers three questions:
 * - is this exactly one statement?
 * - what kind of statement is it (read, write, admin-only, never allowed)?
 * - which tables does it name (FROM, JOIN, INTO, UPDATE, USING, MERGE INTO)?
 *
 * The database stays the real guard (READ ONLY transactions, read-only SQLite handles, the
 * connection's own role); this only refuses what Polpo must never send.
 */

export type SqlDialect = "sqlite" | "postgres";

/** read: SELECT/WITH/VALUES/TABLE/EXPLAIN; write: INSERT/UPDATE/DELETE/MERGE; admin: DDL and privileged statements. */
export type SqlStatementClass = "read" | "write" | "admin";

export interface ClassifiedSql {
  kind: SqlStatementClass;
  /** The statement's first keyword, upper case (INSERT, SELECT, CREATE, ...). */
  command: string;
  /** Tables the statement names, as written (schema.table or table), lower-cased unless quoted. */
  tables: string[];
  /** Why the statement needs the admin grant, when kind is "admin". */
  adminReason?: string;
}

interface Token { type: "word" | "ident" | "string" | "punct" | "number" | "param"; value: string }

/** Statements that would end, nest or alter the transaction Polpo runs, or switch identity: never allowed. */
const FORBIDDEN_COMMANDS = new Set([
  "BEGIN", "START", "COMMIT", "END", "ROLLBACK", "ABORT", "SAVEPOINT", "RELEASE", "PREPARE",
  "SET", "RESET", "DISCARD", "LISTEN", "UNLISTEN", "LOAD", "CHECKPOINT", "VACUUM",
  "ATTACH", "DETACH", "PRAGMA", "DEALLOCATE", "EXECUTE",
]);

const READ_COMMANDS = new Set(["SELECT", "WITH", "VALUES", "TABLE", "EXPLAIN", "SHOW"]);
const WRITE_COMMANDS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE", "UPSERT"]);

/**
 * Functions only an administrator may call: server control, file system access, large objects,
 * other databases, session-wide settings (settings go through the transaction's `settings`).
 */
const ADMIN_FUNCTIONS = /^(pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_promote|pg_read_file|pg_read_binary_file|pg_ls_\w+|pg_stat_file|pg_file_\w+|pg_logdir_ls|pg_switch_wal|pg_create_\w+|pg_drop_\w+|pg_replication_\w+|pg_logical_\w+|pg_start_backup|pg_stop_backup|pg_backup_\w+|pg_import_system_collations|pg_sleep\w*|lo_import|lo_export|lo_\w+|dblink\w*|set_config|load_extension|readfile|writefile|edit|fts3_tokenizer)$/;

/** Splits SQL into tokens; comments vanish, literals and quoted identifiers become single tokens. */
export function tokenizeSql(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "-" && sql[i + 1] === "-") { while (i < n && sql[i] !== "\n") i++; continue; }
    if (ch === "/" && sql[i + 1] === "*") {
      // PostgreSQL block comments nest
      let depth = 1; i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; } else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; } else i++;
      }
      if (depth > 0) throw new Error("Unterminated comment in SQL");
      continue;
    }
    if (ch === "'" || ((ch === "E" || ch === "e" || ch === "N" || ch === "n" || ch === "X" || ch === "x" || ch === "B" || ch === "b") && sql[i + 1] === "'")) {
      const escapes = ch === "E" || ch === "e";
      i += ch === "'" ? 1 : 2;
      let value = "";
      for (;;) {
        if (i >= n) throw new Error("Unterminated string literal in SQL");
        const c = sql[i]!;
        if (escapes && c === "\\") { value += sql[i + 1] ?? ""; i += 2; continue; }
        if (c === "'") { if (sql[i + 1] === "'") { value += "'"; i += 2; continue; } i++; break; }
        value += c; i++;
      }
      tokens.push({ type: "string", value });
      continue;
    }
    if (ch === "$") {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end < 0) throw new Error("Unterminated dollar-quoted string in SQL");
        tokens.push({ type: "string", value: sql.slice(i + tag[0].length, end) });
        i = end + tag[0].length;
        continue;
      }
      const param = /^\$\d+/.exec(sql.slice(i));
      if (param) { tokens.push({ type: "param", value: param[0] }); i += param[0].length; continue; }
    }
    if (ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      i++;
      let value = "";
      for (;;) {
        if (i >= n) throw new Error("Unterminated quoted identifier in SQL");
        const c = sql[i]!;
        if (c === close) { if (close !== "]" && sql[i + 1] === close) { value += close; i += 2; continue; } i++; break; }
        value += c; i++;
      }
      tokens.push({ type: "ident", value });
      continue;
    }
    if (/[A-Za-z_\u0080-￿]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$\u0080-￿]/.test(sql[j]!)) j++;
      tokens.push({ type: "word", value: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[0-9.eE]/.test(sql[j]!)) j++;
      tokens.push({ type: "number", value: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === "?" || ch === ":" && /[A-Za-z_]/.test(sql[i + 1] ?? "") || ch === "@" && /[A-Za-z_]/.test(sql[i + 1] ?? "")) {
      tokens.push({ type: ch === "?" ? "param" : "punct", value: ch });
      i++;
      continue;
    }
    tokens.push({ type: "punct", value: ch });
    i++;
  }
  return tokens;
}

/** The statement's tokens, after checking it is exactly one statement (one trailing semicolon is fine). */
function singleStatement(sql: string): Token[] {
  const tokens = tokenizeSql(sql);
  while (tokens.length && tokens[tokens.length - 1]!.type === "punct" && tokens[tokens.length - 1]!.value === ";") tokens.pop();
  if (!tokens.length) throw new Error("The statement is empty");
  if (tokens.some((token) => token.type === "punct" && token.value === ";")) throw new Error("Only one statement per sql string is allowed (found a ';' between statements)");
  return tokens;
}

const upper = (token: Token | undefined) => token?.type === "word" ? token.value.toUpperCase() : "";

/**
 * Classifies one statement for data_transaction. Throws for anything that is never allowed:
 * more than one statement, transaction control, SET/RESET (use `settings`), identity switches,
 * COPY to or from a program or file.
 */
export function classifySql(sql: string, dialect: SqlDialect): ClassifiedSql {
  const tokens = singleStatement(sql);
  let start = 0;
  // A statement wrapped in parentheses: (SELECT ...)
  while (tokens[start]?.type === "punct" && tokens[start]!.value === "(") start++;
  const command = upper(tokens[start]);
  if (!command) throw new Error("The statement must start with a SQL keyword");
  const words = tokens.filter((token) => token.type === "word").map((token) => token.value.toUpperCase());

  if (FORBIDDEN_COMMANDS.has(command)) {
    if (command === "SET" || command === "RESET") {
      throw new Error(`${command} is not allowed inside a data transaction: pass settings (applied as SET LOCAL) instead; SET ROLE, SET SESSION AUTHORIZATION and SET TRANSACTION are never allowed`);
    }
    if (command === "START" || command === "BEGIN" || command === "COMMIT" || command === "END" || command === "ROLLBACK" || command === "ABORT"
      || command === "SAVEPOINT" || command === "RELEASE" || command === "PREPARE") {
      throw new Error(`Transaction control (${command}) is not allowed: Polpo opens, commits and rolls back the transaction itself`);
    }
    throw new Error(`${command} is not allowed in a data transaction`);
  }
  // Identity switches can hide inside other statements too (e.g. ALTER ... SET ROLE is not a thing, but be strict)
  for (let index = 0; index < words.length - 1; index++) {
    if (words[index] === "SESSION" && words[index + 1] === "AUTHORIZATION") throw new Error("SESSION AUTHORIZATION is never allowed");
  }
  if (command === "COPY") {
    if (words.includes("PROGRAM")) throw new Error("COPY ... PROGRAM is never allowed");
    if (tokens.some((token) => token.type === "string")) throw new Error("COPY to or from a server file is never allowed");
  }

  const functions = calledFunctions(tokens);
  const privileged = functions.find((name) => ADMIN_FUNCTIONS.test(name));
  const tables = referencedTables(tokens, start, dialect);

  if (READ_COMMANDS.has(command)) {
    // EXPLAIN ANALYZE runs the statement: classify what it explains
    if (command === "EXPLAIN") {
      const inner = tokens.slice(start + 1).findIndex((token) => ["SELECT", "WITH", "VALUES", "TABLE", "INSERT", "UPDATE", "DELETE", "MERGE"].includes(upper(token)));
      const innerCommand = inner >= 0 ? upper(tokens[start + 1 + inner]) : "";
      const analyzes = words.includes("ANALYZE") || words.includes("ANALYSE");
      if (analyzes && WRITE_COMMANDS.has(innerCommand)) return withAdmin({ kind: "write", command, tables }, privileged);
    }
    if (command === "SHOW") return { kind: "read", command, tables: [] };
    // WITH ... INSERT/UPDATE/DELETE (data-modifying CTEs) writes
    const writes = command === "WITH" && words.some((word) => word === "INSERT" || word === "UPDATE" || word === "DELETE" || word === "MERGE");
    // SELECT ... INTO creates a table; FOR UPDATE/SHARE takes row locks (still a read for grants)
    if ((command === "SELECT" || command === "WITH") && selectInto(tokens)) return { kind: "admin", command, tables, adminReason: "SELECT ... INTO creates a table" };
    return withAdmin({ kind: writes ? "write" : "read", command, tables }, privileged);
  }
  if (WRITE_COMMANDS.has(command)) {
    if (dialect === "postgres" && (command === "REPLACE" || command === "UPSERT")) throw new Error(`${command} is not PostgreSQL syntax`);
    return withAdmin({ kind: "write", command, tables }, privileged);
  }
  return { kind: "admin", command, tables, adminReason: `${command} statements (schema changes, permissions, procedures and other privileged commands)` };
}

function withAdmin(result: ClassifiedSql, privileged: string | undefined): ClassifiedSql {
  return privileged ? { ...result, kind: "admin", adminReason: `it calls ${privileged}()` } : result;
}

/** SELECT a, b INTO new_table FROM ...: INTO at the top level of a SELECT (not INSERT INTO). */
function selectInto(tokens: Token[]): boolean {
  let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type === "punct" && token.value === "(") depth++;
    else if (token.type === "punct" && token.value === ")") depth--;
    else if (depth === 0 && upper(token) === "INTO" && upper(tokens[index - 1]) !== "INSERT" && upper(tokens[index - 1]) !== "MERGE") return true;
  }
  return false;
}

/** Names followed by "(": function calls (and a few keywords, which never match ADMIN_FUNCTIONS). */
function calledFunctions(tokens: Token[]): string[] {
  const names: string[] = [];
  for (let index = 0; index < tokens.length - 1; index++) {
    const token = tokens[index]!;
    const next = tokens[index + 1]!;
    if ((token.type === "word" || token.type === "ident") && next.type === "punct" && next.value === "(") names.push(token.value.toLowerCase());
  }
  return names;
}

const TABLE_KEYWORDS = new Set(["FROM", "JOIN", "INTO", "UPDATE", "USING", "TABLE"]);
const CLAUSE_END = new Set([
  "WHERE", "GROUP", "ORDER", "LIMIT", "OFFSET", "HAVING", "WINDOW", "UNION", "INTERSECT", "EXCEPT", "RETURNING", "SET", "VALUES",
  "ON", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "LATERAL", "FOR", "FETCH", "DEFAULT", "SELECT", "USING", "DO",
  "OVERRIDING", "WHEN", "THEN", "AS", "TABLESAMPLE", "ONLY",
]);

/**
 * Tables a statement names after FROM, JOIN, INTO, UPDATE, USING, TABLE (and the comma lists of
 * FROM), minus CTE names. Subqueries and set-returning functions are skipped (their own FROMs are
 * found on their own). Names are returned as written: schema.table or table.
 */
export function referencedTables(tokens: Token[], start = 0, dialect: SqlDialect = "postgres"): string[] {
  const ctes = new Set<string>();
  for (let index = start; index < tokens.length - 1; index++) {
    // WITH name AS (, WITH RECURSIVE name(cols) AS (, , name AS (
    const token = tokens[index]!;
    if ((token.type === "word" || token.type === "ident") && (upper(tokens[index - 1]) === "WITH" || upper(tokens[index - 1]) === "RECURSIVE" || (tokens[index - 1]?.type === "punct" && tokens[index - 1]!.value === ","))) {
      let next = index + 1;
      if (tokens[next]?.type === "punct" && tokens[next]!.value === "(") {
        let depth = 0;
        for (; next < tokens.length; next++) {
          if (tokens[next]!.value === "(") depth++;
          else if (tokens[next]!.value === ")" && --depth === 0) { next++; break; }
        }
      }
      if (upper(tokens[next]) !== "AS") continue;
      next++;
      if (upper(tokens[next]) === "NOT") next++;
      if (upper(tokens[next]) === "MATERIALIZED") next++;
      if (tokens[next]?.type === "punct" && tokens[next]!.value === "(") ctes.add(nameOf(token));
    }
  }
  const tables: string[] = [];
  const add = (name: string) => {
    if (ctes.has(name) || tables.includes(name)) return;
    tables.push(name);
  };
  for (let index = start; index < tokens.length; index++) {
    const keyword = upper(tokens[index]);
    if (!TABLE_KEYWORDS.has(keyword)) continue;
    // DELETE FROM, INSERT INTO, MERGE INTO, UPDATE x, UPDATE ONLY x; "TABLE x" only as a statement or after a set operator
    if (keyword === "TABLE" && index !== start && !["UNION", "INTERSECT", "EXCEPT", "ALL", "("].includes(upper(tokens[index - 1]) || tokens[index - 1]!.value)) continue;
    // EXTRACT(YEAR FROM x), SUBSTRING(x FROM 2), TRIM(BOTH FROM x), IS DISTINCT FROM: FROM inside a function or comparison
    if (keyword === "FROM" && isExpressionFrom(tokens, index)) continue;
    // ON CONFLICT ... DO UPDATE SET: no table follows
    if (keyword === "UPDATE" && upper(tokens[index - 1]) === "DO") continue;
    // FOR UPDATE / FOR NO KEY UPDATE (row locks)
    if (keyword === "UPDATE" && ["FOR", "KEY"].includes(upper(tokens[index - 1]))) continue;
    // SELECT ... INTO var is admin-classified elsewhere; INSERT/MERGE INTO and the rest name tables
    let cursor = index + 1;
    for (;;) {
      if (upper(tokens[cursor]) === "ONLY" || upper(tokens[cursor]) === "LATERAL") cursor++;
      const first = tokens[cursor];
      if (!first || (first.type !== "word" && first.type !== "ident")) break; // a subquery, a parameter, VALUES (...)
      if (first.type === "word" && CLAUSE_END.has(first.value.toUpperCase())) break;
      let name = nameOf(first);
      cursor++;
      while (tokens[cursor]?.type === "punct" && tokens[cursor]!.value === "." && (tokens[cursor + 1]?.type === "word" || tokens[cursor + 1]?.type === "ident")) {
        name = `${name}.${nameOf(tokens[cursor + 1]!)}`;
        cursor += 2;
      }
      // name( ... ) is a function in FROM (generate_series, unnest): not a table
      if (tokens[cursor]?.type === "punct" && tokens[cursor]!.value === "(" && keyword !== "INTO") {
        break;
      }
      add(normalizeTableName(name, dialect));
      // optional alias, then a comma continues the FROM list
      if (keyword !== "FROM" && keyword !== "USING") break;
      if (upper(tokens[cursor]) === "AS") cursor++;
      if ((tokens[cursor]?.type === "word" && !CLAUSE_END.has(upper(tokens[cursor]))) || tokens[cursor]?.type === "ident") cursor++;
      // alias column list: AS t(a, b)
      if (tokens[cursor]?.value === "(") {
        let depth = 0;
        for (; cursor < tokens.length; cursor++) {
          if (tokens[cursor]!.value === "(") depth++;
          else if (tokens[cursor]!.value === ")" && --depth === 0) { cursor++; break; }
        }
      }
      if (tokens[cursor]?.type === "punct" && tokens[cursor]!.value === ",") { cursor++; continue; }
      break;
    }
  }
  return tables;
}

function isExpressionFrom(tokens: Token[], index: number): boolean {
  if (upper(tokens[index - 1]) === "DISTINCT") return true;
  // inside parentheses that belong to a function call: walk back to the opening paren
  let depth = 0;
  for (let back = index - 1; back >= 0; back--) {
    const token = tokens[back]!;
    if (token.type === "punct" && token.value === ")") depth++;
    else if (token.type === "punct" && token.value === "(") {
      if (depth === 0) {
        const before = tokens[back - 1];
        // "(SELECT ... FROM" is a subquery; "extract(... FROM" is a function
        const firstInside = upper(tokens[back + 1]);
        if (firstInside === "SELECT" || firstInside === "WITH" || firstInside === "DELETE" || firstInside === "UPDATE" || firstInside === "INSERT") return false;
        return !!before && (before.type === "word" || before.type === "ident") && !TABLE_KEYWORDS.has(upper(before)) && upper(before) !== "AS" && upper(before) !== "IN" && upper(before) !== "EXISTS";
      }
      depth--;
    }
  }
  return false;
}

function nameOf(token: Token): string {
  return token.type === "ident" ? token.value : token.value.toLowerCase();
}

/** PostgreSQL's default schema and SQLite's main database are dropped so grants can name either form. */
function normalizeTableName(name: string, dialect: SqlDialect): string {
  if (dialect === "sqlite" && /^(main|temp)\./.test(name)) return name.slice(name.indexOf(".") + 1);
  return name;
}

/** Is a table (as a statement names it) one of the datasets a grant allows? */
export function tableAllowed(table: string, dialect: SqlDialect, allowed: (dataset: string) => boolean): boolean {
  if (allowed(table)) return true;
  // PostgreSQL: an unqualified name is public.<name>, and public.<name> may be granted as <name>
  if (dialect === "postgres") {
    if (!table.includes(".")) return allowed(`public.${table}`);
    if (table.startsWith("public.")) return allowed(table.slice("public.".length));
  }
  return false;
}

/** A custom setting name a transaction may set with SET LOCAL: namespace.name (e.g. archivio.autore). */
export const SETTING_KEY = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;
/** Settings that switch identity or reopen what Polpo bounds: never settable. */
const FORBIDDEN_SETTINGS = new Set(["role", "session_authorization", "transaction_read_only", "default_transaction_read_only", "transaction_isolation"]);

/**
 * Checks a transaction setting key. Custom settings (namespace.name) need the write grant; a
 * built-in setting (no dot, e.g. search_path) needs admin; identity and read-only switches never.
 */
export function settingNeedsAdmin(key: string): boolean {
  if (!SETTING_KEY.test(key)) throw new Error(`Invalid setting name "${key}": use lower-case namespace.name (letters, digits, underscores)`);
  if (FORBIDDEN_SETTINGS.has(key)) throw new Error(`Setting "${key}" is never allowed`);
  return !key.includes(".");
}

/** The tables one statement names (for dataset grants), after checking it is a single statement. */
export function sqlTables(sql: string, dialect: SqlDialect): string[] {
  const tokens = singleStatement(sql);
  let start = 0;
  while (tokens[start]?.type === "punct" && tokens[start]!.value === "(") start++;
  return referencedTables(tokens, start, dialect);
}
