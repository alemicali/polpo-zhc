/**
 * Hosted MCP servers (custom MCP servers Polpo builds and serves; each becomes a connector).
 * Mounted under the authenticated API at /api/v1/mcp-servers. Secrets never pass through here:
 * a server names vault entries (owner / service / key) and responses only say whether they are set.
 *
 *   GET    /mcp-servers                         list
 *   GET    /mcp-servers/templates               ready-made connectors (Printful, Gelato, Printify…) with install status
 *   GET    /mcp-servers/templates/{t}           one template
 *   POST   /mcp-servers/templates/{t}/install   settings → secrets → agents → read-only tests → publish + deploy (or upgrade → draft + diff)
 *   POST   /mcp-servers                         create { id?, spec } or { template } (a draft)
 *   POST   /mcp-servers/generate                draft a spec with the orchestrator model (from an API / a description)
 *   GET    /mcp-servers/{id}                    meta, draft (+ problems), production spec, secrets set, tests
 *   PATCH  /mcp-servers/{id}                    visibility, disabled (kill switch), onTestFailure, rateLimits, settings (non-secret values)
 *   DELETE /mcp-servers/{id}                    the server, its bound connector and files
 *   PUT    /mcp-servers/{id}/draft              { spec }: save the draft (problems listed, not refused)
 *   DELETE /mcp-servers/{id}/draft              back to the production spec
 *   PUT    /mcp-servers/{id}/secrets/{name}     { value } to the vault (write-only, never echoed)
 *   PUT    /mcp-servers/{id}/tests              saved test cases
 *   POST   /mcp-servers/{id}/test               run one tool { tool, input, ref?, confirm?, dryRun? }
 *   POST   /mcp-servers/{id}/tests/run          run the saved tests { ref? }
 *   POST   /mcp-servers/{id}/publish            { bump?, version?, note?, deploy?, force? }
 *   POST   /mcp-servers/{id}/deploy             { version, note? }
 *   POST   /mcp-servers/{id}/rollback           { to?, note? }
 *   GET    /mcp-servers/{id}/versions[/{v}]     versions (newest first) / one version
 *   GET    /mcp-servers/{id}/deploys            deploy history
 *   GET    /mcp-servers/{id}/diff?from=&to=     per-field changes + unified diff (refs: draft, production, semver)
 *   GET    /mcp-servers/{id}/logs?limit=        call log
 *   GET    /mcp-servers/{id}/pending            calls waiting for approval (and their outcome)
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { McpServerError, type McpServerService } from "../../mcp-servers/service.js";
import { McpServerInputError } from "../../mcp-servers/validate.js";
import { CodeBuildError } from "../../mcp-servers/code-build.js";
import { generateServer, type GenerateInput, type LlmQuery } from "../../mcp-servers/generate.js";
import { serverTemplate } from "../../mcp-servers/templates/index.js";
import { PUBLIC_MCP_SERVERS_PATH } from "../../mcp-servers/public.js";
import type { UrlPolicy } from "../../mcp/net.js";
import { NoOrchestratorModelError } from "../../llm/orchestrator-model.js";

export interface McpServerRouteDeps {
  service: () => McpServerService;
  /** The orchestrator model (generation). */
  llm: () => LlmQuery;
  actor: (c: Context) => string;
  /** The public base (POLPO_PUBLIC_URL, else the request origin) for public endpoint URLs. */
  publicBase: (c: Context) => string;
  urlPolicy?: () => UrlPolicy;
}

const tags = ["MCP servers"];
const okAny = z.object({ ok: z.boolean(), data: z.any() });
const errorSchema = z.object({ ok: z.boolean(), error: z.string(), code: z.string().optional(), details: z.any().optional() });
const anyBody = (description: string) => ({ body: { content: { "application/json": { schema: z.record(z.string(), z.any()).openapi({ description }) } } } });
const idParam = z.object({ id: z.string() });
const responses = (what: string) => ({
  200: { content: { "application/json": { schema: okAny } }, description: what },
  400: { content: { "application/json": { schema: errorSchema } }, description: "Invalid input" },
  404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" },
  409: { content: { "application/json": { schema: errorSchema } }, description: "Conflict (nothing to publish, already deployed, tests failed…)" },
});

