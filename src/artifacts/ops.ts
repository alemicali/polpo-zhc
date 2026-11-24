/**
 * Changes to part of an artifact, so an agent sends a few KB instead of rewriting a large content
 * (the same commands for REST PATCH /artifacts/:id, MCP polpo_artifact_update, the agents' and Polpo's
 * artifact_update):
 *
 * - update: old_str → new_str (one, or several `updates` applied in sequence). old_str must occur once
 *   (or replace_all); matched exactly, then ignoring trailing spaces, smart quotes and dashes, like the
 *   coding `edit` tool; nothing is saved when one fails, and the error shows the closest lines.
 * - rewrite: the whole new content. append / prepend: text added at the end or the beginning.
 * - patch: JSON Patch (RFC 6902) on the artifact's model: the workspace JSON (slides, sheets, motion),
 *   { pages } of a design, { tabs } of a document.
 * - ops: per-kind operations (docs tabs, sheets cells/rows/columns, slides, design boards/pages/layers,
 *   motion scenes/layers); see ARTIFACT_OPS_GUIDE.
 *
 * Every result is checked again (artifactContentProblem plus the model's shape) before it is saved.
 */
import { artifactContentProblem, type ArtifactType } from "@polpo-ai/core/artifacts";
import { applyEdits, EditError, normalizeToLF, splitBom, applyReplacementsToOriginal } from "../tools/edit-text.js";

export class ArtifactChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactChangeError";
  }
}

const fail = (message: string): never => { throw new ArtifactChangeError(message); };

// ── Text updates ───────────────────────────────────────────────────────

export interface TextUpdate {
  old_str: string;
  new_str: string;
  replace_all?: boolean;
}

/** An update in any spelling models send: old_str/new_str, old_text/new_text, find/replace, oldText/newText. */
export function normalizeTextUpdate(value: unknown, where = "update"): TextUpdate {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const oldStr = v.old_str ?? v.old_text ?? v.oldText ?? v.old_string ?? v.find;
  const newStr = v.new_str ?? v.new_text ?? v.newText ?? v.new_string ?? v.replace;
  if (typeof oldStr !== "string") fail(`${where}: old_str is missing (the exact text to replace)`);
  if (typeof newStr !== "string") fail(`${where}: new_str is missing (the replacement; "" deletes old_str)`);
  const all = v.replace_all ?? v.replaceAll;
  return { old_str: oldStr as string, new_str: newStr as string, ...(all === true ? { replace_all: true } : {}) };
}

function editMessage(message: string, index: number, total: number): string {
  const name = total > 1 ? `updates[${index}].old_str` : "old_str";
  return message
    .replace(/^Error: /, "")
    .replace(/\bedits\[\d+\]\.old_text\b|\bold_text\b/g, name)
    .replace(/\bnew_text\b/g, "new_str")
    .replace(/ in the artifact\./g, " in the artifact.")
    .replace(/Read the file again/g, "Read the artifact again (artifact_get / polpo_artifact_get)")
    .replace(/the file has/g, "the artifact has")
    .replace(/as the file has it/g, "as the artifact has it")
    .replace(/ \(to create or rewrite a file use write\)/g, " (to replace everything use command rewrite)")
    .replace(/, without the line numbers\./g, ".");
}

/**
 * Apply updates in sequence (each to the result of the previous one), all or nothing. Line endings
 * and a byte order mark are kept as the content has them.
 */
export function applyTextUpdates(content: string, updates: TextUpdate[]): string {
  if (!updates.length) fail("No update given: pass old_str and new_str (or updates: [{ old_str, new_str }])");
  let out = content;
  updates.forEach((u, i) => {
    const { bom, text } = splitBom(out);
    const normalized = normalizeToLF(text);
    try {
      const applied = applyEdits(normalized, [{ oldText: u.old_str, newText: u.new_str, replaceAll: u.replace_all }], "the artifact");
      out = bom + (text === normalized ? applied.newContent : applyReplacementsToOriginal(text, applied.replacements));
    } catch (err) {
      if (err instanceof EditError) fail(editMessage(err.message, i, updates.length) + (updates.length > 1 ? " Nothing was saved." : ""));
      throw err;
    }
  });
  return out;
}

// ── JSON Patch (RFC 6902) ─────────────────────────────────────────────

export interface JsonPatchOp {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  from?: string;
  value?: unknown;
}

function pointer(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) fail(`JSON pointer "${path}" must start with /`);
  return path.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function parentOf(doc: unknown, tokens: string[], path: string): { parent: any; key: string } {
  let node: any = doc;
  for (const token of tokens.slice(0, -1)) {
    if (Array.isArray(node)) node = node[Number(token)];
    else if (node && typeof node === "object") node = node[token];
    else node = undefined;
    if (node === undefined) fail(`JSON patch: ${path} does not exist`);
  }
  if (!node || typeof node !== "object") fail(`JSON patch: the parent of ${path} is not an object or array`);
  return { parent: node, key: tokens[tokens.length - 1]! };
}

function getAt(doc: unknown, path: string): unknown {
  let node: any = doc;
  for (const token of pointer(path)) {
    if (Array.isArray(node)) {
      if (!/^\d+$/.test(token)) return undefined;
      node = node[Number(token)];
    } else if (node && typeof node === "object" && Object.prototype.hasOwnProperty.call(node, token)) node = node[token];
    else return undefined;
  }
  return node;
}

function arrayIndex(parent: unknown[], key: string, path: string, adding: boolean): number {
  if (adding && key === "-") return parent.length;
  if (!/^\d+$/.test(key)) fail(`JSON patch: "${key}" is not an array index in ${path}`);
  const index = Number(key);
  if (index > parent.length || (!adding && index === parent.length)) fail(`JSON patch: index ${index} is out of range in ${path} (length ${parent.length})`);
  return index;
}

const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)) as T);

