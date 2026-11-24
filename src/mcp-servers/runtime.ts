/**
 * Running a hosted server: one tool call (http in Polpo, code in the isolated worker), and the MCP
 * server object that serves a deployed version — in process for the bound connector (agents,
 * Polpo's chat, task runners) and over Streamable HTTP on the public endpoint.
 *
 * Rules every call follows:
 * - the kill switch (meta.disabled) refuses every call;
 * - tools that need approval are not run for agents / Polpo: the call is queued (pending/<id>.json)
 *   and a person approves it in Approvals; it then runs once, in the server process;
 * - on the public endpoint, destructive / approval tools are neither listed nor callable unless the
 *   tool says publicCallable;
 * - secrets are read from the vault for the call only.
 */
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema,
  type CallToolResult, type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { VaultStore } from "@polpo-ai/core";
import { executeHttpTool, type FetchLike } from "./http-executor.js";
import type { Resolver } from "../sandbox/net-proxy.js";
import { McpServerStore } from "./store.js";
import { truncateText } from "./template.js";
import {
  isSensitiveTool, limitsOf,
  type McpCallSource, type McpServerSpec, type McpServerTool, type McpToolCallResult, type PendingCall,
} from "./types.js";

export const HOSTED_SERVER_VERSION = "1.0.0";

/** What a code tool run needs (see code-worker.ts). */
export interface CodeRunRequest {
  serverId: string;
  /** The build folder (code + node_modules). */
  buildDir: string;
  /** Identifies the worker: one per server and version. */
  workerKey: string;
  tool: McpServerTool;
  input: Record<string, unknown>;
  secrets: Record<string, string>;
  allowedDomains: string[];
  limits: ReturnType<typeof limitsOf>;
  signal?: AbortSignal;
}

export interface CodeRunner {
  run(req: CodeRunRequest): Promise<McpToolCallResult>;
}

export interface HostedRuntimeDeps {
  polpoDir: string;
  vault?: VaultStore;
  fetch?: FetchLike;
  resolve?: Resolver;
  /** Code tools (the bubblewrap worker pool); absent: code tools answer that they are unavailable. */
  codeRunner?: CodeRunner;
  /** The server process: create the Approvals request for a queued call (returns its id). */
  requestApproval?: (call: PendingCall, tool: McpServerTool, spec: McpServerSpec) => Promise<string | undefined>;
  /** Tests: retries without waiting. */
  sleep?: (ms: number) => Promise<void>;
}

/** A secret's value from the vault (one credential field of one entry). */
export async function readSecret(vault: VaultStore | undefined, spec: McpServerSpec, name: string): Promise<string | undefined> {
  const ref = spec.secrets[name];
  if (!ref || !vault) return undefined;
  const entry = await vault.get(ref.owner, ref.service).catch(() => undefined);
  const value = entry?.credentials?.[ref.key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Which declared secrets are set (names only). */
export async function secretStatus(vault: VaultStore | undefined, spec: McpServerSpec): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const name of Object.keys(spec.secrets)) out[name] = !!(await readSecret(vault, spec, name));
  return out;
}

export interface RunToolOptions {
  serverId: string;
  spec: McpServerSpec;
  /** The version (undefined: the draft). */
  version?: string;
  toolName: string;
  input: Record<string, unknown>;
  source: McpCallSource;
  /** Do not send (http): show the request. */
  dryRun?: boolean;
  signal?: AbortSignal;
  ip?: string;
  /** Skip the approval queue (the call was approved, or a person confirmed a test). */
  approved?: boolean;
  approvalId?: string;
  requestedBy?: string;
}

