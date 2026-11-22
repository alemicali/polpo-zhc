/**
 * The rest of Configuration, section by section, so a connector can do what the dashboard does
 * without delegating (polpo_ask): sandbox, policies (approval gates, escalation, SLA), members,
 * MCP access (OAuth grants), notification channels' setup, cloud sync, and LLM providers
 * (disconnect, custom providers' non-secret definition).
 *
 * The "settings" toolset, on by default (a connector URL or settings.mcp.toolsets can leave it out).
 * Reads need polpo:read (members and MCP access: polpo:admin, they name
 * people); changes polpo:admin. Secrets never pass through here: API keys, bot tokens, webhook URLs, R2 keys are
 * entered in the dashboard, and the tools give setup_url (the right Configuration section). Vault
 * references ({ owner, service }) are not secrets and may be set.
 */
import { z } from "zod";
import { isSecretKey } from "@polpo-ai/core/secret-redaction";
import {
  DESTRUCTIVE, READ, UPDATE, apiError, apiGet, apiSend, confirmParam, dashboardLink, enc, fail, looseObject, ok, short,
  type McpDeps, type Register,
} from "./kit.js";

const SANDBOX_PROVIDERS = ["local", "bwrap", "docker", "daytona", "e2b"] as const;
/** Lifecycle hooks an approval gate can stop at (packages/server/src/schemas.ts, LifecycleHookSchema). */
export const GATE_HOOKS = [
  "task:create", "task:spawn", "task:transition", "task:complete", "task:fail", "task:retry", "mission:execute", "mission:complete",
  "assessment:run", "assessment:complete", "quality:gate", "quality:sla", "schedule:trigger", "orchestrator:tick", "orchestrator:shutdown",
] as const;
export const CHANNEL_TYPES = ["slack", "email", "telegram", "whatsapp", "webhook", "push"] as const;

/** A channel's secret fields: never accepted or returned here (capability URLs included). */
const CHANNEL_SECRET_FIELDS = ["botToken", "apiKey", "webhookUrl", "url", "headers", "inboundSecret", "vapidPrivateKey"];
/** What each channel type needs that only the dashboard sets (one of them, for slack). */
const CHANNEL_REQUIRED_SECRETS: Record<string, string[][]> = {
  telegram: [["botToken"]], slack: [["webhookUrl", "apiKey"]], webhook: [["url"]], email: [["apiKey", "host"]],
};

type Settings = Record<string, unknown> & {
  notifications?: { channels?: Record<string, Record<string, unknown>> };
  approvalGates?: Array<Record<string, unknown>>;
  escalationPolicy?: unknown;
  sla?: unknown;
};

async function settingsNow(deps: McpDeps): Promise<{ ok: true; settings: Settings } | { ok: false; res: ReturnType<typeof apiError> }> {
  const r = await apiGet(deps, "/config");
  if (!r.ok) return { ok: false, res: apiError(r, "Reading the configuration") };
  return { ok: true, settings: ((r.data as { settings?: Settings })?.settings ?? {}) as Settings };
}

/** A channel without its secrets: the fields people see, and the names of the secrets it has. */
export function channelView(name: string, c: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { name };
  const secrets: string[] = [];
  for (const [k, v] of Object.entries(c ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    if (CHANNEL_SECRET_FIELDS.includes(k) || isSecretKey(k)) {
      secrets.push(k === "headers" ? `headers (${Object.keys(v as object).join(", ")})` : k);
      continue;
    }
    out[k] = v;
  }
  out.secrets_set = secrets;
  return out;
}

/** The names of channels that do not exist. */
function unknownChannels(settings: Settings, names: Array<string | undefined>): string[] {
  const known = Object.keys(settings.notifications?.channels ?? {});
  return [...new Set(names.filter((n): n is string => !!n && !known.includes(n)))];
}

const changedKeys = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));

export function registerSettingsTools(tool: Register, deps: McpDeps): void {
  registerSandboxTools(tool, deps);
  registerPolicyTools(tool, deps);
  registerMemberTools(tool, deps);
  registerMcpAccessTools(tool, deps);
  registerSyncTools(tool, deps);
  registerProviderTools(tool, deps);
  registerChannelConfigTools(tool, deps);
}

// ── Sandbox ──────────────────────────────────────────────────────────

const vaultRef = z.object({ owner: z.string().min(1), service: z.string().min(1) }).describe("The vault entry holding the provider's API key (polpo_vault_list)");
const daytonaInput = z.object({
  credential: vaultRef.optional(),
  api: z.enum(["v0", "v2"]).optional().describe("v0 (default): app.daytona.io or a self-hosted URL; v2: Daytona Cloud's new service (Linux VMs)"),
  apiUrl: z.string().url().optional().describe("v0 only: a custom or self-hosted Daytona API"),
  target: z.string().min(1).optional(), region: z.string().min(1).optional(),
  snapshot: z.string().min(1).optional().describe("v0: the snapshot sandboxes start from"),
  image: z.string().min(1).optional().describe("v2: the registered image sandboxes start from"),
  maxTimeoutSeconds: z.number().int().min(60).optional().describe("v2: a sandbox's wall-clock budget (the plan's maximum)"),
  hibernate: z.object({
    keepSnapshots: z.number().int().optional(), safetySnapshotHours: z.number().int().optional(),
    rotateBeforeMinutes: z.number().int().optional(), snapshotTimeoutSeconds: z.number().int().optional(),
  }).strict().optional().describe("v2 computers: how they hibernate (snapshots kept, safety snapshots, rotation)"),
}).strict();
const e2bInput = z.object({
  credential: vaultRef.optional(), domain: z.string().min(1).optional(), template: z.string().min(1).optional(),
}).strict();

