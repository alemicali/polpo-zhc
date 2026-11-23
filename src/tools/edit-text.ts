/**
 * Text replacement for the `edit` tool: one or more edits matched against the file as it was
 * (never one after the other), on LF line endings, written back with the file's own line endings
 * and byte order mark.
 *
 * Matching, the fuzzy fallback and the CRLF splice are adapted from Pi
 * (`@earendil-works/pi-coding-agent` 1.6, src/core/tools/edit-diff.ts, MIT License,
 * Copyright (c) Mario Zechner). Polpo adds `replace_all`, duplicates reported with their line
 * numbers, and a "not found" error that shows the closest lines and the first character that
 * differs.
 */

export interface TextEdit {
  oldText: string;
  newText: string;
  /** Replace every occurrence instead of requiring a unique one. */
  replaceAll?: boolean;
}

/** A replacement of `matchLength` characters at `matchIndex` (LF-normalized content). */
export interface Replacement {
  matchIndex: number;
  matchLength: number;
  newText: string;
}

interface MatchedReplacement extends Replacement {
  editIndex: number;
}

export interface AppliedEdits {
  newContent: string;
  replacements: Replacement[];
  /** Whether the fuzzy fallback was needed (trailing spaces, smart quotes, dashes, Unicode spaces). */
  fuzzy: boolean;
  /** 1-based line of the first change. */
  firstChangedLine: number;
}

/** An edit the file does not allow; `message` is what the agent reads. */
export class EditError extends Error {
  constructor(message: string, readonly code: "empty" | "not_found" | "not_unique" | "overlap" | "no_change") {
    super(message);
  }
}

// ── Pi (MIT) ────────────────────────────────────────────────────────────────

export function splitBom(text: string): { bom: string; text: string } {
  return text.startsWith("﻿") ? { bom: "﻿", text: text.slice(1) } : { bom: "", text };
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Apply replacements matched in `normalizeToLF(original)` to `original` itself: text outside the
 * replaced ranges keeps its bytes (line endings included); line breaks in the new text get the
 * line ending of the line where the replaced range starts.
 */
export function applyReplacementsToOriginal(original: string, replacements: Replacement[]): string {
  // Only CRLF changes length when normalizing: the LF of the n-th CRLF (original offset p) is at p - n.
  let crlfBefore = 0;
  let nextCrlf = original.indexOf("\r\n");
  const toOriginal = (offset: number) => {
    while (nextCrlf !== -1 && nextCrlf - crlfBefore < offset) {
      crlfBefore++;
      nextCrlf = original.indexOf("\r\n", nextCrlf + 2);
    }
    return offset + crlfBefore;
  };
  const parts: string[] = [];
  let endsWithCr = false;
  const push = (part: string) => {
    if (part.length === 0) return;
    // A CR before a seam and an LF after it would merge into one CRLF: keep them two line breaks.
    if (endsWithCr && part[0] === "\n") parts.push("\n");
    parts.push(part);
    endsWithCr = part[part.length - 1] === "\r";
  };
  let position = 0;
  for (const r of [...replacements].sort((a, b) => a.matchIndex - b.matchIndex)) {
    const start = toOriginal(r.matchIndex);
    push(original.slice(position, start));
    const ending = lineEndingAt(original, start);
    push(ending === "\n" ? r.newText : r.newText.replaceAll("\n", ending));
    position = toOriginal(r.matchIndex + r.matchLength);
  }
  push(original.slice(position));
  return parts.join("");
}

/** Line ending of the line containing `offset` (that of the line before for an unterminated last line). */
function lineEndingAt(content: string, offset: number): string {
  let lineFeed = content.indexOf("\n", offset);
  if (lineFeed === -1) lineFeed = content.lastIndexOf("\n", offset);
  if (lineFeed === -1) return content.includes("\r") ? "\r" : "\n";
  return content[lineFeed - 1] === "\r" ? "\r\n" : "\n";
}

/**
 * Text for fuzzy matching: NFKC, no trailing whitespace on each line, smart quotes, Unicode
 * dashes and Unicode spaces as their ASCII forms. The line count never changes.
 */
export function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[  -   　]/g, " ");
}