/** Run one tool and log it. Expected failures come back as ok: false. */
export async function runTool(opts: RunToolOptions, deps: HostedRuntimeDeps): Promise<McpToolCallResult> {
  const store = new McpServerStore(deps.polpoDir);
  const started = Date.now();
  const tool = opts.spec.tools.find((t) => t.name === opts.toolName);
  const done = (result: McpToolCallResult): McpToolCallResult => {
    store.log(opts.serverId, {
      at: new Date().toISOString(), tool: opts.toolName, source: opts.source, ok: result.ok, ms: result.ms,
      ...(opts.version ? { version: opts.version } : {}), ...(result.status ? { status: result.status } : {}),
      ...(result.error ? { error: result.error.slice(0, 300) } : {}), ...(opts.ip ? { ip: opts.ip } : {}),
      ...(opts.approvalId ?? result.pendingApproval?.approvalId ? { approvalId: opts.approvalId ?? result.pendingApproval?.approvalId } : {}),
    });
    return result;
  };
  const fail = (error: string) => done({ ok: false, text: error, error, ms: Date.now() - started });
  if (!tool) return fail(`Unknown tool "${opts.toolName}"`);
  const meta = store.meta(opts.serverId);
  if (meta?.disabled && opts.source !== "test") return fail("This server is switched off (kill switch): no calls run until it is switched on again");
  if (opts.source === "public" && isSensitiveTool(tool) && !tool.publicCallable) return fail(`${tool.name} is not callable on the public endpoint`);

  // approval: agents and Polpo queue the call; a person approves it in Approvals
  if (tool.requiresApproval && !opts.approved && !opts.dryRun) {
    if (opts.source === "public") return fail(`${tool.name} needs a person's approval and is not callable on the public endpoint`);
    const call: PendingCall = {
      id: randomUUID(), serverId: opts.serverId, tool: tool.name, input: opts.input, ...(opts.version ? { version: opts.version } : {}),
      requestedAt: new Date().toISOString(), ...(opts.requestedBy ? { requestedBy: opts.requestedBy } : {}), status: "pending",
    };
    store.savePending(call);
    let approvalId: string | undefined;
    try { approvalId = await deps.requestApproval?.(call, tool, opts.spec); } catch { /* the server process picks it up */ }
    if (approvalId) store.savePending({ ...call, approvalId });
    const text = `Queued for approval: ${opts.spec.name} · ${tool.title ?? tool.name} runs only after a person approves it in Polpo (Approvals${approvalId ? `, request ${approvalId}` : ""}). `
      + "It has NOT run yet: tell whoever asked that it is waiting for approval; do not call it again.";
    return done({ ok: true, text, structured: { status: "pending_approval", call_id: call.id, ...(approvalId ? { approval_id: approvalId } : {}) }, ms: Date.now() - started, pendingApproval: { id: call.id, ...(approvalId ? { approvalId } : {}) } });
  }

  const validation = validateInput(tool, opts.input);
  if (validation) return fail(validation);
  const limits = limitsOf(opts.spec);

  if (tool.kind === "http") {
    const result = await executeHttpTool(opts.spec, tool, opts.input, {
      secret: (name) => readSecret(deps.vault, opts.spec, name),
      ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.resolve ? { resolve: deps.resolve } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.dryRun ? { dryRun: true } : {}),
    });
    return done(result);
  }

  if (opts.dryRun) return done({ ok: true, text: "Not run (dry run): code tools have no request preview.", ms: Date.now() - started });
  if (!deps.codeRunner) return fail("Code tools are not available here (no isolated worker)");
  const versionKey = opts.version ?? "draft";
  const secrets: Record<string, string> = {};
  for (const name of Object.keys(opts.spec.secrets)) {
    const v = await readSecret(deps.vault, opts.spec, name);
    if (v !== undefined) secrets[name] = v;
  }
  const result = await deps.codeRunner.run({
    serverId: opts.serverId, buildDir: store.buildDir(opts.serverId, versionKey), workerKey: `${opts.serverId}@${versionKey}`,
    tool, input: opts.input, secrets, allowedDomains: opts.spec.allowedDomains, limits, ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return done({ ...result, text: truncateText(result.text, limits.maxResultChars) });
}

/** A light check of the input against the schema: required properties and primitive types. */
export function validateInput(tool: McpServerTool, input: Record<string, unknown>): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "The input must be an object";
  const schema = tool.inputSchema as { required?: unknown; properties?: Record<string, { type?: string | string[]; enum?: unknown[] }> };
  const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : [];
  const missing = required.filter((r) => input[r] === undefined || input[r] === null || input[r] === "");
  if (missing.length) return `Missing required input: ${missing.join(", ")}`;
  for (const [key, value] of Object.entries(input)) {
    const prop = schema.properties?.[key];
    if (!prop || value === undefined || value === null) continue;
    const types = Array.isArray(prop.type) ? prop.type : prop.type ? [prop.type] : [];
    const actual = Array.isArray(value) ? "array" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
    if (types.length && !types.some((t) => t === actual || (t === "number" && actual === "integer"))) return `${key} must be ${types.join(" or ")}`;
    if (Array.isArray(prop.enum) && !prop.enum.includes(value)) return `${key} must be one of ${prop.enum.map((e) => JSON.stringify(e)).join(", ")}`;
  }
  return undefined;
}

