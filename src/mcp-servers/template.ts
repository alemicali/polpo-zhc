/**
 * Templates and response mapping for declarative HTTP tools.
 *
 * Placeholders: `{{input.path.to.value}}`, `{{secrets.NAME}}` (headers and query only) and
 * `{{input.x ?? "default"}}`. A string that is exactly one placeholder renders to the raw value (in
 * JSON bodies: numbers, lists and objects stay typed). Missing values render as `undefined` so the
 * caller can leave the parameter / key out.
 *
 * Picks are JSONPath-ish: `result`, `$.data.items`, `items[0]`, `items[*].id`, `a.b[2].c`.
 */

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][\w]*(?:\.[\w-]+|\[\d+\])*)\s*(?:\?\?\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null))?\s*\}\}/g;
const WHOLE = new RegExp(`^${PLACEHOLDER.source}$`);

export interface TemplateScope {
  input: Record<string, unknown>;
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
  if (root === "secrets") {
    if (!scope.secrets) throw new TemplateError(`Secrets are only allowed in headers and query parameters ("${expr}")`);
    return getPath(scope.secrets, rest);
  }
  throw new TemplateError(`Unknown template variable "${expr}": use input.* or secrets.*`);
}

function fallback(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  return JSON.parse(raw);
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Render a string template. Exactly one placeholder: the raw value (undefined when missing). */
export function renderValue(template: string, scope: TemplateScope, encode?: (s: string) => string): unknown {
  const whole = WHOLE.exec(template);
  if (whole) {
    const v = lookup(whole[1]!, scope);
    const out = v === undefined || v === null ? fallback(whole[2]) : v;
    return encode && out !== undefined ? encode(stringify(out)) : out;
  }
  let missing = false;
  const text = template.replace(PLACEHOLDER, (_m, expr: string, def?: string) => {
    let v = lookup(expr, scope);
    if (v === undefined || v === null) v = fallback(def);
    if (v === undefined || v === null) { missing = true; return ""; }
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
  const missing: string[] = [];
  const out = template.replace(PLACEHOLDER, (_m, expr: string, def?: string) => {
    let v = lookup(expr, { input: scope.input });
    if (v === undefined || v === null) v = fallback(def);
    if (v === undefined || v === null) { missing.push(expr); return ""; }
    return encodeURIComponent(stringify(v));
  });
  if (missing.length) throw new TemplateError(`Missing ${missing.join(", ")} for the URL`);
  return out;
}

/** Render a JSON body template (no secrets: they would end up in logs and echoes). */
export function renderBody(template: unknown, scope: TemplateScope): unknown {
  const inputOnly: TemplateScope = { input: scope.input };
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return renderValue(node, inputOnly);
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

/** The placeholders a template uses (validation). */
export function placeholdersOf(template: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === "string") for (const m of node.matchAll(PLACEHOLDER)) out.push(m[1]!);
    else if (Array.isArray(node)) node.forEach(walk);
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

/** Apply a response mapping: pick, then keep fields (of the object, or of each item). */
export function mapResponse(body: unknown, mapping: { pick?: string; fields?: string[] } | undefined): unknown {
  let value = mapping?.pick ? getPath(body, mapping.pick) : body;
  if (mapping?.fields?.length) value = Array.isArray(value) ? value.map((v) => project(v, mapping.fields!)) : project(value, mapping.fields);
  return value;
}

/** Cut text for the model, saying what was cut. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated: ${text.length - max} more characters — ask for less (filters, pagination)]`;
}
