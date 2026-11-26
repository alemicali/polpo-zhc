/**
 * Hosted MCP servers: custom MCP servers Polpo builds and serves (from an API, a description or a
 * template such as Printful); each becomes a connector on first publish. Reading needs polpo:read;
 * every change (create, edit, test with the instance's credentials, publish, deploy, roll back,
 * visibility, delete) needs polpo:admin. Secrets never pass through here: a server names vault
 * entries (owner / service / key) and the person adds them.
 */
import { z } from "zod";
import {
  DESTRUCTIVE, READ, UPDATE, WRITE, apiError, apiGet, apiSend, confirmParam, dashboardLink, enc, fail, ok, short,
  type McpDeps, type Register,
} from "./kit.js";
import { setupHandoffs } from "./setup.js";

type Summary = {
  id: string; name: string; description?: string; visibility: string; disabled?: boolean; toolCount: number; production?: string; latest?: string;
  versionCount: number; draftChanged: boolean; pendingApprovals: number; connectorId?: string; publicUrl?: string; template?: string;
};
type Tool = { name: string; title?: string; description: string; kind: string; requiresApproval?: boolean; annotations?: Record<string, boolean>; inputSchema?: unknown; http?: { method: string; url: string } };
type Detail = Summary & {
  draft: { spec: { tools: Tool[]; allowedDomains: string[]; auth: { type: string }; secrets: Record<string, { owner: string; service: string; key: string }> }; problems: string[]; stale?: boolean } | null;
  secrets: Record<string, boolean>; tests: unknown[]; rateLimits: { perIpPerMinute: number; globalPerMinute: number };
  settingsSchema?: Array<{ key: string; label: string; required?: boolean }>; effectiveSettings?: Record<string, unknown>;
  templateInfo?: { id: string; latestRevision: number; installedRevision?: number };
};

const serverItem = z.object({
  id: z.string().describe("The hosted server's id (polpo_mcp_servers_list)"), name: z.string(), visibility: z.string(), production: z.string().optional(), latest: z.string().optional(), tool_count: z.number().int(),
  draft_changed: z.boolean(), pending_approvals: z.number().int(), connector_id: z.string().optional(), public_url: z.string().optional(), disabled: z.boolean().optional(),
});

const item = (s: Summary) => ({
  id: s.id, name: s.name, visibility: s.visibility, ...(s.production ? { production: s.production } : {}), ...(s.latest ? { latest: s.latest } : {}),
  tool_count: s.toolCount, draft_changed: s.draftChanged, pending_approvals: s.pendingApprovals,
  ...(s.connectorId ? { connector_id: s.connectorId } : {}), ...(s.publicUrl ? { public_url: s.publicUrl } : {}), ...(s.disabled ? { disabled: true } : {}),
});
const line = (s: ReturnType<typeof item>) => `- ${s.id} "${s.name}" [${s.visibility}${s.disabled ? ", switched off" : ""}] ${s.production ? `v${s.production} in production` : "not deployed"}`
  + `${s.draft_changed ? " · draft has changes" : ""} · ${s.tool_count} tools${s.connector_id ? ` · connector ${s.connector_id}` : ""}${s.pending_approvals ? ` · ${s.pending_approvals} waiting for approval` : ""}`;

type TemplateInfo = {
  id: string; name: string; category: string; description: string; revision: number; status: string;
  maturity: { testedWithLiveApi: boolean; note?: string };
  installs: Array<{ serverId: string; production?: string; revision?: number; status: string }>;
  readOnlyTools: string[]; approvalTools: string[];
  settings: Array<{ key: string; label: string; required?: boolean; default?: unknown }>;
  secrets: Array<{ name: string; label: string; howTo: string }>;
  tools: Array<{ name: string; description: string; readOnly: boolean; requiresApproval: boolean }>;
  changelog: Array<{ revision: number; note: string }>;
};
type InstallData = {
  id: string; status: string; revision: number; version?: string; missingSecrets?: string[]; connectorId?: string;
  access?: { agents: string[] | "*"; polpo: boolean };
  tests?: { passed: number; failed: number; skipped: number; results: Array<{ tool: string; passed?: boolean; error?: string; text: string }> };
  diff?: { changes: Array<{ field: string; kind: string }>; suggestedBump?: string };
};
const statusLine = (t: TemplateInfo) => {
  const i = t.installs[0];
  if (t.status === "available") return "available";
  if (t.status === "update_available") return `installed as ${i?.serverId} v${i?.production} (revision ${i?.revision ?? 1}): update available`;
  if (t.status === "draft") return `being installed as ${i?.serverId} (not published)`;
  return `installed as ${i?.serverId} v${i?.production}`;
};

const notFound = (id: string) => fail(`There is no hosted server "${id}". List them with polpo_mcp_servers_list.`);
const ADMIN = "polpo:admin" as const;

