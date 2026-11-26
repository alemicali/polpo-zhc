/**
 * Validation of a server spec (drafts are saved with problems listed; publish needs none).
 */
import { isReservedVaultOwner } from "@polpo-ai/core/vault-store";
import { placeholdersOf, parsePath, TemplateError } from "./template.js";
import { normalizeSettingsSchema } from "./settings.js";
import {
  MCP_TOOL_NAME_PATTERN, SECRET_NAME_PATTERN,
  type HttpResponseAggregate, type HttpResponseFilter, type HttpResponseMapping, type McpServerAuth, type McpServerScope, type McpServerSpec, type McpServerTool,
} from "./types.js";

export class McpServerInputError extends Error {}

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const DOMAIN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;
const LIMIT_KEYS = ["timeoutMs", "maxResponseBytes", "maxResultChars", "retries", "memoryMb", "concurrency", "idleMs", "depsMaxMb"] as const;
const LIMIT_MAX: Record<string, number> = {
  timeoutMs: 120_000, maxResponseBytes: 20 * 1024 * 1024, maxResultChars: 200_000, retries: 5, memoryMb: 2048, concurrency: 32, idleMs: 3_600_000, depsMaxMb: 1024,
};
const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const NPM_RANGE = /^[\w.^~<>=*|\s-]{1,64}$/;

const str = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function stringRecord(v: unknown, field: string): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined;
  if (!obj(v)) throw new McpServerInputError(`${field} must be an object of strings`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "string") throw new McpServerInputError(`${field}.${k} must be a string`);
    out[k] = val;
  }
  return out;
}

function auth(v: unknown): McpServerAuth {
  if (v === undefined || v === null) return { type: "none" };
  if (!obj(v) || !str(v.type)) throw new McpServerInputError("auth.type is required");
  switch (v.type) {
    case "none": return { type: "none" };
    case "bearer":
      if (!str(v.secret)) throw new McpServerInputError("auth.secret (a secret name) is required for bearer auth");
      return { type: "bearer", secret: v.secret };
    case "header":
      if (!str(v.header) || !str(v.secret)) throw new McpServerInputError("auth.header and auth.secret are required for header auth");
      return { type: "header", header: v.header, secret: v.secret, ...(typeof v.prefix === "string" && v.prefix ? { prefix: v.prefix } : {}) };
    case "query":
      if (!str(v.param) || !str(v.secret)) throw new McpServerInputError("auth.param and auth.secret are required for query auth");
      return { type: "query", param: v.param, secret: v.secret };
    case "basic":
      if (!str(v.usernameSecret) || !str(v.passwordSecret)) throw new McpServerInputError("auth.usernameSecret and auth.passwordSecret are required for basic auth");
      return { type: "basic", usernameSecret: v.usernameSecret, passwordSecret: v.passwordSecret };
    case "oauth2_client_credentials":
      if (!str(v.tokenUrl) || !str(v.clientIdSecret) || !str(v.clientSecretSecret)) throw new McpServerInputError("auth.tokenUrl, auth.clientIdSecret and auth.clientSecretSecret are required");
      return {
        type: "oauth2_client_credentials", tokenUrl: v.tokenUrl, clientIdSecret: v.clientIdSecret, clientSecretSecret: v.clientSecretSecret,
        ...(Array.isArray(v.scopes) ? { scopes: v.scopes.filter(str) } : {}),
      };
    default:
      throw new McpServerInputError(`Unknown auth.type "${String(v.type)}"`);
  }
}

const MATCHES = new Set(["equals", "contains", "in", "gte", "lte"]);
const AGG_OPS = new Set(["count", "unique", "min", "max", "sum", "value"]);