function lineSpans(content: string): Array<{ start: number; end: number }> {
  let offset = 0;
  return (content.match(/[^\n]*\n|[^\n]+/g) ?? []).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function replacementLineRange(lines: Array<{ start: number; end: number }>, r: Replacement): { startLine: number; endLine: number } {
  const start = r.matchIndex;
  const end = r.matchIndex + r.matchLength;
  const startLine = lines.findIndex((l) => start >= l.start && start < l.end);
  if (startLine === -1) throw new Error("Replacement range is outside the content.");
  let endLine = startLine;
  while (endLine < lines.length && lines[endLine]!.end < end) endLine++;
  if (endLine >= lines.length) throw new Error("Replacement range is outside the content.");
  return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: Replacement[], offset = 0): string {
  let result = content;
  const sorted = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = sorted.length - 1; i >= 0; i--) {
    const r = sorted[i]!;
    const at = r.matchIndex - offset;
    result = result.substring(0, at) + r.newText + result.substring(at + r.matchLength);
  }
  return result;
}

/**
 * Replacements matched in the fuzzy view `base` → replacements of `original`: each one widened to
 * the lines it touches, those lines rewritten from `base`, every other line kept byte for byte.
 */
function widenReplacementsToLines(original: string, base: string, replacements: Replacement[]): Replacement[] {
  const originalLines = lineSpans(original);
  const baseLines = lineSpans(base);
  if (originalLines.length !== baseLines.length) {
    throw new Error("Cannot keep the unchanged lines: the normalized text has a different line count.");
  }
  const groups: Array<{ startLine: number; endLine: number; replacements: Replacement[] }> = [];
  for (const r of [...replacements].sort((a, b) => a.matchIndex - b.matchIndex)) {
    const range = replacementLineRange(baseLines, r);
    const current = groups[groups.length - 1];
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(r);
      continue;
    }
    groups.push({ ...range, replacements: [r] });
  }
  return groups.map((g) => {
    const from = baseLines[g.startLine]!.start;
    const to = baseLines[g.endLine - 1]!.end;
    const originalStart = originalLines[g.startLine]!.start;
    return {
      matchIndex: originalStart,
      matchLength: originalLines[g.endLine - 1]!.end - originalStart,
      newText: applyReplacements(base.slice(from, to), g.replacements, from),
    };
  });
}

// ── Polpo ───────────────────────────────────────────────────────────────────

function findAll(haystack: string, needle: string): number[] {
  const found: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) found.push(i);
  return found;
}

/** 1-based line of a character offset. */
export function lineOf(content: string, offset: number): number {
  let line = 1;
  for (let i = content.indexOf("\n"); i !== -1 && i < offset; i = content.indexOf("\n", i + 1)) line++;
  return line;
}

function editName(index: number, total: number): string {
  return total === 1 ? "old_text" : `edits[${index}].old_text`;
}

/**
 * Apply `edits` to `content` (LF line endings, no BOM). Every edit is matched against `content`
 * as given, exactly first; when one is not found exactly, all are matched on the fuzzy view
 * (`normalizeForFuzzyMatch`) and only the lines they touch are rewritten from it. Throws
 * {@link EditError} with a message for the agent.
 */
export function applyEdits(content: string, edits: TextEdit[], path: string): AppliedEdits {
  const normalized = edits.map((e) => ({ oldText: normalizeToLF(e.oldText), newText: normalizeToLF(e.newText), replaceAll: e.replaceAll === true }));
  normalized.forEach((e, i) => {
    if (e.oldText.length === 0) throw new EditError(`Error: ${editName(i, normalized.length)} is empty in ${path}: give the exact text to replace (to create or rewrite a file use write).`, "empty");
  });
  const fuzzy = normalized.some((e) => !content.includes(e.oldText));
  const base = fuzzy ? normalizeForFuzzyMatch(content) : content;

  const matched: MatchedReplacement[] = [];
  normalized.forEach((e, i) => {
    const needle = base.includes(e.oldText) ? e.oldText : normalizeForFuzzyMatch(e.oldText);
    const positions = needle ? findAll(base, needle) : [];
    if (positions.length === 0) throw new EditError(notFoundMessage(content, e.oldText, path, i, normalized.length), "not_found");
    if (positions.length > 1 && !e.replaceAll) {
      const lines = positions.map((p) => lineOf(base, p));
      throw new EditError(
        `Error: ${editName(i, normalized.length)} found ${positions.length} times in ${path} (lines ${lines.join(", ")}). It must be unique: `
        + "add a few lines around it to tell them apart, or set replace_all: true to replace every one.",
        "not_unique",
      );
    }
    for (const p of positions) matched.push({ editIndex: i, matchIndex: p, matchLength: needle.length, newText: e.newText });
  });

  matched.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matched.length; i++) {
    const prev = matched[i - 1]!;
    const cur = matched[i]!;
    if (prev.matchIndex + prev.matchLength > cur.matchIndex) {
      const what = prev.editIndex === cur.editIndex
        ? `two occurrences of ${editName(cur.editIndex, normalized.length)} overlap`
        : `edits[${prev.editIndex}] and edits[${cur.editIndex}] overlap`;
      throw new EditError(`Error: ${what} in ${path} (line ${lineOf(base, cur.matchIndex)}). Merge them into one edit, or target separate regions.`, "overlap");
    }
  }

  const replacements: Replacement[] = fuzzy ? widenReplacementsToLines(content, base, matched) : matched;
  const newContent = applyReplacements(content, replacements);
  if (newContent === content) {
    throw new EditError(`Error: no change made to ${path}: the replacement${normalized.length > 1 ? "s give" : " gives"} the same text. Check new_text.`, "no_change");
  }
  return {
    newContent,
    replacements,
    fuzzy,
    firstChangedLine: lineOf(content, Math.min(...replacements.map((r) => r.matchIndex))),
  };
}

