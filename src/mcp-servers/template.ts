/**
 * Templates and response shaping for declarative HTTP tools.
 *
 * Placeholders: `{{input.path.to.value}}`, `{{settings.key}}` (the server's non-secret settings),
 * `{{secrets.NAME}}` (headers and query only) and a fallback after `??`: a literal
 * (`{{input.limit ?? 20}}`, `{{input.x ?? "a"}}`) or another variable (`{{input.currency ?? settings.currency}}`).
 * A string that is exactly one placeholder renders to the raw value (in JSON bodies: numbers, lists
 * and objects stay typed). Missing values render as `undefined` so the caller can leave the
 * parameter / key out.
 *
 * Picks are JSONPath-ish: `result`, `$.data.items`, `items[0]`, `items[*].id`, `a.b[2].c`.
 *
 * Shaping (so large responses stay useful): pick → filters (by the tool's input) → local paging →
 * fields, plus aggregates computed on the whole response (counts, unique values, min / max); and
 * when the text is still too long, whole list items are dropped (saying how many) instead of
 * cutting the JSON in the middle.
 */
import type { HttpResponseAggregate, HttpResponseFilter, HttpResponseMapping } from "./types.js";

const VAR = String.raw`[a-zA-Z_][\w]*(?:\.[\w-]+|\[\d+\])*`;
const PLACEHOLDER = new RegExp(String.raw`\{\{\s*(${VAR})\s*(?:\?\?\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null|${VAR}))?\s*\}\}`, "g");
const WHOLE = new RegExp(`^${PLACEHOLDER.source}$`);
const LITERAL = /^(?:"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)$/;

export interface TemplateScope {
  input: Record<string, unknown>;
  /** The server's settings values (non-secret). */
  settings?: Record<string, unknown>;
  /** Present only where secrets may appear (headers, query). */
  secrets?: Record<string, string>;
}

export class TemplateError extends Error {}

/** Path segments of `a.b[0].c` → ["a", "b", 0, "c"]. */
export function parsePath(path: string): Array<string | number | "*"> {
  const clean = path.trim().replace(/^\$\.?/, "");
  if (!clean) return [];
  const out: Array<string | number | "*"> = [];
  for (const part of clean.split(".")) {
    const m = /^([^[\]]*)((?:\[(?:\d+|\*)\])*)$/.exec(part);
    if (!m) throw new TemplateError(`Invalid path segment "${part}" in "${path}"`);
    if (m[1]) out.push(m[1] === "*" ? "*" : m[1]);
    for (const idx of m[2]!.matchAll(/\[(\d+|\*)\]/g)) out.push(idx[1] === "*" ? "*" : Number(idx[1]));
  }
  return out;
}

/** The value at a path (`*` maps over a list). */
export function getPath(value: unknown, path: string | Array<string | number | "*">): unknown {
  const segments = typeof path === "string" ? parsePath(path) : path;
  let current: unknown = value;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (current === undefined || current === null) return undefined;
    if (seg === "*") {
      if (!Array.isArray(current)) return undefined;
      const rest = segments.slice(i + 1);
      return current.map((item) => getPath(item, rest));
    }
    if (typeof seg === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[seg];
    } else {
      if (typeof current !== "object" || Array.isArray(current)) return undefined;
      if (!Object.prototype.hasOwnProperty.call(current, seg)) return undefined;
      current = (current as Record<string, unknown>)[seg];
    }
  }
  return current;
}

function lookup(expr: string, scope: TemplateScope): unknown {
  const [root, ...rest] = parsePath(expr);
  if (root === "input") return getPath(scope.input, rest);
  if (root === "settings") return getPath(scope.settings ?? {}, rest);
  if (root === "secrets") {
    if (!scope.secrets) throw new TemplateError(`Secrets are only allowed in headers and query parameters ("${expr}")`);
    return getPath(scope.secrets, rest);
  }
  throw new TemplateError(`Unknown template variable "${expr}": use input.*, settings.* or secrets.*`);
}