/** Apply a JSON Patch to a document (a copy is changed and returned). */
export function applyJsonPatch<T>(document: T, ops: JsonPatchOp[]): T {
  let doc: any = clone(document);
  ops.forEach((op, i) => {
    const where = `patch[${i}] (${op?.op} ${op?.path})`;
    if (!op || typeof op !== "object" || typeof op.path !== "string") fail(`patch[${i}]: each operation needs op and path`);
    const tokens = pointer(op.path);
    const add = (value: unknown) => {
      if (!tokens.length) { doc = value; return; }
      const { parent, key } = parentOf(doc, tokens, op.path);
      if (Array.isArray(parent)) parent.splice(arrayIndex(parent, key, op.path, true), 0, value);
      else parent[key] = value;
    };
    const remove = (): unknown => {
      if (!tokens.length) fail(`${where}: cannot remove the whole document`);
      const { parent, key } = parentOf(doc, tokens, op.path);
      if (Array.isArray(parent)) return parent.splice(arrayIndex(parent, key, op.path, false), 1)[0];
      if (!Object.prototype.hasOwnProperty.call(parent, key)) fail(`${where}: ${op.path} does not exist`);
      const old = parent[key];
      delete parent[key];
      return old;
    };
    switch (op.op) {
      case "add": add(clone(op.value)); break;
      case "remove": remove(); break;
      case "replace":
        if (getAt(doc, op.path) === undefined) fail(`${where}: ${op.path} does not exist (use add)`);
        if (!tokens.length) doc = clone(op.value);
        else {
          const { parent, key } = parentOf(doc, tokens, op.path);
          if (Array.isArray(parent)) parent[arrayIndex(parent, key, op.path, false)] = clone(op.value);
          else parent[key] = clone(op.value);
        }
        break;
      case "move": {
        if (typeof op.from !== "string") fail(`${where}: move needs from`);
        if (op.path.startsWith(`${op.from}/`)) fail(`${where}: cannot move a value into itself`);
        const from = pointer(op.from!);
        const { parent, key } = parentOf(doc, from, op.from!);
        if (getAt(doc, op.from!) === undefined) fail(`${where}: ${op.from} does not exist`);
        const value = Array.isArray(parent) ? parent.splice(arrayIndex(parent, key, op.from!, false), 1)[0] : (() => { const v = parent[key]; delete parent[key]; return v; })();
        add(value);
        break;
      }
      case "copy": {
        if (typeof op.from !== "string") fail(`${where}: copy needs from`);
        const value = getAt(doc, op.from!);
        if (value === undefined) fail(`${where}: ${op.from} does not exist`);
        add(clone(value));
        break;
      }
      case "test":
        if (JSON.stringify(getAt(doc, op.path)) !== JSON.stringify(op.value)) fail(`${where}: the test failed (the value is not the expected one): nothing was saved`);
        break;
      default:
        fail(`patch[${i}]: unknown op "${String((op as { op?: unknown }).op)}" (add, remove, replace, move, copy, test)`);
    }
  });
  return doc as T;
}

// ── Models of the workspaces ──────────────────────────────────────────

export type ArtifactModelKind = "doc" | "slides" | "sheets" | "motion" | "design";

/** Which model an artifact has (undefined: plain text, changed with text updates only). */
export function artifactModelKind(type: ArtifactType, kind: string | undefined, content: string): ArtifactModelKind | undefined {
  if (type === "doc") return "doc";
  if (type !== "html") return undefined;
  if ((kind === "slides" || kind === "sheets" || kind === "motion") && content.trimStart().startsWith("{")) return kind;
  if (kind === "design") return "design";
  return undefined;
}

// Docs: Markdown with tab markers (the same format as ui/src/components/artifacts/artifact-doc-tabs.ts)

export interface DocTab { id: string; title: string; content: string }
export interface DocModel { namespace?: string; tabs: DocTab[] }

const DOC_HEADER = /^<!-- polpo-doc-tabs:v1 ([\w-]{18}) -->\r?\n/;
const titleOf = (value: string) => Array.from(value.trim().replace(/[\r\n\t]+/g, " ")).slice(0, 100).join("") || "Untitled tab";

export function readDoc(content: string): DocModel {
  const single: DocModel = { tabs: [{ id: "main", title: "Tab 1", content }] };
  const header = DOC_HEADER.exec(content);
  if (!header) return single;
  const namespace = header[1]!;
  const markers = [...content.matchAll(new RegExp(`^<!-- polpo-doc-tab:${namespace} ([\\w-]{1,20}) ([^\\r\\n]+) -->\\r?\\n\\r?\\n`, "gm"))];
  if (markers[0]?.index !== header[0].length) return single;
  const ids = new Set<string>();
  const tabs: DocTab[] = [];
  for (const [index, marker] of markers.entries()) {
    const id = marker[1]!;
    if (ids.has(id)) return single;
    ids.add(id);
    const start = marker.index! + marker[0].length;
    const end = markers[index + 1]?.index ?? content.length;
    const section = content.slice(start, end);
    try {
      tabs.push({ id, title: titleOf(decodeURIComponent(marker[2]!)), content: section.endsWith("\n\n") ? section.slice(0, -2) : section.replace(/\r\n\r\n$/, "") });
    } catch {
      return single;
    }
  }
  return { namespace, tabs };
}

const randomId = (length: number) => {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
  let out = "";
  for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
};

export function writeDoc(doc: DocModel): string {
  const first = doc.tabs[0];
  if (!first) return "";
  if (doc.tabs.length === 1 && !doc.namespace && first.id === "main" && first.title === "Tab 1") return first.content;
  const namespace = doc.namespace ?? randomId(18);
  return `<!-- polpo-doc-tabs:v1 ${namespace} -->\n${doc.tabs.map((tab) =>
    `<!-- polpo-doc-tab:${namespace} ${tab.id} ${encodeURIComponent(titleOf(tab.title))} -->\n\n${tab.content}\n\n`).join("")}`;
}

function checkDoc(doc: DocModel): void {
  if (!Array.isArray(doc.tabs) || !doc.tabs.length) fail("A document needs at least one tab");
  const ids = new Set<string>();
  for (const tab of doc.tabs) {
    if (!tab || typeof tab.id !== "string" || !/^[\w-]{1,20}$/.test(tab.id)) fail(`Tab ids are 1–20 letters, digits, _ or - (got ${JSON.stringify(tab?.id)})`);
    if (ids.has(tab.id)) fail(`Two tabs have the id "${tab.id}"`);
    ids.add(tab.id);
    if (typeof tab.title !== "string" || typeof tab.content !== "string") fail(`Tab "${tab.id}" needs a title and a content (strings)`);
  }
}

// Design: the primary artboard's HTML plus a JSON payload with every page and board

export interface Artboard { id: string; name: string; x: number; y: number; width: number; height: number; html: string }
export interface DesignPage { id: string; name: string; boards: Artboard[] }
export interface DesignModel { version: 1; pages: DesignPage[] }

const DESIGN_SCRIPT = /<script\b[^>]*\bdata-polpo-design-workspace\b[^>]*>([\s\S]*?)<\/script>/gi;

export function readDesign(html: string): DesignModel {
  const single: DesignModel = { version: 1, pages: [{ id: "page-1", name: "Page 1", boards: [{ id: "board-1", name: "Artboard 1", x: 0, y: 0, width: 1024, height: 680, html }] }] };
  const matches = [...html.matchAll(DESIGN_SCRIPT)];
  const match = matches[matches.length - 1];
  if (!match) return single;
  try {
    const stored = JSON.parse(match[1]!) as DesignModel;
    if (stored.version !== 1 || !Array.isArray(stored.pages) || !stored.pages.length) return single;
    checkDesign(stored);
    stored.pages[0]!.boards[0]!.html = html.slice(0, match.index) + html.slice(match.index! + match[0].length);
    return stored;
  } catch {
    return single;
  }
}

export function writeDesign(model: DesignModel): string {
  const first = model.pages[0]!.boards[0]!;
  if (model.pages.length === 1 && model.pages[0]!.boards.length === 1 && model.pages[0]!.id === "page-1" && first.id === "board-1" && first.name === "Artboard 1") return first.html;
  const meta = { version: 1, pages: model.pages.map((p, pi) => ({ ...p, boards: p.boards.map((b, bi) => (pi === 0 && bi === 0 ? { ...b, html: "" } : b)) })) };
  return `${first.html}<script type="application/json" data-polpo-design-workspace>${JSON.stringify(meta).replaceAll("<", "\\u003c")}</script>`;
}

