/**
 * The instance's setup: settings, branding (with the logo), providers and models. Reads need
 * polpo:read, changes polpo:admin. Provider API keys never pass through here: the person enters
 * them in the dashboard, and the tools give the link.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import {
  APPEARANCE_CASES, APPEARANCE_PALETTES, APPEARANCE_THEMES, APPEARANCE_TOKENS, APPEARANCE_TOKEN_NAMES, EGRESS_PROXY_NAME, EGRESS_PROXY_URL, parseAppearanceSettings,
  type AppearanceSettings,
} from "@polpo-ai/core";
import { isPrivateAddress } from "../oauth.js";
import {
  BAD_CURSOR, READ, TOOLSET_NAMES, UPDATE, dashboardLink, apiError, apiGet, apiSend, cursorParam, fail, limitParam, normalizeScopes, ok, page, pageOutput, qs, short,
  type McpDeps, type Register, type ResolveHost,
} from "./kit.js";
import { setupHandoff } from "./setup.js";
import { ORCHESTRATOR_NAME_MAX_LENGTH, orchestratorName } from "../../core/orchestrator-name.js";

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
  orchestratorModel: z.unknown().optional(), orchestratorName: z.string().optional(), imageModel: z.string().optional(), reasoning: z.string().optional(),
}).passthrough();

type Settings = Record<string, unknown> & {
  orchestratorModel?: string | { primary?: string; fallbacks?: string[] }; orchestratorName?: string; imageModel?: string; reasoning?: string;
  branding?: { productName?: string; tagline?: string; logoUrl?: string; logoDarkUrl?: string; logoFrame?: "box" | "none" };
  appearance?: AppearanceSettings;
  notifications?: { channels?: Record<string, { type?: string }>; rules?: Array<{ id?: string; name?: string; events?: string[]; channels?: string[] }> };
  approvalGates?: Array<{ id?: string; name?: string; hook?: string; handler?: string }>;
};

/** The settings people choose, without secrets or internals. */
function publicSettings(s: Settings): Record<string, unknown> {
  const keys = ["orchestratorName", "orchestratorModel", "imageModel", "reasoning", ...GENERAL_KEYS, "storage", "compaction", "mcp", "connectors", "egressProxies", "tailscale",
    "escalationPolicy", "sla", "appearance"];
  return Object.fromEntries(keys.filter((k) => s[k] !== undefined).map((k) => [k, k === "egressProxies" ? maskProxies(s[k]) : s[k]]));
}

/**
 * The general settings (Configuration → General) polpo_config_update changes, with the values
 * they take; PATCH /config/settings checks them again (UpdateSettingsSchema).
 */
export const GENERAL_KEYS = [
  "maxRetries", "logLevel", "maxConcurrency", "taskTimeout", "staleThreshold", "maxFixAttempts", "maxQuestionRounds", "maxResolutionAttempts",
  "maxAssessmentRetries", "defaultQualityThreshold", "autoCorrectExpectations", "enableScheduler", "enableVolatileTeams", "volatileCleanup",
  "logRetentionDays", "emailAllowedDomains", "voiceReplies", "defaultRetryPolicy",
] as const;