function fail(c: Context, err: unknown): Response {
  if (err instanceof McpServerError) {
    const status = err.code === "NOT_FOUND" ? 404 : err.code === "INVALID" ? 400 : 409;
    return c.json({ ok: false, error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) }, status);
  }
  if (err instanceof McpServerInputError || err instanceof CodeBuildError) return c.json({ ok: false, error: err.message, code: "INVALID" }, 400);
  if (err instanceof NoOrchestratorModelError) return c.json({ ok: false, error: err.message, code: err.code }, 409);
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ ok: false, error: message, code: "ERROR" }, 500);
}

async function body(c: Context): Promise<Record<string, any>> {
  const b = await c.req.json().catch(() => ({}));
  return b && typeof b === "object" && !Array.isArray(b) ? b : {};
}

export function mcpServerRoutes(deps: McpServerRouteDeps): OpenAPIHono {
  const app = new OpenAPIHono();
  const svc = () => deps.service();
  const withUrl = (c: Context, s: { id: string; visibility: string }) => ({
    ...s, ...(s.visibility === "public" ? { publicUrl: `${deps.publicBase(c)}${PUBLIC_MCP_SERVERS_PATH}/${s.id}` } : {}),
  });

  app.openapi(createRoute({ method: "get", path: "/", tags, summary: "List hosted MCP servers", description: "Custom MCP servers Polpo hosts: name, tools, production version, draft state, visibility, pending approvals.", responses: responses("The servers") }),
    async (c) => { try { return c.json({ ok: true, data: { servers: svc().list().map((s) => withUrl(c, s)) } }, 200); } catch (err) { return fail(c, err) as never; } });

  app.openapi(createRoute({ method: "get", path: "/templates", tags, summary: "Ready-made connectors (templates)",
    description: "The curated catalog of hosted connectors Polpo can install (Printful, Gelato, Printify…): vendor, category, revision, maturity (tested with the live API or not), "
      + "the settings and secrets each needs (with the vendor's instructions; never values), read-only and approval tools, and where each stands here: "
      + "available, draft, installed (server and version) or update_available.",
    responses: responses("The templates") }),
    async (c) => { try { return c.json({ ok: true, data: { templates: svc().templates() } }, 200); } catch (err) { return fail(c, err) as never; } });

  app.openapi(createRoute({ method: "get", path: "/templates/{template}", tags, summary: "One ready-made connector", description: "A template with its tools, settings, secrets' instructions, changelog and install status.", request: { params: z.object({ template: z.string() }) }, responses: responses("The template") }),
    async (c) => {
      try {
        const t = serverTemplate(c.req.valid("param").template);
        if (!t) throw new McpServerError(`No template "${c.req.valid("param").template}"`, "NOT_FOUND");
        return c.json({ ok: true, data: svc().templateInfo(t) }, 200);
      } catch (err) { return fail(c, err) as never; }
    });

  app.openapi(createRoute({ method: "post", path: "/templates/{template}/install", tags, summary: "Install a ready-made connector",
    description: "settings (validated), secrets (values saved straight to the vault, never returned; the dashboard sends them, MCP never does), agents (who the connector grants: "
      + "a list or \"*\"; default none — Polpo only), then the template's read-only tests, then publish 1.0.0 + deploy. status: installed | needs_secrets (nothing published: "
      + "missingSecrets) | tests_failed | draft (publish: false) | upgrade_draft (an older revision is installed: the new one is the draft, with the diff) | up_to_date.",
    request: { params: z.object({ template: z.string() }), ...anyBody("{ id?, settings?, secrets?, agents?, publish?, force? }") }, responses: responses("The install") }),
    async (c) => {
      try {
        const b = await body(c);
        const result = await svc().install(c.req.valid("param").template, {
          ...(typeof b.id === "string" ? { id: b.id } : {}),
          ...(b.settings && typeof b.settings === "object" ? { settings: b.settings } : {}),
          ...(b.secrets && typeof b.secrets === "object" ? { secrets: b.secrets } : {}),
          ...(b.agents !== undefined ? { agents: b.agents } : {}),
          ...(b.publish === false ? { publish: false } : {}), ...(b.force === true ? { force: true } : {}),
        }, deps.actor(c));
        return c.json({ ok: true, data: result }, 200);
      } catch (err) { return fail(c, err) as never; }
    });

  app.openapi(createRoute({ method: "post", path: "/", tags, summary: "Create a hosted MCP server", description: "Create a server as a draft from a spec ({ id?, spec, visibility? }) or a template ({ template: \"printful\" }). Publish it to make a version and its connector.", request: anyBody("{ id?, spec } or { template, id? }"), responses: responses("Created") }),
    async (c) => {
      try {
        const b = await body(c);
        if (typeof b.template === "string") {
          const t = serverTemplate(b.template);
          if (!t) throw new McpServerError(`No template "${b.template}"`, "NOT_FOUND");
          const created = svc().create({ ...(typeof b.id === "string" ? { id: b.id } : {}), spec: t.spec, template: t.id, templateRevision: t.revision }, deps.actor(c));
          svc().saveTests(created.id, t.tests);
          return c.json({ ok: true, data: { ...created, setup: t.setup } }, 200);
        }
        return c.json({ ok: true, data: svc().create({ ...(typeof b.id === "string" ? { id: b.id } : {}), spec: b.spec, ...(b.visibility ? { visibility: b.visibility } : {}) }, deps.actor(c)) }, 200);
      } catch (err) { return fail(c, err) as never; }
    });

  app.openapi(createRoute({ method: "post", path: "/generate", tags, summary: "Draft a server with Polpo's model",
    description: "mode \"api\": from an OpenAPI URL (url) or a pasted OpenAPI document / docs text (text): a curated, small set of task-oriented tools. "
      + "mode \"description\": from a description of the functions (text): code tools, plus HTTP tools when an API is implied. Returns the proposal "
      + "(spec, problems, notes) to review; with create: true it is also saved as a new draft.",
    request: anyBody("{ mode, url?, text?, goal?, name?, vaultOwner?, create?, id? }"), responses: responses("The proposal") }),
    async (c) => {
      try {
        const b = await body(c);
        if (b.mode !== "api" && b.mode !== "description") throw new McpServerError('mode must be "api" or "description"');
        const result = await generateServer(b as GenerateInput, deps.llm(), { ...(deps.urlPolicy ? { urlPolicy: deps.urlPolicy() } : {}) });
        if (b.create === true) {
          const created = svc().create({ ...(typeof b.id === "string" ? { id: b.id } : {}), spec: result.spec }, deps.actor(c));
          return c.json({ ok: true, data: { ...result, id: created.id } }, 200);
        }
        return c.json({ ok: true, data: result }, 200);
      } catch (err) { return fail(c, err) as never; }
    });

  app.openapi(createRoute({ method: "get", path: "/{id}", tags, summary: "Get a hosted MCP server", description: "Settings, the draft (with what stops it from being published), the production spec, which secrets are set (never their values), saved tests.", request: { params: idParam }, responses: responses("The server") }),
    async (c) => { try { const s = await svc().get(c.req.valid("param").id); return c.json({ ok: true, data: withUrl(c, s) }, 200); } catch (err) { return fail(c, err) as never; } });

  app.openapi(createRoute({ method: "patch", path: "/{id}", tags, summary: "Change a server's settings",
    description: "visibility (\"private\": this instance only; \"public\": anyone with the URL, with the instance's credentials), disabled (kill switch), onTestFailure (\"warn\" | \"block\"), rateLimits { perIpPerMinute, globalPerMinute }, settings (values of the settingsSchema, e.g. { store_id }: validated; null clears a key; no new version needed).",
    request: { params: idParam, ...anyBody("{ visibility?, disabled?, onTestFailure?, rateLimits?, settings? }") }, responses: responses("Saved") }),
    async (c) => { try { const s = svc().updateSettings(c.req.valid("param").id, await body(c)); return c.json({ ok: true, data: withUrl(c, s) }, 200); } catch (err) { return fail(c, err) as never; } });

  app.openapi(createRoute({ method: "delete", path: "/{id}", tags, summary: "Delete a hosted MCP server", description: "Removes the server, its versions, logs and the connector bound to it.", request: { params: idParam }, responses: responses("Deleted") }),
    async (c) => { try { const removed = await svc().remove(c.req.valid("param").id); return removed ? c.json({ ok: true, data: { removed } }, 200) : c.json({ ok: false, error: "No such server", code: "NOT_FOUND" }, 404); } catch (err) { return fail(c, err) as never; } });

  app.openapi(createRoute({ method: "put", path: "/{id}/draft", tags, summary: "Save the draft", description: "The whole spec (name, description, baseUrl, allowedDomains, secrets as vault references, auth, tools, limits, dependencies, resources). Problems are listed, not refused; publish needs none.", request: { params: idParam, ...anyBody("{ spec }") }, responses: responses("Saved, with problems") }),
    async (c) => { try { const b = await body(c); return c.json({ ok: true, data: svc().updateDraft(c.req.valid("param").id, b.spec ?? b, deps.actor(c)) }, 200); } catch (err) { return fail(c, err) as never; } });

  app.openapi(createRoute({ method: "delete", path: "/{id}/draft", tags, summary: "Discard the draft", description: "Back to the production spec.", request: { params: idParam }, responses: responses("Discarded") }),
    async (c) => { try { svc().discardDraft(c.req.valid("param").id); return c.json({ ok: true, data: { discarded: true } }, 200); } catch (err) { return fail(c, err) as never; } });

  app.openapi(createRoute({ method: "put", path: "/{id}/secrets/{name}", tags, summary: "Save a secret to the vault",
    description: "{ value }: written to the vault entry the server names for this secret (other fields of the entry are kept). Write-only: the value is never returned or logged; "
      + "the server's GET says only whether it is set.",
    request: { params: z.object({ id: z.string(), name: z.string() }), ...anyBody("{ value }") }, responses: responses("Saved (set: true)") }),
    async (c) => { try { const p = c.req.valid("param"); const b = await body(c); return c.json({ ok: true, data: await svc().saveSecret(p.id, p.name, b.value) }, 200); } catch (err) { return fail(c, err) as never; } });

  app.openapi(createRoute({ method: "put", path: "/{id}/tests", tags, summary: "Save the test cases", description: "A list of { name?, tool, input, expect? (\"ok\" | \"error\"), contains? }. They run on publish (destructive / approval tools are always skipped).", request: { params: idParam, ...anyBody("{ tests: [...] }") }, responses: responses("Saved") }),
    async (c) => { try { const b = await body(c); return c.json({ ok: true, data: { tests: svc().saveTests(c.req.valid("param").id, b.tests) } }, 200); } catch (err) { return fail(c, err) as never; } });

  app.openapi(createRoute({ method: "post", path: "/{id}/test", tags, summary: "Run one tool",
    description: "Run a tool of the draft (ref: \"draft\", \"production\" or a version) with a sample input: the request (secrets masked), the response, timing, errors. "
      + "Destructive and approval tools are a dry run (the request that would go out) unless confirm: true.",
    request: { params: idParam, ...anyBody("{ tool, input?, ref?, confirm?, dryRun? }") }, responses: responses("The result") }),
    async (c) => {
      try {
        const b = await body(c);
        if (typeof b.tool !== "string") throw new McpServerError("tool is required");
        return c.json({ ok: true, data: await svc().test(c.req.valid("param").id, { tool: b.tool, input: b.input ?? {}, ...(b.ref ? { ref: b.ref } : {}), confirm: b.confirm === true, dryRun: b.dryRun === true, actor: deps.actor(c) }) }, 200);
      } catch (err) { return fail(c, err) as never; }
    });

  app.openapi(createRoute({ method: "post", path: "/{id}/tests/run", tags, summary: "Run the saved tests", description: "Every saved test case against a ref (default: the draft); destructive / approval tools are skipped.", request: { params: idParam, ...anyBody("{ ref? }") }, responses: responses("Results") }),
    async (c) => { try { const b = await body(c); return c.json({ ok: true, data: await svc().runSavedTests(c.req.valid("param").id, b.ref ?? "draft") }, 200); } catch (err) { return fail(c, err) as never; } });

  app.openapi(createRoute({ method: "post", path: "/{id}/publish", tags, summary: "Publish the draft",
    description: "Freeze the draft as a new semver version (bump: major | minor | patch, suggested from the changes; or an explicit version). Saved tests run first: failures warn, "
      + "or block when onTestFailure is \"block\" (force: true overrides). The first version is deployed at once and creates the connector; later ones with deploy: true.",
    request: { params: idParam, ...anyBody("{ bump?, version?, note?, deploy?, force? }") }, responses: responses("Published") }),
    async (c) => { try { return c.json({ ok: true, data: await svc().publish(c.req.valid("param").id, await body(c), deps.actor(c)) }, 200); } catch (err) { return fail(c, err) as never; } });

  app.openapi(createRoute({ method: "post", path: "/{id}/deploy", tags, summary: "Deploy a version", description: "Move production to a published version (the connector serves it from now on).", request: { params: idParam, ...anyBody("{ version, note? }") }, responses: responses("Deployed") }),
    async (c) => {
      try {
        const b = await body(c);
        if (typeof b.version !== "string") throw new McpServerError("version is required");
        return c.json({ ok: true, data: await svc().deploy(c.req.valid("param").id, b.version, { actor: deps.actor(c), ...(b.note ? { note: String(b.note) } : {}) }) }, 200);
      } catch (err) { return fail(c, err) as never; }
    });

  app.openapi(createRoute({ method: "post", path: "/{id}/rollback", tags, summary: "Roll back", description: "Production back to the version before (or to `to`).", request: { params: idParam, ...anyBody("{ to?, note? }") }, responses: responses("Rolled back") }),
    async (c) => { try { const b = await body(c); return c.json({ ok: true, data: await svc().rollback(c.req.valid("param").id, { actor: deps.actor(c), ...(b.to ? { to: String(b.to) } : {}), ...(b.note ? { note: String(b.note) } : {}) }) }, 200); } catch (err) { return fail(c, err) as never; } });

  app.openapi(createRoute({ method: "get", path: "/{id}/versions", tags, summary: "List versions", description: "Published versions, newest first (without their spec), with the production marker.", request: { params: idParam }, responses: responses("Versions") }),
    async (c) => { try { return c.json({ ok: true, data: { versions: svc().versions(c.req.valid("param").id) } }, 200); } catch (err) { return fail(c, err) as never; } });

  app.openapi(createRoute({ method: "get", path: "/{id}/versions/{version}", tags, summary: "Get a version", description: "One version with its spec (also \"production\").", request: { params: z.object({ id: z.string(), version: z.string() }) }, responses: responses("The version") }),
    async (c) => { try { const p = c.req.valid("param"); const { lockfile: _l, ...v } = { ...svc().version(p.id, p.version), lockfile: undefined }; return c.json({ ok: true, data: v }, 200); } catch (err) { return fail(c, err) as never; } });

  app.openapi(createRoute({ method: "get", path: "/{id}/deploys", tags, summary: "Deploy history", description: "Deploys and rollbacks, newest first.", request: { params: idParam }, responses: responses("History") }),
    async (c) => { try { return c.json({ ok: true, data: { deploys: svc().deploys(c.req.valid("param").id) } }, 200); } catch (err) { return fail(c, err) as never; } });

  app.openapi(createRoute({ method: "get", path: "/{id}/diff", tags, summary: "Diff two refs", description: "Per-field changes (tools by name) and a git-style unified diff. Refs: draft, production, a version. to defaults to draft; from to production for the draft.", request: { params: idParam, query: z.object({ from: z.string().optional(), to: z.string().optional() }) }, responses: responses("The diff") }),
    async (c) => { try { const q = c.req.valid("query"); return c.json({ ok: true, data: svc().diff(c.req.valid("param").id, q.from, q.to ?? "draft") }, 200); } catch (err) { return fail(c, err) as never; } });

  app.openapi(createRoute({ method: "get", path: "/{id}/logs", tags, summary: "Call log", description: "Latest calls first: tool, source (private, public, test, approval), version, ok, status, ms, error, caller IP (public).", request: { params: idParam, query: z.object({ limit: z.string().optional() }) }, responses: responses("Logs") }),
    async (c) => { try { const n = Math.min(1000, Math.max(1, Number(c.req.valid("query").limit ?? 100) || 100)); return c.json({ ok: true, data: { logs: svc().logs(c.req.valid("param").id, n) } }, 200); } catch (err) { return fail(c, err) as never; } });

  app.openapi(createRoute({ method: "get", path: "/{id}/pending", tags, summary: "Calls waiting for approval", description: "Calls of approval tools: pending, then approved (with their result) or rejected. Approve or reject them in Approvals.", request: { params: idParam }, responses: responses("Pending calls") }),
    async (c) => { try { return c.json({ ok: true, data: { calls: svc().pending(c.req.valid("param").id) } }, 200); } catch (err) { return fail(c, err) as never; } });

  return app;
}
