/**
 * Triggers: public endpoints (POST /hooks/{id}) that receive form submissions and webhooks, check
 * them (secret, HMAC, IP allowlist, contract, filter, dedupe, rate limit) and record each delivery
 * with the mapped values, and run its actions on accepted deliveries (playbook, mission, task, agent
 * turn, notification; in order, after the 202): definitions in create / update, each delivery's
 * action runs in polpo_trigger_deliveries, re-runs in polpo_trigger_run_actions.
 *
 * Scopes: reading (list, get, deliveries) needs read; creating, changing, deleting and the test
 * tools need work; secrets (rotation, the HMAC secret, the query token) and the IP allowlist need
 * admin (polpo_trigger_auth). A secret is never taken in chat: the sender's HMAC secret goes in on
 * the dashboard (setup_url); a generated secret is returned once, to admin only.
 */
import { z } from "zod";
import {
  BAD_CURSOR, DESTRUCTIVE, READ, UPDATE, WRITE, apiError, apiGet, apiSend, confirmParam, cursorParam, dashboardLink, enc, fail, hasScope, limitParam,
  looseObject, ok, page, qs, short,
  type McpDeps, type Register,
} from "./kit.js";
import { setupHandoff } from "./setup.js";

type Stats = { counts: Record<string, number>; total: number; lastDeliveryAt?: string; lastStatus?: string };
export type TriggerRow = {
  id: string; name: string; description?: string; enabled: boolean; owner?: string; endpoint: string; path: string;
  auth: { secret: boolean; allowQueryToken?: boolean; hmac?: { header: string; algorithm: string; encoding: string; prefix?: string; timestampHeader?: string }; ipAllowlist?: string[] };
  secrets: Array<{ id: string; hint: string; createdAt: string; expiresAt?: string }>;
  hmacSecret?: { secretSet: boolean; previousUntil?: string };
  contract: { contentTypes: string[]; maxBodyBytes: number; maxFileBytes?: number; schema?: Record<string, unknown> };
  contractVersion: number; filter?: { mode?: string; conditions: Array<{ path: string; op: string; value?: unknown }> };
  dedupe?: { key: string; ttlSeconds: number }; rateLimitPerMinute: number; mapping?: Record<string, string>; retention: number; stats: Stats;
  actions?: ActionRow[]; actionLimits?: { concurrency?: number; perMinute?: number; perDay?: number; agentDailyCostUsd?: number };
};
export type ActionRow = {
  id: string; kind: string; enabled: boolean; name?: string; retries?: number; waitSeconds?: number;
  playbook?: string; params?: Record<string, string>; mission?: string; variables?: Record<string, string>;
  title?: string; description?: string; assignTo?: string;
  agent?: string; instructions?: string; data?: string; allowedTools?: string[]; maxSteps?: number; deliverTo?: { channel: string; chatId: string; threadId?: number; name?: string };
  channel?: string; body?: string; severity?: string;
};
export type ActionRunRow = {
  actionId: string; kind: string; name?: string; status: string; attempts: number; queuedAt: string; startedAt?: string; endedAt?: string; error?: string; reason?: string;
  refs?: { playbook?: string; missionId?: string; missionName?: string; copyOf?: string; taskId?: string; sessionId?: string; agent?: string; notificationId?: string; channel?: string };
  costUsd?: number; outputs?: Record<string, unknown>;
};
type DeliveryRow = {
  id: string; receivedAt: string; status: string; httpStatus: number; reasons: string[]; errors?: string[]; test?: boolean; kind?: string; bytes: number;
  duplicateOf?: string; count?: number; body?: unknown; mapped?: Record<string, unknown>; mappingErrors?: string[]; headers?: Record<string, string>;
  files?: Array<{ filename: string; size: number }>; bodyTruncated?: boolean; contractVersion: number; ip?: string;
  actions?: ActionRunRow[]; actionsStatus?: string; actionsRequestedBy?: string; origin?: { triggerId: string; deliveryId: string; depth?: number };
  previousActions?: Array<{ endedAt?: string; status?: string; runs: ActionRunRow[] }>;
};

const ACTIONS_HELP = "Actions run on an accepted delivery (never on filtered, duplicate or rejected ones; a test only with run_actions), in order, after the 202, as the trigger's owner.";

/** One action as a line. */
export const actionLine = (a: ActionRow, i: number) => {
  const what = a.kind === "playbook" ? `run playbook ${a.playbook}${a.params ? ` (${Object.entries(a.params).map(([k, v]) => `${k}=${v}`).join(", ")})` : ""}`
    : a.kind === "mission" ? `start mission ${a.mission}${a.variables ? ` (${Object.entries(a.variables).map(([k, v]) => `${k}=${v}`).join(", ")})` : ""}`
      : a.kind === "task" ? `create task "${short(a.title ?? "", 80)}" for ${a.assignTo}`
        : a.kind === "agent" ? `${a.agent ?? "Polpo"} takes a turn: "${short(a.instructions ?? "", 100)}"${a.allowedTools ? ` (tools: ${a.allowedTools.join(", ") || "none"})` : ""}${a.deliverTo ? ` → reply to ${a.deliverTo.name ?? a.deliverTo.chatId} (${a.deliverTo.channel})` : ""}`
          : `notify ${a.channel}: "${short(a.body ?? "", 100)}"`;
  return `  ${i + 1}. [${a.id}] ${a.name ? `${a.name}: ` : ""}${what}${a.waitSeconds ? ` · waits ${a.waitSeconds}s` : ""}${a.enabled ? "" : " (disabled)"}`;
};

/** What an action run created, as text. */
const refsText = (r: ActionRunRow["refs"]) => !r ? "" : [
  r.missionId ? `mission ${r.missionName ?? ""} [${r.missionId}]${r.copyOf ? ` (a copy of ${r.copyOf})` : ""}` : "", r.taskId ? `task ${r.taskId}` : "",
  r.sessionId ? `chat session ${r.sessionId}${r.agent ? ` (${r.agent})` : ""}` : "", r.notificationId ? `notification ${r.notificationId} on ${r.channel}` : "",
  !r.notificationId && r.channel ? `reply sent on ${r.channel}` : "",
].filter(Boolean).join(", ");