function fallback(raw: string | undefined, scope: TemplateScope): unknown {
  if (raw === undefined) return undefined;
  if (LITERAL.test(raw)) return JSON.parse(raw);
  const v = lookup(raw, scope);
  return v === null ? undefined : v;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const missingValue = (v: unknown) => v === undefined || v === null || v === "";

/** Render a string template. Exactly one placeholder: the raw value (undefined when missing). */
export function renderValue(template: string, scope: TemplateScope, encode?: (s: string) => string): unknown {
  const whole = WHOLE.exec(template);
  if (whole) {
    const v = lookup(whole[1]!, scope);
    const out = missingValue(v) ? fallback(whole[2], scope) : v;
    const value = out === "" ? undefined : out;
    return encode && value !== undefined ? encode(stringify(value)) : value;
  }
  let missing = false;
  const text = template.replace(PLACEHOLDER, (_m, expr: string, def?: string) => {
    let v = lookup(expr, scope);
    if (missingValue(v)) v = fallback(def, scope);
    if (missingValue(v)) { missing = true; return ""; }
    const s = stringify(v);
    return encode ? encode(s) : s;
  });
  return missing && text.trim() === "" ? undefined : text;
}

/** Render to a string; undefined when the template's only values are missing. */
export function renderString(template: string, scope: TemplateScope, encode?: (s: string) => string): string | undefined {
  const v = renderValue(template, scope, encode);
  return v === undefined ? undefined : stringify(v);
}

/** Render a URL: placeholders are URL-encoded; a missing one is an error (a path needs every part). */
export function renderUrl(template: string, scope: TemplateScope): string {
  const noSecrets: TemplateScope = { input: scope.input, ...(scope.settings ? { settings: scope.settings } : {}) };
  const missing: string[] = [];
  const out = template.replace(PLACEHOLDER, (_m, expr: string, def?: string) => {
    let v = lookup(expr, noSecrets);
    if (missingValue(v)) v = fallback(def, noSecrets);
    if (missingValue(v)) { missing.push(expr); return ""; }
    return encodeURIComponent(stringify(v));
  });
  if (missing.length) throw new TemplateError(`Missing ${missing.join(", ")} for the URL${missing.some((m) => m.startsWith("settings.")) ? " (set it in the server's settings)" : ""}`);
  return out;
}

/** Render a JSON body template (no secrets: they would end up in logs and echoes). */
export function renderBody(template: unknown, scope: TemplateScope): unknown {
  const noSecrets: TemplateScope = { input: scope.input, ...(scope.settings ? { settings: scope.settings } : {}) };
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return renderValue(node, noSecrets);
    if (Array.isArray(node)) return node.map(walk).filter((v) => v !== undefined);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        const r = walk(v);
        if (r !== undefined) out[k] = r;
      }
      return out;
    }
    return node;
  };
  return walk(template);
}

/** The variables a template uses, fallbacks included (validation). */
export function placeholdersOf(template: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === "string") {
      for (const m of node.matchAll(PLACEHOLDER)) {
        out.push(m[1]!);
        if (m[2] && !LITERAL.test(m[2])) out.push(m[2]);
      }
    } else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") Object.values(node).forEach(walk);
  };
  walk(template);
  return out;
}

function project(item: unknown, fields: string[]): unknown {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const v = getPath(item, field);
    if (v === undefined) continue;
    // nested fields keep their shape: "options.color" → { options: { color } }
    const parts = field.split(".");
    let target = out;
    for (const part of parts.slice(0, -1)) {
      target[part] = (target[part] && typeof target[part] === "object" ? target[part] : {}) as Record<string, unknown>;
      target = target[part] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]!] = v;
  }
  return out;
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const norm = (v: unknown) => String(v).trim().toLowerCase();

function same(a: unknown, b: unknown): boolean {
  if (typeof a === "string" || typeof b === "string") {
    const na = num(a);
    const nb = num(b);
    if (na !== undefined && nb !== undefined && (typeof a === "number" || typeof b === "number")) return na === nb;
    return norm(a) === norm(b);
  }
  return a === b;
}

/** Does an item pass a filter rule? Rules whose input is not given pass. */
export function matchesFilter(item: unknown, rule: HttpResponseFilter, input: Record<string, unknown>): boolean {
  const wanted = rule.input !== undefined ? input[rule.input] : rule.value;
  if (wanted === undefined || wanted === null || wanted === "" || (Array.isArray(wanted) && wanted.length === 0)) return true;
  const actual = getPath(item, rule.path);
  if (actual === undefined || actual === null) return false;
  switch (rule.match ?? "equals") {
    case "contains": return norm(actual).includes(norm(wanted));
    case "in": return (Array.isArray(wanted) ? wanted : [wanted]).some((w) => same(actual, w));
    case "gte": { const a = num(actual); const w = num(wanted); return a !== undefined && w !== undefined && a >= w; }
    case "lte": { const a = num(actual); const w = num(wanted); return a !== undefined && w !== undefined && a <= w; }
    default: return Array.isArray(actual) ? actual.some((x) => same(x, wanted)) : same(actual, wanted);
  }
}

