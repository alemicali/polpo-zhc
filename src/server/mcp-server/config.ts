/**
 * The instance's setup: settings, branding (with the logo), providers and models. Reads need
 * polpo:read, changes polpo:admin. Provider API keys never pass through here: the person enters
 * them in the dashboard, and the tools give the link.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { EGRESS_PROXY_NAME, EGRESS_PROXY_URL } from "@polpo-ai/core";
import { isPrivateAddress } from "../oauth.js";
import {
  BAD_CURSOR, READ, UPDATE, apiError, apiGet, apiSend, cursorParam, fail, limitParam, ok, page, pageOutput, qs, short,
  type McpDeps, type Register, type ResolveHost,
} from "./kit.js";

/** Largest logo accepted (the dashboard's upload limit). */
export const MAX_LOGO_BYTES = 4 * 1024 * 1024;
const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** The image type from the first bytes (what the file is, whatever it claims). */
export function sniffImage(bytes: Uint8Array): string | undefined {
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return undefined;
}

const defaultResolve: ResolveHost = async (hostname) => (await lookup(hostname, { all: true })).map((a) => a.address);

/**
 * Fetch an image from a public URL: https only, never an address inside the server's network
 * (checked again at every redirect), at most MAX_LOGO_BYTES, and a real PNG, JPEG, WebP or GIF.
 */