function checkDesign(model: DesignModel): void {
  if (!Array.isArray(model.pages) || !model.pages.length) fail("A design needs at least one page");
  const pageIds = new Set<string>();
  const boardIds = new Set<string>();
  for (const page of model.pages) {
    if (!page || typeof page.id !== "string" || typeof page.name !== "string") fail("Every page needs an id and a name");
    if (pageIds.has(page.id)) fail(`Two pages have the id "${page.id}"`);
    pageIds.add(page.id);
    if (!Array.isArray(page.boards) || !page.boards.length) fail(`Page "${page.name}" needs at least one artboard`);
    for (const b of page.boards) {
      if (!b || typeof b.id !== "string" || typeof b.name !== "string" || typeof b.html !== "string") fail("Every artboard needs an id, a name and html");
      if (boardIds.has(b.id)) fail(`Two artboards have the id "${b.id}"`);
      boardIds.add(b.id);
      if (![b.x, b.y, b.width, b.height].every((n) => typeof n === "number" && Number.isFinite(n)) || b.width <= 0 || b.height <= 0) {
        fail(`Artboard "${b.name}" needs numeric x, y and a positive width and height`);
      }
    }
  }
}

// JSON workspaces

type Json = Record<string, any>;

function checkUniqueIds(items: unknown[], what: string): void {
  const ids = new Set<string>();
  items.forEach((item, i) => {
    const id = (item as Json | null)?.id;
    if (typeof id !== "string" || !id) fail(`${what} ${i} needs a string id`);
    if (ids.has(id)) fail(`Two ${what}s have the id "${id}"`);
    ids.add(id);
  });
}

function checkWorkspace(kind: "slides" | "sheets" | "motion", model: Json): void {
  if (!model || typeof model !== "object" || model.version !== 1) fail(`A ${kind} workspace needs version 1`);
  if (kind === "slides") {
    if (!Array.isArray(model.slides) || !model.slides.length) fail("A slides workspace needs at least one slide");
    checkUniqueIds(model.slides, "slide");
    model.slides.forEach((s: Json) => { if (s.elements !== undefined) { if (!Array.isArray(s.elements)) fail(`Slide "${s.id}": elements must be an array`); checkUniqueIds(s.elements, `element of slide ${s.id}`); } });
  } else if (kind === "motion") {
    if (!Array.isArray(model.scenes) || !model.scenes.length) fail("A motion workspace needs at least one scene");
    checkUniqueIds(model.scenes, "scene");
    model.scenes.forEach((s: Json) => { if (!Array.isArray(s.layers)) fail(`Scene "${s.id}" needs a layers array`); checkUniqueIds(s.layers, `layer of scene ${s.id}`); });
  } else {
    if (!Array.isArray(model.sheets) || !model.sheets.length) fail("A sheets workspace needs at least one sheet");
    if (model.sheets.length > 20) fail("A workbook has at most 20 sheets");
    const names = new Set<string>();
    for (const sheet of model.sheets as Json[]) {
      if (!sheet || typeof sheet.name !== "string" || !sheet.name.trim()) fail("Every sheet needs a name");
      if (names.has(sheet.name)) fail(`Two sheets are named "${sheet.name}"`);
      names.add(sheet.name);
      if (!sheet.cells || typeof sheet.cells !== "object" || Array.isArray(sheet.cells)) fail(`Sheet "${sheet.name}" needs a cells object`);
      for (const [address, value] of Object.entries(sheet.cells)) {
        const at = parseAddress(address);
        if (!at) fail(`Sheet "${sheet.name}": "${address}" is not a cell address (A1 to AZ500)`);
        if (typeof value !== "string") fail(`Sheet "${sheet.name}" cell ${address}: values are strings`);
      }
    }
  }
}

/** The model of an artifact's content. */
export function readModel(kind: ArtifactModelKind, content: string): Json {
  if (kind === "doc") return readDoc(content);
  if (kind === "design") return readDesign(content);
  try {
    return JSON.parse(content) as Json;
  } catch {
    return fail(`This ${kind} workspace is not valid JSON: rewrite it, or fix it with text updates`);
  }
}

/** The content of a model, after checking its shape. */
export function writeModel(kind: ArtifactModelKind, model: Json): string {
  if (kind === "doc") { checkDoc(model as DocModel); return writeDoc(model as DocModel); }
  if (kind === "design") { checkDesign(model as DesignModel); return writeDesign(model as DesignModel); }
  checkWorkspace(kind, model);
  return JSON.stringify(model);
}

// ── Selectors ─────────────────────────────────────────────────────────

/** An item by id, by name/title, or by position (a number, from 0). */
function findIndex(items: Json[], selector: unknown, what: string, nameKeys: string[] = ["name", "title"]): number {
  if (typeof selector === "number" && Number.isInteger(selector)) {
    if (selector < 0 || selector >= items.length) fail(`There is no ${what} at position ${selector} (there are ${items.length}, from 0)`);
    return selector;
  }
  if (typeof selector !== "string" || !selector) fail(`Say which ${what}: its id, its name or its position (from 0)`);
  let index = items.findIndex((item) => item?.id === selector);
  if (index < 0) index = items.findIndex((item) => nameKeys.some((k) => typeof item?.[k] === "string" && item[k] === selector));
  if (index < 0) index = items.findIndex((item) => nameKeys.some((k) => typeof item?.[k] === "string" && item[k].toLowerCase() === (selector as string).toLowerCase()));
  if (index < 0) {
    const known = items.slice(0, 30).map((item, i) => `${i}: ${item?.id ?? ""}${nameKeys.map((k) => item?.[k]).find((v) => typeof v === "string") ? ` "${nameKeys.map((k) => item?.[k]).find((v) => typeof v === "string")}"` : ""}`);
    fail(`No ${what} "${selector}". There are: ${known.join(", ")}${items.length > 30 ? ", …" : ""}`);
  }
  return index;
}

function insertAt<T>(items: T[], value: T, at: unknown, after?: number): void {
  const index = typeof at === "number" && Number.isInteger(at) ? Math.max(0, Math.min(at, items.length)) : after !== undefined ? after + 1 : items.length;
  items.splice(index, 0, value);
}

function setFields(target: Json, set: unknown, what: string, protectedKeys: string[] = ["id"]): void {
  if (!set || typeof set !== "object" || Array.isArray(set)) fail(`${what}: set is an object of the fields to change (null removes a field)`);
  for (const [key, value] of Object.entries(set as Json)) {
    if (protectedKeys.includes(key) && value !== target[key]) fail(`${what}: ${key} cannot be changed with set`);
    if (value === null) delete target[key]; else target[key] = value;
  }
}

const newId = (prefix: string, taken: Set<string>) => {
  let id = "";
  do id = `${prefix}-${randomId(8)}`; while (taken.has(id));
  return id;
};

// ── Sheets addresses ──────────────────────────────────────────────────