const MAX_SHOWN_LINES = 8;
const MAX_SHOWN_LINE_CHARS = 200;

function trimmed(line: string): string {
  return line.trim();
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Where `oldText` was most probably meant to be: the window of lines (as many as `oldText` has)
 * with the most lines equal to its lines once trimmed, else the line closest to its first line.
 */
export function closestLines(content: string, oldText: string): { start: number; lines: string[] } | undefined {
  const fileLines = content.split("\n");
  const wanted = oldText.replace(/\n$/, "").split("\n");
  if (fileLines.length === 0 || wanted.length === 0) return undefined;
  const wantedTrimmed = wanted.map(trimmed);
  const byText = new Map<string, number[]>();
  wantedTrimmed.forEach((t, i) => {
    if (!t) return;
    const list = byText.get(t) ?? [];
    list.push(i);
    byText.set(t, list);
  });
  const scores = new Map<number, number>();
  fileLines.forEach((line, f) => {
    const at = byText.get(trimmed(line));
    if (!at) return;
    for (const i of at) {
      const start = f - i;
      if (start < 0 || start >= fileLines.length) continue;
      scores.set(start, (scores.get(start) ?? 0) + 1);
    }
  });
  let best: number | undefined;
  let bestScore = 0;
  for (const [start, score] of scores) {
    if (score > bestScore || (score === bestScore && best !== undefined && start < best)) { best = start; bestScore = score; }
  }
  if (best === undefined) {
    // no line in common: the line that starts most like the first non-empty line of old_text
    const first = wantedTrimmed.find(Boolean);
    if (!first) return undefined;
    let bestPrefix = 0;
    fileLines.forEach((line, f) => {
      const p = commonPrefix(trimmed(line), first);
      if (p > bestPrefix) { bestPrefix = p; best = f - wantedTrimmed.indexOf(first); }
    });
    if (best === undefined || bestPrefix < Math.min(4, first.length)) return undefined;
    best = Math.max(0, best);
  }
  return { start: best, lines: fileLines.slice(best, best + wanted.length) };
}

function show(text: string): string {
  return JSON.stringify(text);
}

function notFoundMessage(content: string, oldText: string, path: string, index: number, total: number): string {
  const name = editName(index, total);
  let message = `Error: ${name} not found in ${path}.`;
  const close = closestLines(content, oldText);
  if (!close) return `${message} Read the file again and copy the text exactly, including whitespace and line breaks.`;
  const shown = close.lines.slice(0, MAX_SHOWN_LINES)
    .map((l, i) => `${close.start + i + 1}\t${l.length > MAX_SHOWN_LINE_CHARS ? `${l.slice(0, MAX_SHOWN_LINE_CHARS)}…` : l}`);
  const last = close.start + close.lines.length;
  message += ` Closest match, line${close.lines.length > 1 ? `s ${close.start + 1}-${last}` : ` ${close.start + 1}`}:\n${shown.join("\n")}`;
  if (close.lines.length > MAX_SHOWN_LINES) message += `\n… (${close.lines.length - MAX_SHOWN_LINES} more lines)`;
  const actual = close.lines.join("\n");
  const wanted = oldText.replace(/\n$/, "");
  const at = commonPrefix(wanted, actual);
  if (at < wanted.length || at < actual.length) {
    const line = lineOf(wanted, at);
    const column = at - (wanted.lastIndexOf("\n", at - 1) + 1) + 1;
    message += `\nFirst difference: ${name} line ${line}, column ${column} has ${show(wanted.slice(at, at + 12) || "(end)")}, `
      + `the file has ${show(actual.slice(at, at + 12) || "(end)")}.`;
  }
  return `${message}\nCopy the text exactly as the file has it (tabs or spaces, quotes, line breaks), without the line numbers.`;
}