export function registerMcpServerTools(tool: Register, deps: McpDeps): void {
  const link = (id?: string) => dashboardLink(deps, id ? `/connectors?server=${enc(id)}` : "/connectors?tab=servers");

  tool("connectors", "polpo_mcp_servers_list", {
    title: "List hosted MCP servers",
    description: "Custom MCP servers Polpo hosts (built from an API, a description or a template like Printful): production version, draft changes, "
      + "visibility (private: this instance only; public: anyone with the URL), the connector each one became, calls waiting for approval.",
    inputSchema: {},
    outputSchema: { items: z.array(serverItem) },
    annotations: READ,
  }, async () => {
    const r = await apiGet(deps, "/mcp-servers");
    if (!r.ok) return apiError(r, "Listing hosted servers");
    const items = ((r.data as { servers?: Summary[] }).servers ?? []).map(item);
    return ok(items.map(line).join("\n") || "No hosted servers. Create one with polpo_mcp_server_create (template: printful) or polpo_mcp_server_generate.", { items });
  });

  tool("connectors", "polpo_mcp_server_get", {
    title: "Get a hosted MCP server",
    description: "One hosted server: its draft tools (kind, method and URL, which need approval), allowed domains, auth, the vault entries it reads (set or not, never the values), "
      + "what stops the draft from being published, saved tests, rate limits. With versions: true, also its versions and deploy history.",
    inputSchema: {
      id: z.string().describe("The hosted server's id (polpo_mcp_servers_list)"),
      versions: z.boolean().optional().describe("Also list versions and deploys"),
      diff: z.object({ from: z.string().optional().describe("From this ref"), to: z.string().optional().describe("To this ref") }).optional()
        .describe("Also what changed between two refs (draft, production, a version; default: the draft against production): per-tool changes and a unified diff"),
    },
    outputSchema: { server: z.object({ id: z.string().describe("The hosted server's id (polpo_mcp_servers_list)"), name: z.string() }).passthrough(), versions: z.array(z.any()).optional(), deploys: z.array(z.any()).optional(), diff: z.any().optional() },
    annotations: READ,
  }, async ({ id, versions, diff }) => {
    const r = await apiGet(deps, `/mcp-servers/${enc(id)}`);
    if (!r.ok) return r.status === 404 ? notFound(id) : apiError(r, `Reading ${id}`);
    const s = r.data as Detail;
    const spec = s.draft?.spec;
    const lines = [line(item(s)).slice(2)];
    if (s.publicUrl) lines.push(`public URL: ${s.publicUrl} (rate limits: ${s.rateLimits.perIpPerMinute}/min per IP, ${s.rateLimits.globalPerMinute}/min in all)`);
    if (spec) {
      lines.push(`domains: ${spec.allowedDomains.join(", ") || "(none)"} · auth: ${spec.auth.type}`);
      for (const [name, ref] of Object.entries(spec.secrets)) {
        lines.push(`secret ${name}: vault ${ref.owner}/${ref.service} field ${ref.key} — ${s.secrets[name] ? "set" : `NOT SET: ${setupHandoffs(deps, [{ target: { kind: "mcp-server", item: id, field: name }, what: name }]).next_step ?? "the person adds it in the vault"}`}`);
      }
      for (const f of s.settingsSchema ?? []) lines.push(`setting ${f.key} (${f.label}): ${s.effectiveSettings?.[f.key] !== undefined ? String(s.effectiveSettings[f.key]) : f.required ? "NOT SET (required)" : "not set"}`);
      if (s.templateInfo) lines.push(`template ${s.templateInfo.id}: revision ${s.templateInfo.installedRevision ?? "—"} installed, latest ${s.templateInfo.latestRevision}${(s.templateInfo.installedRevision ?? 0) < s.templateInfo.latestRevision && s.templateInfo.installedRevision ? " (update: polpo_mcp_server_install)" : ""}`);
      lines.push("draft tools:", ...spec.tools.map((t) => `- ${t.name} (${t.kind}${t.http ? ` ${t.http.method} ${t.http.url}` : ""})${t.requiresApproval ? " [needs approval]" : t.annotations?.readOnlyHint ? " [read-only]" : ""}: ${short(t.description, 120)}`));
      if (s.draft?.problems.length) lines.push(`before publishing, fix: ${s.draft.problems.join("; ")}`);
    }
    let extra: Record<string, unknown> = {};
    if (versions) {
      const [v, d] = await Promise.all([apiGet(deps, `/mcp-servers/${enc(id)}/versions`), apiGet(deps, `/mcp-servers/${enc(id)}/deploys`)]);
      const vs = v.ok ? (v.data as { versions: Array<{ version: string; production: boolean; createdAt: string; author: string; note?: string }> }).versions : [];
      const ds = d.ok ? (d.data as { deploys: Array<{ action: string; from?: string; to: string; actor: string; at: string }> }).deploys : [];
      lines.push("versions:", ...vs.map((x) => `- ${x.version}${x.production ? " (production)" : ""} by ${x.author} ${x.createdAt}${x.note ? `: ${short(x.note, 80)}` : ""}`));
      lines.push("deploys:", ...ds.slice(0, 10).map((x) => `- ${x.at} ${x.action} ${x.from ?? "∅"} → ${x.to} by ${x.actor}`));
      extra = { versions: vs, deploys: ds };
    }
    if (diff) {
      const qs = new URLSearchParams({ ...(diff.from ? { from: diff.from } : {}), ...(diff.to ? { to: diff.to } : {}) }).toString();
      const dr = await apiGet(deps, `/mcp-servers/${enc(id)}/diff${qs ? `?${qs}` : ""}`);
      if (dr.ok) {
        const d = dr.data as { changes: Array<{ field: string; kind: string }>; unified: string; suggestedBump?: string };
        lines.push(`diff: ${d.changes.map((c) => `${c.kind} ${c.field}`).join(", ") || "no changes"}${d.suggestedBump ? ` (suggested bump: ${d.suggestedBump})` : ""}`, short(d.unified, 6000));
        extra = { ...extra, diff: d };
      } else lines.push(`diff: ${dr.error}`);
    }
    lines.push(`dashboard: ${link(id)}`);
    return ok(lines.join("\n"), { server: s, ...extra });
  });

  tool("connectors", "polpo_mcp_server_create", {
    title: "Create a hosted MCP server",
    description: "Create a hosted server as a draft: from a template (template: \"printful\") or a full spec (name, baseUrl, allowedDomains, secrets as vault references "
      + "{ owner, service, key }, auth, tools). Never put a secret value in it: the person adds the vault entry. Then test, publish (it becomes a connector).",
    inputSchema: {
      template: z.string().optional().describe("A template id (polpo_mcp_server_templates); to install it in one step use polpo_mcp_server_install"),
      id: z.string().optional().describe("The server's id (default: from the name)"),
      spec: z.record(z.string(), z.any()).optional().describe("The full spec (see polpo_mcp_server_get for its shape)"),
    },
    outputSchema: { id: z.string().describe("The hosted server's id (polpo_mcp_servers_list)"), problems: z.array(z.string()), setup: z.string().optional() },
    annotations: WRITE,
    scope: ADMIN,
  }, async ({ template, id, spec }) => {
    if (!template && !spec) return fail("Give a template (e.g. printful) or a spec. To draft one from an API or a description, use polpo_mcp_server_generate.");
    const r = await apiSend(deps, "POST", "/mcp-servers", { ...(template ? { template } : { spec }), ...(id ? { id } : {}) });
    if (!r.ok) return apiError(r, "Creating the server");
    const d = r.data as { id: string; problems: string[]; setup?: string };
    return ok(`Created the draft ${d.id}.${d.setup ? ` Setup: ${d.setup}` : ""}${d.problems.length ? ` Fix before publishing: ${d.problems.join("; ")}.` : ""} `
      + `Test it with polpo_mcp_server_test, then polpo_mcp_server_publish. Dashboard: ${link(d.id)}`, d);
  });

  tool("connectors", "polpo_mcp_server_templates", {
    title: "Ready-made connectors",
    description: "The curated hosted connectors Polpo can install in one step (Printful, Gelato, Printify…): vendor, category, maturity (tested with the live API or not), "
      + "the settings and secrets each needs (with where to create the token), read-only and approval tools, and their status here: available, draft, installed (version) "
      + "or update_available. Install with polpo_mcp_server_install.",
    inputSchema: { id: z.string().optional().describe("One template (e.g. printful): also its tools, settings and changelog") },
    outputSchema: { templates: z.array(z.object({ id: z.string(), name: z.string(), status: z.string(), revision: z.number() }).passthrough()) },
    annotations: READ,
  }, async ({ id }) => {
    const r = await apiGet(deps, id ? `/mcp-servers/templates/${enc(id)}` : "/mcp-servers/templates");
    if (!r.ok) return r.status === 404 ? fail(`There is no template "${id}". List them with polpo_mcp_server_templates.`) : apiError(r, "Reading the templates");
    const list = (id ? [r.data] : (r.data as { templates: unknown[] }).templates) as TemplateInfo[];
    const lines = list.map((t) => [
      `- ${t.id} "${t.name}" (${t.category}, revision ${t.revision}) — ${statusLine(t)}${t.maturity.testedWithLiveApi ? "" : " · not yet tested with the live API"}`,
      `  ${short(t.description, 200)}`,
      `  read-only: ${t.readOnlyTools.join(", ") || "none"} · needs approval: ${t.approvalTools.join(", ") || "none"}`,
      ...(t.settings.length ? [`  settings: ${t.settings.map((s) => `${s.key}${s.required ? " (required)" : ""}${s.default !== undefined ? ` = ${s.default}` : ""}`).join(", ")}`] : []),
      `  secrets: ${t.secrets.map((s) => `${s.name} (${s.label}: ${short(s.howTo, 160)})`).join("; ")}`,
      ...(id ? t.tools.map((x) => `  - ${x.name}${x.requiresApproval ? " [needs approval]" : x.readOnly ? " [read-only]" : ""}: ${short(x.description, 140)}`) : []),
      ...(id ? t.changelog.map((c) => `  rev ${c.revision}: ${c.note}`) : []),
    ].join("\n"));
    return ok(`${lines.join("\n")}\nDashboard: ${link()}`, { templates: list });
  });

  tool("connectors", "polpo_mcp_server_install", {
    title: "Install a ready-made connector",
    description: "Install a template (e.g. \"install the Printful connector\"): settings (e.g. store_id), which agents may use it (agents: names or \"*\"; default none — "
      + "ask the person, an agent sees no tools until granted), then the template's read-only tests, then publish 1.0.0 + deploy (it becomes a connector). Secrets never pass "
      + "through here: when one is missing the result has setup_url / setup_ids — show the link, call polpo_setup_wait, then call this again. On a server already installed "
      + "at an older revision it makes the new revision a draft and shows the diff (publish it with polpo_mcp_server_publish after the person agrees).",
    inputSchema: {
      template: z.string().describe("The template id (polpo_mcp_server_templates)"),
      id: z.string().optional().describe("The server id (default: the template's id)"),
      settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe("Setting values, e.g. { store_id: \"123\" } (null clears one)"),
      agents: z.union([z.array(z.string()), z.literal("*")]).optional().describe("Agents the connector grants (\"*\": all); omitted: unchanged (none on a new install)"),
      publish: z.boolean().optional().describe("false: only run the checks and keep a draft"),
    },
    outputSchema: {
      id: z.string(), status: z.string(), revision: z.number(), version: z.string().optional(), missing_secrets: z.array(z.string()).optional(),
      setup_url: z.string().optional(), setup_id: z.string().optional(), setup_ids: z.array(z.string()).optional(), next_step: z.string().optional(),
      tests: z.object({ passed: z.number(), failed: z.number(), skipped: z.number() }).passthrough().optional(),
      access: z.object({ agents: z.union([z.array(z.string()), z.literal("*")]), polpo: z.boolean() }).optional(),
      changes: z.array(z.object({ field: z.string(), kind: z.string() })).optional(),
    },
    annotations: WRITE,
    scope: ADMIN,
  }, async ({ template, id, settings, agents, publish }) => {
    const r = await apiSend(deps, "POST", `/mcp-servers/templates/${enc(template)}/install`, {
      ...(id ? { id } : {}), ...(settings ? { settings } : {}), ...(agents !== undefined ? { agents } : {}), ...(publish === false ? { publish: false } : {}),
    });
    if (!r.ok) return r.status === 404 ? fail(`${r.error}. List the templates with polpo_mcp_server_templates.`) : apiError(r, `Installing ${template}`);
    const d = r.data as InstallData;
    const base = {
      id: d.id, status: d.status, revision: d.revision, ...(d.version ? { version: d.version } : {}), ...(d.access ? { access: d.access } : {}),
      ...(d.tests ? { tests: { passed: d.tests.passed, failed: d.tests.failed, skipped: d.tests.skipped } } : {}),
    };
    const who = d.access ? (d.access.agents === "*" ? "all agents and Polpo" : d.access.agents.length ? `${d.access.agents.join(", ")} and Polpo` : "Polpo only (no agent yet: grant agents with agents: [...])") : undefined;
    switch (d.status) {
      case "needs_secrets": {
        const info = await apiGet(deps, `/mcp-servers/templates/${enc(template)}`);
        const secrets = info.ok ? (info.data as TemplateInfo).secrets : [];
        const handoff = setupHandoffs(deps, (d.missingSecrets ?? []).map((name) => {
          const s = secrets.find((x) => x.name === name);
          return { target: { kind: "mcp-server" as const, item: d.id, field: name }, what: `${s?.label ?? name}${s?.howTo ? ` (${s.howTo})` : ""}` };
        }));
        return ok(`${d.id}: almost there — the ${(d.missingSecrets ?? []).join(", ")} secret is not in the vault yet, so nothing was published. ${"next_step" in handoff ? handoff.next_step : ""} Then call polpo_mcp_server_install again.`,
          { ...base, missing_secrets: d.missingSecrets ?? [], ...handoff });
      }
      case "tests_failed":
        return ok([`${d.id}: a read-only test failed, so nothing was published:`, ...(d.tests?.results ?? []).filter((x) => x.passed === false).map((x) => `- ${x.tool}: ${short(x.error ?? x.text, 200)}`),
          "Check the secret and the settings (polpo_mcp_server_get), then install again."].join("\n"), base);
      case "upgrade_draft":
        return ok(`${d.id}: revision ${d.revision} of the template is now the draft. Changes: ${(d.diff?.changes ?? []).map((c) => `${c.kind} ${c.field}`).join(", ") || "none"}`
          + `${d.diff?.suggestedBump ? ` (suggested bump: ${d.diff.suggestedBump})` : ""}. Show them to the person, then polpo_mcp_server_publish { id: "${d.id}", deploy: true }. Dashboard: ${link(d.id)}`,
        { ...base, changes: d.diff?.changes ?? [] });
      case "up_to_date":
        return ok(`${d.id} is already on revision ${d.revision} (v${d.version} in production); settings and access saved${who ? ` — used by ${who}` : ""}.`, base);
      case "draft":
        return ok(`${d.id}: checks passed (${d.tests?.passed ?? 0} tests), kept as a draft. Publish with polpo_mcp_server_publish. Dashboard: ${link(d.id)}`, base);
      default:
        return ok(`Installed ${d.id} v${d.version} (template revision ${d.revision}); read-only tests: ${d.tests?.passed ?? 0} passed, ${d.tests?.skipped ?? 0} skipped. `
          + `It is the connector ${d.connectorId ?? d.id}${who ? `, used by ${who}` : ""}. Dashboard: ${link(d.id)}`, base);
    }
  });

  tool("connectors", "polpo_mcp_server_generate", {
    title: "Draft a hosted server with Polpo's model",
    description: "Propose a server: mode \"api\" from an OpenAPI URL (url) or pasted OpenAPI / docs text (text) — a curated, small set of task-oriented tools, not one per endpoint; "
      + "mode \"description\" from a description of the functions (text) — code tools, plus HTTP tools when an API is implied. Returns the proposal to review with the person "
      + "(names, parameters, which tools need approval); with create: true it is saved as a draft.",
    inputSchema: {
      mode: z.enum(["api", "description"]).describe("api: from an OpenAPI document or docs; description: from what the functions should do"),
      url: z.string().optional().describe("api: an OpenAPI document URL (https)"),
      text: z.string().optional().describe("api: a pasted OpenAPI document or docs; description: what the tools should do"),
      goal: z.string().optional().describe("What the person wants the server for (steers which tools are kept)"),
      name: z.string().optional().describe("The server's name"),
      vault_owner: z.string().optional().describe("Vault owner of the credential the server will read (default polpo-infra)"),
      create: z.boolean().optional().describe("Save the proposal as a new draft"),
    },
    outputSchema: { id: z.string().optional(), spec: z.object({ name: z.string() }).passthrough(), problems: z.array(z.string()), notes: z.array(z.string()) },
    annotations: WRITE,
    scope: ADMIN,
  }, async ({ mode, url, text, goal, name, vault_owner, create }) => {
    const r = await apiSend(deps, "POST", "/mcp-servers/generate", { mode, ...(url ? { url } : {}), ...(text ? { text } : {}), ...(goal ? { goal } : {}), ...(name ? { name } : {}), ...(vault_owner ? { vaultOwner: vault_owner } : {}), create: create === true });
    if (!r.ok) return apiError(r, "Drafting the server");
    const d = r.data as { id?: string; spec: { name: string; tools: Tool[] }; problems: string[]; notes: string[] };
    return ok([
      `${d.id ? `Saved as the draft ${d.id}` : "Proposal (not saved)"}: ${d.spec.name}, ${d.spec.tools.length} tools`,
      ...d.spec.tools.map((t) => `- ${t.name} (${t.kind})${t.requiresApproval ? " [needs approval]" : ""}: ${short(t.description, 140)}`),
      ...d.notes.map((n) => `note: ${n}`),
      ...(d.problems.length ? [`to fix: ${d.problems.join("; ")}`] : []),
      d.id ? `Review it with the person, test it (polpo_mcp_server_test), then publish. Dashboard: ${link(d.id)}` : "Review it with the person; create it with polpo_mcp_server_create { spec } or call again with create: true.",
    ].join("\n"), d);
  });

  tool("connectors", "polpo_mcp_server_update", {
    title: "Change a hosted server",
    description: "Save the draft (spec: the whole spec) and/or settings: settings (the server's declared values, e.g. a store id), visibility (private | public — public means ANYONE with the URL can call it with the instance's credentials: "
      + "ask the person and pass confirm: true), disabled (kill switch), on_test_failure (warn | block), rate_limits. Changes to the draft go live only after publish + deploy.",
    inputSchema: {
      id: z.string().describe("The hosted server's id (polpo_mcp_servers_list)"),
      spec: z.record(z.string(), z.any()).optional().describe("The whole draft spec (replaces the draft)"),
      visibility: z.enum(["private", "public"]).optional().describe("private: this instance only; public: anyone with the URL"),
      disabled: z.boolean().optional().describe("Kill switch: true refuses every call"),
      on_test_failure: z.enum(["warn", "block"]).optional().describe("What publish does when a saved test fails"),
      rate_limits: z.object({ per_ip_per_minute: z.number().int().min(1).describe("Requests per minute from one address"), global_per_minute: z.number().int().min(1).describe("Requests per minute in all") }).optional().describe("The public endpoint's limits"),
      settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional()
        .describe("Setting values the server declares (e.g. { store_id: \"123\" }; null clears one): used at once, no new version"),
      discard_draft: z.boolean().optional().describe("Throw the draft away (back to production)"),
      confirm: confirmParam("make a server public"),
    },
    outputSchema: { changed: z.array(z.string()) },
    annotations: UPDATE,
    scope: ADMIN,
  }, async ({ id, spec, visibility, disabled, on_test_failure, rate_limits, settings, discard_draft, confirm }) => {
    if (visibility === "public" && confirm !== true) {
      return fail("Making it public lets anyone with the URL call its tools with this instance's credentials (destructive and approval tools stay off). Ask the person, then call again with confirm: true.");
    }
    const done: string[] = [];
    if (discard_draft) {
      const r = await apiSend(deps, "DELETE", `/mcp-servers/${enc(id)}/draft`);
      if (!r.ok) return r.status === 404 ? notFound(id) : apiError(r, "Discarding the draft");
      done.push("draft discarded");
    }
    if (spec) {
      const r = await apiSend(deps, "PUT", `/mcp-servers/${enc(id)}/draft`, { spec });
      if (!r.ok) return r.status === 404 ? notFound(id) : apiError(r, "Saving the draft");
      const problems = (r.data as { problems: string[] }).problems;
      done.push(`draft saved${problems.length ? ` (to fix before publishing: ${problems.join("; ")})` : ""}`);
    }
    if (visibility || disabled !== undefined || on_test_failure || rate_limits || settings) {
      const r = await apiSend(deps, "PATCH", `/mcp-servers/${enc(id)}`, {
        ...(visibility ? { visibility } : {}), ...(disabled !== undefined ? { disabled } : {}), ...(on_test_failure ? { onTestFailure: on_test_failure } : {}),
        ...(rate_limits ? { rateLimits: { perIpPerMinute: rate_limits.per_ip_per_minute, globalPerMinute: rate_limits.global_per_minute } } : {}),
        ...(settings ? { settings } : {}),
      });
      if (!r.ok) return r.status === 404 ? notFound(id) : apiError(r, "Saving the settings");
      const s = r.data as { visibility: string; disabled?: boolean; publicUrl?: string; settings?: Record<string, unknown> };
      done.push(`settings saved: ${s.visibility}${s.disabled ? ", switched off" : ""}${s.publicUrl ? ` — public URL ${s.publicUrl}` : ""}`
        + `${settings ? ` — values: ${Object.entries(s.settings ?? {}).map(([k, v]) => `${k}=${String(v)}`).join(", ") || "none"}` : ""}`);
    }
    return done.length ? ok(`${id}: ${done.join("; ")}.`, { changed: done }) : fail("Nothing to change.");
  });

  tool("connectors", "polpo_mcp_server_test", {
    title: "Test a hosted server's tools",
    description: "Run one tool with a sample input (the draft by default; ref: production or a version) and see the request (secrets masked), the response, timing and errors — "
      + "or, with all: true, the saved test cases. Destructive and approval tools are only a dry run (the request that would go out) unless confirm: true after the person agreed.",
    inputSchema: {
      id: z.string().describe("The hosted server's id (polpo_mcp_servers_list)"),
      tool: z.string().optional().describe("The tool to run"),
      input: z.record(z.string(), z.any()).optional().describe("The sample input"),
      ref: z.string().optional().describe("draft (default), production or a version"),
      all: z.boolean().optional().describe("Run the saved test cases instead"),
      confirm: confirmParam("really run a destructive or approval tool"),
    },
    outputSchema: { ok: z.boolean().optional(), passed: z.number().int().optional(), failed: z.number().int().optional(), skipped: z.union([z.number(), z.string()]).optional(), ms: z.number().optional() },
    annotations: { ...WRITE, openWorldHint: true },
    scope: ADMIN,
  }, async ({ id, tool: name, input, ref, all, confirm }) => {
    if (all) {
      const r = await apiSend(deps, "POST", `/mcp-servers/${enc(id)}/tests/run`, { ...(ref ? { ref } : {}) });
      if (!r.ok) return r.status === 404 ? notFound(id) : apiError(r, "Running the tests");
      const d = r.data as { passed: number; failed: number; skipped: number; results: Array<{ tool: string; passed?: boolean; skipped?: string; error?: string; ms: number }> };
      return ok([`${d.passed} passed, ${d.failed} failed, ${d.skipped} skipped`, ...d.results.map((x) => `- ${x.tool}: ${x.skipped ? `skipped (${x.skipped})` : x.passed ? `ok (${x.ms} ms)` : `FAILED: ${short(x.error ?? "", 200)}`}`)].join("\n"), d);
    }
    if (!name) return fail("Name the tool to run (or all: true for the saved tests).");
    const r = await apiSend(deps, "POST", `/mcp-servers/${enc(id)}/test`, { tool: name, input: input ?? {}, ...(ref ? { ref } : {}), confirm: confirm === true });
    if (!r.ok) return r.status === 404 ? fail(r.error) : apiError(r, `Running ${name}`);
    const d = r.data as { ok: boolean; text: string; error?: string; ms: number; status?: number; request?: { method: string; url: string }; skipped?: string };
    return ok([
      d.skipped ? `Not sent: ${d.skipped}` : d.ok ? `ok in ${d.ms} ms${d.status ? ` (HTTP ${d.status})` : ""}` : `failed in ${d.ms} ms: ${d.error}`,
      ...(d.request ? [`request: ${d.request.method} ${d.request.url}`] : []),
      ...(d.ok && !d.skipped ? [short(d.text, 4000)] : []),
    ].join("\n"), d);
  });

  tool("connectors", "polpo_mcp_server_publish", {
    title: "Publish a hosted server",
    description: "Freeze the draft as a new semver version (bump suggested from the changes, or major | minor | patch, or an explicit version). Saved tests run first (as the server's suite: HTTP mocked). "
      + "The first version is deployed at once and becomes a connector (Polpo may use it; grant agents in Connectors). Later ones go live with deploy: true or polpo_mcp_server_deploy. "
      + "When the saved tests are required (polpo_target_suite_save gate.required) the deploy runs them on the version first: a failure leaves it published, not deployed (deployBlocked); override_reason deploys anyway.",
    inputSchema: {
      id: z.string().describe("The hosted server's id (polpo_mcp_servers_list)"),
      bump: z.enum(["major", "minor", "patch"]).optional().describe("Default: suggested from the changes"),
      version: z.string().optional().describe("An explicit semver instead of a bump"),
      note: z.string().optional().describe("What changed (shown in the history)"),
      deploy: z.boolean().optional().describe("Also deploy it to production"),
      force: z.boolean().optional().describe("Publish even when saved tests fail and the server blocks on failures"),
      override_reason: z.string().min(3).max(1000).optional().describe("With deploy: deploy even though the required suite fails; the reason is recorded in the deploy history"),
    },
    outputSchema: {
      version: z.string(), deployed: z.object({ to: z.string(), action: z.string() }).passthrough().optional(), tests: z.object({ passed: z.number(), failed: z.number(), skipped: z.number() }).passthrough().optional(),
      deployBlocked: z.object({ reason: z.string(), runId: z.string().optional(), failures: z.array(z.string()) }).passthrough().optional(),
    },
    annotations: WRITE,
    scope: ADMIN,
  }, async ({ id, override_reason, ...rest }) => {
    const r = await apiSend(deps, "POST", `/mcp-servers/${enc(id)}/publish`, { ...rest, ...(override_reason ? { override: { reason: override_reason } } : {}) });
    if (!r.ok) return r.status === 404 ? notFound(id) : apiError(r, "Publishing");
    const d = r.data as { version: string; deployed?: { to: string; action: string; gate?: { decision: string } }; tests?: { passed: number; failed: number; skipped: number }; deployBlocked?: { reason: string; runId?: string; failures: string[] } };
    const deployed = d.deployed ? ` and deployed it (${d.deployed.action}${d.deployed.gate ? `, suite gate: ${d.deployed.gate.decision}` : ""})`
      : d.deployBlocked ? ` but NOT deployed — ${d.deployBlocked.reason}${d.deployBlocked.runId ? ` (run ${d.deployBlocked.runId}: polpo_target_suites kind mcp-server)` : ""}. Fix the tool (or the test) and publish again; an admin may deploy anyway with override_reason`
        : " (not deployed: polpo_mcp_server_deploy)";
    return ok(`Published ${id} ${d.version}${deployed}.`
      + `${d.tests ? ` Tests: ${d.tests.passed} passed, ${d.tests.failed} failed, ${d.tests.skipped} skipped.` : ""}`, d);
  });

  tool("connectors", "polpo_mcp_server_deploy", {
    title: "Deploy or roll back a hosted server",
    description: "Move a hosted server's production to a published version (version), or roll back (rollback: true: to the version deployed before, or to `version`). "
      + "Its connector serves that version from now on. When its saved tests are required (gate.required) they run on the version first and a failure blocks the deploy; "
      + "override_reason deploys anyway (recorded). Rollbacks are never gated.",
    inputSchema: {
      id: z.string().describe("The hosted server's id (polpo_mcp_servers_list)"),
      version: z.string().optional().describe("The version to deploy (with rollback: the version to go back to)"),
      rollback: z.boolean().optional().describe("Roll back instead"),
      note: z.string().optional().describe("What changed (shown in the history)"),
      override_reason: z.string().min(3).max(1000).optional().describe("Deploy even though the required suite (the saved tests) fails; the reason is recorded in the deploy history"),
    },
    outputSchema: { from: z.string().optional(), to: z.string(), action: z.string() },
    annotations: UPDATE,
    scope: ADMIN,
  }, async ({ id, version, rollback, note, override_reason }) => {
    if (!rollback && !version) return fail("Give the version to deploy, or rollback: true.");
    const r = rollback
      ? await apiSend(deps, "POST", `/mcp-servers/${enc(id)}/rollback`, { ...(version ? { to: version } : {}), ...(note ? { note } : {}) })
      : await apiSend(deps, "POST", `/mcp-servers/${enc(id)}/deploy`, { version, ...(note ? { note } : {}), ...(override_reason ? { override: { reason: override_reason } } : {}) });
    if (!r.ok) {
      if (r.status === 404) return fail(r.error);
      if (r.code === "GATE_BLOCKED") return fail(`${r.error}. ${id}@${version} was NOT deployed: production is unchanged. Fix the tool (or the test) and publish again; an admin may deploy anyway with override_reason.`);
      return apiError(r, rollback ? "Rolling back" : "Deploying");
    }
    const d = r.data as { from?: string; to: string; action: string; gate?: { decision: string; reason?: string } };
    return ok(`${id}: production ${d.from ?? "∅"} → ${d.to} (${d.action}${d.gate ? `, suite gate: ${d.gate.decision}${d.gate.reason ? ` — ${d.gate.reason}` : ""}` : ""}).`, d);
  });

  tool("connectors", "polpo_mcp_server_logs", {
    title: "Hosted server call log",
    description: "Latest calls (tool, source: private / public / test / approval, version, ok, HTTP status, time, error, caller IP for public calls) and the calls waiting for approval.",
    inputSchema: { id: z.string().describe("The hosted server's id (polpo_mcp_servers_list)"), limit: z.number().int().min(1).max(500).optional().describe("How many calls (default 30)") },
    outputSchema: { logs: z.array(z.object({ at: z.string(), tool: z.string(), source: z.string(), ok: z.boolean() }).passthrough()), pending: z.array(z.any()) },
    annotations: READ,
  }, async ({ id, limit }) => {
    const [l, p] = await Promise.all([apiGet(deps, `/mcp-servers/${enc(id)}/logs?limit=${limit ?? 30}`), apiGet(deps, `/mcp-servers/${enc(id)}/pending`)]);
    if (!l.ok) return l.status === 404 ? notFound(id) : apiError(l, "Reading the log");
    const logs = (l.data as { logs: Array<{ at: string; tool: string; source: string; ok: boolean; ms: number; status?: number; error?: string; ip?: string; version?: string }> }).logs;
    const pending = p.ok ? (p.data as { calls: Array<{ id: string; tool: string; status: string; requestedAt: string; approvalId?: string; result?: { ok: boolean; error?: string } }> }).calls : [];
    return ok([
      ...logs.map((x) => `- ${x.at} ${x.tool} [${x.source}${x.version ? ` v${x.version}` : ""}] ${x.ok ? "ok" : `failed: ${short(x.error ?? "", 120)}`} ${x.ms} ms${x.status ? ` HTTP ${x.status}` : ""}${x.ip ? ` from ${x.ip}` : ""}`),
      ...(pending.length ? ["approval calls:", ...pending.slice(0, 20).map((x) => `- ${x.requestedAt} ${x.tool}: ${x.status}${x.approvalId ? ` (approval ${x.approvalId})` : ""}${x.result && !x.result.ok ? ` — ${short(x.result.error ?? "", 120)}` : ""}`)] : []),
    ].join("\n") || "No calls yet.", { logs, pending });
  });

  tool("connectors", "polpo_mcp_server_delete", {
    title: "Delete a hosted server",
    description: "Delete a hosted server with its versions, logs and the connector it became (agents lose its tools).",
    inputSchema: { id: z.string().describe("The hosted server's id (polpo_mcp_servers_list)"), confirm: confirmParam("delete the server and its connector") },
    outputSchema: { removed: z.boolean() },
    annotations: DESTRUCTIVE,
    scope: ADMIN,
  }, async ({ id, confirm }) => {
    if (confirm !== true) return fail(`Deleting ${id} removes its versions and its connector: ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "DELETE", `/mcp-servers/${enc(id)}`);
    if (!r.ok) return r.status === 404 ? notFound(id) : apiError(r, "Deleting");
    return ok(`Deleted ${id} and its connector.`, { removed: true });
  });
}