const MAX_ROWS = 500;
const MAX_COLUMNS = 52;

export function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function columnLetters(n: number): string {
  let out = "";
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
}

function parseAddress(address: string): { col: number; row: number } | undefined {
  const m = /^([A-Za-z]{1,2})(\d{1,3})$/.exec(address);
  if (!m) return undefined;
  const col = columnNumber(m[1]!);
  const row = Number(m[2]);
  return col >= 1 && col <= MAX_COLUMNS && row >= 1 && row <= MAX_ROWS ? { col, row } : undefined;
}

function parseRange(range: string): { c1: number; r1: number; c2: number; r2: number } {
  const [a, b = a] = String(range).split(":");
  const p = parseAddress(a ?? "");
  const q = parseAddress(b ?? "");
  if (!p || !q) return fail(`"${range}" is not a range like A1:C10 (columns A–AZ, rows 1–500)`);
  return { c1: Math.min(p.col, q.col), r1: Math.min(p.row, q.row), c2: Math.max(p.col, q.col), r2: Math.max(p.row, q.row) };
}

const addressOf = (col: number, row: number) => `${columnLetters(col)}${row}`;

type Shift = { axis: "row" | "col"; at: number; count: number; deleting: boolean };

/** The new coordinate after a shift, or undefined when it was deleted. */
function shifted(n: number, s: Shift): number | undefined {
  if (n < s.at) return n;
  if (s.deleting) return n < s.at + s.count ? undefined : n - s.count;
  return n + s.count;
}

function shiftAddress(address: string, s: Shift): string | undefined {
  const p = parseAddress(address);
  if (!p) return address;
  const col = s.axis === "col" ? shifted(p.col, s) : p.col;
  const row = s.axis === "row" ? shifted(p.row, s) : p.row;
  return col === undefined || row === undefined ? undefined : addressOf(col, row);
}

/** A range after a shift (shrunk when part of it was deleted), undefined when all of it was. */
function shiftRange(range: string, s: Shift): string | undefined {
  const r = parseRange(range);
  const lo = s.axis === "row" ? r.r1 : r.c1;
  const hi = s.axis === "row" ? r.r2 : r.c2;
  let a = shifted(lo, s);
  let b = shifted(hi, s);
  if (s.deleting) {
    if (a === undefined) a = s.at;
    if (b === undefined) b = s.at - 1;
    if (b < a) return undefined;
  }
  const out = s.axis === "row" ? { ...r, r1: a!, r2: b! } : { ...r, c1: a!, c2: b! };
  return `${addressOf(out.c1, out.r1)}:${addressOf(out.c2, out.r2)}`;
}