const count = (max: number) => z.number().int().min(0).max(max);
const generalInput = z.object({
  maxRetries: count(20).optional().describe("Retries of a failed task before it fails (default 3)"),
  logLevel: z.enum(["quiet", "normal", "verbose"]).optional(),
  maxConcurrency: z.number().int().min(1).max(1000).nullable().optional().describe("Most agents running at once; null: no limit"),
  taskTimeout: z.number().int().min(1000).nullable().optional().describe("Default timeout per task in ms; null: the default (30 min)"),
  staleThreshold: z.number().int().min(1000).nullable().optional().describe("Idle ms before an agent counts as stale; null: the default (5 min)"),
  maxFixAttempts: count(20).nullable().optional().describe("Fix attempts per review before a full retry (default 2)"),
  maxQuestionRounds: count(20).nullable().optional().describe("Auto-answered question rounds per task (default 2)"),
  maxResolutionAttempts: count(20).nullable().optional().describe("Deadlock resolution attempts per task (default 2)"),
  maxAssessmentRetries: count(20).nullable().optional().describe("Assessment retries when every reviewer fails (default 1)"),
  defaultQualityThreshold: z.number().min(1).max(5).nullable().optional().describe("Missions scoring below this (1–5) fail"),
  autoCorrectExpectations: z.boolean().nullable().optional(),
  enableScheduler: z.boolean().nullable().optional().describe("Run scheduled missions"),
  enableVolatileTeams: z.boolean().nullable().optional().describe("Missions may define their own temporary agents"),
  volatileCleanup: z.enum(["on_complete", "manual"]).nullable().optional(),
  logRetentionDays: z.number().int().min(0).max(3650).nullable().optional().describe("Days of event logs kept (0: forever)"),
  emailAllowedDomains: z.array(z.string().min(1).max(253)).nullable().optional().describe("Domains agents may email (e.g. ['example.com'])"),
  voiceReplies: z.enum(["off", "voice", "always"]).nullable().optional().describe("Polpo's own voice replies in chats"),
  defaultRetryPolicy: z.object({
    escalateAfter: count(20).optional(), fallbackAgent: z.string().min(1).optional(), escalateModel: z.string().min(3).optional(),
  }).strict().nullable().optional().describe("After escalateAfter failures, retry with fallbackAgent / escalateModel"),
}).strict();

const vaultRefInput = z.object({ owner: z.string().min(1).describe("The agent that owns the vault entry"), service: z.string().min(1).describe("The entry's service") })
  .describe("A vault entry (polpo_vault_list): the secret stays there, never passes through here");

/** Vault references that are not in the vault catalog (owner/service), or [] when all exist or the catalog is unavailable. */
async function missingVaultRefs(deps: McpDeps, refs: Array<{ owner: string; service: string }>): Promise<string[]> {
  if (refs.length === 0) return [];
  const r = await apiGet(deps, "/vault-catalog");
  if (!r.ok || !Array.isArray(r.data)) return [];
  const known = new Set((r.data as Array<{ owner: string; service: string }>).map((e) => `${e.owner}/${e.service}`));
  return refs.map((x) => `${x.owner}/${x.service}`).filter((k) => !known.has(k));
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

type Branding = { productName?: string; tagline?: string; logoUrl?: string; logoDarkUrl?: string; logoFrame?: "box" | "none" };

const brandingOutput = {
  productName: z.string().optional(), tagline: z.string().optional(), logoUrl: z.string().optional(), logoDarkUrl: z.string().optional(),
  logoFrame: z.enum(["box", "none"]).optional().describe("How the logo is shown: box (a tile, the default) or none (bare)"),
};

const tokenMapOutput = z.record(z.string(), z.union([z.string(), z.number()]));
const appearanceOutput = z.object({
  theme: z.enum(APPEARANCE_THEMES).optional(),
  palette: z.enum(APPEARANCE_PALETTES).optional(),
  custom: z.object({ enabled: z.boolean(), derive: z.boolean().optional(), light: tokenMapOutput.optional(), dark: tokenMapOutput.optional() }).passthrough().optional(),
}).passthrough();

const logoInput = z.union([
  z.object({ url: z.string().url().describe("A public https URL of the image") }),
  z.object({ path: z.string().min(1).describe("A file of the instance (polpo_files_search), e.g. assets/logo.png") }),
  z.object({ base64: z.string().min(1).describe("The image's bytes in base64"), mime_type: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]).describe("Its type") }),
]);

/** Every design token, each optional; null removes it (back to the palette's value). */
const tokensInput = z.object(Object.fromEntries(APPEARANCE_TOKEN_NAMES.map((name) => {
  const kind = APPEARANCE_TOKENS[name].kind;
  const value = kind === "radius" ? z.number().min(0).max(24)
    : kind === "weight" ? z.number().min(100).max(900)
    : kind === "case" ? z.enum(APPEARANCE_CASES)
    : z.string().min(1).max(240);
  const hint = ({
    color: "colour", font: "CSS font stack", radius: "px, 0–24", shadow: "box-shadow",
    size: "font size: rem 0.5–6 or px 8–96, e.g. 1.5rem", weight: "font weight 100–900, e.g. 600",
    tracking: "letter-spacing: em -0.1–0.3 or px -3–6, 0 or normal, e.g. 0.06em", case: "label case",
  } as const)[kind];
  return [name, value.nullable().optional().describe(`${APPEARANCE_TOKENS[name].css} (${hint})`)];
}))).strict();

