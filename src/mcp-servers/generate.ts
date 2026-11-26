/**
 * Drafting a server with the orchestrator model:
 * - from an API (an OpenAPI document by URL or pasted, or pasted docs text): a CURATED, small set of
 *   task-oriented HTTP tools (not one per endpoint), with descriptions written for a model;
 * - from a description of the functions: code tools (plus HTTP tools when an API is implied).
 *
 * The result is a proposal: the person reviews names, parameters and which tools need approval,
 * then saves it as a draft. Nothing runs and nothing is published here.
 */
import { parse as parseYaml } from "yaml";
import { checkConnectorUrl, type UrlPolicy } from "../mcp/net.js";
import { McpServerInputError, normalizeSpec, specProblems } from "./validate.js";
import type { McpServerSpec } from "./types.js";

export type LlmQuery = (prompt: string) => Promise<string>;

export interface GenerateInput {
  mode: "api" | "description";
  /** api: an OpenAPI document URL. */
  url?: string;
  /** api: a pasted OpenAPI document (JSON / YAML) or docs text; description: what the tools should do. */
  text?: string;
  /** What the person wants the server for (steers the curation). */
  goal?: string;
  name?: string;
  /** Vault owner for the proposed credential (default "polpo-infra"). */
  vaultOwner?: string;
}

export interface GenerateResult {
  spec: McpServerSpec;
  problems: string[];
  notes: string[];
  source: { kind: "openapi" | "docs" | "description"; endpoints?: number; title?: string };
}

const MAX_DOC_BYTES = 5 * 1024 * 1024;
const MAX_PROMPT_DOC = 60_000;

/** Fetch an OpenAPI document (https, public addresses only, size-capped). */
export async function fetchApiDocument(url: string, policy: UrlPolicy = {}, fetchImpl: typeof fetch = fetch): Promise<string> {
  const checked = await checkConnectorUrl(url, policy);
  const res = await fetchImpl(checked.toString(), { redirect: "follow", signal: AbortSignal.timeout(20_000), headers: { accept: "application/json, application/yaml, text/yaml, text/plain, */*" } });
  if (!res.ok) throw new McpServerInputError(`Could not fetch ${checked.host}: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_DOC_BYTES) throw new McpServerInputError("The document is larger than 5 MB");
  return text;
}

interface OpenApiDoc {
  openapi?: string; swagger?: string; info?: { title?: string; description?: string };
  servers?: Array<{ url?: string }>; host?: string; basePath?: string; schemes?: string[];
  paths?: Record<string, Record<string, { summary?: string; description?: string; operationId?: string; parameters?: unknown[]; requestBody?: unknown }>>;
  components?: { securitySchemes?: Record<string, unknown> }; securityDefinitions?: Record<string, unknown>;
}

/** Parse JSON or YAML into an OpenAPI document (undefined: not one). */
export function parseOpenApi(text: string): OpenApiDoc | undefined {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch {
    try { doc = parseYaml(text); } catch { return undefined; }
  }
  if (!doc || typeof doc !== "object") return undefined;
  const d = doc as OpenApiDoc;
  return (d.openapi || d.swagger) && d.paths ? d : undefined;
}

const METHODS = ["get", "post", "put", "patch", "delete"];

/** A compact outline of the API for the prompt: base URL, auth schemes, one line per operation. */
export function outlineOpenApi(doc: OpenApiDoc): { outline: string; endpoints: number; baseUrl?: string } {
  const baseUrl = doc.servers?.[0]?.url ?? (doc.host ? `${doc.schemes?.[0] ?? "https"}://${doc.host}${doc.basePath ?? ""}` : undefined);
  const lines: string[] = [`Title: ${doc.info?.title ?? "(untitled)"}`];
  if (doc.info?.description) lines.push(`About: ${doc.info.description.slice(0, 600)}`);
  if (baseUrl) lines.push(`Base URL: ${baseUrl}`);
  const security = doc.components?.securitySchemes ?? doc.securityDefinitions;
  if (security) lines.push(`Auth schemes: ${JSON.stringify(security).slice(0, 800)}`);
  let endpoints = 0;
  for (const [path, ops] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = ops?.[method];
      if (!op) continue;
      endpoints++;
      const params = (Array.isArray(op.parameters) ? op.parameters : []).map((p) => {
        const x = p as { name?: string; in?: string; required?: boolean };
        return x.name ? `${x.name}${x.required ? "*" : ""}(${x.in ?? "?"})` : "";
      }).filter(Boolean).join(", ");
      const body = op.requestBody ? ` body:${JSON.stringify(op.requestBody).slice(0, 300)}` : "";
      lines.push(`${method.toUpperCase()} ${path} — ${(op.summary ?? op.description ?? op.operationId ?? "").replace(/\s+/g, " ").slice(0, 160)}${params ? ` [${params}]` : ""}${body}`);
    }
  }
  return { outline: lines.join("\n"), endpoints, ...(baseUrl ? { baseUrl } : {}) };
}