/** References in a formula after a shift (references to deleted cells become #REF!). */
function shiftFormula(formula: string, s: Shift): string {
  if (!formula.startsWith("=")) return formula;
  return formula.replace(/(?<![A-Za-z0-9_!$.])(\$?)([A-Za-z]{1,2})(\$?)(\d{1,3})(?![A-Za-z0-9_(])/g, (whole, d1: string, letters: string, d2: string, digits: string) => {
    const col = columnNumber(letters);
    const row = Number(digits);
    if (col > MAX_COLUMNS || row > MAX_ROWS) return whole;
    const c = s.axis === "col" ? shifted(col, s) : col;
    const r = s.axis === "row" ? shifted(row, s) : row;
    if (c === undefined || r === undefined) return "#REF!";
    return `${d1}${columnLetters(c)}${d2}${r}`;
  });
}

function shiftSheet(sheet: Json, s: Shift): void {
  const max = s.axis === "row" ? MAX_ROWS : MAX_COLUMNS;
  if (!s.deleting) {
    const used = Object.keys(sheet.cells ?? {}).map(parseAddress).filter(Boolean).map((p) => (s.axis === "row" ? p!.row : p!.col));
    const last = used.length ? Math.max(...used) : 0;
    if (last >= s.at && last + s.count > max) fail(`Inserting ${s.count} ${s.axis === "row" ? "rows" : "columns"} would push cells past ${s.axis === "row" ? `row ${MAX_ROWS}` : "column AZ"}`);
  }
  for (const key of ["cells", "styles", "validations"] as const) {
    const map = sheet[key] as Json | undefined;
    if (!map) continue;
    const next: Json = {};
    for (const [address, value] of Object.entries(map)) {
      const moved = shiftAddress(address, s);
      if (moved) next[moved] = key === "cells" && typeof value === "string" ? shiftFormula(value, s) : value;
    }
    sheet[key] = next;
  }
  for (const key of ["rules", "charts"] as const) {
    if (!Array.isArray(sheet[key])) continue;
    sheet[key] = (sheet[key] as Json[]).flatMap((item) => {
      if (typeof item?.range !== "string") return [item];
      const range = shiftRange(item.range, s);
      return range ? [{ ...item, range }] : [];
    });
  }
}

// ── Operations per kind ───────────────────────────────────────────────

export type ArtifactOp = Json & { op: string };

export const ARTIFACT_OPS_GUIDE = [
  "ops: per-kind operations, applied in order (all or nothing). Positions are from 0; an item is named by its id, its name/title or its position.",
  "- doc (Markdown with tabs): set_tab {tab, content} · edit_tab {tab, old_str, new_str, replace_all?} · insert_tab {title, content?, id?, at?} · rename_tab {tab, title} · move_tab {tab, to} · delete_tab {tab}. A document without tabs is one tab (position 0); insert_tab turns it into a tabbed document.",
  "- sheets: set_cells {sheet?, cells:{A1:\"v\"|null}} · set_range {sheet?, start:\"A1\", values:[[\"a\",\"b\"],…]} · clear_range {sheet?, range, styles?} · set_style {sheet?, range, style:{bold,…}|null} · insert_rows/delete_rows {sheet?, at (row number from 1), count?} · insert_columns/delete_columns {sheet?, at:\"C\", count?} · add_sheet {name, cells?, at?} · rename_sheet {sheet, name} · delete_sheet {sheet}. sheet defaults to the first; formulas, styles, rules and charts follow inserted or deleted rows and columns (#REF! for deleted cells).",
  "- slides: insert_slide {slide:{…}, at?} · replace_slide {slide, value} · update_slide {slide, set:{title,body,…}} · move_slide {slide, to} · delete_slide {slide} · insert_element {slide, element:{…}, at?} · update_element {slide, element, set} · delete_element {slide, element}.",
  "- design: replace_board {board, html} · edit_board {board, old_str, new_str, replace_all?} · update_board {board, set:{name,x,y,width,height}} · insert_board {page?, board:{name,x,y,width,height,html,id?}} · delete_board {board} · insert_page {page:{name,id?}, at?} · rename_page {page, name} · delete_page {page} · set_layer {board, id (an element's id attribute), attributes?:{name:value|null}, style?:{property:value|null}, text?}.",
  "- motion: insert_scene {scene:{…}, at?} · replace_scene {scene, value} · update_scene {scene, set} · move_scene {scene, to} · delete_scene {scene} · insert_layer {scene, layer:{…}, at?} · update_layer {scene, layer, set} · delete_layer {scene, layer} · set_project {set:{width,height,audio}}.",
].join("\n");

function docOp(doc: DocModel, op: ArtifactOp): void {
  const tabs = doc.tabs;
  const tabAt = () => findIndex(tabs as Json[], op.tab, "tab", ["title"]);
  switch (op.op) {
    case "set_tab": {
      if (typeof op.content !== "string") fail("set_tab needs content");
      tabs[tabAt()]!.content = op.content;
      return;
    }
    case "edit_tab": {
      const tab = tabs[tabAt()]!;
      tab.content = applyTextUpdates(tab.content, [normalizeTextUpdate(op, "edit_tab")]);
      return;
    }
    case "insert_tab": {
      const taken = new Set(tabs.map((t) => t.id));
      const id = typeof op.id === "string" ? op.id : newId("tab", taken).slice(0, 20);
      if (taken.has(id)) fail(`A tab with id "${id}" exists`);
      if (!doc.namespace && tabs.length === 1 && tabs[0]!.id === "main") doc.namespace = randomId(18);
      insertAt(tabs, { id, title: typeof op.title === "string" ? op.title : "Untitled tab", content: typeof op.content === "string" ? op.content : "" }, op.at);
      return;
    }
    case "rename_tab": {
      if (typeof op.title !== "string" || !op.title.trim()) fail("rename_tab needs a title");
      tabs[tabAt()]!.title = op.title;
      if (!doc.namespace) doc.namespace = randomId(18);
      return;
    }
    case "move_tab": {
      const [tab] = tabs.splice(tabAt(), 1);
      insertAt(tabs, tab!, op.to);
      return;
    }
    case "delete_tab": {
      if (tabs.length === 1) fail("A document keeps at least one tab");
      tabs.splice(tabAt(), 1);
      return;
    }
    default:
      fail(`Unknown doc op "${op.op}" (set_tab, edit_tab, insert_tab, rename_tab, move_tab, delete_tab)`);
  }
}

function sheetsOp(model: Json, op: ArtifactOp): void {
  const sheets = model.sheets as Json[];
  const sheet = () => sheets[op.sheet === undefined ? 0 : findIndex(sheets, op.sheet, "sheet", ["name"])]!;
  const count = typeof op.count === "number" && Number.isInteger(op.count) && op.count > 0 ? op.count : 1;
  const value = (v: unknown) => (v === null || v === undefined ? undefined : typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v).toUpperCase() === "TRUE" || String(v).toUpperCase() === "FALSE" ? String(v).toUpperCase() : String(v) : fail("Cell values are strings, numbers or booleans"));
  switch (op.op) {
    case "set_cells": {
      if (!op.cells || typeof op.cells !== "object") fail("set_cells needs cells: { A1: \"value\" } (null clears a cell)");
      const s = sheet();
      s.cells ??= {};
      for (const [address, v] of Object.entries(op.cells as Json)) {
        const at = parseAddress(address);
        if (!at) fail(`"${address}" is not a cell address (A1 to AZ500)`);
        const key = addressOf(at!.col, at!.row);
        const text = value(v);
        if (text === undefined || text === "") delete s.cells[key]; else s.cells[key] = text;
      }
      return;
    }
    case "set_range": {
      const start = parseAddress(String(op.start ?? "A1"));
      if (!start) fail(`"${op.start}" is not a cell address`);
      if (!Array.isArray(op.values) || !op.values.every(Array.isArray)) fail("set_range needs values: rows of values ([[\"a\", \"b\"], [\"c\", \"d\"]])");
      const s = sheet();
      s.cells ??= {};
      (op.values as unknown[][]).forEach((row, r) => row.forEach((v, c) => {
        const col = start!.col + c;
        const rowNo = start!.row + r;
        if (col > MAX_COLUMNS || rowNo > MAX_ROWS) fail(`set_range goes past ${col > MAX_COLUMNS ? "column AZ" : `row ${MAX_ROWS}`}`);
        const key = addressOf(col, rowNo);
        const text = value(v);
        if (text === undefined || text === "") delete s.cells[key]; else s.cells[key] = text;
      }));
      return;
    }
    case "clear_range": {
      const r = parseRange(String(op.range ?? ""));
      const s = sheet();
      for (const key of ["cells", ...(op.styles ? ["styles", "validations"] : [])]) {
        const map = s[key] as Json | undefined;
        if (!map) continue;
        for (const address of Object.keys(map)) {
          const p = parseAddress(address);
          if (p && p.col >= r.c1 && p.col <= r.c2 && p.row >= r.r1 && p.row <= r.r2) delete map[address];
        }
      }
      return;
    }
    case "set_style": {
      const r = parseRange(String(op.range ?? ""));
      if (op.style !== null && (typeof op.style !== "object" || Array.isArray(op.style))) fail("set_style needs style: { bold?, italic?, fill?, … } (null clears the style)");
      const s = sheet();
      s.styles ??= {};
      for (let c = r.c1; c <= r.c2; c += 1) for (let row = r.r1; row <= r.r2; row += 1) {
        const key = addressOf(c, row);
        if (op.style === null) { delete s.styles[key]; continue; }
        const next = { ...(s.styles[key] ?? {}) };
        for (const [k, v] of Object.entries(op.style as Json)) { if (v === null) delete next[k]; else next[k] = v; }
        if (Object.keys(next).length) s.styles[key] = next; else delete s.styles[key];
      }
      return;
    }
    case "insert_rows": case "delete_rows": {
      const at = Number(op.at);
      if (!Number.isInteger(at) || at < 1 || at > MAX_ROWS) fail(`${op.op} needs at: a row number from 1 to ${MAX_ROWS}`);
      shiftSheet(sheet(), { axis: "row", at, count, deleting: op.op === "delete_rows" });
      return;
    }
    case "insert_columns": case "delete_columns": {
      const at = typeof op.at === "number" ? op.at : columnNumber(String(op.at ?? ""));
      if (!Number.isInteger(at) || at < 1 || at > MAX_COLUMNS) fail(`${op.op} needs at: a column letter (A to AZ)`);
      shiftSheet(sheet(), { axis: "col", at, count, deleting: op.op === "delete_columns" });
      return;
    }
    case "add_sheet": {
      if (typeof op.name !== "string" || !op.name.trim()) fail("add_sheet needs a name");
      if (sheets.some((s) => s.name === op.name)) fail(`A sheet is named "${op.name}"`);
      insertAt(sheets, { name: op.name, cells: {} }, op.at);
      if (op.cells) sheetsOp(model, { op: "set_cells", sheet: op.name, cells: op.cells });
      return;
    }
    case "rename_sheet": {
      if (typeof op.name !== "string" || !op.name.trim()) fail("rename_sheet needs a name");
      const s = sheet();
      if (sheets.some((x) => x !== s && x.name === op.name)) fail(`A sheet is named "${op.name}"`);
      const old = s.name as string;
      s.name = op.name;
      // references from other sheets ('Old'!A1 or Old!A1) follow the new name
      const quoted = (n: string) => (/^[A-Za-z_][\w]*$/.test(n) ? n : `'${n.replace(/'/g, "''")}'`);
      for (const other of sheets) for (const [k, v] of Object.entries(other.cells ?? {})) {
        if (typeof v === "string" && v.startsWith("=")) other.cells[k] = v.split(`${quoted(old)}!`).join(`${quoted(op.name)}!`);
      }
      return;
    }
    case "delete_sheet": {
      if (sheets.length === 1) fail("A workbook keeps at least one sheet");
      sheets.splice(findIndex(sheets, op.sheet, "sheet", ["name"]), 1);
      return;
    }
    default:
      fail(`Unknown sheets op "${op.op}" (set_cells, set_range, clear_range, set_style, insert_rows, delete_rows, insert_columns, delete_columns, add_sheet, rename_sheet, delete_sheet)`);
  }
}

