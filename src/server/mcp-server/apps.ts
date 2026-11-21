/**
 * Apps registered on the instance (their services, deployments and domains): list, start, stop,
 * restart. Browser profiles (the signed-in browsers agents use): list, clear. Registering an app and
 * signing a profile in to a site happen in the dashboard.
 */
import { z } from "zod";
import {
  BAD_CURSOR, DESTRUCTIVE, READ, apiError, apiGet, apiSend, confirmParam, cursorParam, dashboardLink, enc, fail, formatBytes, limitParam,
  looseObject, ok, page, pageOutput, short,
  type McpDeps, type Register,
} from "./kit.js";

type Service = { id: string; name: string; kind: string; port?: number; publicUrl?: string };
type App = {
  id: string; name: string; description?: string; tags?: string[]; services: Service[]; deployments: Array<{ id: string; name: string; environment: string; url?: string }>;
  domains: Array<{ hostname: string }>; runtime?: Array<{ kind: string; resourceId: string; status: string; error?: string }>;
};

const appItem = z.object({ id: z.string(), name: z.string(), description: z.string().optional(), services: z.array(looseObject), running: z.number().int() }).passthrough();
const view = (a: App) => ({
  id: a.id, name: a.name, ...(a.description ? { description: a.description } : {}), ...(a.tags?.length ? { tags: a.tags } : {}),
  services: a.services.map((s) => {
    const rt = a.runtime?.find((r) => r.kind === "service" && r.resourceId === s.id);
    return { id: s.id, name: s.name, kind: s.kind, status: rt?.status ?? "stopped", ...(s.publicUrl ? { url: s.publicUrl } : s.port ? { url: `http://127.0.0.1:${s.port}/` } : {}), ...(rt?.error ? { error: rt.error } : {}) };
  }),
  deployments: a.deployments.map((d) => ({ id: d.id, name: d.name, environment: d.environment, ...(d.url ? { url: d.url } : {}) })),
  domains: a.domains.map((d) => d.hostname),
  running: (a.runtime ?? []).filter((r) => r.kind === "service" && r.status === "running").length,
});

const notFound = (id: string) => fail(`There is no app ${id}. List them with polpo_apps_list.`);