const SPEC_SHAPE = `{
  "name": "Service name",
  "description": "What the server is for (one or two sentences, for the model)",
  "baseUrl": "https://api.example.com",
  "allowedDomains": ["api.example.com"],
  "secrets": { "token": { "owner": "<vault owner>", "service": "<service slug>", "key": "token" } },
  "auth": { "type": "bearer", "secret": "token" }  // or { "type": "header", "header": "X-API-Key", "secret": "token" } / { "type": "query", "param": "api_key", "secret": "token" } / { "type": "none" }
  "tools": [{
    "name": "snake_case_verb_object",
    "title": "Short title",
    "description": "When to use it and what it returns (for the model)",
    "kind": "http",
    "inputSchema": { "type": "object", "properties": { "id": { "type": "string", "description": "..." } }, "required": ["id"] },
    "annotations": { "readOnlyHint": true, "destructiveHint": false },
    "requiresApproval": false,
    "http": {
      "method": "GET", "url": "/things/{{input.id}}",
      "query": { "limit": "{{input.limit ?? 20}}" },
      "body": { "field": "{{input.field}}" },
      "response": { "pick": "data", "fields": ["id", "name"] },
      "errors": [{ "status": 404, "message": "No such thing" }]
    }
  }]
}`;

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fenced ? fenced[1]! : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(raw);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "service";
}