/** A logo from a URL, a file of the instance or base64: a real PNG, JPEG, WebP or GIF up to 4 MB. */
async function readLogo(deps: McpDeps, logo: z.infer<typeof logoInput>): Promise<{ ok: true; image: { bytes: Uint8Array; type: string } } | { ok: false; error: string }> {
  if ("url" in logo) {
    const got = await fetchPublicImage(deps, logo.url);
    return got.ok ? { ok: true, image: got } : { ok: false, error: `could not be read: ${got.error}. Give another URL, a file of the instance (path) or base64 data` };
  }
  if ("path" in logo) {
    const res = await deps.api("GET", `/api/v1/files/read${qs({ path: logo.path })}`);
    if (res.status >= 400) return { ok: false, error: `could not be read: ${logo.path} (HTTP ${res.status}). Find the file with polpo_files_search` };
    const bytes = res.bytes ?? new Uint8Array();
    if (bytes.byteLength > MAX_LOGO_BYTES) return { ok: false, error: `is too large: ${logo.path} is larger than 4 MB` };
    const type = sniffImage(bytes);
    return type ? { ok: true, image: { bytes, type } } : { ok: false, error: `is not an image: ${logo.path} is not a PNG, JPEG, WebP or GIF` };
  }
  const bytes = new Uint8Array(Buffer.from(logo.base64.replace(/^data:[^,]*,/, ""), "base64"));
  if (bytes.byteLength === 0) return { ok: false, error: "is empty: the base64 data is empty or invalid" };
  if (bytes.byteLength > MAX_LOGO_BYTES) return { ok: false, error: "is too large: the image is larger than 4 MB" };
  const type = sniffImage(bytes);
  if (!type) return { ok: false, error: "is not an image: the data is not a PNG, JPEG, WebP or GIF" };
  if (type !== logo.mime_type) return { ok: false, error: `has the wrong type: the data is ${type}, not ${logo.mime_type}. Pass mime_type ${type}` };
  return { ok: true, image: { bytes, type } };
}

/** The instance's default look (the public route the dashboard reads). */
async function appearanceNow(deps: McpDeps): Promise<AppearanceSettings> {
  const r = await apiGet(deps, "/config/appearance");
  return r.ok && r.data && typeof r.data === "object" ? r.data as AppearanceSettings : {};
}

type TokensPatch = { enabled?: boolean; derive?: boolean; light?: Record<string, unknown>; dark?: Record<string, unknown>; replace?: boolean };

/** The appearance after a change: theme and palette set or removed (null), tokens merged (null removes one) or replaced. */
export function mergeAppearance(before: AppearanceSettings, change: { theme?: string | null; palette?: string | null; tokens?: TokensPatch }): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(before ?? {})) as Record<string, unknown> & { custom?: Record<string, unknown> };
  for (const key of ["theme", "palette"] as const) {
    if (change[key] === null) delete out[key];
    else if (change[key] !== undefined) out[key] = change[key];
  }
  const t = change.tokens;
  if (t) {
    const custom: Record<string, unknown> = { enabled: false, ...(out.custom ?? {}) };
    if (t.enabled !== undefined) custom.enabled = t.enabled;
    else if (t.light || t.dark) custom.enabled = true;
    if (t.derive === false) custom.derive = false;
    else if (t.derive === true) delete custom.derive;
    for (const mode of ["light", "dark"] as const) {
      const given = t[mode];
      if (!given) continue;
      const base: Record<string, unknown> = t.replace ? {} : { ...((custom[mode] as Record<string, unknown> | undefined) ?? {}) };
      for (const [k, v] of Object.entries(given)) {
        if (v === undefined) continue;
        if (v === null) delete base[k];
        else base[k] = v;
      }
      if (Object.keys(base).length) custom[mode] = base;
      else delete custom[mode];
    }
    out.custom = custom;
  }
  return out;
}

