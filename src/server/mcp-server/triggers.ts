/**
 * Triggers: public endpoints (POST /hooks/{id}) that receive form submissions and webhooks, check
 * them (secret, HMAC, IP allowlist, contract, filter, dedupe, rate limit) and record each delivery
 * with the values an action would receive (mapping). Registration and reception only: no action
 * runs on a delivery yet (the action engine comes later).
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
};
type DeliveryRow = {
  id: string; receivedAt: string; status: string; httpStatus: number; reasons: string[]; errors?: string[]; test?: boolean; kind?: string; bytes: number;
  duplicateOf?: string; count?: number; body?: unknown; mapped?: Record<string, unknown>; mappingErrors?: string[]; headers?: Record<string, string>;
  files?: Array<{ filename: string; size: number }>; bodyTruncated?: boolean; contractVersion: number; ip?: string;
};

const NO_ACTIONS = "Nothing runs on a delivery yet (the action engine comes later): deliveries are recorded with their mapped values.";
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
  + `${d.count && d.count > 1 ? ` ×${d.count}` : ""}${d.duplicateOf ? ` dup of ${d.duplicateOf}` : ""}${d.reasons.length ? ` · ${short(d.reasons.join("; "), 160)}` : ""}`;

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
};
type Def = { description?: string | null; enabled?: boolean; contract?: z.infer<typeof contractInput>; filter?: z.infer<typeof filterInput>; dedupe?: { key: string; ttl_seconds?: number } | null; rate_limit_per_minute?: number; mapping?: Record<string, string> | null; retention?: number };
const definitionBody = (d: Def) => ({
  ...(d.description !== undefined ? { description: d.description } : {}), ...(d.enabled !== undefined ? { enabled: d.enabled } : {}),
  ...contractBody(d.contract), ...(d.filter !== undefined ? { filter: d.filter } : {}),
  ...(d.dedupe !== undefined ? { dedupe: d.dedupe === null ? null : { key: d.dedupe.key, ...(d.dedupe.ttl_seconds ? { ttlSeconds: d.dedupe.ttl_seconds } : {}) } } : {}),
  ...(d.rate_limit_per_minute !== undefined ? { rateLimitPerMinute: d.rate_limit_per_minute } : {}),
  ...(d.mapping !== undefined ? { mapping: d.mapping } : {}), ...(d.retention !== undefined ? { retention: d.retention } : {}),
});
const sampleInput = z.object({
  body: z.unknown().describe("The parsed body as it would arrive (JSON value; form fields as an object; text as a string)"),
  content_type: CONTENT.optional().describe("Default json"),
  headers: z.record(z.string(), z.string()).optional(),
  query: z.record(z.string(), z.string()).optional(),
});
const sampleBody = (s: z.infer<typeof sampleInput>) => ({ body: s.body, ...(s.content_type ? { contentType: s.content_type } : {}), ...(s.headers ? { headers: s.headers } : {}), ...(s.query ? { query: s.query } : {}) });
const curl = (t: TriggerRow) => `curl -X POST '${t.endpoint}' -H 'content-type: application/json'${t.auth.secret ? " -H 'Authorization: Bearer <secret>'" : ""}${t.auth.hmac ? ` -H '${t.auth.hmac.header}: <signature>'` : ""} -d '{"hello":"world"}'`;

export function registerTriggerTools(tool: Register, deps: McpDeps): void {
  tool("automation", "polpo_triggers_list", {
    title: "List triggers",
    description: "Triggers: public endpoints (POST /hooks/{id}) that receive form submissions and webhooks. Each with its endpoint URL, auth, contract version, delivery counts per status and last delivery. "
      + NO_ACTIONS,
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
    description: "What a trigger received, newest first: status (accepted, rejected, filtered, duplicate, rate_limited), HTTP answer, reasons. "
      + "With delivery_id: that delivery with its payload (secrets redacted), contract errors and mapped values.",
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
      + NO_ACTIONS,
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
      `Behind Tailscale Funnel the path /<instance>/hooks/ must be published. Dashboard: ${dashboardLink(deps, `/triggers?trigger=${enc(trigger.id)}`)}`, NO_ACTIONS].filter(Boolean).join("\n"),
    { trigger, ...(secret && admin ? { secret } : {}), curl: curl(trigger) });
  });

  tool("automation", "polpo_trigger_update", {
    title: "Change a trigger",
    description: "Change a trigger's name, description, enabled, contract (a change makes a new contract version), filter, dedupe, rate limit, mapping, retention. "
      + "Only the fields given change; null removes filter, dedupe, mapping, contract.schema. Auth and the IP allowlist: polpo_trigger_auth (admin).",
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
      + "infer_schema (a JSON Schema from a sample or a delivery, to save as the contract with polpo_trigger_update); replay (a stored delivery through the current contract, filter, dedupe and mapping, dry run). "
      + NO_ACTIONS,
    inputSchema: {
      id: z.string().min(1).describe("The trigger's id"),
      action: z.enum(["send", "validate", "infer_schema", "replay"]).describe("What to do (see the description)"),
      sample: sampleInput.optional().describe("send, validate, infer_schema"),
      delivery_id: z.string().optional().describe("replay, infer_schema"),
      draft: z.object({ contract: contractInput.optional(), filter: filterInput.optional(), mapping: z.record(z.string(), z.string()).nullable().optional() }).optional()
        .describe("validate / replay: unsaved changes to try"),
    },
    outputSchema: { result: looseObject.optional(), delivery: looseObject.optional(), schema: looseObject.optional() },
    annotations: WRITE,
  }, async ({ id, action, sample, delivery_id, draft }) => {
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
        return ok(`Test delivery ${d.id}: ${d.status} (HTTP ${d.httpStatus})${d.reasons.length ? ` — ${d.reasons.join("; ")}` : ""}${d.errors?.length ? `\n${d.errors.join("\n")}` : ""}${d.mapped ? `\nmapped: ${JSON.stringify(d.mapped)}` : ""}\n${NO_ACTIONS}`, { delivery: d });
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