function responseMapping(r: Record<string, unknown>, name: string): HttpResponseMapping {
  const filters = Array.isArray(r.filters) ? r.filters.map((f, i) => {
    if (!obj(f) || !str(f.path)) throw new McpServerInputError(`${name}: response.filters[${i}].path is required`);
    if (f.input === undefined && f.value === undefined) throw new McpServerInputError(`${name}: response.filters[${i}] needs an input or a value`);
    if (f.match !== undefined && !MATCHES.has(String(f.match))) throw new McpServerInputError(`${name}: response.filters[${i}].match must be equals, contains, in, gte or lte`);
    return {
      path: f.path.trim(),
      ...(str(f.input) ? { input: f.input.trim() } : {}),
      ...(typeof f.value === "string" || typeof f.value === "number" || typeof f.value === "boolean" ? { value: f.value } : {}),
      ...(f.match !== undefined ? { match: f.match as HttpResponseFilter["match"] } : {}),
    };
  }) : [];
  const p = obj(r.page) ? r.page : undefined;
  const int = (v: unknown, max: number) => (typeof v === "number" && v >= 1 ? Math.min(max, Math.floor(v)) : undefined);
  const page = p ? {
    ...(str(p.offsetInput) ? { offsetInput: p.offsetInput } : {}), ...(str(p.limitInput) ? { limitInput: p.limitInput } : {}),
    ...(int(p.defaultLimit, 1000) ? { defaultLimit: int(p.defaultLimit, 1000) } : {}), ...(int(p.maxLimit, 1000) ? { maxLimit: int(p.maxLimit, 1000) } : {}),
  } : undefined;
  const aggregates: Record<string, HttpResponseAggregate> = {};
  if (obj(r.aggregates)) {
    for (const [k, a] of Object.entries(r.aggregates)) {
      if (!obj(a) || !str(a.path) || !AGG_OPS.has(String(a.op))) throw new McpServerInputError(`${name}: response.aggregates.${k} needs a path and op (count, unique, min, max, sum, value)`);
      aggregates[k] = { path: a.path.trim(), op: a.op as HttpResponseAggregate["op"] };
    }
  }
  return {
    ...(str(r.pick) ? { pick: r.pick } : {}),
    ...(Array.isArray(r.fields) ? { fields: r.fields.filter(str) } : {}),
    ...(typeof r.maxChars === "number" && r.maxChars > 0 ? { maxChars: Math.min(200_000, Math.floor(r.maxChars)) } : {}),
    ...(filters.length ? { filters } : {}),
    ...(page ? { page } : {}),
    ...(Object.keys(aggregates).length ? { aggregates } : {}),
  };
}

function tool(v: unknown, i: number): McpServerTool {
  if (!obj(v)) throw new McpServerInputError(`tools[${i}] must be an object`);
  const name = typeof v.name === "string" ? v.name.trim() : "";
  if (!MCP_TOOL_NAME_PATTERN.test(name)) throw new McpServerInputError(`tools[${i}].name must be 1–64 letters, digits, _ or -`);
  const kind = v.kind === "code" ? "code" : v.kind === "http" || v.kind === undefined ? "http" : null;
  if (!kind) throw new McpServerInputError(`${name}: kind must be "http" or "code"`);
  const inputSchema = obj(v.inputSchema) ? v.inputSchema : { type: "object", properties: {} };
  if (inputSchema.type !== undefined && inputSchema.type !== "object") throw new McpServerInputError(`${name}: inputSchema must be a JSON Schema of type "object"`);
  const out: McpServerTool = {
    name,
    description: typeof v.description === "string" ? v.description : "",
    inputSchema: { type: "object", properties: {}, ...inputSchema },
    kind,
    ...(str(v.title) ? { title: v.title } : {}),
    ...(obj(v.outputSchema) ? { outputSchema: v.outputSchema } : {}),
    ...(v.requiresApproval === true ? { requiresApproval: true } : {}),
    ...(v.publicCallable === true ? { publicCallable: true } : {}),
    ...(str(v.uiResource) ? { uiResource: v.uiResource } : {}),
    ...(Array.isArray(v.scopes) && v.scopes.some(str) ? { scopes: [...new Set(v.scopes.filter(str).map((s) => s.trim()))] } : {}),
  };
  if (obj(v.annotations)) {
    const a: Record<string, boolean> = {};
    for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) if (typeof v.annotations[k] === "boolean") a[k] = v.annotations[k] as boolean;
    if (Object.keys(a).length) out.annotations = a;
  }
  if (kind === "http") {
    const h = v.http;
    if (!obj(h)) throw new McpServerInputError(`${name}: http (method, url) is required for an HTTP tool`);
    const method = typeof h.method === "string" ? h.method.toUpperCase() : "GET";
    if (!METHODS.has(method)) throw new McpServerInputError(`${name}: http.method must be GET, POST, PUT, PATCH or DELETE`);
    if (!str(h.url)) throw new McpServerInputError(`${name}: http.url is required`);
    out.http = {
      method: method as "GET",
      url: h.url.trim(),
      ...(stringRecord(h.headers, `${name}.http.headers`) ? { headers: stringRecord(h.headers, `${name}.http.headers`) } : {}),
      ...(stringRecord(h.query, `${name}.http.query`) ? { query: stringRecord(h.query, `${name}.http.query`) } : {}),
      ...(h.body !== undefined && h.body !== null ? { body: h.body } : {}),
      ...(h.bodyType === "form" ? { bodyType: "form" as const } : {}),
      ...(obj(h.response) ? { response: responseMapping(h.response, name) } : {}),
      ...(obj(h.pagination) && ["offset", "cursor", "page"].includes(String(h.pagination.style)) ? { pagination: h.pagination as never } : {}),
      ...(Array.isArray(h.errors) ? { errors: h.errors.filter((e): e is Record<string, unknown> => obj(e) && str(e.message)).map((e) => ({
        message: e.message as string,
        ...(typeof e.status === "number" || e.status === "4xx" || e.status === "5xx" ? { status: e.status as number } : {}),
        ...(str(e.match) ? { match: e.match } : {}),
      })) } : {}),
      ...(typeof h.retries === "number" && h.retries >= 0 ? { retries: Math.min(5, Math.floor(h.retries)) } : {}),
    };
  } else {
    const c = v.code;
    if (!obj(c) || typeof c.source !== "string") throw new McpServerInputError(`${name}: code.source is required for a code tool`);
    if (c.source.length > 200_000) throw new McpServerInputError(`${name}: code.source is larger than 200 KB`);
    out.code = { source: c.source };
  }
  return out;
}