export async function fetchPublicImage(deps: McpDeps, url: string): Promise<{ ok: true; bytes: Uint8Array; type: string } | { ok: false; error: string }> {
  const doFetch = deps.fetch ?? fetch;
  const resolve = deps.resolveHost ?? defaultResolve;
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    let u: URL;
    try { u = new URL(current); } catch { return { ok: false, error: `${current} is not a valid URL` }; }
    if (u.protocol !== "https:" && !(deps.allowPrivateFetch && u.protocol === "http:")) return { ok: false, error: "The logo URL must be https" };
    if (!deps.allowPrivateFetch) {
      const host = u.hostname.replace(/^\[|\]$/g, "");
      const addresses = isIP(host) ? [host] : await resolve(host).catch(() => [] as string[]);
      if (addresses.length === 0) return { ok: false, error: `Cannot resolve ${host}` };
      if (addresses.some(isPrivateAddress)) return { ok: false, error: `${host} is a private or local address: only public URLs are fetched` };
    }
    let res: Response;
    try {
      res = await doFetch(u, { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { accept: LOGO_TYPES.join(", ") } });
    } catch (err) {
      return { ok: false, error: `Could not fetch ${u.host}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, u).toString();
      continue;
    }
    if (!res.ok || !res.body) return { ok: false, error: `${u.host} answered HTTP ${res.status}` };
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_LOGO_BYTES) return { ok: false, error: `The image is ${Math.round(declared / 1024)} KB: the limit is ${MAX_LOGO_BYTES / 1024 / 1024} MB` };
    // read at most the limit, whatever the headers say
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_LOGO_BYTES) { void reader.cancel(); return { ok: false, error: `The image is larger than ${MAX_LOGO_BYTES / 1024 / 1024} MB` }; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
    const type = sniffImage(bytes);
    if (!type) return { ok: false, error: "The URL does not point to a PNG, JPEG, WebP or GIF image" };
    return { ok: true, bytes, type };
  }
  return { ok: false, error: "Too many redirects" };
}

const settingsView = z.object({
  orchestratorModel: z.unknown().optional(), imageModel: z.string().optional(), reasoning: z.string().optional(),
}).passthrough();

type Settings = Record<string, unknown> & {
  orchestratorModel?: string | { primary?: string; fallbacks?: string[] }; imageModel?: string; reasoning?: string;
  branding?: { productName?: string; tagline?: string; logoUrl?: string };
  notifications?: { channels?: Record<string, { type?: string }>; rules?: Array<{ id?: string; name?: string; events?: string[]; channels?: string[] }> };
  approvalGates?: Array<{ id?: string; name?: string; hook?: string; handler?: string }>;
};

/** The settings people choose, without secrets or internals. */
function publicSettings(s: Settings): Record<string, unknown> {
  const keys = ["orchestratorModel", "imageModel", "reasoning", "maxRetries", "maxConcurrency", "taskTimeout", "enableScheduler",
    "defaultQualityThreshold", "voiceReplies", "maxFixAttempts", "logRetentionDays", "storage", "mcp", "egressProxies", "tailscale"];
  return Object.fromEntries(keys.filter((k) => s[k] !== undefined).map((k) => [k, k === "egressProxies" ? maskProxies(s[k]) : s[k]]));
}

/** Egress proxies without the credentials a URL may carry (user:password@). */
export function maskProxies(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, String(v).replace(/\/\/[^@/\s]*@/, "//•••@")]));
}

const modelSpec = z.union([
  z.string().min(3).describe("provider:model, e.g. anthropic:claude-opus-5-5"),
  z.object({ primary: z.string().min(3).describe("provider:model"), fallbacks: z.array(z.string().min(3)).optional().describe("Models to try when the primary fails, in order") }),
]);

/** Model specs not in the catalog (provider:id), or [] when all are known. */
async function unknownModels(deps: McpDeps, specs: string[]): Promise<string[]> {
  if (specs.length === 0) return [];
  const r = await apiGet(deps, "/providers/models");
  if (!r.ok || !Array.isArray(r.data)) return [];
  const known = new Set((r.data as Array<{ id: string; provider: string }>).map((m) => `${m.provider}:${m.id}`));
  return specs.filter((s) => !known.has(s));
}

async function brandingNow(deps: McpDeps): Promise<Record<string, unknown>> {
  const r = await apiGet(deps, "/config/branding");
  return r.ok && r.data && typeof r.data === "object" ? r.data as Record<string, unknown> : {};
}

const brandingOutput = { productName: z.string().optional(), tagline: z.string().optional(), logoUrl: z.string().optional() };

export function registerConfigTools(tool: Register, deps: McpDeps): void {
  const dashboard = (path: string) => deps.publicUrl ? `${deps.publicUrl.replace(/\/+$/, "")}${path}` : path;

  tool("config", "polpo_config_get", {
    title: "Get the configuration",
    description: "The instance's settings (Polpo's model and fallbacks, image model, reasoning, retries, concurrency, scheduler…), branding, "
      + "and a summary of notification channels, notification rules and approval gates. Secrets are never included.",
    inputSchema: {},
    outputSchema: {
      project: z.string().optional(), settings: settingsView, branding: z.object(brandingOutput).optional(),
      channels: z.array(z.object({ name: z.string(), type: z.string().optional() })),
      rules: z.array(z.object({ id: z.string().optional(), name: z.string().optional(), events: z.array(z.string()).optional(), channels: z.array(z.string()).optional() })),
      gates: z.array(z.object({ id: z.string().optional(), name: z.string().optional(), hook: z.string().optional(), handler: z.string().optional() })),
    },
    annotations: READ,
  }, async () => {
    const r = await apiGet(deps, "/config");
    if (!r.ok) return apiError(r, "Reading the configuration");
    const cfg = r.data as { project?: string; settings?: Settings };
    const s = cfg.settings ?? {};
    const channels = Object.entries(s.notifications?.channels ?? {}).map(([name, c]) => ({ name, ...(c?.type ? { type: c.type } : {}) }));
    const rules = (s.notifications?.rules ?? []).map((x) => ({ id: x.id, name: x.name, events: x.events, channels: x.channels }));
    const gates = (s.approvalGates ?? []).map((g) => ({ id: g.id, name: g.name, hook: g.hook, handler: g.handler }));
    const settings = publicSettings(s);
    const om = s.orchestratorModel;
    const text = [
      `project: ${cfg.project ?? "-"}`,
      `Polpo's model: ${typeof om === "string" ? om : om?.primary ?? "default"}${typeof om === "object" && om?.fallbacks?.length ? ` (fallbacks: ${om.fallbacks.join(", ")})` : ""}`,
      `image model: ${s.imageModel ?? "default"} · reasoning: ${s.reasoning ?? "default"}`,
      ...Object.entries(settings).filter(([k]) => !["orchestratorModel", "imageModel", "reasoning"].includes(k)).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`),
      `branding: ${s.branding?.productName ?? "Polpo"}${s.branding?.tagline ? ` — ${s.branding.tagline}` : ""}${s.branding?.logoUrl ? " (custom logo)" : ""}`,
      `channels: ${channels.map((c) => `${c.name}${c.type ? ` (${c.type})` : ""}`).join(", ") || "none"}`,
      `rules: ${rules.map((x) => x.name ?? x.id).join(", ") || "none"} · approval gates: ${gates.map((g) => g.name ?? g.id).join(", ") || "none"}`,
    ].join("\n");
    return ok(text, { ...(cfg.project ? { project: cfg.project } : {}), settings, ...(s.branding ? { branding: s.branding } : {}), channels, rules, gates });
  });

  tool("config", "polpo_config_update", {
    title: "Update settings",
    description: "Change Polpo's own model (and fallbacks), the image model, the reasoning level or the egress proxies agents' browsers can use "
      + "(agent.browserEgress picks one). Only the fields given change; models are checked against the catalog (polpo_models_list). "
      + "The result lists what changed. Needs the admin scope.",
    inputSchema: {
      orchestrator_model: modelSpec.optional().describe("Polpo's model: provider:model, or { primary, fallbacks }"),
      image_model: z.string().nullable().optional().describe("The model for images (provider:model), or null for the default"),
      reasoning: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional().describe("How much Polpo reasons before answering"),
      egress_proxies: z.record(z.string().regex(EGRESS_PROXY_NAME, "letters, digits, - and _"), z.string().regex(EGRESS_PROXY_URL, "a proxy URL like socks5://100.101.55.7:1080"))
        .nullable().optional().describe("Named proxies for agents' browsers, e.g. { home: 'socks5://100.101.55.7:1080' }: replaces them all; null removes them"),
      allow_unlisted: z.boolean().optional().describe("true to accept a model that is not in the catalog (e.g. a gateway's own model)"),
    },
    outputSchema: { changed: z.array(z.string()), settings: settingsView },
    annotations: UPDATE,
  }, async ({ orchestrator_model, image_model, reasoning, egress_proxies, allow_unlisted }) => {
    const body: Record<string, unknown> = {};
    if (orchestrator_model !== undefined) body.orchestratorModel = orchestrator_model;
    if (image_model !== undefined) body.imageModel = image_model;
    if (reasoning !== undefined) body.reasoning = reasoning;
    if (egress_proxies !== undefined) body.egressProxies = egress_proxies;
    if (Object.keys(body).length === 0) return fail("Nothing to change: give orchestrator_model, image_model, reasoning or egress_proxies.");
    if (!allow_unlisted) {
      const specs = [
        ...(typeof orchestrator_model === "string" ? [orchestrator_model] : orchestrator_model ? [orchestrator_model.primary, ...(orchestrator_model.fallbacks ?? [])] : []),
        ...(image_model ? [image_model] : []),
      ];
      const unknown = await unknownModels(deps, specs);
      if (unknown.length) return fail(`Not in the model catalog: ${unknown.join(", ")}. Find the right provider:model with polpo_models_list, or pass allow_unlisted: true for a gateway's own model.`);
    }
    const before = await apiGet(deps, "/config");
    const prev = ((before.ok ? (before.data as { settings?: Settings }).settings : undefined) ?? {}) as Settings;
    const r = await apiSend(deps, "PATCH", "/config/settings", body);
    if (!r.ok) return apiError(r, "Updating the settings");
    const next = ((r.data as { settings?: Settings })?.settings ?? {}) as Settings;
    const changed = ["orchestratorModel", "imageModel", "reasoning", "egressProxies"].filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
    const settings = publicSettings(next);
    const show = (k: string, v: unknown) => JSON.stringify((k === "egressProxies" ? maskProxies(v) : v) ?? "default");
    return ok(changed.length
      ? `Changed ${changed.map((k) => `${k}: ${show(k, prev[k])} → ${show(k, next[k])}`).join("; ")}.`
      : "Nothing changed (the values were the same).", { changed, settings });
  });

  tool("config", "polpo_branding_get", {
    title: "Get the branding",
    description: "The instance's branding everyone sees in the dashboard: product name, tagline and logo.",
    inputSchema: {},
    outputSchema: { ...brandingOutput, logo_link: z.string().optional() },
    annotations: READ,
  }, async () => {
    const b = await brandingNow(deps) as { productName?: string; tagline?: string; logoUrl?: string };
    const logoLink = b.logoUrl ? (b.logoUrl.startsWith("/") ? dashboard(b.logoUrl) : b.logoUrl) : undefined;
    return ok(`${b.productName ?? "Polpo (default name)"}${b.tagline ? ` — ${b.tagline}` : ""}\nlogo: ${logoLink ?? "default"}`, { ...b, ...(logoLink ? { logo_link: logoLink } : {}) });
  });

  tool("config", "polpo_branding_update", {
    title: "Update the branding",
    description: "Change the product name, the tagline or the logo everyone sees in the dashboard. Only the fields given change; an empty string "
      + "restores the default. The logo comes from a public https URL (fetched by the server), a file of the instance, or base64 data; "
      + "PNG, JPEG, WebP or GIF up to 4 MB. Needs the admin scope.",
    inputSchema: {
      product_name: z.string().max(80).optional().describe("The product name in the navigation ('' for the default)"),
      tagline: z.string().max(120).optional().describe("The short label under the name ('' for none)"),
      logo: z.union([
        z.object({ url: z.string().url().describe("A public https URL of the image") }),
        z.object({ path: z.string().min(1).describe("A file of the instance (polpo_files_search), e.g. assets/logo.png") }),
        z.object({ base64: z.string().min(1).describe("The image's bytes in base64"), mime_type: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]).describe("Its type") }),
      ]).optional().describe("The new logo: { url } or { path } or { base64, mime_type }"),
      remove_logo: z.boolean().optional().describe("true to go back to the default logo"),
    },
    outputSchema: { changed: z.array(z.string()), branding: z.object({ ...brandingOutput }) },
    annotations: UPDATE,
  }, async ({ product_name, tagline, logo, remove_logo }) => {
    if (product_name === undefined && tagline === undefined && !logo && !remove_logo) return fail("Nothing to change: give product_name, tagline, logo or remove_logo.");
    if (logo && remove_logo) return fail("Give either logo or remove_logo, not both.");
    const changed: string[] = [];
    // the logo first: if it cannot be read, nothing changes
    let image: { bytes: Uint8Array; type: string } | undefined;
    if (logo && "url" in logo) {
      const got = await fetchPublicImage(deps, logo.url);
      if (!got.ok) return fail(`The logo was not changed: ${got.error}. Give another URL, a file of the instance (logo.path) or base64 data.`);
      image = got;
    } else if (logo && "path" in logo) {
      const res = await deps.api("GET", `/api/v1/files/read${qs({ path: logo.path })}`);
      if (res.status >= 400) return fail(`The logo was not changed: cannot read ${logo.path} (HTTP ${res.status}). Find the file with polpo_files_search.`);
      const bytes = res.bytes ?? new Uint8Array();
      if (bytes.byteLength > MAX_LOGO_BYTES) return fail(`The logo was not changed: ${logo.path} is larger than 4 MB.`);
      const type = sniffImage(bytes);
      if (!type) return fail(`The logo was not changed: ${logo.path} is not a PNG, JPEG, WebP or GIF image.`);
      image = { bytes, type };
    } else if (logo && "base64" in logo) {
      const bytes = new Uint8Array(Buffer.from(logo.base64.replace(/^data:[^,]*,/, ""), "base64"));
      if (bytes.byteLength === 0) return fail("The logo was not changed: the base64 data is empty or invalid.");
      if (bytes.byteLength > MAX_LOGO_BYTES) return fail("The logo was not changed: the image is larger than 4 MB.");
      const type = sniffImage(bytes);
      if (!type) return fail("The logo was not changed: the data is not a PNG, JPEG, WebP or GIF image.");
      if (type !== logo.mime_type) return fail(`The logo was not changed: the data is ${type}, not ${logo.mime_type}. Pass mime_type ${type}.`);
      image = { bytes, type };
    }
    if (image) {
      const up = await apiSend(deps, "POST", "/config/instance-logo", new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: image.type }));
      if (!up.ok) return apiError(up, "Uploading the logo");
      changed.push("logo");
    } else if (remove_logo) {
      const del = await apiSend(deps, "DELETE", "/config/instance-logo");
      if (!del.ok) return apiError(del, "Removing the logo");
      changed.push("logo");
    }
    const text: Record<string, string> = {};
    if (product_name !== undefined) text.productName = product_name.trim();
    if (tagline !== undefined) text.tagline = tagline.trim();
    if (Object.keys(text).length) {
      const before = await brandingNow(deps);
      const r = await apiSend(deps, "PATCH", "/config/settings", { branding: text });
      if (!r.ok) return apiError(r, "Updating the branding", changed.length ? "The logo was changed already." : undefined);
      for (const [k, v] of Object.entries(text)) if ((before[k] ?? "") !== v) changed.push(k);
    }
    const now = await brandingNow(deps) as { productName?: string; tagline?: string; logoUrl?: string };
    return ok(changed.length ? `Branding updated: ${changed.join(", ")}. Now: ${now.productName ?? "Polpo"}${now.tagline ? ` — ${now.tagline}` : ""}${now.logoUrl ? " with a custom logo" : ""}.` : "Nothing changed (the values were the same).",
      { changed, branding: now });
  });

  const providerItem = z.object({ name: z.string(), configured: z.boolean(), source: z.string().optional(), env_var: z.string().optional() });

  tool("config", "polpo_providers_list", {
    title: "List model providers",
    description: "The LLM providers (Anthropic, OpenAI, Google, OpenRouter…) and whether each has a key or sign-in. "
      + "API keys are never sent through this connector: to add or change one, give the person setup_url (the dashboard's Providers page).",
    inputSchema: {
      configured: z.boolean().optional().describe("true: only providers with a key; false: only those without"),
      limit: limitParam(50, 200),
      cursor: cursorParam(),
    },
    outputSchema: { ...pageOutput(providerItem), setup_url: z.string() },
    annotations: READ,
  }, async ({ configured, limit, cursor }) => {
    const r = await apiGet(deps, "/providers");
    if (!r.ok) return apiError(r, "Listing providers");
    const all = ((r.data as Array<{ name: string; hasKey: boolean; source?: string; envVar?: string }>) ?? [])
      .map((p) => ({ name: p.name, configured: p.hasKey, ...(p.source ? { source: p.source } : {}), ...(p.envVar ? { env_var: p.envVar } : {}) }))
      .filter((p) => configured === undefined || p.configured === configured)
      .sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
    const p = page(all, limit ?? 50, cursor);
    if (!p) return fail(BAD_CURSOR);
    const setup = dashboard("/config?section=providers");
    return ok(`${p.items.map((x) => `- ${x.name}: ${x.configured ? `configured (${x.source})` : "no key"}`).join("\n") || "No providers match."}`
      + `${p.next_cursor ? `\n(more: cursor ${p.next_cursor})` : ""}\nTo add or change a key: ${setup}`, { ...p, setup_url: setup });
  });

  const modelItem = z.object({ spec: z.string(), name: z.string().optional(), provider: z.string(), configured: z.boolean().optional(), context_window: z.number().optional(), reasoning: z.boolean().optional() }).passthrough();

  tool("config", "polpo_models_list", {
    title: "List models",
    description: "Models in the catalog, cheapest first: spec (provider:model, what settings and agents take), name, context window, "
      + "whether it reasons and whether its provider is configured. Filter by provider or words.",
    inputSchema: {
      provider: z.string().optional().describe("Only this provider, e.g. anthropic"),
      text: z.string().optional().describe("Words in the model's id or name"),
      configured: z.boolean().optional().describe("true: only models whose provider has a key"),
      limit: limitParam(30, 200),
      cursor: cursorParam(),
    },
    outputSchema: pageOutput(modelItem),
    annotations: READ,
  }, async ({ provider, text, configured, limit, cursor }) => {
    const [r, providers] = await Promise.all([apiGet(deps, `/providers/models${qs({ provider })}`), configured !== undefined ? apiGet(deps, "/providers") : Promise.resolve(null)]);
    if (!r.ok) return apiError(r, "Listing models");
    const keyed = providers?.ok ? new Set((providers.data as Array<{ name: string; hasKey: boolean }>).filter((p) => p.hasKey).map((p) => p.name)) : undefined;
    const words = (text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const all = ((r.data as Array<{ id: string; name?: string; provider: string; contextWindow?: number; reasoning?: boolean; configured?: boolean; cost?: { input?: number; output?: number } }>) ?? [])
      .map((m) => ({
        spec: `${m.provider}:${m.id}`, ...(m.name ? { name: m.name } : {}), provider: m.provider,
        ...(m.configured !== undefined ? { configured: m.configured } : keyed ? { configured: keyed.has(m.provider) } : {}),
        ...(m.contextWindow ? { context_window: m.contextWindow } : {}), ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
        ...(m.cost ? { cost: m.cost } : {}),
      }))
      .filter((m) => words.every((w) => `${m.spec} ${m.name ?? ""}`.toLowerCase().includes(w)) && (configured === undefined || m.configured === configured));
    const p = page(all, limit ?? 30, cursor);
    if (!p) return fail(BAD_CURSOR);
    return ok(`${p.items.map((m) => `- ${m.spec}${m.name ? ` (${short(m.name, 60)})` : ""}${m.context_window ? `, ${Math.round(m.context_window / 1000)}k ctx` : ""}${m.reasoning ? ", reasoning" : ""}${m.configured === false ? ", no key" : ""}`).join("\n") || "No models match."}`
      + `${p.next_cursor ? `\n(${p.total} in all; more: cursor ${p.next_cursor})` : ""}`, p);
  });
}