export function registerAppTools(tool: Register, deps: McpDeps): void {
  tool("apps", "polpo_apps_list", {
    title: "List apps",
    description: "Apps registered on the instance: their services (and whether each runs, at which URL), deployments and domains. With id, one app.",
    inputSchema: { id: z.string().optional().describe("One app"), limit: limitParam(30, 100), cursor: cursorParam() },
    outputSchema: pageOutput(appItem),
    annotations: READ,
  }, async ({ id, limit, cursor }) => {
    const r = id ? await apiGet(deps, `/apps/${enc(id)}`) : await apiGet(deps, "/apps");
    if (!r.ok) return id && r.status === 404 ? notFound(id) : apiError(r, "Listing apps");
    const all = (id ? [r.data as App] : (r.data as App[]) ?? []).map(view);
    const p = page(all, limit ?? 30, cursor);
    if (!p) return fail(BAD_CURSOR);
    return ok(`${p.items.map((a) => `- ${a.id} "${a.name}": ${a.services.map((s) => `${s.name} [${s.status}]${s.url ? ` ${s.url}` : ""}`).join(", ") || "no services"}${a.domains.length ? ` · ${a.domains.join(", ")}` : ""}`).join("\n") || `No apps (register one in the dashboard: ${dashboardLink(deps, "/apps")}).`}`
      + `${p.next_cursor ? `\n(more: cursor ${p.next_cursor})` : ""}`, p);
  });

  tool("apps", "polpo_app_control", {
    title: "Start, stop or restart an app",
    description: "Start an app's services, or stop or restart them (stop and restart interrupt whoever uses it: they need confirm: true).",
    inputSchema: {
      id: z.string().min(1).describe("The app's id"),
      action: z.enum(["start", "stop", "restart"]).describe("What to do"),
      confirm: confirmParam("stop or restart it"),
    },
    outputSchema: { app: appItem, errors: z.array(z.string()) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ id, action, confirm }) => {
    const cur = await apiGet(deps, `/apps/${enc(id)}`);
    if (!cur.ok) return cur.status === 404 ? notFound(id) : apiError(cur, `Reading app ${id}`);
    if (action !== "start" && confirm !== true) return fail(`${action === "stop" ? "Stopping" : "Restarting"} "${(cur.data as App).name}" interrupts its services: ask the person, then call again with confirm: true.`);
    const res = await deps.api("POST", `/api/v1/apps/${enc(id)}/lifecycle/${action}`);
    const body = res.body as { ok?: boolean; error?: string; data?: { errors?: string[] } } | null;
    if (res.status >= 400) return fail(`${action} of ${id} failed (HTTP ${res.status}): ${body?.error ?? "unknown error"}.`);
    const after = await apiGet(deps, `/apps/${enc(id)}`);
    const app = view((after.ok ? after.data : cur.data) as App);
    const errors = body?.data?.errors ?? [];
    return ok(`${action === "start" ? "Started" : action === "stop" ? "Stopped" : "Restarted"} ${app.name}: ${app.services.map((s) => `${s.name} [${s.status}]`).join(", ") || "no services"}.${errors.length ? ` Errors: ${errors.join("; ")}` : ""}`,
      { app, errors });
  });

  const profileItem = z.object({ name: z.string(), agents: z.array(z.string()), exists: z.boolean(), signed_in: z.boolean(), size: z.string().optional(), last_used_at: z.string().optional() });

  tool("apps", "polpo_browser_profiles_list", {
    title: "List browser profiles",
    description: "The browser profiles agents use (cookies and sign-ins kept between runs): which agents use each, whether some site is signed in, size, last use. "
      + "Signing a profile in to a site happens in the dashboard's live browser.",
    inputSchema: {},
    outputSchema: { items: z.array(profileItem), setup_url: z.string() },
    annotations: READ,
  }, async () => {
    const r = await apiGet(deps, "/browser-profiles");
    if (!r.ok) return apiError(r, "Listing browser profiles");
    const items = ((r.data as { profiles?: Array<{ name: string; agents: string[]; exists: boolean; hasCookies: boolean; sizeBytes: number; lastUsedAt?: string }> })?.profiles ?? [])
      .map((p) => ({ name: p.name, agents: p.agents, exists: p.exists, signed_in: p.hasCookies, ...(p.exists ? { size: formatBytes(p.sizeBytes) } : {}), ...(p.lastUsedAt ? { last_used_at: p.lastUsedAt } : {}) }));
    const setup = dashboardLink(deps, "/browser");
    return ok(`${items.map((p) => `- ${p.name}: ${p.agents.join(", ") || "no agents"}${p.signed_in ? ", signed in somewhere" : ""}${p.size ? `, ${p.size}` : ""}${p.last_used_at ? `, last used ${short(p.last_used_at, 16)}` : ""}`).join("\n") || "No browser profiles."}\nSign in to sites: ${setup}`,
      { items, setup_url: setup });
  });

  tool("apps", "polpo_browser_profile_clear", {
    title: "Clear a browser profile",
    description: "Delete a browser profile's data (cookies, sign-ins, history): its agents start signed out. It cannot be undone. Needs confirm: true.",
    inputSchema: { name: z.string().min(1).describe("The profile's name (polpo_browser_profiles_list)"), confirm: confirmParam("clear the profile") },
    outputSchema: { name: z.string(), cleared: z.boolean() },
    annotations: DESTRUCTIVE,
  }, async ({ name, confirm }) => {
    if (confirm !== true) return fail(`Clearing profile ${name} signs its agents out of every site: ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "DELETE", `/browser-profiles/${enc(name)}`);
    if (!r.ok) return apiError(r, `Clearing profile ${name}`);
    return ok(`Cleared browser profile ${name}.`, { name, cleared: true });
  });
}