/** Parse and normalize a spec (throws McpServerInputError on a shape error). */
export function normalizeSpec(input: unknown): McpServerSpec {
  if (!obj(input)) throw new McpServerInputError("The server spec must be an object");
  if (!str(input.name)) throw new McpServerInputError("name is required");
  const secrets: McpServerSpec["secrets"] = {};
  if (input.secrets !== undefined && input.secrets !== null) {
    if (!obj(input.secrets)) throw new McpServerInputError("secrets must be an object: name → { owner, service, key }");
    for (const [name, ref] of Object.entries(input.secrets)) {
      if (!SECRET_NAME_PATTERN.test(name)) throw new McpServerInputError(`Secret name "${name}" must be letters, digits and _`);
      if (!obj(ref) || !str(ref.owner) || !str(ref.service) || !str(ref.key)) throw new McpServerInputError(`secrets.${name} must be a vault reference { owner, service, key }`);
      if (isReservedVaultOwner(ref.owner)) throw new McpServerInputError(`secrets.${name}: vault owners starting with "$" are reserved for Polpo`);
      if ("value" in ref) throw new McpServerInputError(`secrets.${name}: never put a secret value in the server: reference a vault entry`);
      secrets[name] = { owner: ref.owner.trim(), service: ref.service.trim(), key: ref.key.trim() };
    }
  }
  const tools = Array.isArray(input.tools) ? input.tools.map(tool) : [];
  const limits: Record<string, number> = {};
  if (obj(input.limits)) {
    for (const k of LIMIT_KEYS) {
      const v = input.limits[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) limits[k] = Math.min(LIMIT_MAX[k]!, Math.floor(v));
    }
  }
  const deps: Record<string, string> = {};
  if (obj(input.dependencies)) {
    for (const [name, range] of Object.entries(input.dependencies)) {
      if (!NPM_NAME.test(name)) throw new McpServerInputError(`dependencies: "${name}" is not an npm package name`);
      if (typeof range !== "string" || !NPM_RANGE.test(range) || /[;&|`$()]/.test(range.replace(/\|\|/g, ""))) throw new McpServerInputError(`dependencies.${name}: use a version or range (e.g. "^1.2.0")`);
      deps[name] = range.trim();
    }
  }
  const resources = Array.isArray(input.resources) ? input.resources.filter(obj).map((r, i) => {
    if (!str(r.uri) || !str(r.name) || typeof r.text !== "string") throw new McpServerInputError(`resources[${i}] needs uri, name and text`);
    return { uri: r.uri, name: r.name, mimeType: str(r.mimeType) ? r.mimeType : "text/plain", text: r.text, ...(str(r.description) ? { description: r.description } : {}) };
  }) : [];
  const scopes: Record<string, McpServerScope> = {};
  if (input.scopes !== undefined && input.scopes !== null) {
    if (!obj(input.scopes)) throw new McpServerInputError("scopes must be an object: name → { headers?, query?, description? }");
    for (const [name, sc] of Object.entries(input.scopes)) {
      if (!SECRET_NAME_PATTERN.test(name)) throw new McpServerInputError(`Scope name "${name}" must be letters, digits and _`);
      if (!obj(sc)) throw new McpServerInputError(`scopes.${name} must be an object`);
      const h = stringRecord(sc.headers, `scopes.${name}.headers`);
      const q = stringRecord(sc.query, `scopes.${name}.query`);
      scopes[name] = { ...(str(sc.description) ? { description: sc.description.trim() } : {}), ...(h && Object.keys(h).length ? { headers: h } : {}), ...(q && Object.keys(q).length ? { query: q } : {}) };
    }
  }
  let settingsSchema;
  try { settingsSchema = normalizeSettingsSchema(input.settingsSchema); } catch (err) { throw new McpServerInputError((err as Error).message); }
  const query = stringRecord(input.query, "query");
  return {
    name: input.name.trim().slice(0, 100),
    ...(str(input.description) ? { description: input.description.trim().slice(0, 2000) } : {}),
    ...(str(input.icon) ? { icon: input.icon.trim().slice(0, 64) } : {}),
    ...(str(input.baseUrl) ? { baseUrl: input.baseUrl.trim() } : {}),
    allowedDomains: Array.isArray(input.allowedDomains) ? [...new Set(input.allowedDomains.filter(str).map((d) => d.trim().toLowerCase()))] : [],
    secrets,
    auth: auth(input.auth),
    ...(stringRecord(input.headers, "headers") && Object.keys(stringRecord(input.headers, "headers")!).length ? { headers: stringRecord(input.headers, "headers") } : {}),
    ...(query && Object.keys(query).length ? { query } : {}),
    ...(Object.keys(scopes).length ? { scopes } : {}),
    ...(settingsSchema.length ? { settingsSchema } : {}),
    ...(Object.keys(limits).length ? { limits } : {}),
    ...(Object.keys(deps).length ? { dependencies: deps } : {}),
    tools,
    ...(resources.length ? { resources } : {}),
  };
}

/** What stops a spec from being published (empty: publishable). */
export function specProblems(spec: McpServerSpec): string[] {
  const problems: string[] = [];
  if (spec.tools.length === 0) problems.push("The server has no tools");
  if (spec.tools.length > 100) problems.push("A server may have at most 100 tools");
  const names = new Set<string>();
  for (const d of spec.allowedDomains) if (!DOMAIN.test(d)) problems.push(`"${d}" is not a domain (api.example.com, *.example.com)`);
  if (spec.baseUrl) {
    try {
      const u = new URL(spec.baseUrl);
      if (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname)) problems.push("baseUrl must use https");
    } catch { problems.push("baseUrl is not a valid URL"); }
  }
  const secretNames = new Set(Object.keys(spec.secrets));
  const authSecrets = (() => {
    const a = spec.auth;
    if (a.type === "bearer" || a.type === "header" || a.type === "query") return [a.secret];
    if (a.type === "basic") return [a.usernameSecret, a.passwordSecret];
    if (a.type === "oauth2_client_credentials") return [a.clientIdSecret, a.clientSecretSecret];
    return [];
  })();
  for (const s of authSecrets) if (!secretNames.has(s)) problems.push(`auth uses the secret "${s}", which the server does not declare`);
  const hasHttp = spec.tools.some((t) => t.kind === "http");
  const hasCode = spec.tools.some((t) => t.kind === "code");
  if ((hasHttp || hasCode) && spec.allowedDomains.length === 0 && (hasHttp || authSecrets.length)) problems.push("List the domains the server may call (allowedDomains)");
  if (spec.dependencies && !hasCode) problems.push("dependencies are only for code tools");
  const resourceUris = new Set((spec.resources ?? []).map((r) => r.uri));
  const settingKeys = new Set((spec.settingsSchema ?? []).map((f) => f.key));
  // server-level defaults (every tool, or the tools of a scope): settings and secrets must be declared
  const serverLevel = [spec.headers ?? {}, spec.query ?? {}, ...Object.values(spec.scopes ?? {}).flatMap((s) => [s.headers ?? {}, s.query ?? {}])];
  for (const p of placeholdersOf(serverLevel)) {
    try {
      const [root, first] = parsePath(p);
      if (root === "secrets" && typeof first === "string" && !secretNames.has(first)) problems.push(`server defaults: {{${p}}} is not a declared secret`);
      else if (root === "settings" && typeof first === "string" && !settingKeys.has(first)) problems.push(`server defaults: {{${p}}} is not a declared setting (settingsSchema)`);
      else if (root !== "input" && root !== "secrets" && root !== "settings") problems.push(`server defaults: unknown template variable {{${p}}}`);
    } catch (err) {
      problems.push(`server defaults: ${err instanceof TemplateError ? err.message : String(err)}`);
    }
  }
  for (const t of spec.tools) {
    if (names.has(t.name)) problems.push(`Two tools are named "${t.name}"`);
    names.add(t.name);
    if (!t.description.trim()) problems.push(`${t.name}: describe what it does (the model reads it)`);
    if (t.uiResource && !resourceUris.has(t.uiResource)) problems.push(`${t.name}: uiResource "${t.uiResource}" is not one of the server's resources`);
    if (t.annotations?.readOnlyHint && (t.annotations.destructiveHint || t.requiresApproval)) problems.push(`${t.name}: a read-only tool cannot be destructive or need approval`);
    if (t.kind === "http" && t.http) {
      const props = Object.keys((t.inputSchema.properties ?? {}) as Record<string, unknown>);
      for (const p of placeholdersOf([t.http.url, t.http.headers ?? {}, t.http.query ?? {}, t.http.body ?? null])) {
        try {
          const [root, first] = parsePath(p);
          if (root === "input" && typeof first === "string" && !props.includes(first)) problems.push(`${t.name}: {{${p}}} is not an input property`);
          if (root === "secrets" && typeof first === "string" && !secretNames.has(first)) problems.push(`${t.name}: {{${p}}} is not a declared secret`);
          if (root === "settings" && typeof first === "string" && !settingKeys.has(first)) problems.push(`${t.name}: {{${p}}} is not a declared setting (settingsSchema)`);
          if (root !== "input" && root !== "secrets" && root !== "settings") problems.push(`${t.name}: unknown template variable {{${p}}}`);
        } catch (err) {
          problems.push(`${t.name}: ${err instanceof TemplateError ? err.message : String(err)}`);
        }
      }
      for (const s of t.scopes ?? []) if (!spec.scopes?.[s]) problems.push(`${t.name}: scope "${s}" is not declared (scopes)`);
      for (const f of t.http.response?.filters ?? []) if (f.input && !props.includes(f.input)) problems.push(`${t.name}: response filter input "${f.input}" is not an input property`);
      for (const p of placeholdersOf([t.http.url, t.http.body ?? null])) if (p.startsWith("secrets.")) problems.push(`${t.name}: secrets may only appear in headers and query parameters`);
      if (!/^https?:\/\//i.test(t.http.url) && !spec.baseUrl) problems.push(`${t.name}: relative URL but the server has no baseUrl`);
      if (t.http.response?.pick) { try { parsePath(t.http.response.pick); } catch (err) { problems.push(`${t.name}: response.pick: ${(err as Error).message}`); } }
    }
    if (t.kind === "code" && t.code && !/\bhandler\b/.test(t.code.source)) problems.push(`${t.name}: the code must export a handler(input, ctx) function`);
  }
  return problems;
}
