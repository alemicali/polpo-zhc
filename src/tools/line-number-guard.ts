/**
 * The read tool shows each line as "<n>\t<text>". Models (local or not) often copy those numbers
 * into what they write: with the tab, with a space instead ("1 First line"), or with the tab
 * escaped as the two characters "\t" — sometimes even with the line breaks escaped as "\n", the
 * whole text on one line. The file then holds numbers (and escapes) that were never in it. These
 * helpers spot that in write and edit.
 */

// A line number as the read tool shows it: followed by a tab, a space, a literal "\t", a dot stuck
// to the text ("1.Text": a markdown list has a space after the dot), the text itself ("1Text"), or
// nothing (an empty line; or the literal "\n" a model wrote instead of the last line break).
const LINE_NUMBER = /^(\d+)(?:\t| |\\t|\.(?=\S)|(?=[^\d\s.\\])|\\n$|$)/;

/**
 * The lines of `text`. Text without a real line break but with literal "\n" escapes is split on
 * those: a model that escaped the line breaks wrote its lines that way.
 */
function contentLines(text: string): { lines: string[]; escaped: boolean } {
  const normalized = text.replace(/\r\n/g, "\n");
  const escaped = !normalized.includes("\n") && normalized.includes("\\n");
  const lines = normalized.split(escaped ? "\\n" : "\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return { lines, escaped };
}

/**
 * Whether every line of `text` starts with consecutive line numbers (n, n+1, n+2…), as the read
 * tool shows them. Two lines at least: one numbered line alone is too common to tell.
 */
export function hasCopiedLineNumbers(text: string): boolean {
  const { lines } = contentLines(text);
  if (lines.length < 2) return false;
  let expected: number | undefined;
  let withText = 0;
  for (const line of lines) {
    const match = LINE_NUMBER.exec(line);
    if (!match) return false;
    const n = Number(match[1]);
    if (expected !== undefined && n !== expected) return false;
    expected = n + 1;
    if (line.slice(match[0].length).replace(/^\\n$/, "").trim()) withText++;
  }
  // Lines that are only a number are data (e.g. the numbers 1 to 10, one per line): copied line
  // numbers sit in front of text on most lines (a bare number is a copied empty line).
  return withText * 2 >= lines.length;
}

/** Whether `text` has its line breaks written as literal "\n" (no real line break). */
export function hasEscapedLineBreaks(text: string): boolean {
  return contentLines(text).escaped;
}

/** `text` without a leading line number on each line (for the edit tool's hint). */
export function withoutLineNumbers(text: string): string {
  const { lines, escaped } = contentLines(text);
  const bare = lines.map((line) => line.replace(/^\d+(?:\t| |\\t|\.(?=\S)|(?=[^\d\s.\\]))/, ""));
  const joined = bare.join("\n");
  // keep a trailing line break the input had
  return escaped || !/\r?\n$/.test(text) ? joined : `${joined}\n`;
}

/** The error for content refused because it carries copied line numbers. */
export function copiedLineNumbersError(tool: "write" | "edit", what: string, escapedLineBreaks = false): string {
  return `Error: every line of ${what} starts with a line number (1, 2, 3…) like the ones the read tool shows. `
    + "Those numbers are not part of the file, so nothing was written: write the text without them"
    + (escapedLineBreaks ? ", with real line breaks instead of the two characters \\n" : "")
    + `. Only if the numbers really belong in the file (e.g. a numbered list), call ${tool} again with keep_line_numbers: true.`;
}

/**
 * Whether a write or edit must be refused for copied line numbers. `keepLineNumbers` is the agent
 * saying the numbers belong in the file: an explicit flag, since a model that copied them tends to
 * repeat the same call unchanged.
 */
export function refuseLineNumbers(text: string, keepLineNumbers: boolean | undefined): boolean {
  return !keepLineNumbers && hasCopiedLineNumbers(text);
}