export const actionRunLine = (r: ActionRunRow) => `  - [${r.actionId}] ${r.kind} ${r.status}${r.attempts > 1 ? ` after ${r.attempts} attempts` : ""}`
  + `${refsText(r.refs) ? ` → ${refsText(r.refs)}` : ""}${r.costUsd ? ` · $${r.costUsd.toFixed(4)}` : ""}${r.error ? ` · error: ${short(r.error, 200)}` : ""}${r.reason ? ` · ${short(r.reason, 200)}` : ""}`;
const STATUS = z.enum(["accepted", "rejected", "filtered", "duplicate", "rate_limited"]);
const CONTENT = z.enum(["json", "form", "multipart", "text"]);
const at = (iso?: string) => (iso ? iso.slice(0, 16).replace("T", " ") : "");

export const triggerLine = (t: TriggerRow) => {
  const auth = [t.auth.secret ? "secret" : "", t.auth.hmac ? `hmac ${t.auth.hmac.algorithm}${t.hmacSecret && !t.hmacSecret.secretSet ? " (secret NOT set)" : ""}` : "", t.auth.ipAllowlist?.length ? `ip ${t.auth.ipAllowlist.length}` : ""].filter(Boolean).join("+");
  const c = t.stats.counts;
  return `- ${t.name} [${t.id}]${t.enabled ? "" : " (disabled)"} · ${t.endpoint} · auth ${auth} · contract v${t.contractVersion} ${t.contract.contentTypes.join("/")}`
    + ` · ${t.stats.total} deliveries (${c.accepted ?? 0} accepted, ${c.rejected ?? 0} rejected, ${c.filtered ?? 0} filtered, ${c.duplicate ?? 0} duplicate${c.rate_limited ? `, ${c.rate_limited} rate limited` : ""})`
    + `${t.stats.lastDeliveryAt ? ` · last ${at(t.stats.lastDeliveryAt)} ${t.stats.lastStatus}` : ""}`;
};
export const deliveryLine = (d: DeliveryRow) => `- ${d.id} ${at(d.receivedAt)} ${d.status}${d.test ? " (test)" : ""} HTTP ${d.httpStatus}${d.kind ? ` ${d.kind}` : ""} ${d.bytes} B`
  + `${d.count && d.count > 1 ? ` ×${d.count}` : ""}${d.duplicateOf ? ` dup of ${d.duplicateOf}` : ""}${d.actionsStatus ? ` · actions ${d.actionsStatus}` : ""}${d.reasons.length ? ` · ${short(d.reasons.join("; "), 160)}` : ""}`;

const triggerDetail = (t: TriggerRow) => [
  triggerLine(t).slice(2),
  t.description ? `description: ${t.description}` : "",
  `auth: ${t.auth.secret ? `generated secret (${t.secrets.map((s) => `${s.hint}${s.expiresAt ? ` until ${at(s.expiresAt)}` : ""}`).join(", ") || "none"}; header Authorization: Bearer or X-Polpo-Secret${t.auth.allowQueryToken ? ", or ?token=" : ""})` : "no generated secret"}`
    + `${t.auth.hmac ? `; HMAC ${t.auth.hmac.algorithm}/${t.auth.hmac.encoding} in ${t.auth.hmac.header}${t.auth.hmac.prefix ? ` (prefix ${t.auth.hmac.prefix})` : ""}${t.auth.hmac.timestampHeader ? `, timestamp ${t.auth.hmac.timestampHeader}` : ""}, secret ${t.hmacSecret?.secretSet ? "set" : "NOT set"}` : ""}`
    + `${t.auth.ipAllowlist?.length ? `; IP allowlist ${t.auth.ipAllowlist.join(", ")}` : ""}`,
  `contract v${t.contractVersion}: ${t.contract.contentTypes.join(", ")}, at most ${t.contract.maxBodyBytes} bytes${t.contract.schema ? `, schema ${short(JSON.stringify(t.contract.schema), 300)}` : ", no schema"}`,
  t.filter ? `filter (${t.filter.mode ?? "all"}): ${t.filter.conditions.map((c) => `${c.path} ${c.op}${c.value !== undefined ? ` ${JSON.stringify(c.value)}` : ""}`).join("; ")}` : "no filter",
  t.dedupe ? `dedupe: ${t.dedupe.key} for ${t.dedupe.ttlSeconds}s` : "no dedupe",
  `rate limit ${t.rateLimitPerMinute}/min · keeps ${t.retention} deliveries`,
  t.mapping ? `mapping: ${Object.entries(t.mapping).map(([k, v]) => `${k} ← ${v}`).join(", ")}` : "no mapping",
  t.actions?.length ? `actions (in order, on accepted deliveries):\n${t.actions.map(actionLine).join("\n")}` : "no actions (deliveries are only recorded)",
  t.actionLimits ? `action limits: ${Object.entries(t.actionLimits).map(([k, v]) => `${k} ${v}`).join(", ")}` : "",
].filter(Boolean).join("\n");