function listOps(kind: "slides" | "motion", model: Json, op: ArtifactOp): void {
  const [itemKey, childKey, item, child] = kind === "slides" ? ["slides", "elements", "slide", "element"] : ["scenes", "layers", "scene", "layer"];
  const items = model[itemKey] as Json[];
  const at = () => findIndex(items, op[item], item, ["title", "name"]);
  const ids = () => new Set(items.map((s) => s.id as string));
  switch (op.op) {
    case `insert_${item}`: {
      const value = op[item];
      if (!value || typeof value !== "object" || Array.isArray(value)) fail(`insert_${item} needs ${item}: the ${item} object`);
      const copy = clone(value) as Json;
      copy.id ??= newId(item, ids());
      if (kind === "motion") copy.layers ??= [];
      insertAt(items, copy, op.at);
      return;
    }
    case `replace_${item}`: {
      if (!op.value || typeof op.value !== "object" || Array.isArray(op.value)) fail(`replace_${item} needs value: the new ${item} object`);
      const index = at();
      items[index] = { ...clone(op.value), id: (op.value as Json).id ?? items[index]!.id };
      return;
    }
    case `update_${item}`: setFields(items[at()]!, op.set, `update_${item}`); return;
    case `move_${item}`: {
      const [moved] = items.splice(at(), 1);
      insertAt(items, moved!, op.to);
      return;
    }
    case `delete_${item}`: {
      if (items.length === 1) fail(`A ${kind} workspace keeps at least one ${item}`);
      items.splice(at(), 1);
      return;
    }
    case `insert_${child}`: {
      const parent = items[at()]!;
      const value = op[child];
      if (!value || typeof value !== "object" || Array.isArray(value)) fail(`insert_${child} needs ${child}: the ${child} object`);
      parent[childKey] ??= [];
      const copy = clone(value) as Json;
      copy.id ??= newId(child, new Set((parent[childKey] as Json[]).map((e) => e.id)));
      insertAt(parent[childKey], copy, op.at);
      return;
    }
    case `update_${child}`: {
      const parent = items[at()]!;
      const children = (parent[childKey] ?? []) as Json[];
      setFields(children[findIndex(children, op[child], child, ["name", "text"])]!, op.set, `update_${child}`);
      return;
    }
    case `delete_${child}`: {
      const parent = items[at()]!;
      const children = (parent[childKey] ?? []) as Json[];
      children.splice(findIndex(children, op[child], child, ["name", "text"]), 1);
      return;
    }
    case "set_project":
      if (kind !== "motion") break;
      setFields(model, op.set, "set_project", ["version", "scenes"]);
      return;
  }
  fail(`Unknown ${kind} op "${op.op}" (insert_${item}, replace_${item}, update_${item}, move_${item}, delete_${item}, insert_${child}, update_${child}, delete_${child}${kind === "motion" ? ", set_project" : ""})`);
}

/** Set attributes, inline style properties or the text of the element with id="…" in an HTML document. */
export function setLayer(html: string, id: string, change: { attributes?: Json; style?: Json; text?: unknown }): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const open = new RegExp(`<([a-zA-Z][\\w:-]*)(\\s[^>]*?\\bid\\s*=\\s*(["']?)${escaped}\\3(?=[\\s/>])[^>]*?)(/?)>`, "g");
  const matches = [...html.matchAll(open)];
  if (!matches.length) fail(`No element with id="${id}" in this artboard`);
  if (matches.length > 1) fail(`Several elements have id="${id}": make the id unique first (edit_board)`);
  const m = matches[0]!;
  const tag = m[1]!;
  let attrs = m[2]!;
  const setAttr = (name: string, value: string | null) => {
    if (!/^[\w:-]+$/.test(name)) fail(`"${name}" is not an attribute name`);
    const re = new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)|\\s${name}(?=[\\s/>]|$)`, "i");
    const next = value === null ? "" : ` ${name}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
    attrs = re.test(attrs) ? attrs.replace(re, next) : value === null ? attrs : attrs + next;
  };
  for (const [name, value] of Object.entries(change.attributes ?? {})) {
    if (name.toLowerCase() === "id") fail("set_layer cannot change the id");
    setAttr(name, value === null ? null : String(value));
  }
  if (change.style && Object.keys(change.style).length) {
    const current = /\sstyle\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
    const props = new Map<string, string>();
    for (const decl of (current?.[2] ?? current?.[3] ?? "").replace(/&quot;/g, "\"").split(";")) {
      const i = decl.indexOf(":");
      if (i > 0) props.set(decl.slice(0, i).trim().toLowerCase(), decl.slice(i + 1).trim());
    }
    for (const [prop, value] of Object.entries(change.style)) {
      const name = prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      if (value === null) props.delete(name); else props.set(name, String(value));
    }
    setAttr("style", props.size ? [...props].map(([k, v]) => `${k}: ${v}`).join("; ") : null);
  }
  const start = m.index!;
  const openEnd = start + m[0].length;
  let out = `${html.slice(0, start)}<${tag}${attrs}${m[4]}>${html.slice(openEnd)}`;
  if (change.text !== undefined) {
    if (m[4]) fail(`<${tag} id="${id}"> has no text content`);
    const shift = out.length - html.length;
    const close = new RegExp(`</${tag}\\s*>`, "i");
    const rest = out.slice(openEnd + shift);
    const end = close.exec(rest);
    if (!end) fail(`<${tag} id="${id}"> is not closed`);
    if (/<[a-zA-Z]/.test(rest.slice(0, end!.index))) fail(`<${tag} id="${id}"> contains other elements: change its text with edit_board`);
    const text = String(change.text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    out = out.slice(0, openEnd + shift) + text + rest.slice(end!.index);
  }
  return out;
}