function registerSandboxTools(tool: Register, deps: McpDeps): void {
  const setup = dashboardLink(deps, "/config?section=sandbox");

  tool("settings", "polpo_sandbox_get", {
    title: "Get the sandbox settings",
    description: "Where agents' tools run, for the whole instance: the default provider (local, bwrap, docker, daytona, e2b), the providers "
      + "agents may choose, network rule, resources, chats on remote providers, isolation, lifecycle, warm VMs, volumes, and the remote "
      + "providers' options (never their keys: those are vault references). Also which providers this machine can run and whether each "
      + "remote provider is ready.",
    inputSchema: {},
    outputSchema: { settings: looseObject.nullable(), available: z.array(z.string()), providers: z.unknown().optional(), setup_url: z.string() },
    annotations: READ,
  }, async () => {
    const [r, p] = await Promise.all([apiGet(deps, "/sandbox"), apiGet(deps, "/sandbox/providers")]);
    if (!r.ok) return apiError(r, "Reading the sandbox settings");
    const d = r.data as { settings?: Record<string, unknown> | null; available?: string[]; snapshot?: unknown };
    const settings = d.settings ?? null;
    return ok([
      `default: ${String(settings?.provider ?? "local")} · allowed: ${(settings?.allowedProviders as string[] | undefined)?.join(", ") ?? "any"} · network: ${JSON.stringify(settings?.network ?? "default")}`,
      `this machine can run: ${(d.available ?? []).join(", ")}`,
      `settings: ${JSON.stringify(settings ?? {})}`,
      `To set a provider's API key: ${setup}`,
    ].join("\n"), { settings, available: d.available ?? [], ...(p.ok ? { providers: p.data } : {}), setup_url: setup });
  });

  tool("settings", "polpo_sandbox_update", {
    title: "Update the sandbox settings",
    description: "Change where agents' tools run, for the whole instance. Only the fields given change; null removes one (back to the default). "
      + "providers.daytona / providers.e2b merge into the current options (null removes the provider); their API key is only a vault "
      + "reference (credential: { owner, service }), set in the dashboard when missing. The result lists what changed and anything the "
      + "server did not accept. Needs the admin scope.",
    inputSchema: {
      provider: z.enum(SANDBOX_PROVIDERS).nullable().optional().describe("The default provider"),
      allowed_providers: z.array(z.enum(SANDBOX_PROVIDERS)).nullable().optional().describe("Providers agents may choose"),
      network: z.object({
        mode: z.enum(["deny", "allowlist", "open", "unrestricted"]),
        allow: z.array(z.string().min(1)).optional().describe("allowlist: hosts like example.com, *.example.com, example.com:22"),
      }).strict().nullable().optional().describe("What sandboxes may reach: deny, allowlist, open (public only) or unrestricted"),
      resources: z.object({
        cpus: z.number().positive().optional(), memoryMb: z.number().int().positive().optional(),
        diskMb: z.number().int().positive().optional(), timeoutMin: z.number().int().positive().optional(),
      }).strict().nullable().optional().describe("CPU, memory, disk and time limits of a sandbox"),
      chat_idle_minutes: z.number().int().min(1).nullable().optional().describe("Chat workspaces close after this idle time"),
      confine_external_content: z.boolean().nullable().optional().describe("Agents reading external content run at least in bwrap"),
      allow_local: z.boolean().nullable().optional().describe("With confine_external_content: Polpo itself may still run locally"),
      chat_remote: z.boolean().nullable().optional().describe("Chats may run on remote providers (Daytona, E2B)"),
      isolation: z.enum(["reuse", "fresh", "shared"]).nullable().optional().describe("reuse a released sandbox, a fresh one per run, or one shared by concurrent runs"),
      lifecycle: z.object({
        onRelease: z.enum(["pool", "destroy"]).optional(), stopAfterIdleMinutes: z.number().int().min(0).optional(),
        deleteAfterStopMinutes: z.number().int().min(0).optional(),
      }).strict().nullable().optional().describe("After a run: pool or destroy the sandbox, idle stop, deletion"),
      warm: z.object({ daytona: z.number().int().min(0).max(20).optional(), e2b: z.number().int().min(0).max(20).optional() }).strict().nullable().optional()
        .describe("Remote VMs kept ready per provider (they cost money)"),
      volumes: z.array(z.object({
        name: z.string().regex(/^[a-z][a-z0-9_-]{1,62}$/), access: z.enum(["read-only", "read-write"]).optional(), writeBack: z.enum(["auto", "manual"]).optional(),
      }).strict()).nullable().optional().describe("Persistent volumes runs mount, by name"),
      providers: z.object({ daytona: daytonaInput.nullable().optional(), e2b: e2bInput.nullable().optional() }).strict().optional()
        .describe("Remote providers' options (merged; null removes a provider)"),
    },
    outputSchema: { changed: z.array(z.string()), settings: looseObject.nullable(), ignored: z.array(z.string()), setup_url: z.string() },
    annotations: UPDATE,
  }, async (args) => {
    const map: Record<string, string> = {
      provider: "provider", allowed_providers: "allowedProviders", network: "network", resources: "resources", chat_idle_minutes: "chatIdleMinutes",
      confine_external_content: "confineExternalContent", allow_local: "allowLocal", chat_remote: "chatRemote", isolation: "isolation",
      lifecycle: "lifecycle", warm: "warm", volumes: "volumes",
    };
    const given = Object.entries(args).filter(([, v]) => v !== undefined);
    if (given.length === 0) return fail("Nothing to change: give provider, allowed_providers, network, resources, chat_idle_minutes, confine_external_content, allow_local, chat_remote, isolation, lifecycle, warm, volumes or providers.");
    const cur = await apiGet(deps, "/sandbox");
    if (!cur.ok) return apiError(cur, "Reading the sandbox settings");
    const before = ((cur.data as { settings?: Record<string, unknown> | null }).settings ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = JSON.parse(JSON.stringify(before));
    const requested: Record<string, unknown> = {};
    for (const [arg, key] of Object.entries(map)) {
      const v = (args as Record<string, unknown>)[arg];
      if (v === undefined) continue;
      if (v === null) delete next[key];
      else { next[key] = v; requested[key] = v; }
    }
    if (args.providers) {
      const providers = { ...((next.providers as Record<string, Record<string, unknown>> | undefined) ?? {}) };
      for (const id of ["daytona", "e2b"] as const) {
        const v = args.providers[id];
        if (v === undefined) continue;
        if (v === null) delete providers[id];
        else { providers[id] = { ...(providers[id] ?? {}), ...v }; requested[`providers.${id}`] = providers[id]; }
      }
      if (Object.keys(providers).length) next.providers = providers;
      else delete next.providers;
    }
    const r = await apiSend(deps, "PATCH", "/config/settings", { sandbox: Object.keys(next).length ? next : null });
    if (!r.ok) return apiError(r, "Updating the sandbox settings", "Nothing was changed. Fix the value named in the error.");
    const after = await apiGet(deps, "/sandbox");
    const settings = (after.ok ? (after.data as { settings?: Record<string, unknown> | null }).settings : null) ?? null;
    const now = settings ?? {};
    const flat = (o: Record<string, unknown>) => ({ ...o, ...Object.fromEntries(Object.entries((o.providers as Record<string, unknown>) ?? {}).map(([k, v]) => [`providers.${k}`, v])) });
    const changed = changedKeys(flat(before), flat(now)).filter((k) => k !== "providers");
    // what the server normalized away (invalid for this field)
    const ignored = Object.entries(requested).filter(([k, v]) => JSON.stringify(flat(now)[k]) !== JSON.stringify(v)
      && !(typeof v === "object" && v && typeof flat(now)[k] === "object" && Object.entries(v).every(([kk, vv]) => JSON.stringify((flat(now)[k] as Record<string, unknown>)[kk]) === JSON.stringify(vv))))
      .map(([k]) => k);
    const missingKey = ["daytona", "e2b"].filter((id) => (now.providers as Record<string, Record<string, unknown>> | undefined)?.[id] && !(now.providers as Record<string, Record<string, unknown>>)[id].credential);
    return ok([
      changed.length ? `Changed ${changed.join(", ")}.` : "Nothing changed (the values were the same).",
      ...(ignored.length ? [`Not accepted (invalid, left as before): ${ignored.join(", ")}.`] : []),
      ...(missingKey.length ? [`${missingKey.join(", ")} has no API key yet: the person picks its vault entry at ${setup}.`] : []),
    ].join(" "), { changed, settings, ignored, setup_url: setup });
  });

  tool("settings", "polpo_sandbox_provider_test", {
    title: "Test a remote sandbox provider",
    description: "Check that a remote sandbox provider (daytona, e2b) answers with its configured key: says whether it works and why not.",
    inputSchema: { provider: z.enum(["daytona", "e2b"]).describe("The remote provider") },
    outputSchema: { provider: z.string(), result: z.unknown() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ provider }) => {
    const r = await apiSend(deps, "POST", `/sandbox/providers/${provider}/test`);
    if (!r.ok) return apiError(r, `Testing ${provider}`, r.status === 400 ? `The person picks its API key's vault entry at ${dashboardLink(deps, "/config?section=sandbox")}.` : undefined);
    return ok(`${provider}: ${JSON.stringify(r.data)}`, { provider, result: r.data });
  });
}

// ── Policies: approval gates, escalation, SLA ────────────────────────

const gateItem = z.object({ id: z.string(), name: z.string(), handler: z.string(), hook: z.string() }).passthrough();

function registerPolicyTools(tool: Register, deps: McpDeps): void {
  tool("settings", "polpo_policies_get", {
    title: "Get the policies",
    description: "The instance's policies (Configuration → Policies): approval gates (where work stops for an automatic or human approval), "
      + "the escalation policy (who takes over when tasks keep failing) and SLA monitoring.",
    inputSchema: {},
    outputSchema: { gates: z.array(gateItem), escalation_policy: z.unknown().nullable(), sla: z.unknown().nullable() },
    annotations: READ,
  }, async () => {
    const s = await settingsNow(deps);
    if (!s.ok) return s.res;
    const gates = (s.settings.approvalGates ?? []) as Array<z.infer<typeof gateItem>>;
    return ok([
      `approval gates: ${gates.map((g) => `${g.id} (${g.handler} at ${g.hook})`).join(", ") || "none"}`,
      `escalation policy: ${s.settings.escalationPolicy ? JSON.stringify(s.settings.escalationPolicy) : "none"}`,
      `SLA: ${s.settings.sla ? JSON.stringify(s.settings.sla) : "none"}`,
    ].join("\n"), { gates, escalation_policy: s.settings.escalationPolicy ?? null, sla: s.settings.sla ?? null });
  });

  tool("settings", "polpo_policies_update", {
    title: "Update the escalation policy and SLA",
    description: "Set or remove (null) the escalation policy (levels of who handles repeated failures: an agent, Polpo, or a human on channels) "
      + "and SLA monitoring (warning threshold, channels, what a violation does). Channels must exist (polpo_channels_list). Needs the admin scope.",
    inputSchema: {
      escalation_policy: z.object({
        name: z.string().min(1).max(120),
        levels: z.array(z.object({
          level: z.number().int().min(0), handler: z.enum(["agent", "orchestrator", "human"]),
          target: z.string().min(1).optional().describe("agent: its name; human: a channel"),
          timeoutMs: z.number().int().min(0).optional(), notifyChannels: z.array(z.string().min(1)).optional(),
        }).strict()).min(1),
      }).strict().nullable().optional().describe("Who handles repeated failures, level by level; null removes it"),
      sla: z.object({
        warningThreshold: z.number().min(0).max(1).optional().describe("Fraction of the deadline elapsed before a warning (0–1)"),
        checkIntervalMs: z.number().int().min(1000).optional(),
        warningChannels: z.array(z.string().min(1)).optional(), violationChannels: z.array(z.string().min(1)).optional(),
        violationAction: z.enum(["notify", "fail"]).optional(),
      }).strict().nullable().optional().describe("SLA monitoring; null removes it"),
    },
    outputSchema: { changed: z.array(z.string()), escalation_policy: z.unknown().nullable(), sla: z.unknown().nullable() },
    annotations: UPDATE,
  }, async ({ escalation_policy, sla }) => {
    if (escalation_policy === undefined && sla === undefined) return fail("Nothing to change: give escalation_policy or sla (null removes one).");
    const s = await settingsNow(deps);
    if (!s.ok) return s.res;
    const channels = [
      ...(escalation_policy?.levels ?? []).flatMap((l) => [...(l.notifyChannels ?? []), ...(l.handler === "human" ? [l.target] : [])]),
      ...(sla?.warningChannels ?? []), ...(sla?.violationChannels ?? []),
    ];
    const missing = unknownChannels(s.settings, channels);
    if (missing.length) return fail(`No channel ${missing.join(", ")}. List them with polpo_channels_list.`);
    const body: Record<string, unknown> = {};
    if (escalation_policy !== undefined) body.escalationPolicy = escalation_policy;
    if (sla !== undefined) body.sla = sla;
    const r = await apiSend(deps, "PATCH", "/config/settings", body);
    if (!r.ok) return apiError(r, "Updating the policies");
    const next = ((r.data as { settings?: Settings })?.settings ?? {}) as Settings;
    const changed = Object.keys(body).filter((k) => JSON.stringify(s.settings[k]) !== JSON.stringify(next[k]));
    return ok(changed.length ? `Changed ${changed.join(", ")}.` : "Nothing changed (the values were the same).",
      { changed, escalation_policy: next.escalationPolicy ?? null, sla: next.sla ?? null });
  });

  tool("settings", "polpo_approval_gate_save", {
    title: "Save an approval gate",
    description: "Create or replace an approval gate: at a lifecycle hook (e.g. task:complete, mission:execute), work stops until it is "
      + "approved, automatically (handler auto, with a condition) or by a person (handler human, notified on channels). Same id replaces it. "
      + "Needs the admin scope.",
    inputSchema: {
      id: z.string().min(1).max(80).regex(/^[A-Za-z0-9_.-]+$/, "letters, digits, '.', '_' and '-'").describe("The gate's id (an existing one to replace it)"),
      name: z.string().min(1).max(120).describe("A readable name"),
      handler: z.enum(["auto", "human"]).describe("auto: approved when the condition holds; human: a person decides"),
      hook: z.enum(GATE_HOOKS).describe("Where work stops"),
      condition: z.string().min(1).max(2000).optional().describe("An expression on the event that must hold for the gate to apply"),
      notify_channels: z.array(z.string().min(1)).optional().describe("Channels that hear about it (polpo_channels_list)"),
      timeout_ms: z.number().int().min(0).optional().describe("How long to wait for an answer (ms)"),
      timeout_action: z.enum(["approve", "reject"]).optional().describe("What happens when nobody answers in time"),
      priority: z.number().int().optional().describe("Higher runs first when several gates apply"),
      max_revisions: z.number().int().min(0).optional().describe("How many times the work may be sent back"),
      include_outcomes: z.boolean().optional().describe("Show the task's outcomes to the approver"),
    },
    outputSchema: { gate: gateItem, created: z.boolean() },
    annotations: UPDATE,
  }, async (a) => {
    const s = await settingsNow(deps);
    if (!s.ok) return s.res;
    const missing = unknownChannels(s.settings, a.notify_channels ?? []);
    if (missing.length) return fail(`No channel ${missing.join(", ")}. List them with polpo_channels_list.`);
    const existed = (s.settings.approvalGates ?? []).some((g) => g.id === a.id);
    const gate = {
      id: a.id, name: a.name, handler: a.handler, hook: a.hook,
      ...(a.condition ? { condition: { expression: a.condition } } : {}),
      ...(a.notify_channels ? { notifyChannels: a.notify_channels } : {}),
      ...(a.timeout_ms !== undefined ? { timeoutMs: a.timeout_ms } : {}),
      ...(a.timeout_action ? { timeoutAction: a.timeout_action } : {}),
      ...(a.priority !== undefined ? { priority: a.priority } : {}),
      ...(a.max_revisions !== undefined ? { maxRevisions: a.max_revisions } : {}),
      ...(a.include_outcomes !== undefined ? { includeOutcomes: a.include_outcomes } : {}),
    };
    const r = await apiSend(deps, "PUT", `/config/gates/${enc(a.id)}`, gate);
    if (!r.ok) return apiError(r, `Saving gate ${a.id}`);
    return ok(`${existed ? "Replaced" : "Created"} approval gate ${a.id}: ${a.handler} approval at ${a.hook}.`, { gate, created: !existed });
  });

  tool("settings", "polpo_approval_gate_delete", {
    title: "Delete an approval gate",
    description: "Delete an approval gate (polpo_policies_get lists them): work no longer stops there. Needs confirm: true.",
    inputSchema: { id: z.string().min(1).describe("The gate's id"), confirm: confirmParam("delete the gate") },
    outputSchema: { id: z.string(), deleted: z.boolean() },
    annotations: DESTRUCTIVE,
  }, async ({ id, confirm }) => {
    if (confirm !== true) return fail(`Deleting gate ${id} lets work pass without that approval: ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "DELETE", `/config/gates/${enc(id)}`);
    if (!r.ok) return r.status === 404 ? fail(`There is no gate "${id}". List them with polpo_policies_get.`) : apiError(r, `Deleting gate ${id}`);
    return ok(`Deleted approval gate ${id}.`, { id, deleted: true });
  });
}

// ── Members ──────────────────────────────────────────────────────────

function registerMemberTools(tool: Register, deps: McpDeps): void {
  const setup = dashboardLink(deps, "/config?section=members");

  tool("settings", "polpo_members_list", {
    title: "List members",
    description: "Who may sign in to the dashboard (the instance's members, by email), and whether sign-in is on. Members have no roles: "
      + "every member can use and configure the instance. Needs the admin scope.",
    inputSchema: {},
    outputSchema: { enabled: z.boolean(), members: z.array(z.object({ email: z.string() })), setup_url: z.string() },
    annotations: READ,
    scope: "polpo:admin",
  }, async () => {
    const r = await apiGet(deps, "/auth/instance/members");
    if (!r.ok) return apiError(r, "Listing members");
    const d = r.data as { enabled?: boolean; members?: Array<{ email: string }> };
    const members = d.members ?? [];
    return ok(`${d.enabled ? "Sign-in is on" : "Sign-in is off (anyone who reaches the dashboard can use it)"}. Members: ${members.map((m) => m.email).join(", ") || "none"}.`,
      { enabled: !!d.enabled, members, setup_url: setup });
  });

  tool("settings", "polpo_members_invite", {
    title: "Add a member",
    description: "Let a person sign in to the dashboard: adds their email, and by default emails them a sign-in link. Needs the admin scope.",
    inputSchema: {
      email: z.string().email().describe("Their email address"),
      send_invite: z.boolean().optional().describe("Email them a sign-in link (default true; needs sign-in on and email set up)"),
    },
    outputSchema: { email: z.string(), invited: z.boolean(), invite_error: z.string().optional(), members: z.array(z.object({ email: z.string() })) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ email, send_invite }) => {
    const r = await apiSend(deps, "POST", "/auth/instance/members", { email, sendInvite: send_invite !== false });
    if (!r.ok) return apiError(r, `Adding ${email}`);
    const d = r.data as { members?: Array<{ email: string }>; invited?: boolean; inviteError?: string };
    return ok(`${email} is a member${d.invited ? " and was emailed a sign-in link" : ""}${d.inviteError ? ` (the invite was not sent: ${d.inviteError})` : ""}.`,
      { email, invited: !!d.invited, ...(d.inviteError ? { invite_error: d.inviteError } : {}), members: d.members ?? [] });
  });

  tool("settings", "polpo_members_remove", {
    title: "Remove a member",
    description: "Stop a person from signing in to the dashboard (the last member cannot be removed). Needs confirm: true.",
    inputSchema: { email: z.string().email().describe("The member's email"), confirm: confirmParam("remove the member") },
    outputSchema: { email: z.string(), removed: z.boolean(), members: z.array(z.object({ email: z.string() })) },
    annotations: DESTRUCTIVE,
  }, async ({ email, confirm }) => {
    if (confirm !== true) return fail(`Removing ${email} stops them from signing in: ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "DELETE", `/auth/instance/members/${enc(email)}`);
    if (!r.ok) return apiError(r, `Removing ${email}`);
    const members = ((r.data as { members?: Array<{ email: string }> }).members ?? []);
    const removed = !members.some((m) => m.email.toLowerCase() === email.toLowerCase());
    return ok(removed ? `Removed ${email}.` : `${email} was not a member.`, { email, removed, members });
  });
}

// ── MCP access ───────────────────────────────────────────────────────

const grantItem = z.object({ id: z.string(), client_name: z.string().optional(), subject: z.string().optional(), scopes: z.array(z.string()) }).passthrough();

function registerMcpAccessTools(tool: Register, deps: McpDeps): void {
  tool("settings", "polpo_mcp_access_list", {
    title: "List MCP access",
    description: "Who may use this instance through MCP: OAuth grants (the app, the person who allowed it, scopes, when) and named MCP keys "
      + "(name and scopes, never their values). Keys are set with polpo_config_update (mcp.keys, vault references). Needs the admin scope.",
    inputSchema: {},
    outputSchema: { grants: z.array(grantItem), keys: z.array(z.object({ name: z.string() }).passthrough()), scopes: z.array(z.string()) },
    annotations: READ,
    scope: "polpo:admin",
  }, async () => {
    const r = await apiGet(deps, "/mcp/access");
    if (!r.ok) return apiError(r, "Reading MCP access");
    const d = r.data as { grants?: Array<z.infer<typeof grantItem>>; keys?: Array<Record<string, unknown> & { name: string }>; scopes?: Array<{ id: string }> };
    // never values, whatever the API returns
    const keys = (d.keys ?? []).map(({ value: _v, key: _k, ...k }) => k);
    const grants = d.grants ?? [];
    return ok([
      `OAuth grants: ${grants.map((g) => `${g.id} — ${g.client_name ?? "?"} for ${g.subject ?? "?"} [${g.scopes.join(" ")}]`).join("; ") || "none"}`,
      `MCP keys: ${keys.map((k) => `${k.name} [${((k.scopes as string[] | undefined) ?? []).join(" ")}]`).join("; ") || "none"}`,
    ].join("\n"), { grants, keys, scopes: (d.scopes ?? []).map((s) => s.id) });
  });

  tool("settings", "polpo_mcp_grant_revoke", {
    title: "Revoke an MCP grant",
    description: "Disconnect an app that was allowed through OAuth (polpo_mcp_access_list): its tokens stop working at once; it must ask again. "
      + "Needs confirm: true and the admin scope.",
    inputSchema: { id: z.string().min(1).describe("The grant's id"), confirm: confirmParam("revoke the grant") },
    outputSchema: { id: z.string(), revoked: z.boolean() },
    annotations: DESTRUCTIVE,
  }, async ({ id, confirm }) => {
    if (confirm !== true) return fail(`Revoking grant ${id} disconnects that app (maybe this very connection): ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "DELETE", `/mcp/grants/${enc(id)}`);
    if (!r.ok) return r.status === 404 ? fail(`There is no grant "${id}" (it may have expired). List them with polpo_mcp_access_list.`) : apiError(r, `Revoking ${id}`);
    return ok(`Revoked grant ${id}.`, { id, revoked: true });
  });
}

// ── Cloud sync ───────────────────────────────────────────────────────

type SyncConfig = {
  r2?: { endpoint: string; accessKeyId: string; secretAccessKey: string; bucket: string; prefix?: string };
  schedule?: { enabled: boolean; cron: string };
  excludes?: string[];
  internalExcludes?: string[];
  nextRunAt?: string | null;
  lastPushedAt?: string;
  lastPulledAt?: string;
};

/** The sync settings without credentials (the access key id too). */
function syncView(c: SyncConfig): Record<string, unknown> {
  return {
    configured: !!c.r2,
    ...(c.r2 ? { r2: { endpoint: c.r2.endpoint, bucket: c.r2.bucket, ...(c.r2.prefix ? { prefix: c.r2.prefix } : {}), has_credentials: !!c.r2.secretAccessKey } } : {}),
    schedule: c.schedule ?? null,
    excludes: c.excludes ?? [],
    internal_excludes: c.internalExcludes ?? [],
    next_run_at: c.nextRunAt ?? null,
    ...(c.lastPushedAt ? { last_pushed_at: c.lastPushedAt } : {}),
    ...(c.lastPulledAt ? { last_pulled_at: c.lastPulledAt } : {}),
  };
}

function registerSyncTools(tool: Register, deps: McpDeps): void {
  const setup = dashboardLink(deps, "/config?section=sync");

  tool("settings", "polpo_sync_status", {
    title: "Get the cloud sync status",
    description: "Cloud sync (the workspace to and from an R2 bucket): whether it is set up (endpoint, bucket, prefix; never the keys), "
      + "the schedule, excluded paths, the run in progress and the latest runs.",
    inputSchema: { history: z.number().int().min(0).max(50).optional().describe("How many past runs (default 5)") },
    outputSchema: { sync: looseObject, active: z.unknown().nullable(), history: z.array(z.unknown()), setup_url: z.string() },
    annotations: READ,
  }, async ({ history }) => {
    const [c, a, h] = await Promise.all([apiGet(deps, "/sync/config"), apiGet(deps, "/sync/active"), apiGet(deps, `/sync/history?limit=${history ?? 5}`)]);
    if (!c.ok) return apiError(c, "Reading the sync settings");
    const sync = syncView(c.data as SyncConfig);
    const runs = h.ok && Array.isArray(h.data) ? h.data.slice(0, history ?? 5) : [];
    return ok([
      sync.configured ? `R2: ${JSON.stringify(sync.r2)}` : `Not set up: the person enters the R2 keys at ${setup}`,
      `schedule: ${sync.schedule ? JSON.stringify(sync.schedule) : "none"} · excludes: ${(sync.excludes as string[]).join(", ") || "none"}`,
      `running: ${a.ok && a.data ? JSON.stringify(a.data) : "no"}`,
      ...(runs.length ? [`latest runs: ${runs.map((r) => short(JSON.stringify(r), 160)).join("; ")}`] : []),
    ].join("\n"), { sync, active: a.ok ? a.data ?? null : null, history: runs, setup_url: setup });
  });

  tool("settings", "polpo_sync_update", {
    title: "Update the cloud sync settings",
    description: "Change cloud sync: the R2 endpoint, bucket and prefix (the keys stay as they are; new keys are entered in the dashboard, "
      + "setup_url), the schedule (cron) and excluded paths. Needs the admin scope.",
    inputSchema: {
      endpoint: z.string().url().optional().describe("The R2 S3 endpoint (https://<account>.r2.cloudflarestorage.com)"),
      bucket: z.string().min(1).optional().describe("The R2 bucket"),
      prefix: z.string().optional().describe("A folder inside the bucket ('' for the root)"),
      schedule: z.object({ enabled: z.boolean(), cron: z.string().min(1).describe("e.g. '0 3 * * *'") }).nullable().optional().describe("null removes it"),
      excludes: z.array(z.string().min(1)).optional().describe("Paths (globs) never synced: replaces the list"),
    },
    outputSchema: { changed: z.array(z.string()), sync: looseObject, setup_url: z.string() },
    annotations: UPDATE,
  }, async ({ endpoint, bucket, prefix, schedule, excludes }) => {
    if (endpoint === undefined && bucket === undefined && prefix === undefined && schedule === undefined && excludes === undefined) {
      return fail("Nothing to change: give endpoint, bucket, prefix, schedule or excludes.");
    }
    const cur = await apiGet(deps, "/sync/config");
    if (!cur.ok) return apiError(cur, "Reading the sync settings");
    const c = cur.data as SyncConfig;
    const body: Record<string, unknown> = {};
    if (endpoint !== undefined || bucket !== undefined || prefix !== undefined) {
      if (!c.r2) return fail(`Cloud sync is not set up: the person enters the R2 keys first, at ${setup}.`);
      // the stored keys stay: the masked secret is restored by the server
      body.r2 = { endpoint: endpoint ?? c.r2.endpoint, accessKeyId: c.r2.accessKeyId, secretAccessKey: c.r2.secretAccessKey, bucket: bucket ?? c.r2.bucket, prefix: prefix ?? c.r2.prefix ?? "" };
    }
    if (schedule !== undefined) body.schedule = schedule;
    if (excludes !== undefined) body.excludes = excludes;
    const r = await apiSend(deps, "PUT", "/sync/config", body);
    if (!r.ok) return apiError(r, "Updating the sync settings");
    const before = syncView(c);
    const now = await apiGet(deps, "/sync/config");
    const after = syncView((now.ok ? now.data : r.data) as SyncConfig);
    const changed = changedKeys(before, after).filter((k) => k !== "next_run_at");
    return ok(changed.length ? `Changed ${changed.join(", ")}.` : "Nothing changed (the values were the same).", { changed, sync: after, setup_url: setup });
  });

  tool("settings", "polpo_sync_disconnect", {
    title: "Disconnect cloud sync",
    description: "Forget the R2 bucket and its keys (the bucket's files stay). Sync stops until it is set up again in the dashboard. Needs confirm: true.",
    inputSchema: { confirm: confirmParam("disconnect cloud sync") },
    outputSchema: { disconnected: z.boolean() },
    annotations: DESTRUCTIVE,
  }, async ({ confirm }) => {
    if (confirm !== true) return fail("Disconnecting removes the R2 keys from this instance (setting it up again needs them): ask the person, then call again with confirm: true.");
    const r = await apiSend(deps, "PUT", "/sync/config", { r2: null });
    if (!r.ok) return apiError(r, "Disconnecting cloud sync");
    return ok("Cloud sync is disconnected.", { disconnected: true });
  });

  tool("settings", "polpo_sync_test", {
    title: "Test cloud sync",
    description: "Check that the R2 bucket answers with the stored keys.",
    inputSchema: {},
    outputSchema: { ok: z.boolean(), error: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => {
    const r = await apiSend(deps, "POST", "/sync/test");
    if (!r.ok) return ok(`The test failed: ${r.error}. Check the settings at ${setup}.`, { ok: false, error: r.error });
    return ok("R2 answered: cloud sync works.", { ok: true });
  });

  tool("settings", "polpo_sync_run", {
    title: "Run cloud sync",
    description: "Push the workspace to R2 or pull it from R2, now. mode copy (default) only adds and updates newer files; mode sync mirrors "
      + "exactly, deleting what the other side does not have. dry_run lists what would happen. A real run needs confirm: true; it runs in "
      + "the background (follow it with polpo_sync_status).",
    inputSchema: {
      direction: z.enum(["push", "pull"]).describe("push: workspace → R2; pull: R2 → workspace (overwrites local files)"),
      mode: z.enum(["copy", "sync"]).optional().describe("copy (default): add and update newer files; sync: an exact mirror, deleting extras"),
      dry_run: z.boolean().optional().describe("Only list what would happen"),
      confirm: confirmParam("run it (after the person agreed)"),
    },
    outputSchema: { started: z.boolean(), finished: z.boolean(), direction: z.string(), mode: z.string(), dry_run: z.boolean(), result: z.unknown().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ direction, mode, dry_run, confirm }) => {
    const m = mode ?? "copy";
    if (!dry_run && confirm !== true) {
      return fail(`A real ${direction} (${m}${m === "sync" ? ": deletes what the other side lacks" : ""}) changes ${direction === "push" ? "the bucket" : "this workspace"}: `
        + "ask the person (or call with dry_run: true first), then call again with confirm: true.");
    }
    const run = deps.api("POST", `/api/v1/sync/${direction}`, { mode: m, dryRun: !!dry_run });
    // a short run answers at once; a long one keeps going in the background
    const first = await Promise.race([run, new Promise<null>((r) => setTimeout(() => r(null), 3000).unref?.())]);
    run.catch(() => {});
    if (first === null) {
      return ok(`The ${direction} started (${m}${dry_run ? ", dry run" : ""}). Follow it with polpo_sync_status.`, { started: true, finished: false, direction, mode: m, dry_run: !!dry_run });
    }
    if (first.status >= 400) {
      const err = (first.body as { error?: string } | null)?.error ?? `HTTP ${first.status}`;
      return fail(`The ${direction} did not start: ${err}.${first.status === 400 ? ` Set it up at ${dashboardLink(deps, "/config?section=sync")}.` : ""}`);
    }
    // NDJSON: the last line is the outcome
    const lines = String(typeof first.body === "string" ? first.body : JSON.stringify(first.body)).trim().split("\n").filter(Boolean);
    let result: unknown = lines.at(-1);
    try { result = JSON.parse(lines.at(-1) ?? "null"); } catch { /* text */ }
    return ok(`The ${direction} finished (${m}${dry_run ? ", dry run" : ""}): ${short(JSON.stringify(result), 400)}`, { started: true, finished: true, direction, mode: m, dry_run: !!dry_run, result });
  });
}

// ── LLM providers ────────────────────────────────────────────────────

const customProviderInput = z.object({
  label: z.string().max(80).optional(),
  api: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]).optional().describe("The API it speaks (default openai-completions)"),
  baseUrl: z.string().min(1).max(2048).optional().describe("The endpoint, e.g. https://gateway.example.com/v1"),
  proxyFor: z.string().max(60).optional().describe("A built-in provider it proxies (e.g. anthropic)"),
  headers: z.record(z.string(), z.string()).optional().describe("Static, non-secret headers (secret ones are entered in the dashboard)"),
  allowPrivateNetwork: z.boolean().optional(),
  timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  models: z.array(z.object({
    id: z.string().min(1), name: z.string().optional(), contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(), reasoning: z.boolean().optional(), input: z.array(z.enum(["text", "image"])).optional(),
  }).passthrough()).max(2000).optional(),
}).passthrough();

function registerProviderTools(tool: Register, deps: McpDeps): void {
  const setup = dashboardLink(deps, "/config?section=providers");
  const view = (p: Record<string, unknown>) => {
    // never the key or its hint
    const { keyHint: _h, apiKey: _k, secrets: _s, ...rest } = p;
    return rest;
  };

  tool("settings", "polpo_custom_providers_list", {
    title: "List custom LLM providers",
    description: "Custom providers and AI gateways (OpenAI- or Anthropic-compatible endpoints): endpoint, API, models, static headers, whether "
      + "a key is set (never the key). Keys are entered in the dashboard (setup_url).",
    inputSchema: {},
    outputSchema: { items: z.array(looseObject), setup_url: z.string() },
    annotations: READ,
  }, async () => {
    const r = await apiGet(deps, "/providers/custom");
    if (!r.ok) return apiError(r, "Listing custom providers");
    const items = ((r.data as Array<Record<string, unknown>>) ?? []).map(view);
    return ok(`${items.map((p) => `- ${String(p.id)}: ${String(p.baseUrl)} (${String(p.api)}), ${Array.isArray(p.models) ? p.models.length : 0} models, ${p.configured ? "ready" : "no key"}`).join("\n") || "No custom providers."}\nKeys: ${setup}`,
      { items, setup_url: setup });
  });

  tool("settings", "polpo_custom_provider_save", {
    title: "Save a custom LLM provider",
    description: "Create or change a custom provider or AI gateway: endpoint, API, models, static headers. Changes merge into the current "
      + "definition. Its API key or secret headers are never sent here: the person enters them at setup_url (changing the endpoint drops the "
      + "stored key). Needs the admin scope.",
    inputSchema: {
      id: z.string().min(2).max(41).regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes").describe("The provider's id (models are id:model)"),
      provider: customProviderInput.describe("The definition (only the fields given change on an existing provider)"),
    },
    outputSchema: { id: z.string(), created: z.boolean(), provider: looseObject, warnings: z.array(z.string()), needs_key: z.boolean(), setup_url: z.string() },
    annotations: UPDATE,
  }, async ({ id, provider }) => {
    const secretish = Object.keys(provider).filter((k) => isSecretKey(k) || k === "secrets");
    if (secretish.length) return fail(`${secretish.join(", ")} cannot be sent through this connector: the person enters keys at ${setup}.`);
    const cur = await apiGet(deps, `/providers/custom/${enc(id)}`);
    const exists = cur.ok;
    if (!exists && cur.status !== 404) return apiError(cur, `Reading provider ${id}`);
    let definition: Record<string, unknown>;
    if (exists) {
      const { id: _id, auth: _a, hasKey: _hk, keyHint: _kh, secretHeaderNames: _sh, envVar: _ev, envKeyPresent: _ep, keySource: _ks, configured: _c, ...stored } = cur.data as Record<string, unknown>;
      definition = { ...stored, ...provider };
    } else {
      if (!provider.baseUrl) return fail("A new provider needs provider.baseUrl.");
      definition = provider;
    }
    const r = exists
      ? await apiSend(deps, "PUT", `/providers/custom/${enc(id)}`, { provider: definition })
      : await apiSend(deps, "POST", "/providers/custom", { id, provider: definition });
    if (!r.ok) return apiError(r, `Saving provider ${id}`, "Nothing was saved. Fix the field named in the error.");
    const saved = await apiGet(deps, `/providers/custom/${enc(id)}`);
    const p = saved.ok ? view(saved.data as Record<string, unknown>) : { id };
    const warnings = ((r.data as { warnings?: string[] } | null)?.warnings) ?? [];
    const needsKey = saved.ok ? !(saved.data as { configured?: boolean }).configured : false;
    return ok(`${exists ? "Updated" : "Created"} provider ${id}.${warnings.length ? ` ${warnings.join(" ")}` : ""}${needsKey ? ` It has no key yet: the person enters it at ${setup}.` : ""}`,
      { id, created: !exists, provider: p, warnings, needs_key: needsKey, setup_url: setup });
  });

  tool("settings", "polpo_custom_provider_remove", {
    title: "Remove a custom LLM provider",
    description: "Remove a custom provider and its stored key: agents and settings using its models fail until they pick another. Needs confirm: true.",
    inputSchema: { id: z.string().min(1).describe("The provider's id"), confirm: confirmParam("remove the provider") },
    outputSchema: { id: z.string(), removed: z.boolean(), warnings: z.array(z.string()) },
    annotations: DESTRUCTIVE,
  }, async ({ id, confirm }) => {
    if (confirm !== true) return fail(`Removing ${id} deletes its key too, and its models stop working: ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "DELETE", `/providers/custom/${enc(id)}`);
    if (!r.ok) return r.status === 404 ? fail(`There is no custom provider "${id}". List them with polpo_custom_providers_list.`) : apiError(r, `Removing ${id}`);
    const warnings = ((r.data as { warnings?: string[] }).warnings) ?? [];
    return ok(`Removed provider ${id}.${warnings.length ? ` ${warnings.join(" ")}` : ""}`, { id, removed: true, warnings });
  });

  tool("settings", "polpo_provider_disconnect", {
    title: "Disconnect an LLM provider",
    description: "Remove a built-in provider's key or sign-in (Anthropic, OpenAI…; polpo_providers_list): its models stop working until the "
      + "person connects it again at setup_url. Needs confirm: true.",
    inputSchema: { name: z.string().min(1).describe("The provider, e.g. openai"), confirm: confirmParam("disconnect the provider") },
    outputSchema: { name: z.string(), disconnected: z.boolean(), setup_url: z.string() },
    annotations: DESTRUCTIVE,
  }, async ({ name, confirm }) => {
    if (confirm !== true) return fail(`Disconnecting ${name} removes its key: its models stop working. Ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "DELETE", `/providers/${enc(name)}/disconnect`);
    if (!r.ok) return apiError(r, `Disconnecting ${name}`);
    return ok(`Disconnected ${name}. To connect it again: ${setup}`, { name, disconnected: true, setup_url: setup });
  });
}

// ── Notification channels' setup ─────────────────────────────────────

const gatewayInput = z.object({
  enableInbound: z.boolean().optional().describe("People can write to Polpo on this channel"),
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
  allowFrom: z.array(z.string()).optional(),
  sessionIdleMinutes: z.number().int().min(0).optional(),
  sessionMode: z.enum(["per-peer", "shared"]).optional(),
  agentSessions: z.record(z.string(), z.object({ sessionMode: z.enum(["per-peer", "shared"]).optional(), sessionIdleMinutes: z.number().int().min(0).optional() }).strict()).optional(),
  agent: z.string().min(1).optional().describe("The agent that answers (default Polpo)"),
  replyTo: z.object({ channel: z.string().min(1), chatId: z.string().optional(), echoInbound: z.boolean().optional() }).strict().optional(),
  groupReplies: z.enum(["mentions", "intent"]).optional(),
  intentThreshold: z.number().min(0).max(1).optional(),
}).strict();

function registerChannelConfigTools(tool: Register, deps: McpDeps): void {
  const setup = dashboardLink(deps, "/config?section=channels");

  tool("settings", "polpo_channel_save", {
    title: "Save a notification channel",
    description: "Create or change a notification channel's setup (Telegram, Slack, email, WhatsApp, webhook, push): its non-secret fields "
      + "(chat id, recipients, sender, SMTP host and port, WhatsApp profile, push options) and the inbound gateway (who may write, which agent "
      + "answers, sessions). Only the fields given change. Bot tokens, API keys, webhook URLs and secret headers are never sent here: the "
      + "result lists what is missing and setup_url, where the person enters them. Needs the admin scope.",
    inputSchema: {
      name: z.string().min(1).max(80).regex(/^[A-Za-z0-9_.-]+$/, "letters, digits, '.', '_' and '-'").describe("The channel's name (an existing one to change it)"),
      type: z.enum(CHANNEL_TYPES).optional().describe("Needed for a new channel"),
      chat_id: z.string().min(1).optional().describe("Telegram / WhatsApp: the chat"),
      to: z.array(z.string().email()).optional().describe("Email: recipients"),
      from: z.string().min(1).optional().describe("Email: sender"),
      provider: z.enum(["resend", "smtp"]).optional().describe("Email: how it is sent"),
      host: z.string().min(1).optional().describe("Email (smtp): the server"),
      port: z.number().int().min(1).max(65535).optional().describe("Email (smtp): the port"),
      profile_dir: z.string().min(1).optional().describe("WhatsApp: the signed-in profile"),
      vapid_subject: z.string().min(1).optional().describe("Push: mailto: or https: contact"),
      vapid_public_key: z.string().min(1).optional().describe("Push: the public key"),
      ttl: z.number().int().min(0).optional().describe("Push: seconds a notification is kept"),
      urgency: z.enum(["very-low", "low", "normal", "high"]).optional().describe("Push: delivery urgency"),
      gateway: gatewayInput.nullable().optional().describe("Inbound messages: replaces the gateway settings; null turns them off"),
    },
    outputSchema: { channel: looseObject, created: z.boolean(), needs_secrets: z.array(z.string()), setup_url: z.string() },
    annotations: UPDATE,
  }, async (a) => {
    const s = await settingsNow(deps);
    if (!s.ok) return s.res;
    const current = s.settings.notifications?.channels?.[a.name];
    if (!current && !a.type) return fail(`There is no channel "${a.name}": give type to create it (${CHANNEL_TYPES.join(", ")}).`);
    const fields: Record<string, unknown> = {
      type: a.type, chatId: a.chat_id, to: a.to, from: a.from, provider: a.provider, host: a.host, port: a.port, profileDir: a.profile_dir,
      vapidSubject: a.vapid_subject, vapidPublicKey: a.vapid_public_key, ttl: a.ttl, urgency: a.urgency,
    };
    // the stored channel as GET /config gives it (secrets masked: the server restores them)
    const next: Record<string, unknown> = { ...(current ?? {}) };
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) next[k] = v;
    if (a.gateway === null) delete next.gateway;
    else if (a.gateway !== undefined) next.gateway = a.gateway;
    if (a.gateway?.agent || a.gateway?.replyTo) {
      const missing = unknownChannels(s.settings, [a.gateway.replyTo?.channel].filter((c) => c !== a.name));
      if (missing.length) return fail(`No channel ${missing.join(", ")} (gateway.replyTo.channel).`);
    }
    const r = await apiSend(deps, "PUT", `/config/channels/${enc(a.name)}`, next);
    if (!r.ok) {
      return apiError(r, `Saving channel ${a.name}`, r.status === 400 && /secret|Re-enter/i.test(r.error)
        ? `Changing where the channel sends drops its saved secrets: the person enters them again at ${setup}.`
        : "Nothing was saved. Fix the field named in the error.");
    }
    const saved = ((r.data as { settings?: Settings })?.settings?.notifications?.channels?.[a.name] ?? next) as Record<string, unknown>;
    const needs = (CHANNEL_REQUIRED_SECRETS[String(saved.type)] ?? []).filter((oneOf) => !oneOf.some((k) => saved[k])).map((oneOf) => oneOf.join(" or "));
    return ok(`${current ? "Updated" : "Created"} channel ${a.name} (${String(saved.type)}).${needs.length ? ` It still needs ${needs.join(", ")}: the person enters ${needs.length > 1 ? "them" : "it"} at ${setup}.` : ""}`
      + `${current ? " Test it with polpo_channel_test." : ""}`,
    { channel: channelView(a.name, saved), created: !current, needs_secrets: needs, setup_url: setup });
  });

  tool("settings", "polpo_channel_remove", {
    title: "Remove a notification channel",
    description: "Remove a notification channel and its saved secrets: rules that use it stop notifying there. Needs confirm: true.",
    inputSchema: { name: z.string().min(1).describe("The channel's name"), confirm: confirmParam("remove the channel") },
    outputSchema: { name: z.string(), removed: z.boolean(), rules_using_it: z.array(z.string()) },
    annotations: DESTRUCTIVE,
  }, async ({ name, confirm }) => {
    const s = await settingsNow(deps);
    if (!s.ok) return s.res;
    const rules = ((s.settings.notifications as { rules?: Array<{ id: string; channels?: string[] }> } | undefined)?.rules ?? [])
      .filter((r) => r.channels?.includes(name)).map((r) => r.id);
    if (confirm !== true) {
      return fail(`Removing channel ${name} deletes its saved secrets${rules.length ? ` and rules ${rules.join(", ")} stop notifying there` : ""}: ask the person, then call again with confirm: true.`);
    }
    const r = await apiSend(deps, "DELETE", `/config/channels/${enc(name)}`);
    if (!r.ok) return r.status === 404 ? fail(`There is no channel "${name}". List them with polpo_channels_list.`) : apiError(r, `Removing channel ${name}`);
    return ok(`Removed channel ${name}.${rules.length ? ` Rules still naming it: ${rules.join(", ")}.` : ""}`, { name, removed: true, rules_using_it: rules });
  });
}