/** Ask the model for a server, check it, keep what is valid. */
export async function generateServer(input: GenerateInput, llm: LlmQuery, opts: { urlPolicy?: UrlPolicy; fetch?: typeof fetch } = {}): Promise<GenerateResult> {
  const notes: string[] = [];
  const owner = input.vaultOwner?.trim() || "polpo-infra";
  let prompt: string;
  let source: GenerateResult["source"];
  if (input.mode === "api") {
    const text = input.url ? await fetchApiDocument(input.url, opts.urlPolicy, opts.fetch) : input.text ?? "";
    if (!text.trim()) throw new McpServerInputError("Give an OpenAPI URL, a pasted OpenAPI document or the API docs text");
    const doc = parseOpenApi(text);
    let material: string;
    if (doc) {
      const o = outlineOpenApi(doc);
      material = o.outline;
      source = { kind: "openapi", endpoints: o.endpoints, ...(doc.info?.title ? { title: doc.info.title } : {}) };
      if (o.outline.length > MAX_PROMPT_DOC) notes.push(`The API has ${o.endpoints} operations: only the first part of the outline was read`);
    } else {
      material = text;
      source = { kind: "docs" };
      if (text.length > MAX_PROMPT_DOC) notes.push("The docs were long: only the first part was read");
    }
    prompt = [
      "You design MCP servers that AI agents use. Build a hosted MCP server for this HTTP API.",
      "",
      "Rules:",
      "- CURATE: 4 to 12 task-oriented tools that cover what people actually do with this API. Not one tool per endpoint; skip admin, webhooks, OAuth and rarely used endpoints.",
      "- Every tool is kind \"http\" (one request). Names are snake_case verb_object. Descriptions say when to use the tool and what it returns, for a model.",
      "- inputSchema: only the parameters that matter, each with a description; mark required ones.",
      "- Use {{input.<param>}} placeholders in url, query and body. A body value that is exactly one placeholder keeps its JSON type. Optional query params are dropped when empty.",
      "- Never put a secret in a tool: auth is set once at server level and the secret comes from the vault.",
      `- The credential secret is named "token" and references the vault: { "owner": "${owner}", "service": "<service slug>", "key": "token" }.`,
      "- response.pick and response.fields keep only what a model needs (ids, names, statuses, amounts), so results stay small.",
      "- annotations: readOnlyHint true for reads; destructiveHint true and requiresApproval true for anything that creates, changes, deletes, sends or costs money.",
      "- allowedDomains: only the API's host(s).",
      input.goal ? `- What the person wants it for: ${input.goal}` : "",
      "",
      "Reply with ONE JSON object, no prose, in this shape:",
      SPEC_SHAPE,
      "",
      "The API:",
      material.slice(0, MAX_PROMPT_DOC),
    ].filter((l) => l !== "").join("\n");
  } else {
    const text = input.text?.trim() ?? "";
    if (!text) throw new McpServerInputError("Describe the functions the server should offer");
    source = { kind: "description" };
    prompt = [
      "You design MCP servers that AI agents use. Build a hosted MCP server from this description.",
      "",
      "Rules:",
      "- Each function becomes a tool. Use kind \"code\" with code.source: an ES module (plain JavaScript) that exports",
      "  `export async function handler(input, ctx) { ... return result }`. ctx.fetch(url, init) is a fetch that only reaches the server's",
      "  allowedDomains; ctx.secrets.<name> holds the declared secrets; ctx.log(...) writes to the server's log. No filesystem, no process, no require of",
      "  Node built-ins beyond pure helpers. Return JSON-serializable data.",
      "- When a function is a single call to a known HTTP API, prefer kind \"http\" (declarative) instead of code.",
      "- npm dependencies only when truly needed: list them in \"dependencies\" (name → version range).",
      `- Credentials: declare them in "secrets" as vault references { "owner": "${owner}", "service": "<slug>", "key": "<field>" }; never literal values.`,
      "- Names snake_case; descriptions for a model; inputSchema with descriptions; annotations readOnlyHint / destructiveHint; requiresApproval true for anything that changes, sends or costs money.",
      "",
      "Reply with ONE JSON object, no prose, in this shape (code tools have \"kind\": \"code\", \"code\": { \"source\": \"...\" } instead of \"http\"):",
      SPEC_SHAPE,
      "",
      "The description:",
      text.slice(0, MAX_PROMPT_DOC),
    ].join("\n");
  }

  const reply = await llm(prompt);
  let raw: Record<string, unknown>;
  try {
    raw = extractJson(reply) as Record<string, unknown>;
  } catch {
    throw new McpServerInputError("The model did not return a server definition: try again, or add more detail");
  }
  if (input.name) raw.name = input.name;
  if (typeof raw.name !== "string" || !raw.name.trim()) raw.name = source.title ?? "Custom server";
  // keep the valid tools, say which were dropped
  const tools = Array.isArray(raw.tools) ? raw.tools : [];
  const kept: unknown[] = [];
  for (const t of tools) {
    try {
      normalizeSpec({ name: "x", tools: [t] });
      kept.push(t);
    } catch (err) {
      notes.push(`Dropped a proposed tool: ${(err as Error).message}`);
    }
  }
  raw.tools = kept;
  // secrets: vault references only (a literal value proposed by the model is dropped)
  if (raw.secrets && typeof raw.secrets === "object") {
    for (const [k, v] of Object.entries(raw.secrets as Record<string, Record<string, unknown>>)) {
      if (!v || typeof v !== "object" || "value" in v || typeof v.owner !== "string" || v.owner.startsWith("$")) {
        (raw.secrets as Record<string, unknown>)[k] = { owner, service: slug(String(raw.name)), key: "token" };
      }
    }
  }
  let spec: McpServerSpec;
  try {
    spec = normalizeSpec(raw);
  } catch (err) {
    // an unusable auth / secret: fall back to none, say so
    notes.push(`The proposed auth was not usable (${(err as Error).message}); set it in the editor`);
    spec = normalizeSpec({ ...raw, auth: { type: "none" }, secrets: {} });
  }
  const secretNames = Object.keys(spec.secrets);
  if (secretNames.length) {
    const refs = Object.entries(spec.secrets).map(([n, r]) => `${n} → ${r.owner}/${r.service} (field ${r.key})`).join(", ");
    notes.push(`Add the credential to the vault before testing: ${refs}`);
  }
  return { spec, problems: specProblems(spec), notes, source };
}