const filterInput = z.object({
  mode: z.enum(["all", "any"]).optional(),
  conditions: z.array(z.object({
    path: z.string().describe("body.*, headers.* or query.*, e.g. body.data.fields[0].value"),
    op: z.enum(["equals", "not_equals", "contains", "in", "gte", "lte", "exists", "not_exists"]),
    value: z.unknown().optional(),
  })).max(20),
}).nullable().describe("Deliveries not matching are recorded as filtered; null removes it");
const contractInput = z.object({
  content_types: z.array(CONTENT).min(1).optional().describe("Accepted: json (default), form (x-www-form-urlencoded), multipart (files: metadata kept), text"),
  max_body_bytes: z.number().int().min(1).max(10 * 1024 * 1024).optional().describe("Default 262144"),
  max_file_bytes: z.number().int().min(1).max(10 * 1024 * 1024).optional(),
  schema: z.record(z.string(), z.unknown()).nullable().optional().describe("A JSON Schema for the parsed body (polpo_trigger_test action infer_schema makes one from a sample); null removes it"),
  note: z.string().max(200).optional().describe("A line for this contract version"),
});
const contractBody = (c: z.infer<typeof contractInput> | undefined): { contract?: Record<string, unknown>; contractNote?: string } => c ? {
  contract: {
    ...(c.content_types ? { contentTypes: c.content_types } : {}), ...(c.max_body_bytes ? { maxBodyBytes: c.max_body_bytes } : {}),
    ...(c.max_file_bytes ? { maxFileBytes: c.max_file_bytes } : {}), ...(c.schema !== undefined ? { schema: c.schema } : {}),
  },
  ...(c.note ? { contractNote: c.note } : {}),
} : {};
const templ = z.record(z.string(), z.string());
const actionInput = z.object({
  kind: z.enum(["playbook", "mission", "task", "agent", "notify"]).describe("playbook: run a playbook; mission: start a mission; task: create a task; agent: one turn of an agent (or Polpo); notify: a message on a notification channel"),
  id: z.string().max(41).optional().describe("Stable id (generated when absent); later actions read its outputs as {{steps.<id>.reply}}, .result, .missionId, .taskId"),
  name: z.string().max(120).optional(),
  enabled: z.boolean().optional().describe("Default true"),
  retries: z.number().int().min(0).max(5).optional().describe("Retries after a failure, with backoff (default 2; 0 for agent)"),
  continue_on_error: z.boolean().optional().describe("When this action fails, still run the later ones (default false: they are skipped)"),
  playbook: z.string().optional().describe("playbook: its name (polpo_playbooks_list)"),
  params: templ.optional().describe("playbook: parameter → template over body / headers / query / mapped / trigger / delivery / steps, e.g. {\"email\": \"{{mapped.email}}\"}; one placeholder of an object passes it as JSON"),
  mission: z.string().optional().describe("mission: its id or name"),
  variables: templ.optional().describe("mission: replace {{name}} in a copy of the mission"),
  title: z.string().optional().describe("task: title template; notify: title template (default the trigger's name)"),
  description: z.string().optional().describe("task: description template"),
  assign_to: z.string().optional().describe("task: the agent"),
  wait_seconds: z.number().int().min(0).max(3600).optional().describe("playbook / mission / task: wait until it ends, so later actions read {{steps.<id>.result}}"),
  agent: z.string().optional().describe("agent: its name; omit for Polpo"),
  instructions: z.string().optional().describe("agent: what to do; only {{trigger.*}} / {{delivery.*}} placeholders: the payload follows as delimited DATA, never as instructions (refer to fields by name)"),
  data: z.enum(["mapped", "body", "both"]).optional().describe("agent: the data the turn receives (default mapped when the trigger has a mapping, else body)"),
  allowed_tools: z.array(z.string()).max(200).optional().describe("agent: only these tools in this turn ('prefix*' a family; [] none)"),
  max_steps: z.number().int().min(1).max(50).optional().describe("agent: tool-loop steps (default 10)"),
  deliver_to: z.object({ channel: z.string().describe("The Telegram channel key (polpo_channels_list)"), chat_id: z.string(), thread_id: z.number().int().optional(), name: z.string().optional() })
    .optional().describe("agent: also send the reply to this chat"),
  channel: z.string().optional().describe("notify: a notification channel id (polpo_channels_list)"),
  body: z.string().optional().describe("notify: message template, e.g. New signup {{mapped.email}}"),
  severity: z.enum(["info", "warning", "critical"]).optional(),
});
/** An action as the REST API takes it. */
const actionBody = (a: z.infer<typeof actionInput>): Record<string, unknown> => ({
  kind: a.kind, ...(a.id ? { id: a.id } : {}), ...(a.name ? { name: a.name } : {}), ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
  ...(a.retries !== undefined ? { retries: a.retries } : {}), ...(a.continue_on_error ? { continueOnError: true } : {}), ...(a.wait_seconds ? { waitSeconds: a.wait_seconds } : {}),
  ...(a.playbook ? { playbook: a.playbook } : {}), ...(a.params ? { params: a.params } : {}), ...(a.mission ? { mission: a.mission } : {}), ...(a.variables ? { variables: a.variables } : {}),
  ...(a.title !== undefined ? { title: a.title } : {}), ...(a.description !== undefined ? { description: a.description } : {}), ...(a.assign_to ? { assignTo: a.assign_to } : {}),
  ...(a.agent ? { agent: a.agent } : {}), ...(a.instructions !== undefined ? { instructions: a.instructions } : {}), ...(a.data ? { data: a.data } : {}),
  ...(a.allowed_tools ? { allowedTools: a.allowed_tools } : {}), ...(a.max_steps ? { maxSteps: a.max_steps } : {}),
  ...(a.deliver_to ? { deliverTo: { channel: a.deliver_to.channel, chatId: a.deliver_to.chat_id, ...(a.deliver_to.thread_id !== undefined ? { threadId: a.deliver_to.thread_id } : {}), ...(a.deliver_to.name ? { name: a.deliver_to.name } : {}) } } : {}),
  ...(a.channel ? { channel: a.channel } : {}), ...(a.body !== undefined ? { body: a.body } : {}), ...(a.severity ? { severity: a.severity } : {}),
});
const definitionShape = {
  description: z.string().max(2000).nullable().optional().describe("What it is for; null removes it"),
  enabled: z.boolean().optional().describe("false: the endpoint answers 404 (nothing is recorded)"),
  contract: contractInput.optional().describe("What a delivery must look like"),
  filter: filterInput.optional(),
  dedupe: z.object({ key: z.string().describe("A template, e.g. {{body.submission_id}} or {{headers.x-request-id}}"), ttl_seconds: z.number().int().min(1).max(604800).optional() }).nullable().optional()
    .describe("Same key within the window → recorded as duplicate, answered 200 with the original delivery id; null removes it"),
  rate_limit_per_minute: z.number().int().min(1).max(6000).optional().describe("Default 60; beyond → 429"),
  mapping: z.record(z.string(), z.string()).nullable().optional().describe("Named fields → templates over body / headers / query ({{body.email}}): what an action would receive"),
  retention: z.number().int().min(1).max(5000).optional().describe("Deliveries kept (default 500)"),
  actions: z.array(actionInput).max(10).nullable().optional().describe("What runs on an accepted delivery, in order (replaces the list; null or [] removes them). " + ACTIONS_HELP),
  action_limits: z.object({
    concurrency: z.number().int().min(1).max(10).optional().describe("Deliveries whose actions run at once (default 2)"),
    per_minute: z.number().int().min(1).max(600).optional().describe("Actions started a minute (default 30)"),
    per_day: z.number().int().min(1).max(100000).optional().describe("Actions started a day (default 1000)"),
    agent_daily_cost_usd: z.number().positive().optional().describe("What the agent actions may spend a day (USD)"),
  }).nullable().optional().describe("Safeguards on the actions; beyond a limit an action is skipped; null: the defaults"),
};
type Def = {
  description?: string | null; enabled?: boolean; contract?: z.infer<typeof contractInput>; filter?: z.infer<typeof filterInput>; dedupe?: { key: string; ttl_seconds?: number } | null;
  rate_limit_per_minute?: number; mapping?: Record<string, string> | null; retention?: number;
  actions?: Array<z.infer<typeof actionInput>> | null; action_limits?: { concurrency?: number; per_minute?: number; per_day?: number; agent_daily_cost_usd?: number } | null;
};
const definitionBody = (d: Def) => ({
  ...(d.description !== undefined ? { description: d.description } : {}), ...(d.enabled !== undefined ? { enabled: d.enabled } : {}),
  ...contractBody(d.contract), ...(d.filter !== undefined ? { filter: d.filter } : {}),
  ...(d.dedupe !== undefined ? { dedupe: d.dedupe === null ? null : { key: d.dedupe.key, ...(d.dedupe.ttl_seconds ? { ttlSeconds: d.dedupe.ttl_seconds } : {}) } } : {}),
  ...(d.rate_limit_per_minute !== undefined ? { rateLimitPerMinute: d.rate_limit_per_minute } : {}),
  ...(d.mapping !== undefined ? { mapping: d.mapping } : {}), ...(d.retention !== undefined ? { retention: d.retention } : {}),
  ...(d.actions !== undefined ? { actions: d.actions === null ? null : d.actions.map(actionBody) } : {}),
  ...(d.action_limits !== undefined ? { actionLimits: d.action_limits === null ? null : {
    ...(d.action_limits.concurrency !== undefined ? { concurrency: d.action_limits.concurrency } : {}), ...(d.action_limits.per_minute !== undefined ? { perMinute: d.action_limits.per_minute } : {}),
    ...(d.action_limits.per_day !== undefined ? { perDay: d.action_limits.per_day } : {}), ...(d.action_limits.agent_daily_cost_usd !== undefined ? { agentDailyCostUsd: d.action_limits.agent_daily_cost_usd } : {}),
  } } : {}),
});
const sampleInput = z.object({
  body: z.unknown().describe("The parsed body as it would arrive (JSON value; form fields as an object; text as a string)"),
  content_type: CONTENT.optional().describe("Default json"),
  headers: z.record(z.string(), z.string()).optional(),
  query: z.record(z.string(), z.string()).optional(),
  run_actions: z.boolean().optional().describe("send: also run the trigger's actions (off by default: a test runs nothing)"),
});
const sampleBody = (s: z.infer<typeof sampleInput>) => ({ body: s.body, ...(s.content_type ? { contentType: s.content_type } : {}), ...(s.headers ? { headers: s.headers } : {}), ...(s.query ? { query: s.query } : {}), ...(s.run_actions ? { runActions: true } : {}) });
const curl = (t: TriggerRow) => `curl -X POST '${t.endpoint}' -H 'content-type: application/json'${t.auth.secret ? " -H 'Authorization: Bearer <secret>'" : ""}${t.auth.hmac ? ` -H '${t.auth.hmac.header}: <signature>'` : ""} -d '{"hello":"world"}'`;