function designOp(model: DesignModel, op: ArtifactOp): void {
  const pages = model.pages;
  const boards = () => pages.flatMap((p, pi) => p.boards.map((b, bi) => ({ b, p, pi, bi })));
  const board = () => {
    const all = boards();
    const index = findIndex(all.map((x) => x.b) as unknown as Json[], op.board, "artboard", ["name"]);
    return all[index]!;
  };
  const allIds = () => new Set(boards().map((x) => x.b.id));
  switch (op.op) {
    case "replace_board": {
      if (typeof op.html !== "string") fail("replace_board needs html");
      board().b.html = op.html;
      return;
    }
    case "edit_board": {
      const { b } = board();
      b.html = applyTextUpdates(b.html, [normalizeTextUpdate(op, "edit_board")]);
      return;
    }
    case "update_board": setFields(board().b as unknown as Json, op.set, "update_board", ["id", "html"]); return;
    case "set_layer": {
      if (typeof op.id !== "string" || !op.id) fail("set_layer needs id: the id attribute of the element to change");
      const { b } = board();
      b.html = setLayer(b.html, op.id, { attributes: op.attributes, style: op.style, text: op.text });
      return;
    }
    case "insert_board": {
      const value = op.board as Json | undefined;
      if (!value || typeof value !== "object") fail("insert_board needs board: { name, x, y, width, height, html }");
      const page = pages[op.page === undefined ? 0 : findIndex(pages as unknown as Json[], op.page, "page", ["name"])]!;
      const taken = allIds();
      const id = typeof value!.id === "string" ? value!.id : newId("board", taken);
      if (taken.has(id)) fail(`An artboard with id "${id}" exists`);
      const last = page.boards[page.boards.length - 1];
      insertAt(page.boards, {
        id, name: String(value!.name ?? `Artboard ${taken.size + 1}`), html: typeof value!.html === "string" ? value!.html : "<!doctype html><html><body></body></html>",
        x: Number(value!.x ?? (last ? last.x + last.width + 80 : 0)), y: Number(value!.y ?? 0), width: Number(value!.width ?? 1024), height: Number(value!.height ?? 680),
      }, op.at);
      return;
    }
    case "delete_board": {
      // deleting the primary artboard: the next one becomes the outer document
      const { p, bi } = board();
      if (p.boards.length === 1) fail(`Page "${p.name}" keeps at least one artboard (delete the page instead)`);
      p.boards.splice(bi, 1);
      return;
    }
    case "insert_page": {
      const value = (op.page ?? {}) as Json;
      const taken = new Set(pages.map((p) => p.id));
      const id = typeof value.id === "string" ? value.id : newId("page", taken);
      if (taken.has(id)) fail(`A page with id "${id}" exists`);
      const boardIds = allIds();
      insertAt(pages, {
        id, name: String(value.name ?? `Page ${pages.length + 1}`),
        boards: [{ id: newId("board", boardIds), name: "Artboard 1", x: 0, y: 0, width: 1024, height: 680, html: "<!doctype html><html><body></body></html>" }],
      }, op.at);
      return;
    }
    case "rename_page": {
      if (typeof op.name !== "string" || !op.name.trim()) fail("rename_page needs a name");
      pages[findIndex(pages as unknown as Json[], op.page, "page", ["name"])]!.name = op.name;
      return;
    }
    case "delete_page": {
      if (pages.length === 1) fail("A design keeps at least one page");
      pages.splice(findIndex(pages as unknown as Json[], op.page, "page", ["name"]), 1);
      return;
    }
    default:
      fail(`Unknown design op "${op.op}" (replace_board, edit_board, update_board, set_layer, insert_board, delete_board, insert_page, rename_page, delete_page)`);
  }
}

/** Apply per-kind ops to a model (a copy is changed and returned). */
export function applyArtifactOps(kind: ArtifactModelKind, model: Json, ops: ArtifactOp[]): Json {
  const next = clone(model);
  ops.forEach((op, i) => {
    if (!op || typeof op !== "object" || typeof op.op !== "string") fail(`ops[${i}]: each operation is an object with op`);
    try {
      if (kind === "doc") docOp(next as DocModel, op);
      else if (kind === "sheets") sheetsOp(next, op);
      else if (kind === "design") designOp(next as DesignModel, op);
      else listOps(kind, next, op);
    } catch (err) {
      if (err instanceof ArtifactChangeError) fail(`ops[${i}] (${op.op}): ${err.message}${ops.length > 1 ? ". Nothing was saved." : ""}`);
      throw err;
    }
  });
  return next;
}

// ── One change request ────────────────────────────────────────────────

/** A change to the content, as REST, MCP and the tools take it (one of them per call). */
export interface ArtifactContentChange {
  /** update (default when old_str/updates are given), rewrite (default when content is given), append, prepend. */
  command?: "update" | "rewrite" | "append" | "prepend";
  old_str?: string;
  new_str?: string;
  replace_all?: boolean;
  updates?: unknown[];
  /** Earlier name of updates (find/replace or old_text/new_text). */
  edits?: unknown[];
  content?: string;
  /** For append/prepend (or the content field). */
  text?: string;
  append?: string;
  prepend?: string;
  patch?: JsonPatchOp[];
  ops?: ArtifactOp[];
}

/** Whether a request changes the content at all, and whether it needs the current content to do it. */
export function changeShape(change: ArtifactContentChange): { changes: boolean; needsCurrent: boolean } {
  const updates = change.command === "update" || change.old_str !== undefined || (change.updates?.length ?? 0) > 0 || (change.edits?.length ?? 0) > 0;
  const partial = updates || change.append !== undefined || change.prepend !== undefined || change.command === "append" || change.command === "prepend"
    || (change.patch?.length ?? 0) > 0 || (change.ops?.length ?? 0) > 0;
  return { changes: partial || change.content !== undefined || change.command === "rewrite", needsCurrent: partial };
}

/**
 * The new content after a change. `current` is the content now (needed unless it is a rewrite).
 * Throws ArtifactChangeError with a message for the model.
 */
export function resolveArtifactChange(artifact: { type: ArtifactType; kind?: string }, current: string, change: ArtifactContentChange): { content: string; summary: string } {
  const kinds = [
    change.command === "rewrite" || (change.content !== undefined && !change.command) ? "rewrite" : undefined,
    change.command === "update" || change.old_str !== undefined || change.updates?.length || change.edits?.length ? "update" : undefined,
    change.command === "append" || change.append !== undefined ? "append" : undefined,
    change.command === "prepend" || change.prepend !== undefined ? "prepend" : undefined,
    change.patch?.length ? "patch" : undefined,
    change.ops?.length ? "ops" : undefined,
  ].filter(Boolean);
  if (kinds.length > 1) fail(`Give one kind of change per call (got ${kinds.join(" + ")})`);
  const kind = kinds[0];
  if (!kind) fail("Nothing to change: pass command update (old_str, new_str), rewrite (content), append/prepend (text), patch or ops");
  let content: string;
  let summary: string;
  switch (kind) {
    case "rewrite":
      if (typeof change.content !== "string") fail("rewrite needs content: the whole new content");
      content = change.content!;
      summary = "rewritten";
      break;
    case "update": {
      const list = change.updates?.length ? change.updates : change.edits?.length ? change.edits : [change];
      const updates = list.map((u, i) => normalizeTextUpdate(u, list.length > 1 ? `updates[${i}]` : "update"));
      content = applyTextUpdates(current, updates);
      summary = `${updates.length} update${updates.length > 1 ? "s" : ""}`;
      break;
    }
    case "append": case "prepend": {
      const text = change[kind] ?? change.text ?? change.content;
      if (typeof text !== "string" || !text) fail(`${kind} needs the text to add`);
      content = kind === "append" ? current + text! : text! + current;
      summary = `${kind}ed ${text!.length} characters`;
      break;
    }
    default: {
      const model = artifactModelKind(artifact.type, artifact.kind, current);
      if (!model) fail(`${kind} works on documents and on slides, sheets, design and motion workspaces; change this ${artifact.type}${artifact.kind ? `/${artifact.kind}` : ""} with update (old_str/new_str)`);
      const read = readModel(model!, current);
      const next = kind === "patch" ? applyJsonPatch(read, change.patch!) : applyArtifactOps(model!, read, change.ops!);
      content = writeModel(model!, next);
      summary = kind === "patch" ? `JSON patch (${change.patch!.length} operation${change.patch!.length > 1 ? "s" : ""})` : `${change.ops!.map((o) => o.op).join(", ")}`;
    }
  }
  const problem = artifactContentProblem(artifact.type, content, artifact.kind);
  if (problem) fail(`${problem}: nothing was saved`);
  return { content, summary };
}