/** What changed between two appearances, as paths (appearance.theme, appearance.custom.light.primary…). */
export function appearanceChanges(before: AppearanceSettings, after: AppearanceSettings): string[] {
  const flat = (a: AppearanceSettings) => {
    const out: Record<string, unknown> = {};
    if (a.theme !== undefined) out.theme = a.theme;
    if (a.palette !== undefined) out.palette = a.palette;
    if (a.custom) {
      out["custom.enabled"] = a.custom.enabled;
      out["custom.derive"] = a.custom.derive !== false;
      for (const mode of ["light", "dark"] as const) for (const [k, v] of Object.entries(a.custom[mode] ?? {})) out[`custom.${mode}.${k}`] = v;
    }
    return out;
  };
  const a = flat(before ?? {});
  const b = flat(after ?? {});
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => `appearance.${k}`);
}

function describeAppearance(a: AppearanceSettings): string {
  const parts: string[] = [];
  if (a.theme) parts.push(`theme ${a.theme}`);
  if (a.palette) parts.push(`palette ${a.palette}`);
  if (a.custom) {
    const names = (m?: Record<string, unknown>) => Object.keys(m ?? {}).join(", ") || "none";
    parts.push(`custom tokens ${a.custom.enabled ? "on" : "off"}${a.custom.derive === false ? " (no derive)" : ""} (light: ${names(a.custom.light)}; dark: ${names(a.custom.dark)})`);
  }
  return parts.join(" · ") || "the built-in default (dark, tide)";
}