/** The tool as MCP lists it (annotations, outputSchema, MCP Apps widget). */
export function mcpToolDefinition(tool: McpServerTool): Tool {
  const annotations = { ...(tool.title ? { title: tool.title } : {}), ...(tool.annotations ?? {}) };
  if (tool.requiresApproval) annotations.destructiveHint ??= true;
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    description: tool.requiresApproval ? `${tool.description}\n\nNeeds a person's approval: calling it queues the call; it runs once approved.` : tool.description,
    inputSchema: tool.inputSchema as Tool["inputSchema"],
    ...(tool.outputSchema && !tool.requiresApproval ? { outputSchema: tool.outputSchema as Tool["outputSchema"] } : {}),
    ...(Object.keys(annotations).length ? { annotations } : {}),
    ...(tool.uiResource ? { _meta: { ui: { resourceUri: tool.uiResource } } } : {}),
  };
}

/** A tool call result as MCP returns it. */
export function mcpCallResult(tool: McpServerTool, result: McpToolCallResult): CallToolResult {
  const structured = result.ok && tool.outputSchema && !tool.requiresApproval
    ? (result.structured && typeof result.structured === "object" && !Array.isArray(result.structured) ? result.structured as Record<string, unknown> : { result: result.structured ?? result.text })
    : result.ok && result.structured && typeof result.structured === "object" && !Array.isArray(result.structured) ? result.structured as Record<string, unknown> : undefined;
  return {
    content: [{ type: "text", text: result.ok ? result.text : (result.error ?? result.text) }],
    ...(structured ? { structuredContent: structured } : {}),
    ...(result.ok ? {} : { isError: true }),
  };
}

export interface ServeOptions {
  serverId: string;
  source: Extract<McpCallSource, "private" | "public">;
  ip?: string;
  requestedBy?: string;
}

/** The deployed version's spec, or undefined when nothing is deployed. */
export function deployedSpec(polpoDir: string, serverId: string): { version: string; spec: McpServerSpec } | undefined {
  const store = new McpServerStore(polpoDir);
  const version = store.production(serverId);
  const v = version ? store.version(serverId, version) : undefined;
  return v ? { version: v.version, spec: v.spec } : undefined;
}

/** The MCP server for the deployed version (null when nothing is deployed). */
export function createHostedMcpServer(opts: ServeOptions, deps: HostedRuntimeDeps): Server | null {
  const deployed = deployedSpec(deps.polpoDir, opts.serverId);
  if (!deployed) return null;
  const { spec, version } = deployed;
  const visible = (t: McpServerTool) => opts.source !== "public" || !isSensitiveTool(t) || !!t.publicCallable;
  const server = new Server(
    { name: spec.name, version, ...(spec.description ? { title: spec.name } : {}) },
    {
      capabilities: { tools: { listChanged: false }, ...(spec.resources?.length ? { resources: {} } : {}) },
      ...(spec.description ? { instructions: spec.description } : {}),
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: spec.tools.filter(visible).map(mcpToolDefinition) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = spec.tools.find((t) => t.name === request.params.name);
    if (!tool || !visible(tool)) return { content: [{ type: "text", text: `Unknown tool "${request.params.name}"` }], isError: true };
    const result = await runTool({
      serverId: opts.serverId, spec, version, toolName: tool.name, input: (request.params.arguments ?? {}) as Record<string, unknown>,
      source: opts.source, signal: extra.signal, ...(opts.ip ? { ip: opts.ip } : {}), ...(opts.requestedBy ? { requestedBy: opts.requestedBy } : {}),
    }, deps);
    return mcpCallResult(tool, result);
  });
  if (spec.resources?.length) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: spec.resources!.map((r) => ({ uri: r.uri, name: r.name, mimeType: r.mimeType, ...(r.description ? { description: r.description } : {}) })),
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const r = spec.resources!.find((x) => x.uri === request.params.uri);
      if (!r) throw new Error(`Unknown resource ${request.params.uri}`);
      return { contents: [{ uri: r.uri, mimeType: r.mimeType, text: r.text }] };
    });
  }
  return server;
}