export function aggregate(body: unknown, agg: HttpResponseAggregate): unknown {
  const raw = getPath(body, agg.path);
  if (agg.op === "value") return raw;
  const list = Array.isArray(raw) ? raw.flat().filter((v) => v !== undefined && v !== null) : raw === undefined || raw === null ? [] : [raw];
  switch (agg.op) {
    case "count": return Array.isArray(raw) ? raw.length : list.length;
    case "unique": {
      const seen = new Map<string, unknown>();
      for (const v of list) { const k = typeof v === "object" ? JSON.stringify(v) : String(v); if (!seen.has(k)) seen.set(k, v); }
      return [...seen.values()];
    }
    default: {
      const nums = list.map(num).filter((n): n is number => n !== undefined);
      if (!nums.length) return undefined;
      if (agg.op === "min") return Math.min(...nums);
      if (agg.op === "max") return Math.max(...nums);
      return Math.round(nums.reduce((a, b) => a + b, 0) * 100) / 100;
    }
  }
}

/**
 * Shape a response for the model: pick, filters (by input), local paging, fields, aggregates.
 * `input` is the tool call's input (filters and paging read it).
 */
export function shapeResponse(body: unknown, mapping: HttpResponseMapping | undefined, input: Record<string, unknown> = {}): unknown {
  if (!mapping) return body;
  let value = mapping.pick ? getPath(body, mapping.pick) : body;
  if (mapping.filters?.length && Array.isArray(value)) value = value.filter((item) => mapping.filters!.every((f) => matchesFilter(item, f, input)));
  let paging: { total: number; offset: number; limit: number } | undefined;
  if (mapping.page && Array.isArray(value)) {
    const max = mapping.page.maxLimit ?? 100;
    const offset = Math.max(0, Math.floor(num(input[mapping.page.offsetInput ?? "offset"]) ?? 0));
    const limit = Math.min(max, Math.max(1, Math.floor(num(input[mapping.page.limitInput ?? "limit"]) ?? mapping.page.defaultLimit ?? 20)));
    paging = { total: value.length, offset, limit };
    value = value.slice(offset, offset + limit);
  }
  if (mapping.fields?.length) value = Array.isArray(value) ? value.map((v) => project(v, mapping.fields!)) : project(value, mapping.fields);
  if (paging) {
    const next = paging.offset + paging.limit;
    value = { items: value, total: paging.total, offset: paging.offset, limit: paging.limit, ...(next < paging.total ? { next_offset: next } : {}) };
  }
  if (mapping.aggregates && Object.keys(mapping.aggregates).length) {
    const sums: Record<string, unknown> = {};
    for (const [key, agg] of Object.entries(mapping.aggregates)) { const v = aggregate(body, agg); if (v !== undefined) sums[key] = v; }
    value = isPlain(value) ? { ...value, ...sums } : { result: value, ...sums };
  }
  return value;
}

/** Apply a response mapping (pick, fields; filters and paging without input). */
export function mapResponse(body: unknown, mapping: HttpResponseMapping | undefined): unknown {
  return shapeResponse(body, mapping, {});
}

/** Cut text for the model, saying what was cut. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated: ${text.length - max} more characters — ask for less (filters, pagination)]`;
}

/**
 * A value as the model's text within `max` characters. A list (or an object's largest list) that
 * does not fit keeps as many WHOLE items as fit and says how many there are, instead of cutting the
 * JSON mid-item; anything else falls back to truncateText.
 */
export function fitText(value: unknown, max: number): string {
  const full = JSON.stringify(value ?? null, null, 2);
  if (full.length <= max) return full;
  let list: unknown[] | undefined;
  let wrap: ((kept: unknown[]) => unknown) | undefined;
  const note = (kept: number, total: number) => `Only the first ${kept} of ${total} items fit: narrow it (filters) or page it (offset / limit) to see the rest.`;
  if (Array.isArray(value)) {
    list = value;
    wrap = (kept) => ({ items: kept, shown: kept.length, total: value.length, note: note(kept.length, value.length) });
  } else if (isPlain(value)) {
    let best: string | undefined;
    let size = 0;
    for (const [k, v] of Object.entries(value)) {
      if (!Array.isArray(v)) continue;
      const s = JSON.stringify(v).length;
      if (s > size) { size = s; best = k; }
    }
    if (best) {
      const key = best;
      list = value[key] as unknown[];
      wrap = (kept) => ({ ...value, [key]: kept, [`${key}_shown`]: kept.length, [`${key}_total`]: list!.length, note: note(kept.length, list!.length) });
    }
  }
  if (list && wrap) {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (JSON.stringify(wrap(list.slice(0, mid)), null, 2).length <= max) lo = mid; else hi = mid - 1;
    }
    if (lo > 0) return JSON.stringify(wrap(list.slice(0, lo)), null, 2);
  }
  return truncateText(full, max);
}
