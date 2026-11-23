/** A tiny SQL tokenizer for highlighting (not a parser): every character lands in exactly one token. */

export type SqlTokenType = "keyword" | "function" | "string" | "number" | "comment" | "operator" | "identifier" | "quoted" | "plain";
export interface SqlToken { type: SqlTokenType; text: string }

const KEYWORDS = new Set(`
select from where and or not in is null like ilike between exists as on join inner left right full outer cross lateral using
group by order having limit offset fetch first next rows only distinct all any some union intersect except case when then else end
with recursive asc desc nulls last true false explain analyze verbose cast interval date time timestamp over partition window
filter within values default insert into update set delete returning create alter drop table view index primary key foreign
references unique check constraint
`.trim().split(/\s+/));

const PATTERN = /(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^']|'')*(?:'|$))|("(?:[^"]|"")*(?:"|$)|`[^`]*(?:`|$))|(\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|([A-Za-z_][A-Za-z0-9_$]*)|(<=|>=|<>|!=|::|\|\||[-+*/%=<>,;().])/gi;

export function highlightSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let last = 0;
  for (const match of sql.matchAll(PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ type: "plain", text: sql.slice(last, index) });
    const [text, comment, string, quoted, number, word] = match;
    let type: SqlTokenType = "operator";
    if (comment) type = "comment";
    else if (string) type = "string";
    else if (quoted) type = "quoted";
    else if (number) type = "number";
    else if (word) type = KEYWORDS.has(word.toLowerCase()) ? "keyword" : /^\s*\(/.test(sql.slice(index + text.length)) ? "function" : "identifier";
    tokens.push({ type, text });
    last = index + text.length;
  }
  if (last < sql.length) tokens.push({ type: "plain", text: sql.slice(last) });
  return tokens;
}

/** The statement starts with SELECT, WITH or EXPLAIN (after comments): what the SQL tab may run. */
export function looksReadOnly(sql: string): boolean {
  const stripped = sql.replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)*\s*/g, "").trim();
  return /^(select|with|explain)\b/i.test(stripped);
}