// ── Reading a part ────────────────────────────────────────────────────

export interface ArtifactPartSelector {
  tab?: string | number;
  slide?: string | number;
  /** Slides from..to, e.g. "2-5" (positions from 0). */
  slides?: string;
  sheet?: string | number;
  /** With sheet: only these cells, e.g. "A1:D20". */
  range?: string;
  board?: string | number;
  page?: string | number;
  scene?: string | number;
}

const sizeOf = (value: unknown) => (typeof value === "string" ? value.length : JSON.stringify(value ?? null).length);

/** The structure of an artifact (tabs, slides, sheets, pages and boards, scenes) with ids and sizes. */
export function artifactOutline(artifact: { type: ArtifactType; kind?: string }, content: string): string {
  const kind = artifactModelKind(artifact.type, artifact.kind, content);
  const lines = content.split("\n").length;
  if (!kind) return `${content.length} characters, ${lines} lines (read a part with offset/limit, change it with update old_str → new_str)`;
  try {
    const model = readModel(kind, content);
    if (kind === "doc") {
      const tabs = (model as DocModel).tabs;
      return tabs.length === 1 && tabs[0]!.id === "main" ? `Document without tabs: ${content.length} characters, ${lines} lines`
        : `Tabs:\n${tabs.map((t, i) => `  ${i}. ${t.id} "${t.title}" (${t.content.length} characters)`).join("\n")}`;
    }
    if (kind === "design") {
      return `Pages and artboards:\n${(model as DesignModel).pages.map((p, i) => `  page ${i}. ${p.id} "${p.name}"\n${p.boards.map((b) => `    board ${b.id} "${b.name}" ${b.width}×${b.height} at ${b.x},${b.y} (${b.html.length} characters)`).join("\n")}`).join("\n")}`;
    }
    if (kind === "sheets") {
      return `Sheets:\n${(model.sheets as Json[]).map((s, i) => {
        const cells = Object.keys(s.cells ?? {});
        const at = cells.map(parseAddress).filter(Boolean) as Array<{ col: number; row: number }>;
        const used = at.length ? `${addressOf(Math.min(...at.map((a) => a.col)), Math.min(...at.map((a) => a.row)))}:${addressOf(Math.max(...at.map((a) => a.col)), Math.max(...at.map((a) => a.row)))}` : "empty";
        return `  ${i}. "${s.name}" ${cells.length} cells (${used})${s.charts?.length ? `, ${s.charts.length} charts` : ""}`;
      }).join("\n")}`;
    }
    const [key, child] = kind === "slides" ? ["slides", "elements"] : ["scenes", "layers"];
    return `${key[0]!.toUpperCase()}${key.slice(1)}:\n${(model[key] as Json[]).map((s, i) =>
      `  ${i}. ${s.id} "${s.title ?? s.name ?? ""}"${s.layout ? ` ${s.layout}` : ""}${s.hidden ? " (hidden)" : ""}${Array.isArray(s[child]) ? `, ${s[child].length} ${child}` : ""} (${sizeOf(s)} characters)`).join("\n")}`;
  } catch (err) {
    return `${content.length} characters (${err instanceof Error ? err.message : "unreadable model"})`;
  }
}

/** One part of an artifact (a tab, slides, a sheet or range, a page or board, a scene) as text. */
export function readArtifactPart(artifact: { type: ArtifactType; kind?: string }, content: string, selector: ArtifactPartSelector): string {
  const kind = artifactModelKind(artifact.type, artifact.kind, content);
  if (!kind) fail("This artifact has no parts: read it with offset/limit");
  const model = readModel(kind!, content);
  if (kind === "doc") {
    if (selector.tab === undefined) fail("Say which tab (tab: its id, title or position)");
    const tabs = (model as DocModel).tabs;
    const tab = tabs[findIndex(tabs as unknown as Json[], selector.tab, "tab", ["title"])]!;
    return `Tab ${tab.id} "${tab.title}":\n${tab.content}`;
  }
  if (kind === "design") {
    const pages = (model as DesignModel).pages;
    if (selector.board !== undefined) {
      const all = pages.flatMap((p) => p.boards);
      const b = all[findIndex(all as unknown as Json[], selector.board, "artboard", ["name"])]!;
      return `Artboard ${b.id} "${b.name}" ${b.width}×${b.height} at ${b.x},${b.y}:\n${b.html}`;
    }
    if (selector.page !== undefined) {
      const p = pages[findIndex(pages as unknown as Json[], selector.page, "page", ["name"])]!;
      return JSON.stringify(p, null, 1);
    }
    fail("Say which board or page");
  }
  if (kind === "sheets") {
    const sheets = model.sheets as Json[];
    const sheet = sheets[selector.sheet === undefined ? 0 : findIndex(sheets, selector.sheet, "sheet", ["name"])]!;
    if (!selector.range) return JSON.stringify(sheet);
    const r = parseRange(selector.range);
    const pick = (map: Json | undefined) => Object.fromEntries(Object.entries(map ?? {}).filter(([a]) => {
      const p = parseAddress(a);
      return p && p.col >= r.c1 && p.col <= r.c2 && p.row >= r.r1 && p.row <= r.r2;
    }));
    return JSON.stringify({ name: sheet.name, range: selector.range, cells: pick(sheet.cells), ...(sheet.styles ? { styles: pick(sheet.styles) } : {}) });
  }
  const [key, item] = kind === "slides" ? ["slides", "slide"] : ["scenes", "scene"];
  const items = model[key] as Json[];
  if (kind === "slides" && selector.slides) {
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(selector.slides);
    if (!m) fail(`slides is a range of positions like "2-5" (from 0)`);
    return JSON.stringify(items.slice(Number(m![1]), Number(m![2]) + 1));
  }
  const sel = kind === "slides" ? selector.slide : selector.scene;
  if (sel === undefined) fail(`Say which ${item} (${item}: its id, title or position${kind === "slides" ? `, or slides: "2-5"` : ""})`);
  return JSON.stringify(items[findIndex(items, sel, item, ["title", "name"])]);
}