export function registerConfigTools(tool: Register, deps: McpDeps): void {
  const dashboard = (path: string) => deps.publicUrl ? `${deps.publicUrl.replace(/\/+$/, "")}${path}` : path;

  tool("config", "polpo_config_get", {
    title: "Get the configuration",
    description: "The instance's settings (the orchestrator's display name, Polpo's model and fallbacks, image model, reasoning, retries, concurrency, scheduler…), branding, "
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
    // the orchestrator's display name always, its default ("Polpo") too
    const settings = { ...publicSettings(s), orchestratorName: orchestratorName(s) };
    const om = s.orchestratorModel;
    const text = [
      `project: ${cfg.project ?? "-"}`,
      `orchestrator name: ${settings.orchestratorName}${s.orchestratorName ? "" : " (default)"}`,
      `Polpo's model: ${typeof om === "string" ? om : om?.primary ?? "default"}${typeof om === "object" && om?.fallbacks?.length ? ` (fallbacks: ${om.fallbacks.join(", ")})` : ""}`,
      `image model: ${s.imageModel ?? "default"} · reasoning: ${s.reasoning ?? "default"}`,
      ...Object.entries(settings).filter(([k]) => !["orchestratorName", "orchestratorModel", "imageModel", "reasoning"].includes(k)).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`),
      `branding: ${s.branding?.productName ?? "Polpo"}${s.branding?.tagline ? ` — ${s.branding.tagline}` : ""}${s.branding?.logoUrl ? " (custom logo)" : ""}`,
      `channels: ${channels.map((c) => `${c.name}${c.type ? ` (${c.type})` : ""}`).join(", ") || "none"}`,
      `rules: ${rules.map((x) => x.name ?? x.id).join(", ") || "none"} · approval gates: ${gates.map((g) => g.name ?? g.id).join(", ") || "none"}`,
    ].join("\n");
    return ok(text, { ...(cfg.project ? { project: cfg.project } : {}), settings, ...(s.branding ? { branding: s.branding } : {}), channels, rules, gates });
  });

  tool("config", "polpo_config_update", {
    title: "Update settings",
    description: "Change the instance's settings: the orchestrator's display name (orchestrator_name), Polpo's own model (and fallbacks), the image model, the reasoning level, the egress proxies agents' "
      + "browsers can use (agent.browserEgress picks one), the general settings (retries, concurrency, timeouts, log level, scheduler, quality, "
      + "voice replies…), compaction, Tailscale in remote computers, Polpo's MCP server (toolsets, named keys) and connectors' network policy. "
      + "Secrets are only vault references ({ owner, service }). Only the fields given change; models are checked against the catalog "
      + "(polpo_models_list). The result lists what changed. Needs the admin scope.",
    inputSchema: {
      orchestrator_name: z.string().trim().max(ORCHESTRATOR_NAME_MAX_LENGTH).regex(/^[^\r\n]*$/, "a single line").nullable().optional()
        .describe("The orchestrator's display name in chats, groups, channels and its own prompt (1–40 characters); null or '' restores the default, Polpo"),
      orchestrator_model: modelSpec.optional().describe("Polpo's model: provider:model, or { primary, fallbacks }"),
      image_model: z.string().nullable().optional().describe("The model for images (provider:model), or null for the default"),
      reasoning: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional().describe("How much Polpo reasons before answering"),
      egress_proxies: z.record(z.string().regex(EGRESS_PROXY_NAME, "letters, digits, - and _"), z.string().regex(EGRESS_PROXY_URL, "a proxy URL like socks5://100.101.55.7:1080"))
        .nullable().optional().describe("Named proxies for agents' browsers, e.g. { home: 'socks5://100.101.55.7:1080' }: replaces them all; null removes them"),
      allow_unlisted: z.boolean().optional().describe("true to accept a model that is not in the catalog (e.g. a gateway's own model)"),
      general: generalInput.optional().describe("General settings (Configuration → General); only the keys given change, null restores a default"),
      compaction: z.object({
        auto: z.boolean().optional(), prune: z.boolean().optional(), thresholdPct: z.number().min(0.1).max(0.99).optional(),
        reserveTokens: z.number().int().min(0).optional(), keepRecentTokens: z.number().int().min(0).optional(),
        model: z.string().min(3).optional(), summaryTimeoutMs: z.number().int().min(1000).optional(), memoryFlush: z.boolean().optional(),
      }).strict().nullable().optional().describe("How conversations are compacted when they fill the window: replaces it; null: the defaults"),
      tailscale: z.object({
        auth_key: vaultRefInput.describe("The vault entry holding the Tailscale auth key"),
        tags: z.array(z.string().min(1)).optional(), hostname_prefix: z.string().min(1).optional(),
      }).nullable().optional().describe("Tailscale inside remote computers (the key only as a vault reference); null removes it"),
      mcp: z.object({
        toolsets: z.array(z.string().min(1)).optional().describe(`Toolsets offered at /mcp: names (${TOOLSET_NAMES.join(", ")}), "all" or "default"`),
        keys: z.array(z.object({
          name: z.string().min(1).max(80), key_ref: vaultRefInput.describe("The vault entry holding the key's value"),
          scopes: z.array(z.string().min(1)).optional().describe("polpo:read, polpo:work, polpo:files, polpo:messages, polpo:connectors, polpo:computers, polpo:vault, polpo:admin"),
        })).optional().describe("Named MCP keys: replaces them all"),
      }).nullable().optional().describe("Polpo's own MCP server: toolsets and named keys (the keys given change); null removes the settings"),
      connectors: z.object({
        allowPrivateNetwork: z.boolean().optional(), toolTimeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
      }).strict().nullable().optional().describe("Connectors on private addresses and their default tool timeout; null: the defaults"),
    },
    outputSchema: { changed: z.array(z.string()), settings: settingsView },
    annotations: UPDATE,
  }, async ({ orchestrator_name, orchestrator_model, image_model, reasoning, egress_proxies, allow_unlisted, general, compaction, tailscale, mcp, connectors }) => {
    const body: Record<string, unknown> = {};
    if (orchestrator_name !== undefined) body.orchestratorName = orchestrator_name || null;
    if (orchestrator_model !== undefined) body.orchestratorModel = orchestrator_model;
    if (image_model !== undefined) body.imageModel = image_model;
    if (reasoning !== undefined) body.reasoning = reasoning;
    if (egress_proxies !== undefined) body.egressProxies = egress_proxies;
    for (const [k, v] of Object.entries(general ?? {})) if (v !== undefined) body[k] = v;
    if (compaction !== undefined) body.compaction = compaction;
    if (connectors !== undefined) body.connectors = connectors;
    const refs: Array<{ owner: string; service: string }> = [];
    if (tailscale !== undefined) {
      body.tailscale = tailscale === null ? null
        : { authKey: tailscale.auth_key, ...(tailscale.tags ? { tags: tailscale.tags } : {}), ...(tailscale.hostname_prefix ? { hostnamePrefix: tailscale.hostname_prefix } : {}) };
      if (tailscale) refs.push(tailscale.auth_key);
    }
    if (mcp !== undefined) {
      if (mcp?.toolsets) {
        const unknown = mcp.toolsets.filter((t) => !["all", "default", ...TOOLSET_NAMES].includes(t.trim().toLowerCase()));
        if (unknown.length) return fail(`Unknown toolset ${unknown.join(", ")}: use ${TOOLSET_NAMES.join(", ")}, "all" or "default".`);
      }
      for (const key of mcp?.keys ?? []) {
        const bad = (key.scopes ?? []).filter((x) => normalizeScopes([x]).length === 0);
        if (bad.length) return fail(`MCP key ${key.name}: unknown scope ${bad.join(", ")}.`);
        refs.push(key.key_ref);
      }
      body.mcp = mcp === null ? null : {
        ...(mcp.toolsets ? { toolsets: mcp.toolsets } : {}),
        ...(mcp.keys ? { keys: mcp.keys.map((k) => ({ name: k.name, keyRef: k.key_ref, ...(k.scopes ? { scopes: k.scopes } : {}) })) } : {}),
      };
    }
    if (Object.keys(body).length === 0) {
      return fail("Nothing to change: give orchestrator_name, orchestrator_model, image_model, reasoning, egress_proxies, general, compaction, tailscale, mcp or connectors.");
    }
    const missing = await missingVaultRefs(deps, refs);
    if (missing.length) {
      const [owner, service] = missing[0].split("/");
      return fail(`Nothing was changed: no vault entry ${missing.join(", ")}. ${setupHandoff(deps, { kind: "vault", item: owner, field: service }, `${service} credentials of ${owner}`).next_step} Then call this again.`);
    }
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
    const changed = Object.keys(body).filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
    const settings = publicSettings(next);
    const show = (k: string, v: unknown) => JSON.stringify((k === "egressProxies" ? maskProxies(v) : v) ?? "default");
    return ok(changed.length
      ? `Changed ${changed.map((k) => `${k}: ${show(k, prev[k])} → ${show(k, next[k])}`).join("; ")}.`
      : "Nothing changed (the values were the same).", { changed, settings });
  });

  tool("config", "polpo_branding_get", {
    title: "Get the branding and appearance",
    description: "The instance's branding and default look everyone sees in the dashboard: product name, tagline, logo and dark-mode logo, "
      + "how the logo is framed (logoFrame: box, the default tile, or none, bare); "
      + "the default theme (light, dark, system), palette and custom design tokens per mode (colours, fonts, radius, shadows). "
      + "A person may still customize their own browser.",
    inputSchema: {},
    outputSchema: { ...brandingOutput, logo_link: z.string().optional(), logo_dark_link: z.string().optional(), appearance: appearanceOutput, tokens: z.array(z.string()) },
    annotations: READ,
  }, async () => {
    const b = await brandingNow(deps) as Branding;
    const appearance = await appearanceNow(deps);
    const link = (u?: string) => (u ? (u.startsWith("/") ? dashboard(u) : u) : undefined);
    const logoLink = link(b.logoUrl);
    const darkLink = link(b.logoDarkUrl);
    return ok([
      `${b.productName ?? "Polpo (default name)"}${b.tagline ? ` — ${b.tagline}` : ""}`,
      `logo: ${logoLink ?? "default"} · dark-mode logo: ${darkLink ?? (logoLink ? "the logo" : "default")} · frame: ${b.logoFrame ?? "box (default)"}`,
      `appearance: ${describeAppearance(appearance)}`,
    ].join("\n"), {
      ...b, ...(logoLink ? { logo_link: logoLink } : {}), ...(darkLink ? { logo_dark_link: darkLink } : {}), appearance, tokens: APPEARANCE_TOKEN_NAMES,
    });
  });

  tool("config", "polpo_branding_update", {
    title: "Update the branding and appearance",
    description: "Change what everyone sees in the dashboard: the product name, the tagline, the logo, the dark-mode logo, how the logo is framed, and the default look "
      + "(theme, palette, custom design tokens per mode). Only the fields given change; an empty string restores a default name or tagline. "
      + "A logo comes from a public https URL (fetched by the server), a file of the instance, or base64 data; PNG, JPEG, WebP or GIF up to 4 MB; "
      + "null removes it. Tokens: colours (#rrggbb, oklch(…), hsl(…), rgb(…)), fonts (a CSS font stack; Inter Tight is bundled with the dashboard, loaded only when used: \"Inter Tight\", sans-serif), radius (0–24 px), shadows (shadowCard on cards, shadowRaised on popovers, menus, dialogs); "
      + "status colours (success, warning, info, destructive and their *Foreground; statusRunning, statusQueued, statusAssigned for task states); "
      + "the type scale (textDisplay, textH1, textH2, textH3, textBody, textSmall, textCaption, textMicro: rem 0.5–6 or px 8–96), headingWeight (100–900), "
      + "headingTracking and labelTracking (em -0.1–0.3), labelCase (uppercase, none, capitalize, lowercase); "
      + "a token set to null goes back to the palette's; with derive on (default) the dashboard fills the rest (text on primary, ring, sidebar…). "
      + "The result lists what changed. Needs the admin scope.",
    inputSchema: {
      product_name: z.string().max(80).optional().describe("The product name in the navigation ('' for the default)"),
      tagline: z.string().max(120).optional().describe("The short label under the name ('' for none)"),
      logo: logoInput.nullable().optional().describe("The new logo: { url } or { path } or { base64, mime_type }; null: the default logo"),
      logo_dark: logoInput.nullable().optional().describe("The logo in dark mode (same forms); null: use the logo"),
      remove_logo: z.boolean().optional().describe("true to go back to the default logo (same as logo: null)"),
      logo_frame: z.enum(["box", "none"]).nullable().optional().describe("How the logo is shown: box (in a tile, the default) or none (bare, same height, no background); null: the default"),
      theme: z.enum(APPEARANCE_THEMES).nullable().optional().describe("The default theme; null: the built-in default (dark)"),
      palette: z.enum(APPEARANCE_PALETTES).nullable().optional().describe("The default palette; null: the built-in default (tide)"),
      tokens: z.object({
        enabled: z.boolean().optional().describe("Apply the custom tokens (default: true when tokens are given)"),
        derive: z.boolean().optional().describe("Fill the tokens not given from those given (default true)"),
        light: tokensInput.optional().describe("Light-mode tokens to set (null removes one)"),
        dark: tokensInput.optional().describe("Dark-mode tokens to set (null removes one)"),
        replace: z.boolean().optional().describe("true: the given light/dark maps replace the current ones instead of merging"),
      }).strict().optional().describe("Custom design tokens per mode"),
      reset_appearance: z.boolean().optional().describe("true: drop the instance's default look (theme, palette and tokens) before applying the rest"),
    },
    outputSchema: { changed: z.array(z.string()), branding: z.object({ ...brandingOutput }), appearance: appearanceOutput },
    annotations: UPDATE,
  }, async ({ product_name, tagline, logo, logo_dark, remove_logo, logo_frame, theme, palette, tokens, reset_appearance }) => {
    const touchesAppearance = theme !== undefined || palette !== undefined || tokens !== undefined || reset_appearance === true;
    if (product_name === undefined && tagline === undefined && logo === undefined && logo_dark === undefined && !remove_logo && logo_frame === undefined && !touchesAppearance) {
      return fail("Nothing to change: give product_name, tagline, logo, logo_dark, logo_frame, theme, palette, tokens or reset_appearance.");
    }
    if (logo && remove_logo) return fail("Give either logo or remove_logo, not both.");
    // the appearance first (pure validation): if it is not valid, nothing changes
    let nextAppearance: AppearanceSettings | null | undefined;
    const before = touchesAppearance ? await appearanceNow(deps) : {};
    if (touchesAppearance) {
      const merged = mergeAppearance(reset_appearance ? {} : before, { theme, palette, tokens });
      try {
        nextAppearance = parseAppearanceSettings(merged);
      } catch (err) {
        return fail(`Nothing was changed: ${err instanceof Error ? err.message : String(err)}.`);
      }
    }
    // then the logos: if one cannot be read, nothing changes
    const images: Array<{ variant: "light" | "dark"; image: { bytes: Uint8Array; type: string } | null }> = [];
    for (const [variant, input] of [["light", remove_logo ? null : logo], ["dark", logo_dark]] as const) {
      if (input === undefined) continue;
      if (input === null) { images.push({ variant, image: null }); continue; }
      const got = await readLogo(deps, input);
      if (!got.ok) return fail(`Nothing was changed: the ${variant === "dark" ? "dark-mode logo" : "logo"} ${got.error}.`);
      images.push({ variant, image: got.image });
    }
    const changed: string[] = [];
    for (const { variant, image } of images) {
      const path = `/config/instance-logo${variant === "dark" ? "?variant=dark" : ""}`;
      const r = image
        ? await apiSend(deps, "POST", path, new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: image.type }))
        : await apiSend(deps, "DELETE", path);
      if (!r.ok) return apiError(r, `${image ? "Uploading" : "Removing"} the ${variant === "dark" ? "dark-mode logo" : "logo"}`, changed.length ? `Already changed: ${changed.join(", ")}.` : undefined);
      changed.push(variant === "dark" ? "logo_dark" : "logo");
    }
    const patch: Record<string, unknown> = {};
    const text: Record<string, string> = {};
    if (product_name !== undefined) text.productName = product_name.trim();
    if (tagline !== undefined) text.tagline = tagline.trim();
    if (logo_frame !== undefined) text.logoFrame = logo_frame ?? "";
    const brandingBefore = Object.keys(text).length ? await brandingNow(deps) : {};
    if (Object.keys(text).length) patch.branding = text;
    if (nextAppearance !== undefined) patch.appearance = nextAppearance;
    if (Object.keys(patch).length) {
      const r = await apiSend(deps, "PATCH", "/config/settings", patch);
      if (!r.ok) return apiError(r, "Updating the branding and appearance", changed.length ? `Already changed: ${changed.join(", ")}.` : undefined);
      for (const [k, v] of Object.entries(text)) if ((brandingBefore[k] ?? "") !== v) changed.push(k === "logoFrame" ? "logo_frame" : k);
    }
    const now = await brandingNow(deps) as Branding;
    const appearance = await appearanceNow(deps);
    if (touchesAppearance) changed.push(...appearanceChanges(before, appearance));
    return ok(changed.length
      ? `Updated: ${changed.join(", ")}. Now: ${now.productName ?? "Polpo"}${now.tagline ? ` — ${now.tagline}` : ""}${now.logoUrl ? " with a custom logo" : ""}${now.logoDarkUrl ? " (and a dark-mode one)" : ""}${now.logoFrame === "none" ? ", shown bare" : ""}; appearance: ${describeAppearance(appearance)}.`
      : "Nothing changed (the values were the same).",
    { changed, branding: now, appearance });
  });

  const providerItem = z.object({
    name: z.string(), configured: z.boolean(), source: z.string().optional(), env_var: z.string().optional(),
    setup_url: z.string().optional().describe("Without a key: the link that opens its key form"), setup_id: z.string().optional(), next_step: z.string().optional(),
  });

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
    const setup = dashboardLink(deps, "/config?section=providers");
    // each provider without a key: the link that opens its key form, and what to wait for
    for (const item of p.items as Array<Record<string, unknown>>) {
      if (!item.configured) Object.assign(item, setupHandoff(deps, { kind: "provider", item: String(item.name), field: "apiKey" }, `${String(item.name)} API key`));
    }
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