export function registerTriggerTools(tool: Register, deps: McpDeps): void {
  tool("automation", "polpo_triggers_list", {
    title: "List triggers",
    description: "Triggers: public endpoints (POST /hooks/{id}) that receive form submissions and webhooks. Each with its endpoint URL, auth, contract version, delivery counts per status and last delivery. "
      + ACTIONS_HELP,
    inputSchema: { enabled: z.boolean().optional().describe("true: only enabled ones; false: only disabled ones"), limit: limitParam(30, 100), cursor: cursorParam() },
    outputSchema: { items: z.array(looseObject), next_cursor: z.string().nullable(), total: z.number().int().optional() },
    annotations: READ,
  }, async ({ enabled, limit, cursor }) => {
    const r = await apiGet(deps, "/triggers");
    if (!r.ok) return apiError(r, "Listing triggers");
    const all = ((r.data as TriggerRow[]) ?? []).filter((t) => enabled === undefined || t.enabled === enabled);
    const p = page(all, limit ?? 30, cursor);
    if (!p) return fail(BAD_CURSOR);
    return ok(`${p.items.map(triggerLine).join("\n") || "No triggers yet (polpo_trigger_create)."}${p.next_cursor ? `\n(more: cursor ${p.next_cursor})` : ""}`, p as unknown as Record<string, unknown>);
  });

  tool("automation", "polpo_trigger_get", {
    title: "Get a trigger",
    description: "A trigger's definition: endpoint, auth (hints only, never a secret), contract and its versions (with versions: the history; with diff_from/diff_to: a unified diff), filter, dedupe, rate limit, mapping, counts.",
    inputSchema: {
      id: z.string().min(1).describe("The trigger's id (polpo_triggers_list)"),
      versions: z.boolean().optional().describe("Include the contract's version history"),
      diff_from: z.number().int().optional().describe("A contract version to diff from"), diff_to: z.number().int().optional().describe("A contract version to diff to"),
    },
    outputSchema: { trigger: looseObject, versions: z.array(looseObject).optional(), diff: z.string().optional() },
    annotations: READ,
  }, async ({ id, versions, diff_from, diff_to }) => {
    const r = await apiGet(deps, `/triggers/${enc(id)}`);
    if (!r.ok) return r.status === 404 ? fail(`There is no trigger "${id}". List them with polpo_triggers_list.`) : apiError(r, `Reading trigger ${id}`);
    const t = r.data as TriggerRow;
    const lines = [triggerDetail(t), `curl: ${curl(t)}`];
    const out: Record<string, unknown> = { trigger: t };
    if (versions) {
      const v = await apiGet(deps, `/triggers/${enc(id)}/contract-versions`);
      if (v.ok) {
        out.versions = v.data;
        lines.push(`contract versions:\n${(v.data as Array<{ version: number; createdAt: string; by?: string; note?: string }>).map((x) => `  v${x.version} ${at(x.createdAt)}${x.by ? ` by ${x.by}` : ""}${x.note ? ` — ${x.note}` : ""}`).join("\n")}`);
      }
    }
    if (diff_from !== undefined && diff_to !== undefined) {
      const d = await apiGet(deps, `/triggers/${enc(id)}/contract-versions/diff${qs({ from: diff_from, to: diff_to })}`);
      if (!d.ok) return apiError(d, "Diffing contract versions");
      out.diff = (d.data as { diff: string }).diff;
      lines.push(`diff v${diff_from} → v${diff_to}:\n${out.diff}`);
    }
    return ok(lines.join("\n"), out);
  });

  tool("automation", "polpo_trigger_deliveries", {
    title: "A trigger's deliveries",
    description: "What a trigger received, newest first: status (accepted, rejected, filtered, duplicate, rate_limited), HTTP answer, reasons, the actions' overall status. "
      + "With delivery_id: that delivery with its payload (secrets redacted), contract errors, mapped values and its actions' runs (status, attempts, error, what each created: mission, task, chat session, notification).",
    inputSchema: {
      id: z.string().min(1).describe("The trigger's id"),
      delivery_id: z.string().optional().describe("One delivery (tdl_…): with its payload, errors and mapped values"),
      status: z.array(STATUS).optional().describe("Only these statuses"),
      test: z.boolean().optional().describe("true: only test deliveries; false: only real ones"),
      limit: limitParam(20, 200),
      cursor: z.string().optional().describe("next_cursor of the previous page"),
    },
    outputSchema: { deliveries: z.array(looseObject).optional(), delivery: looseObject.optional(), next_cursor: z.string().nullable().optional(), counts: looseObject.optional() },
    annotations: READ,
  }, async ({ id, delivery_id, status, test, limit, cursor }) => {
    if (delivery_id) {
      const r = await apiGet(deps, `/triggers/${enc(id)}/deliveries/${enc(delivery_id)}`);
      if (!r.ok) return r.status === 404 ? fail(`No delivery "${delivery_id}" for trigger "${id}" (only the newest are kept).`) : apiError(r, "Reading the delivery");
      const d = r.data as DeliveryRow;
      return ok([
        deliveryLine(d).slice(2),
        d.errors?.length ? `contract errors:\n${d.errors.map((e) => `  ${e}`).join("\n")}` : "",
        d.files?.length ? `files: ${d.files.map((f) => `${f.filename} (${f.size} B)`).join(", ")}` : "",
        d.body !== undefined ? `body${d.bodyTruncated ? " (truncated)" : ""}: ${short(JSON.stringify(d.body), 3000)}` : "body: not kept (refused before it was read or authenticated)",
        d.mapped ? `mapped: ${JSON.stringify(d.mapped)}` : "",
        d.mappingErrors?.length ? `mapping errors: ${d.mappingErrors.join("; ")}` : "",
        d.origin ? `arrived while trigger ${d.origin.triggerId}'s actions ran (delivery ${d.origin.deliveryId}, depth ${d.origin.depth ?? 1})` : "",
        d.actions?.length ? `actions ${d.actionsStatus}${d.actionsRequestedBy ? ` (for ${d.actionsRequestedBy})` : ""}:\n${d.actions.map(actionRunLine).join("\n")}` : "",
        d.previousActions?.length ? `earlier runs: ${d.previousActions.map((p) => `${p.status ?? "?"}${p.endedAt ? ` ${at(p.endedAt)}` : ""}`).join(", ")}` : "",
      ].filter(Boolean).join("\n"), { delivery: d });
    }
    const r = await apiGet(deps, `/triggers/${enc(id)}/deliveries${qs({ limit: limit ?? 20, cursor, status: status?.join(","), test })}`);
    if (!r.ok) return r.status === 404 ? fail(`There is no trigger "${id}".`) : apiError(r, "Listing deliveries");
    const p = r.data as { deliveries: DeliveryRow[]; nextCursor?: string; total: number; counts: Record<string, number> };
    return ok(`${p.deliveries.map(deliveryLine).join("\n") || "No deliveries."}${p.nextCursor ? `\n(more: cursor ${p.nextCursor})` : ""}`,
      { deliveries: p.deliveries, next_cursor: p.nextCursor ?? null, counts: p.counts });
  });

  tool("automation", "polpo_trigger_create", {
    title: "Create a trigger",
    description: "A public endpoint (POST <public URL>/hooks/{id}) for a form (Tally, Typeform…) or any service's webhook, with a contract (content types, size, JSON Schema), "
      + "an optional filter, dedupe, rate limit and mapping. It gets a generated secret (Authorization: Bearer or X-Polpo-Secret); the secret is shown once, "
      + "to admin scope only (else get one with polpo_trigger_auth action rotate_secret, admin, or on the dashboard). HMAC signatures and the IP allowlist: polpo_trigger_auth. "
      + "With actions (playbook, mission, task, agent, notify) it does something on each accepted delivery, e.g. 'when the form arrives run the onboarding playbook': "
      + "actions: [{ kind: 'playbook', playbook: 'onboarding', params: { email: '{{mapped.email}}' } }]. " + ACTIONS_HELP,
    inputSchema: { name: z.string().min(1).max(120).describe("A name people recognise, e.g. Tally signup form"), slug: z.string().max(40).optional().describe("The id starts with it (a random suffix is added)"), ...definitionShape },
    outputSchema: { trigger: looseObject, secret: z.string().optional(), curl: z.string() },
    annotations: WRITE,
  }, async ({ name, slug, ...def }) => {
    const r = await apiSend(deps, "POST", "/triggers", { name, ...(slug ? { id: slug } : {}), ...definitionBody(def) });
    if (!r.ok) return apiError(r, "Creating the trigger");
    const { trigger, secret } = r.data as { trigger: TriggerRow; secret?: string };
    const admin = hasScope(deps.principal ?? { scopes: ["polpo:admin"] }, "polpo:admin");
    const secretLine = secret
      ? admin ? `Secret (shown only now — give it to the person for the sender's Authorization: Bearer header, do not repeat or store it): ${secret}`
        : "A secret was generated; it is shown once and needs admin scope: ask an admin to rotate it (polpo_trigger_auth action rotate_secret) or use the dashboard."
      : "";
    return ok([`Created trigger ${trigger.name} [${trigger.id}] at ${trigger.endpoint}.`, secretLine, `curl: ${curl(trigger)}`,
      `Behind Tailscale Funnel the path /<instance>/hooks/ must be published. Dashboard: ${dashboardLink(deps, `/triggers?trigger=${enc(trigger.id)}`)}`,
      trigger.actions?.length ? `Actions:\n${trigger.actions.map(actionLine).join("\n")}` : "No actions yet: deliveries are only recorded (add actions with polpo_trigger_update)."].filter(Boolean).join("\n"),
    { trigger, ...(secret && admin ? { secret } : {}), curl: curl(trigger) });
  });

  tool("automation", "polpo_trigger_update", {
    title: "Change a trigger",
    description: "Change a trigger's name, description, enabled (disabling also skips its queued actions), contract (a change makes a new contract version), filter, dedupe, rate limit, mapping, retention, "
      + "actions (the whole list, in order: give every action, with its id to keep it) and action limits. "
      + "Only the fields given change; null removes filter, dedupe, mapping, contract.schema, actions. Auth and the IP allowlist: polpo_trigger_auth (admin). " + ACTIONS_HELP,
    inputSchema: { id: z.string().min(1).describe("The trigger's id"), name: z.string().min(1).max(120).optional().describe("A new name"), ...definitionShape },
    outputSchema: { trigger: looseObject },
    annotations: UPDATE,
  }, async ({ id, name, ...def }) => {
    const r = await apiSend(deps, "PATCH", `/triggers/${enc(id)}`, { ...(name ? { name } : {}), ...definitionBody(def) });
    if (!r.ok) return r.status === 404 ? fail(`There is no trigger "${id}".`) : apiError(r, `Changing trigger ${id}`);
    const { trigger } = r.data as { trigger: TriggerRow };
    return ok(`Changed:\n${triggerDetail(trigger)}`, { trigger });
  });

  tool("automation", "polpo_trigger_delete", {
    title: "Delete a trigger",
    description: "Delete a trigger, its deliveries, its contract history and its HMAC secret. Its endpoint answers 404 afterwards.",
    inputSchema: { id: z.string().min(1).describe("The trigger's id"), confirm: confirmParam("delete the trigger") },
    outputSchema: { deleted: z.boolean() },
    annotations: DESTRUCTIVE,
  }, async ({ id, confirm }) => {
    if (confirm !== true) return fail(`Deleting trigger ${id} removes its endpoint and every delivery. Ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "DELETE", `/triggers/${enc(id)}`);
    if (!r.ok) return r.status === 404 ? fail(`There is no trigger "${id}".`) : apiError(r, `Deleting trigger ${id}`);
    return ok(`Deleted trigger ${id}.`, { deleted: true });
  });

  tool("automation", "polpo_trigger_test", {
    title: "Test a trigger",
    description: "Test tools: send (a test delivery, recorded with test: true, through contract, filter, dedupe and mapping); validate (a sample against the contract, filter and mapping — saved or a draft — without recording); "
      + "infer_schema (a JSON Schema from a sample or a delivery, to save as the contract with polpo_trigger_update); replay (a stored delivery through the current contract, filter, dedupe and mapping, dry run); "
      + "preview_actions (the actions, or a draft of them, rendered against a delivery, the newest accepted by default: params, task text, the agent's message, the notification; nothing runs). "
      + "A test delivery runs no action unless sample.run_actions is true.",
    inputSchema: {
      id: z.string().min(1).describe("The trigger's id"),
      action: z.enum(["send", "validate", "infer_schema", "replay", "preview_actions"]).describe("What to do (see the description)"),
      sample: sampleInput.optional().describe("send, validate, infer_schema"),
      delivery_id: z.string().optional().describe("replay, infer_schema, preview_actions"),
      actions: z.array(actionInput).max(10).optional().describe("preview_actions: a draft of the actions (default: the saved ones)"),
      draft: z.object({ contract: contractInput.optional(), filter: filterInput.optional(), mapping: z.record(z.string(), z.string()).nullable().optional() }).optional()
        .describe("validate / replay: unsaved changes to try"),
    },
    outputSchema: { result: looseObject.optional(), delivery: looseObject.optional(), schema: looseObject.optional() },
    annotations: WRITE,
  }, async ({ id, action, sample, delivery_id, draft, actions }) => {
    const draftBody = draft ? { ...(draft.contract ? { contract: contractBody(draft.contract).contract } : {}), ...(draft.filter !== undefined ? { filter: draft.filter } : {}), ...(draft.mapping !== undefined ? { mapping: draft.mapping } : {}) } : undefined;
    const dry = (res: { status: string; reasons: string[]; errors: string[]; filterMatched: boolean; mapped?: unknown; mappingErrors?: string[]; duplicateOf?: string; dedupeKey?: string }) => [
      `→ ${res.status}${res.reasons.length ? ` (${res.reasons.join("; ")})` : ""}`,
      res.errors.length ? `contract errors:\n${res.errors.map((e) => `  ${e}`).join("\n")}` : "contract: ok",
      `filter: ${res.filterMatched ? "matches" : "does not match"}`,
      res.dedupeKey ? `dedupe key: ${res.dedupeKey}${res.duplicateOf ? ` (duplicate of ${res.duplicateOf})` : ""}` : "",
      res.mapped ? `mapped: ${JSON.stringify(res.mapped)}` : "",
      res.mappingErrors?.length ? `mapping errors: ${res.mappingErrors.join("; ")}` : "",
    ].filter(Boolean).join("\n");
    switch (action) {
      case "send": {
        if (!sample) return fail("send needs sample { body, content_type? }.");
        const r = await apiSend(deps, "POST", `/triggers/${enc(id)}/test`, sampleBody(sample));
        if (!r.ok) return r.status === 404 ? fail(`There is no trigger "${id}".`) : apiError(r, "Sending a test delivery");
        const d = r.data as DeliveryRow;
        const acts = d.actions?.length ? `\nactions ${d.actionsStatus}: they run now; follow them with polpo_trigger_deliveries delivery_id ${d.id}` : sample.run_actions ? "\nThis trigger has no actions." : "\nNo action ran (a test runs them only with run_actions: true).";
        return ok(`Test delivery ${d.id}: ${d.status} (HTTP ${d.httpStatus})${d.reasons.length ? ` — ${d.reasons.join("; ")}` : ""}${d.errors?.length ? `\n${d.errors.join("\n")}` : ""}${d.mapped ? `\nmapped: ${JSON.stringify(d.mapped)}` : ""}${acts}`, { delivery: d });
      }
      case "preview_actions": {
        const r = await apiSend(deps, "POST", `/triggers/${enc(id)}/actions/preview`, { ...(delivery_id ? { deliveryId: delivery_id } : {}), ...(actions ? { actions: actions.map(actionBody) } : {}) });
        if (!r.ok) return r.status === 404 ? fail(`There is no trigger "${id}" (or no delivery "${delivery_id}").`) : apiError(r, "Previewing the actions");
        const p = r.data as { deliveryId?: string; note?: string; actions: Array<{ actionId: string; kind: string; rendered: Record<string, unknown>; error?: string }> };
        return ok([
          p.note ?? `The actions on delivery ${p.deliveryId} (nothing ran; {{steps.…}} render empty in a preview):`,
          ...p.actions.map((a) => `- [${a.actionId}] ${a.kind}${a.error ? ` — error: ${a.error}` : ""}\n${short(JSON.stringify(a.rendered, null, 1), 2500)}`),
        ].join("\n"), { result: p as unknown as Record<string, unknown> });
      }
      case "validate": {
        if (!sample) return fail("validate needs sample { body, content_type? }.");
        const r = await apiSend(deps, "POST", `/triggers/${enc(id)}/validate`, { sample: sampleBody(sample), ...(draftBody ? { draft: draftBody } : {}) });
        if (!r.ok) return apiError(r, "Validating the sample");
        return ok(dry(r.data as never), { result: r.data as Record<string, unknown> });
      }
      case "replay": {
        if (!delivery_id) return fail("replay needs delivery_id (polpo_trigger_deliveries).");
        const r = await apiSend(deps, "POST", `/triggers/${enc(id)}/deliveries/${enc(delivery_id)}/replay`, draftBody ? { draft: draftBody } : {});
        if (!r.ok) return apiError(r, "Replaying the delivery");
        return ok(`Replay of ${delivery_id} (dry run, nothing recorded):\n${dry(r.data as never)}`, { result: r.data as Record<string, unknown> });
      }
      case "infer_schema": {
        if (!sample && !delivery_id) return fail("infer_schema needs sample or delivery_id.");
        const r = await apiSend(deps, "POST", `/triggers/${enc(id)}/infer-schema`, delivery_id ? { deliveryId: delivery_id } : { sample: sample!.body });
        if (!r.ok) return apiError(r, "Inferring a schema");
        const schema = (r.data as { schema: Record<string, unknown> }).schema;
        return ok(`Inferred schema (save it with polpo_trigger_update contract.schema):\n${JSON.stringify(schema, null, 1)}`, { schema });
      }
    }
  });

  tool("automation", "polpo_trigger_run_actions", {
    title: "Re-run a delivery's actions",
    description: "Run a trigger's current actions again on a stored accepted delivery (a test one too): after a fix, or when an action failed. "
      + "They run now, in order; the previous runs stay on the delivery. Refused while its actions are still queued or running, or when the trigger is disabled. "
      + "Follow them with polpo_trigger_deliveries delivery_id.",
    inputSchema: {
      id: z.string().min(1).describe("The trigger's id"),
      delivery_id: z.string().min(1).describe("The delivery (tdl_…; polpo_trigger_deliveries)"),
    },
    outputSchema: { delivery_id: z.string(), actions_status: z.string().optional(), actions: z.array(looseObject) },
    annotations: { ...WRITE, openWorldHint: true },
  }, async ({ id, delivery_id }) => {
    const r = await apiSend(deps, "POST", `/triggers/${enc(id)}/deliveries/${enc(delivery_id)}/run-actions`);
    if (!r.ok) return r.status === 404 ? fail(`No delivery "${delivery_id}" for trigger "${id}" (only the newest are kept).`) : apiError(r, "Re-running the actions");
    const d = r.data as { deliveryId: string; actionsStatus?: string; actions: ActionRunRow[] };
    return ok(`Actions of ${d.deliveryId} ${d.actionsStatus ?? "queued"}:\n${d.actions.map(actionRunLine).join("\n")}\nFollow them with polpo_trigger_deliveries delivery_id ${d.deliveryId}.`,
      { delivery_id: d.deliveryId, ...(d.actionsStatus ? { actions_status: d.actionsStatus } : {}), actions: d.actions as unknown as Array<Record<string, unknown>> });
  });

  tool("automation", "polpo_trigger_auth", {
    title: "Secure a trigger",
    description: "A trigger's secrets and access (admin): rotate_secret (a new generated secret, shown once; the old keeps working overlap_seconds, default a day); "
      + "secret (turn the generated secret on/off, allow ?token=); hmac (configure an HMAC signature: header, algorithm sha256/sha1, encoding hex/base64, prefix like sha256=, timestamp header and tolerance, signed payload; "
      + "the sender's signing secret is entered on the dashboard — setup_url — never in chat; or generate: true makes one, shown once); remove_hmac; ip_allowlist (CIDRs; empty: any).",
    inputSchema: {
      id: z.string().min(1).describe("The trigger's id"),
      action: z.enum(["rotate_secret", "secret", "hmac", "remove_hmac", "ip_allowlist"]).describe("What to change (see the description)"),
      overlap_seconds: z.number().int().min(0).max(604800).optional().describe("rotate_secret / hmac: how long the previous secret keeps working"),
      enabled: z.boolean().optional().describe("secret: the generated secret on or off"),
      allow_query_auth: z.boolean().optional().describe("secret: also accept ?token= (URLs end up in logs: only when the sender cannot set headers)"),
      hmac: z.object({
        header: z.string(), algorithm: z.enum(["sha256", "sha1"]).optional(), encoding: z.enum(["hex", "base64"]).optional(), prefix: z.string().optional(),
        timestamp_header: z.string().optional(), tolerance_seconds: z.number().int().min(1).max(86400).optional(), signed_payload: z.string().optional(),
      }).optional().describe("hmac: the signature check (header, algorithm, encoding, prefix, timestamp header and tolerance, signed payload such as {timestamp}.{body})"),
      generate: z.boolean().optional().describe("hmac: Polpo generates the signing secret (shown once) instead of the person entering the sender's"),
      ip_allowlist: z.array(z.string()).max(50).optional().describe("ip_allowlist: CIDRs or addresses (v4 or v6); empty: any address"),
    },
    outputSchema: { trigger: looseObject.optional(), secret: z.string().optional(), setup_url: z.string().optional(), setup_id: z.string().optional(), next_step: z.string().optional() },
    annotations: UPDATE,
    scope: "polpo:admin",
  }, async ({ id, action, overlap_seconds, enabled, allow_query_auth, hmac, generate, ip_allowlist }) => {
    const notFound = (r: { status: number; error: string }, what: string) => (r.status === 404 ? fail(`There is no trigger "${id}".`) : apiError(r as never, what));
    if (action === "rotate_secret") {
      const r = await apiSend(deps, "POST", `/triggers/${enc(id)}/rotate-secret`, overlap_seconds !== undefined ? { overlapSeconds: overlap_seconds } : {});
      if (!r.ok) return notFound(r, "Rotating the secret");
      const d = r.data as { secret: string; previousValidUntil?: string; trigger: TriggerRow };
      return ok(`New secret (shown only now — give it to the person, do not repeat or store it): ${d.secret}\n${d.previousValidUntil ? `The previous one works until ${d.previousValidUntil}.` : "The previous one stopped working."}`,
        { trigger: d.trigger, secret: d.secret });
    }
    if (action === "secret") {
      const r = await apiSend(deps, "PATCH", `/triggers/${enc(id)}`, { auth: { ...(enabled !== undefined ? { secret: enabled } : {}), ...(allow_query_auth !== undefined ? { allowQueryToken: allow_query_auth } : {}) } });
      if (!r.ok) return notFound(r, "Changing the secret settings");
      const d = r.data as { trigger: TriggerRow; secret?: string };
      return ok(`${triggerDetail(d.trigger)}${d.secret ? `\nNew secret (shown only now): ${d.secret}` : ""}`, { trigger: d.trigger, ...(d.secret ? { secret: d.secret } : {}) });
    }
    if (action === "remove_hmac") {
      const r = await apiSend(deps, "PATCH", `/triggers/${enc(id)}`, { auth: { hmac: null } });
      if (!r.ok) return notFound(r, "Removing the HMAC check");
      await apiSend(deps, "DELETE", `/triggers/${enc(id)}/hmac-secret`);
      return ok(`HMAC check removed.\n${triggerDetail((r.data as { trigger: TriggerRow }).trigger)}`, { trigger: (r.data as { trigger: TriggerRow }).trigger });
    }
    if (action === "ip_allowlist") {
      const r = await apiSend(deps, "PATCH", `/triggers/${enc(id)}`, { auth: { ipAllowlist: ip_allowlist ?? [] } });
      if (!r.ok) return notFound(r, "Setting the IP allowlist");
      return ok(`IP allowlist: ${(ip_allowlist ?? []).join(", ") || "any address"}.`, { trigger: (r.data as { trigger: TriggerRow }).trigger });
    }
    // hmac
    if (hmac) {
      const r = await apiSend(deps, "PATCH", `/triggers/${enc(id)}`, { auth: { hmac: {
        header: hmac.header, algorithm: hmac.algorithm ?? "sha256", encoding: hmac.encoding ?? "hex", ...(hmac.prefix ? { prefix: hmac.prefix } : {}),
        ...(hmac.timestamp_header ? { timestampHeader: hmac.timestamp_header } : {}), ...(hmac.tolerance_seconds ? { toleranceSeconds: hmac.tolerance_seconds } : {}),
        ...(hmac.signed_payload ? { signedPayload: hmac.signed_payload } : {}),
      } } });
      if (!r.ok) return notFound(r, "Configuring the HMAC check");
    }
    if (generate) {
      const r = await apiSend(deps, "PUT", `/triggers/${enc(id)}/hmac-secret`, { generate: true, ...(overlap_seconds !== undefined ? { overlapSeconds: overlap_seconds } : {}) });
      if (!r.ok) return notFound(r, "Generating the HMAC secret");
      return ok(`HMAC signing secret (shown only now — the sender signs with it; do not repeat or store it): ${(r.data as { secret: string }).secret}`, { secret: (r.data as { secret: string }).secret });
    }
    const t = await apiGet(deps, `/triggers/${enc(id)}`);
    if (!t.ok) return notFound(t, "Reading the trigger");
    const trigger = t.data as TriggerRow;
    if (!trigger.auth.hmac) return fail("This trigger has no HMAC check: give hmac { header, algorithm, encoding, prefix? }.");
    if (trigger.hmacSecret?.secretSet && !hmac) return ok(`The HMAC secret is set${trigger.hmacSecret.previousUntil ? ` (the previous works until ${trigger.hmacSecret.previousUntil})` : ""}.`, { trigger });
    const h = setupHandoff(deps, { kind: "trigger", item: id, field: "hmac" }, `signing secret of ${trigger.name} (from the sender's webhook settings)`);
    return ok(`HMAC check configured${trigger.hmacSecret?.secretSet ? " (secret already set)" : "; the signing secret is not set yet"}. ${trigger.hmacSecret?.secretSet ? "" : h.next_step}`, { trigger, ...(trigger.hmacSecret?.secretSet ? {} : h) });
  });
}
