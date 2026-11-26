/**
 * The trigger service: definitions (create, change, delete, secrets and their rotation, the HMAC
 * secret in the vault), reception of POST /hooks/{id} (IP allowlist → rate limit → size → secret /
 * signature → content type → parse → contract → filter → dedupe → record) and the test tools (a test
 * delivery, a dry run of a sample or of a stored delivery, schema inference, contract diffs).
 *
 * Every delivery is recorded (accepted, rejected, filtered, duplicate, rate_limited; at most one
 * rate_limited record a minute) and announced as `trigger:delivery` on the orchestrator's bus — what
 * the action engine will subscribe to. No action runs: the engine is not built yet.
 */
import { randomBytes } from "node:crypto";
import { unifiedLineDiff, type VaultStore } from "@polpo-ai/core";
import { FileTriggerStore } from "./store.js";
import {
  applyMapping, contentKind, contractErrors, contractProblems, dedupeHash, dedupeKeyOf, filterMatches, filterProblems, generateTriggerSecret,
  hashSecret, hmacProblems, inferJsonSchema, ipAllowed, matchSecret, parseBody, parseCidr, providedSecret, storableBody, storableHeaders,
  storableQuery, templateProblems, TriggerParseError, verifyHmac, type DeliveryScope,
} from "./evaluate.js";
import {
  TRIGGER_CONTENT_TYPES, TRIGGER_LIMITS,
  type Trigger, type TriggerAuth, type TriggerContentType, type TriggerContract, type TriggerContractRevision, type TriggerDedupe,
  type TriggerDelivery, type TriggerDeliveryPage, type TriggerDeliveryStatus, type TriggerDryRun, type TriggerFileMeta, type TriggerFilter,
  type TriggerHmacConfig, type TriggerHmacSecretStatus, type TriggerView,
} from "./types.js";

/** Vault namespace of the triggers' HMAC secrets (reserved: internal code only). */
export const TRIGGER_VAULT_OWNER = "$triggers";
export const triggerVaultService = (id: string) => `trigger-${id}-hmac`;
/** The public path prefix (Tailscale Funnel: publish /<instance>/hooks/). */
export const TRIGGER_PUBLIC_PATH = "/hooks";

export interface TriggerEventPayloads {
  changed: { id: string; action: "created" | "updated" | "deleted" | "secret-rotated" | "hmac-secret" };
  delivery: { triggerId: string; deliveryId: string; status: TriggerDeliveryStatus; httpStatus: number; test?: boolean; replay?: boolean; mapped?: Record<string, unknown> };
}

export interface TriggerServiceDeps {
  polpoDir: () => string;
  vault: () => VaultStore | null | undefined;
  /** The public base URL (POLPO_PUBLIC_URL), for the endpoint's URL. */
  publicBase?: () => string | undefined;
  emit?: <K extends keyof TriggerEventPayloads>(kind: K, payload: TriggerEventPayloads[K]) => void;
  now?: () => number;
}

export class TriggerError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 503, readonly code = status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : "VALIDATION_ERROR", readonly problems?: string[]) {
    super(message);
  }
}

/** What create and update accept. null clears an optional part. */
export interface TriggerInput {
  /** create: a slug to start the id with (a random suffix is always added). */
  id?: string;
  name?: string;
  description?: string | null;
  enabled?: boolean;
  owner?: string | null;
  auth?: Partial<TriggerAuth> & { hmac?: TriggerHmacConfig | null };
  contract?: Partial<TriggerContract> & { schema?: Record<string, unknown> | null };
  /** A line for the contract revision this change makes. */
  contractNote?: string;
  filter?: TriggerFilter | null;
  dedupe?: TriggerDedupe | null;
  rateLimitPerMinute?: number;
  mapping?: Record<string, string> | null;
  retention?: number;
}

/** A sample to dry-run, test or validate: the parsed body as it would arrive. */
export interface TriggerSample {
  body: unknown;
  /** json (default), form, multipart or text. */
  contentType?: TriggerContentType;
  headers?: Record<string, string>;
  query?: Record<string, string | string[]>;
}

/** What the public endpoint answers. */
export interface TriggerReceiveResult {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** A draft of the parts a dry run may override (unsaved edits). */
export interface TriggerDraft {
  contract?: Partial<TriggerContract> & { schema?: Record<string, unknown> | null };
  filter?: TriggerFilter | null;
  dedupe?: TriggerDedupe | null;
  mapping?: Record<string, string> | null;
}

const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "trigger";
const newDeliveryId = (now: number) => `tdl_${now.toString(36)}${randomBytes(5).toString("hex")}`;
const iso = (ms: number) => new Date(ms).toISOString();

export class TriggerService {
  readonly store: FileTriggerStore;
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly deps: TriggerServiceDeps) {
    this.store = new FileTriggerStore(deps.polpoDir);
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  // ── Views ──

  endpointPath(id: string): string { return `${TRIGGER_PUBLIC_PATH}/${id}`; }

  endpointUrl(id: string): string {
    const base = this.deps.publicBase?.()?.replace(/\/+$/, "");
    return base ? `${base}${this.endpointPath(id)}` : this.endpointPath(id);
  }

  async view(t: Trigger): Promise<TriggerView> {
    const { secrets, ...rest } = t;
    const now = this.now();
    return {
      ...rest,
      secrets: secrets.filter((s) => !s.expiresAt || Date.parse(s.expiresAt) > now).map(({ hash: _h, ...s }) => s),
      ...(t.auth.hmac ? { hmacSecret: await this.hmacStatus(t.id) } : {}),
      endpoint: this.endpointUrl(t.id),
      path: this.endpointPath(t.id),
      stats: this.store.stats(t.id),
    };
  }

  async list(): Promise<TriggerView[]> {
    return Promise.all(this.store.list().map((t) => this.view(t)));
  }

  require(id: string): Trigger {
    const t = this.store.get(id);
    if (!t) throw new TriggerError(`No trigger "${id}"`, 404);
    return t;
  }

  async get(id: string): Promise<TriggerView> {
    return this.view(this.require(id));
  }

  // ── Definitions ──

  private normalize(base: Trigger, input: TriggerInput): { next: Trigger; problems: string[]; contractChanged: boolean } {
    const problems: string[] = [];
    const next: Trigger = { ...base, auth: { ...base.auth }, contract: { ...base.contract } };
    if (input.name !== undefined) {
      if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 120) problems.push("name: 1–120 characters");
      else next.name = input.name.trim();
    }
    if (input.description !== undefined) {
      if (input.description === null || input.description === "") delete next.description;
      else if (typeof input.description !== "string" || input.description.length > 2000) problems.push("description: at most 2000 characters");
      else next.description = input.description;
    }
    if (input.enabled !== undefined) next.enabled = !!input.enabled;
    if (input.owner !== undefined) {
      if (input.owner === null || input.owner === "") delete next.owner; else next.owner = String(input.owner).slice(0, 200);
    }
    if (input.auth) {
      const a = input.auth;
      if (a.secret !== undefined) next.auth.secret = !!a.secret;
      if (a.allowQueryToken !== undefined) next.auth.allowQueryToken = !!a.allowQueryToken;
      if (a.hmac === null) delete next.auth.hmac;
      else if (a.hmac !== undefined) {
        const h: TriggerHmacConfig = {
          header: String(a.hmac.header ?? "").trim().toLowerCase(), algorithm: a.hmac.algorithm ?? "sha256", encoding: a.hmac.encoding ?? "hex",
          ...(a.hmac.prefix ? { prefix: a.hmac.prefix } : {}),
          ...(a.hmac.timestampHeader ? { timestampHeader: a.hmac.timestampHeader.trim().toLowerCase() } : {}),
          ...(a.hmac.toleranceSeconds !== undefined ? { toleranceSeconds: a.hmac.toleranceSeconds } : {}),
          ...(a.hmac.signedPayload ? { signedPayload: a.hmac.signedPayload } : {}),
        };
        problems.push(...hmacProblems(h));
        next.auth.hmac = h;
      }
      if (a.ipAllowlist !== undefined) {
        const list = (a.ipAllowlist ?? []).map((s) => String(s).trim()).filter(Boolean);
        if (list.length > TRIGGER_LIMITS.maxIpAllowlist) problems.push(`auth.ipAllowlist: at most ${TRIGGER_LIMITS.maxIpAllowlist} entries`);
        for (const e of list) { const c = parseCidr(e); if (typeof c === "string") problems.push(`auth.ipAllowlist: ${c}`); }
        if (list.length) next.auth.ipAllowlist = list; else delete next.auth.ipAllowlist;
      }
    }
    if (!next.auth.secret && !next.auth.hmac) problems.push("auth: enable the generated secret, an HMAC signature, or both — a trigger is never open");
    let contractChanged = false;
    if (input.contract) {
      const c = input.contract;
      const contract: TriggerContract = {
        contentTypes: c.contentTypes ? [...new Set(c.contentTypes)] : base.contract.contentTypes,
        maxBodyBytes: c.maxBodyBytes ?? base.contract.maxBodyBytes,
        ...((c.maxFileBytes ?? base.contract.maxFileBytes) !== undefined ? { maxFileBytes: c.maxFileBytes ?? base.contract.maxFileBytes } : {}),
        ...(c.schema === null ? {} : (c.schema ?? base.contract.schema) ? { schema: (c.schema ?? base.contract.schema)! } : {}),
      };
      problems.push(...contractProblems(contract));
      contractChanged = JSON.stringify(contract) !== JSON.stringify(base.contract);
      next.contract = contract;
    }
    if (input.filter !== undefined) {
      if (input.filter === null || !input.filter.conditions?.length) delete next.filter;
      else {
        problems.push(...filterProblems(input.filter));
        next.filter = { mode: input.filter.mode ?? "all", conditions: input.filter.conditions.map((c) => ({ path: String(c.path).trim(), op: c.op, ...(c.value !== undefined ? { value: c.value } : {}) })) };
      }
    }
    if (input.dedupe !== undefined) {
      if (input.dedupe === null || !input.dedupe.key?.trim()) delete next.dedupe;
      else {
        problems.push(...templateProblems("dedupe.key", input.dedupe.key));
        const ttl = input.dedupe.ttlSeconds ?? 86_400;
        if (!Number.isInteger(ttl) || ttl < 1 || ttl > TRIGGER_LIMITS.maxDedupeTtlSeconds) problems.push(`dedupe.ttlSeconds: 1–${TRIGGER_LIMITS.maxDedupeTtlSeconds}`);
        next.dedupe = { key: input.dedupe.key.trim(), ttlSeconds: ttl };
      }
    }
    if (input.rateLimitPerMinute !== undefined) {
      if (!Number.isInteger(input.rateLimitPerMinute) || input.rateLimitPerMinute < 1 || input.rateLimitPerMinute > TRIGGER_LIMITS.maxRateLimitPerMinute) problems.push(`rateLimitPerMinute: 1–${TRIGGER_LIMITS.maxRateLimitPerMinute}`);
      else next.rateLimitPerMinute = input.rateLimitPerMinute;
    }
    if (input.mapping !== undefined) {
      if (input.mapping === null || Object.keys(input.mapping).length === 0) delete next.mapping;
      else {
        const entries = Object.entries(input.mapping);
        if (entries.length > TRIGGER_LIMITS.maxMappingFields) problems.push(`mapping: at most ${TRIGGER_LIMITS.maxMappingFields} fields`);
        for (const [k, v] of entries) {
          if (!/^[A-Za-z_][\w-]{0,63}$/.test(k)) problems.push(`mapping: "${k}" is not a field name (letters, digits, _ and -)`);
          problems.push(...templateProblems(`mapping.${k}`, v));
        }
        next.mapping = Object.fromEntries(entries.map(([k, v]) => [k, String(v)]));
      }
    }
    if (input.retention !== undefined) {
      if (!Number.isInteger(input.retention) || input.retention < 1 || input.retention > TRIGGER_LIMITS.maxRetention) problems.push(`retention: 1–${TRIGGER_LIMITS.maxRetention}`);
      else next.retention = input.retention;
    }
    return { next, problems, contractChanged };
  }

  /** Create a trigger. With the generated secret on, `secret` is returned this once (only its hash is kept). */
  async create(input: TriggerInput, by?: string): Promise<{ trigger: TriggerView; secret?: string }> {
    if (!input.name?.trim()) throw new TriggerError("name is required", 400);
    const now = this.now();
    let id = "";
    for (let i = 0; i < 5 && (!id || this.store.exists(id)); i++) id = `${slugify(input.id || input.name)}-${randomBytes(4).toString("hex")}`;
    const base: Trigger = {
      id, name: input.name.trim(), enabled: true, createdAt: iso(now), updatedAt: iso(now),
      ...(by ? { owner: by } : {}),
      auth: { secret: input.auth?.secret ?? !input.auth?.hmac },
      secrets: [],
      contract: { contentTypes: ["json"], maxBodyBytes: TRIGGER_LIMITS.defaultMaxBodyBytes },
      contractVersion: 1,
      rateLimitPerMinute: TRIGGER_LIMITS.defaultRateLimitPerMinute,
      retention: TRIGGER_LIMITS.defaultRetention,
    };
    const { next, problems } = this.normalize(base, { ...input, auth: { ...input.auth, secret: base.auth.secret } });
    if (problems.length) throw new TriggerError(`Invalid trigger: ${problems.join("; ")}`, 400, "VALIDATION_ERROR", problems);
    let secret: string | undefined;
    if (next.auth.secret) {
      secret = generateTriggerSecret();
      next.secrets = [{ id: `sec_${randomBytes(4).toString("hex")}`, hash: hashSecret(secret), hint: `${secret.slice(0, 8)}…`, createdAt: iso(now) }];
    }
    this.store.save(next);
    this.store.addContractRevision(id, { version: 1, contract: next.contract, createdAt: iso(now), ...(by ? { by } : {}), note: input.contractNote ?? "Created" });
    this.deps.emit?.("changed", { id, action: "created" });
    return { trigger: await this.view(next), ...(secret ? { secret } : {}) };
  }

  /** Change a trigger; a contract change makes a new revision. Turning the generated secret on makes one (returned this once). */
  async update(id: string, input: TriggerInput, by?: string): Promise<{ trigger: TriggerView; secret?: string }> {
    const current = this.require(id);
    const { next, problems, contractChanged } = this.normalize(current, input);
    if (problems.length) throw new TriggerError(`Invalid trigger: ${problems.join("; ")}`, 400, "VALIDATION_ERROR", problems);
    const now = this.now();
    next.updatedAt = iso(now);
    let secret: string | undefined;
    if (next.auth.secret && !next.secrets.some((s) => !s.expiresAt || Date.parse(s.expiresAt) > now)) {
      secret = generateTriggerSecret();
      next.secrets = [{ id: `sec_${randomBytes(4).toString("hex")}`, hash: hashSecret(secret), hint: `${secret.slice(0, 8)}…`, createdAt: iso(now) }];
    }
    if (contractChanged) {
      next.contractVersion = current.contractVersion + 1;
      this.store.addContractRevision(id, { version: next.contractVersion, contract: next.contract, createdAt: iso(now), ...(by ? { by } : {}), ...(input.contractNote ? { note: input.contractNote } : {}) });
    }
    this.store.save(next);
    if (next.retention < current.retention) this.store.prune(id, next.retention);
    this.deps.emit?.("changed", { id, action: "updated" });
    return { trigger: await this.view(next), ...(secret ? { secret } : {}) };
  }

  async delete(id: string): Promise<boolean> {
    if (!this.store.exists(id)) return false;
    this.store.delete(id);
    this.hits.delete(id);
    await this.deps.vault()?.remove(TRIGGER_VAULT_OWNER, triggerVaultService(id)).catch(() => false);
    this.deps.emit?.("changed", { id, action: "deleted" });
    return true;
  }

  /** A new generated secret, returned this once; the previous keeps working for `overlapSeconds` (0: revoked now). */
  async rotateSecret(id: string, overlapSeconds: number = TRIGGER_LIMITS.defaultOverlapSeconds): Promise<{ secret: string; previousValidUntil?: string; trigger: TriggerView }> {
    const t = this.require(id);
    if (!Number.isInteger(overlapSeconds) || overlapSeconds < 0 || overlapSeconds > TRIGGER_LIMITS.maxOverlapSeconds) throw new TriggerError(`overlapSeconds: 0–${TRIGGER_LIMITS.maxOverlapSeconds}`, 400);
    const now = this.now();
    const until = overlapSeconds > 0 ? iso(now + overlapSeconds * 1000) : undefined;
    const live = t.secrets.filter((s) => !s.expiresAt || Date.parse(s.expiresAt) > now);
    const previous = live.filter((s) => !s.expiresAt).map((s) => ({ ...s, expiresAt: until ?? iso(now) }));
    const stillOverlapping = live.filter((s) => s.expiresAt);
    const secret = generateTriggerSecret();
    t.secrets = [
      { id: `sec_${randomBytes(4).toString("hex")}`, hash: hashSecret(secret), hint: `${secret.slice(0, 8)}…`, createdAt: iso(now) },
      ...(until ? [...previous, ...stillOverlapping] : []),
    ];
    t.auth.secret = true;
    t.updatedAt = iso(now);
    this.store.save(t);
    this.deps.emit?.("changed", { id, action: "secret-rotated" });
    return { secret, ...(until && previous.length ? { previousValidUntil: until } : {}), trigger: await this.view(t) };
  }

  // ── HMAC secret (vault) ──

  private async hmacSecrets(id: string): Promise<{ current?: string; previous?: string; previousUntil?: string }> {
    const entry = await this.deps.vault()?.get(TRIGGER_VAULT_OWNER, triggerVaultService(id)).catch(() => undefined);
    const c = entry?.credentials ?? {};
    const previousValid = c.previous && c.previousUntil && Date.parse(c.previousUntil) > this.now();
    return { ...(c.secret ? { current: c.secret } : {}), ...(previousValid ? { previous: c.previous, previousUntil: c.previousUntil } : {}) };
  }

  async hmacStatus(id: string): Promise<TriggerHmacSecretStatus> {
    const s = await this.hmacSecrets(id);
    return { secretSet: !!s.current, ...(s.previousUntil ? { previousUntil: s.previousUntil } : {}) };
  }

  /**
   * Store the HMAC secret in the vault: the sender's (`secret`) or one Polpo generates (`generate`,
   * returned this once). The previous one keeps working for `overlapSeconds`. Never echoed otherwise.
   */
  async setHmacSecret(id: string, o: { secret?: string; generate?: boolean; overlapSeconds?: number }): Promise<{ secret?: string; status: TriggerHmacSecretStatus }> {
    const t = this.require(id);
    if (!t.auth.hmac) throw new TriggerError("This trigger has no HMAC signature configured (auth.hmac)", 400);
    const vault = this.deps.vault();
    if (!vault) throw new TriggerError("This instance has no vault: the HMAC secret cannot be stored", 503);
    const overlap = o.overlapSeconds ?? TRIGGER_LIMITS.defaultOverlapSeconds;
    if (!Number.isInteger(overlap) || overlap < 0 || overlap > TRIGGER_LIMITS.maxOverlapSeconds) throw new TriggerError(`overlapSeconds: 0–${TRIGGER_LIMITS.maxOverlapSeconds}`, 400);
    let value = o.secret?.trim();
    if (o.generate) value = randomBytes(32).toString("hex");
    if (!value || value.length < 8 || value.length > 1024) throw new TriggerError("The secret must be 8–1024 characters (or generate: true)", 400);
    const current = (await this.hmacSecrets(id)).current;
    const credentials: Record<string, string> = { secret: value };
    if (current && current !== value && overlap > 0) {
      credentials.previous = current;
      credentials.previousUntil = iso(this.now() + overlap * 1000);
    }
    await vault.set(TRIGGER_VAULT_OWNER, triggerVaultService(id), { type: "custom", label: `Trigger ${t.name}: HMAC signing secret`, credentials });
    this.deps.emit?.("changed", { id, action: "hmac-secret" });
    return { ...(o.generate ? { secret: value } : {}), status: await this.hmacStatus(id) };
  }

  async removeHmacSecret(id: string): Promise<TriggerHmacSecretStatus> {
    this.require(id);
    await this.deps.vault()?.remove(TRIGGER_VAULT_OWNER, triggerVaultService(id)).catch(() => false);
    this.deps.emit?.("changed", { id, action: "hmac-secret" });
    return this.hmacStatus(id);
  }

  // ── Contract revisions ──

  contractRevisions(id: string): TriggerContractRevision[] {
    this.require(id);
    return [...this.store.contractRevisions(id)].reverse();
  }

  contractDiff(id: string, from: number, to: number): { from: number; to: number; diff: string } {
    this.require(id);
    const all = this.store.contractRevisions(id);
    const a = all.find((r) => r.version === from);
    const b = all.find((r) => r.version === to);
    if (!a || !b) throw new TriggerError(`No contract version ${!a ? from : to} (kept: ${all.map((r) => r.version).join(", ") || "none"})`, 404);
    return { from, to, diff: unifiedLineDiff(JSON.stringify(a.contract, null, 2), JSON.stringify(b.contract, null, 2), `v${from}`, `v${to}`) };
  }

  // ── Deliveries ──

  deliveries(id: string, o: { limit?: number; cursor?: string; statuses?: TriggerDeliveryStatus[]; test?: boolean } = {}): TriggerDeliveryPage {
    this.require(id);
    return this.store.listDeliveries(id, o);
  }

  delivery(id: string, deliveryId: string): TriggerDelivery {
    this.require(id);
    const d = this.store.getDelivery(id, deliveryId);
    if (!d) throw new TriggerError(`No delivery "${deliveryId}" (only the newest ${this.store.get(id)?.retention ?? TRIGGER_LIMITS.defaultRetention} are kept)`, 404);
    return d;
  }

  private record(t: Trigger, d: TriggerDelivery): TriggerDelivery {
    this.store.addDelivery(d, t.retention);
    this.deps.emit?.("delivery", {
      triggerId: t.id, deliveryId: d.id, status: d.status, httpStatus: d.httpStatus,
      ...(d.test ? { test: true } : {}), ...(d.mapped ? { mapped: d.mapped } : {}),
    });
    return d;
  }

  /** The evaluation shared by real, test and dry-run deliveries: contract → filter → dedupe → mapping. */
  private evaluate(t: Pick<Trigger, "id" | "contract" | "contractVersion" | "filter" | "dedupe" | "mapping">, scope: DeliveryScope, kind: TriggerContentType | undefined, opts: { dryRun?: boolean } = {}): TriggerDryRun & { dedupeHashValue?: string } {
    const base = { contractVersion: t.contractVersion };
    if (kind && !t.contract.contentTypes.includes(kind)) {
      return { ...base, status: "rejected", reasons: [`Content type ${kind} is not accepted (accepted: ${t.contract.contentTypes.join(", ")})`], errors: [], filterMatched: false };
    }
    const errors = contractErrors(t.contract, scope.body);
    if (errors.length) return { ...base, status: "rejected", reasons: [`The body does not match the contract (v${t.contractVersion}): ${errors.length} error${errors.length > 1 ? "s" : ""}`], errors, filterMatched: false };
    const filterMatched = filterMatches(t.filter, scope);
    const m = applyMapping(t.mapping, scope);
    const mapping = { ...(m.mapped ? { mapped: m.mapped } : {}), ...(m.errors ? { mappingErrors: m.errors } : {}) };
    if (!filterMatched) return { ...base, status: "filtered", reasons: ["The filter did not match"], errors: [], filterMatched, ...mapping };
    if (t.dedupe) {
      const key = dedupeKeyOf(t.dedupe.key, scope);
      if (key) {
        const hash = dedupeHash(key);
        const original = this.store.dedupeLookup(t.id, hash, this.now());
        if (original) return { ...base, status: "duplicate", reasons: [`Duplicate of ${original} (same dedupe key within ${t.dedupe.ttlSeconds}s)`], errors: [], filterMatched, dedupeKey: opts.dryRun ? key : undefined, duplicateOf: original, dedupeHashValue: hash, ...mapping };
        return { ...base, status: "accepted", reasons: [], errors: [], filterMatched, ...(opts.dryRun ? { dedupeKey: key } : {}), dedupeHashValue: hash, ...mapping };
      }
    }
    return { ...base, status: "accepted", reasons: [], errors: [], filterMatched, ...mapping };
  }

  private rejectedRecord(t: Trigger, base: Partial<TriggerDelivery> & { reasons: string[]; httpStatus: number }): TriggerDelivery {
    const now = this.now();
    return {
      id: newDeliveryId(now), triggerId: t.id, receivedAt: iso(now), status: "rejected", bytes: 0, headers: {}, query: {},
      contractVersion: t.contractVersion, ...base,
    };
  }

  /** A sliding one-minute window per trigger. */
  private allow(t: Trigger): { ok: true } | { ok: false; retryAfter: number } {
    const now = this.now();
    const recent = (this.hits.get(t.id) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= t.rateLimitPerMinute) {
      this.hits.set(t.id, recent);
      return { ok: false, retryAfter: Math.max(1, Math.ceil((recent[0]! + 60_000 - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(t.id, recent);
    return { ok: true };
  }

  /**
   * POST /hooks/{id}. `read(max)` reads the raw body up to `max` bytes (undefined when larger).
   * Unknown or disabled triggers, and senders outside the IP allowlist, get 404 (existence is not
   * leaked). Secrets never reach the record: secret headers are redacted, the body is stored only
   * once the sender is authenticated.
   */
  async receive(id: string, req: {
    header: (name: string) => string | undefined;
    headers: Headers;
    query: URLSearchParams;
    ip?: string;
    contentLength?: number;
    read: (max: number) => Promise<Buffer | undefined>;
  }): Promise<TriggerReceiveResult> {
    const notFound: TriggerReceiveResult = { status: 404, body: { error: "Not found" } };
    const t = this.store.get(id);
    if (!t || !t.enabled) return notFound;
    const now = this.now();
    const secretHeaders = [t.auth.hmac?.header ?? ""].filter(Boolean);
    const headers = storableHeaders(req.headers, secretHeaders);
    const query = storableQuery(req.query);
    const common = { ...(req.ip ? { ip: req.ip } : {}), headers, query, contentType: req.header("content-type") ?? undefined };

    if (!ipAllowed(req.ip, t.auth.ipAllowlist)) {
      this.record(t, this.rejectedRecord(t, { ...common, httpStatus: 404, reasons: [`Address ${req.ip ?? "unknown"} is not in the IP allowlist`] }));
      return notFound;
    }

    const rate = this.allow(t);
    if (!rate.ok) {
      const last = this.store.latestDelivery(t.id);
      // one rate_limited record a minute, counting the refusals
      if (last?.status === "rate_limited" && now - Date.parse(last.receivedAt) < 60_000) {
        this.store.updateDelivery(t.id, last.id, { count: (last.count ?? 1) + 1 });
      } else {
        this.record(t, { ...this.rejectedRecord(t, { ...common, httpStatus: 429, reasons: [`More than ${t.rateLimitPerMinute} requests a minute`] }), status: "rate_limited", count: 1 });
      }
      return { status: 429, body: { error: "Too many requests", retryAfter: rate.retryAfter }, headers: { "Retry-After": String(rate.retryAfter) } };
    }

    const max = t.contract.maxBodyBytes;
    if (req.contentLength !== undefined && req.contentLength > max) {
      const d = this.record(t, this.rejectedRecord(t, { ...common, bytes: req.contentLength, httpStatus: 413, reasons: [`The body is larger than ${max} bytes`] }));
      return { status: 413, body: { deliveryId: d.id, status: d.status, error: `Body too large (at most ${max} bytes)` } };
    }
    const raw = await req.read(max);
    if (!raw) {
      const d = this.record(t, this.rejectedRecord(t, { ...common, httpStatus: 413, reasons: [`The body is larger than ${max} bytes`] }));
      return { status: 413, body: { deliveryId: d.id, status: d.status, error: `Body too large (at most ${max} bytes)` } };
    }

    // authentication: every configured method must pass
    const auth: NonNullable<TriggerDelivery["auth"]> = {};
    if (t.auth.secret) {
      const given = providedSecret(req.header, req.query, !!t.auth.allowQueryToken);
      const match = given ? matchSecret(given.value, t.secrets, now) : undefined;
      if (!match) {
        const reason = given ? "Wrong or expired secret" : `Missing secret (Authorization: Bearer, X-Polpo-Secret${t.auth.allowQueryToken ? " or ?token=" : ""})`;
        const d = this.record(t, this.rejectedRecord(t, { ...common, bytes: raw.length, httpStatus: 401, reasons: [reason] }));
        return { status: 401, body: { deliveryId: d.id, status: d.status, error: "Unauthorized" } };
      }
      auth.secret = given!.via;
      auth.secretId = match.id;
    }
    if (t.auth.hmac) {
      const r = verifyHmac(t.auth.hmac, raw, req.header, await this.hmacSecrets(t.id), now);
      if (!r.ok) {
        const d = this.record(t, this.rejectedRecord(t, { ...common, bytes: raw.length, httpStatus: 401, reasons: [r.reason] }));
        return { status: 401, body: { deliveryId: d.id, status: d.status, error: "Unauthorized" } };
      }
      auth.hmac = r.which;
    }

    const contentType = req.header("content-type") ?? "";
    const kind = contentKind(contentType);
    if (!kind || !t.contract.contentTypes.includes(kind)) {
      const d = this.record(t, this.rejectedRecord(t, { ...common, auth, bytes: raw.length, httpStatus: 415, reasons: [`Content type ${contentType || "(none)"} is not accepted (accepted: ${t.contract.contentTypes.join(", ")})`] }));
      return { status: 415, body: { deliveryId: d.id, status: d.status, error: `Unsupported content type (accepted: ${t.contract.contentTypes.join(", ")})` } };
    }
    let parsed: { body: unknown; files?: TriggerFileMeta[] };
    try {
      parsed = await parseBody(raw, kind, contentType, t.contract.maxFileBytes ?? TRIGGER_LIMITS.defaultMaxFileBytes);
    } catch (err) {
      const status = err instanceof TriggerParseError ? err.status : 400;
      const message = err instanceof Error ? err.message : String(err);
      const d = this.record(t, this.rejectedRecord(t, { ...common, auth, kind, bytes: raw.length, httpStatus: status, reasons: [message] }));
      return { status, body: { deliveryId: d.id, status: d.status, error: message } };
    }
    return this.finish(t, { ...common, auth, kind, bytes: raw.length, ...(parsed.files?.length ? { files: parsed.files } : {}) }, parsed.body);
  }

  /** Evaluate, record and answer a parsed delivery (real or test). */
  private finish(t: Trigger, base: Partial<TriggerDelivery> & { headers: Record<string, string>; query: Record<string, string | string[]>; bytes: number; kind?: TriggerContentType }, body: unknown, test = false): TriggerReceiveResult & { delivery: TriggerDelivery } {
    const now = this.now();
    const ev = this.evaluate(t, { body, headers: base.headers, query: base.query }, base.kind);
    const httpStatus = ev.status === "rejected" ? 400 : ev.status === "duplicate" ? 200 : 202;
    const stored = storableBody(body);
    const d: TriggerDelivery = {
      id: newDeliveryId(now), triggerId: t.id, receivedAt: iso(now), status: ev.status, httpStatus, reasons: ev.reasons,
      contractVersion: t.contractVersion, ...base,
      ...(ev.errors.length ? { errors: ev.errors } : {}),
      ...(stored.body !== undefined ? { body: stored.body } : {}), ...(stored.truncated ? { bodyTruncated: true } : {}),
      ...(ev.mapped && ev.status !== "rejected" ? { mapped: ev.mapped } : {}), ...(ev.mappingErrors ? { mappingErrors: ev.mappingErrors } : {}),
      ...(ev.dedupeHashValue ? { dedupeHash: ev.dedupeHashValue } : {}), ...(ev.duplicateOf ? { duplicateOf: ev.duplicateOf } : {}),
      ...(test ? { test: true } : {}),
    };
    this.record(t, d);
    if (ev.status === "accepted" && ev.dedupeHashValue && t.dedupe) this.store.dedupeRemember(t.id, ev.dedupeHashValue, d.id, now + t.dedupe.ttlSeconds * 1000, now);
    if (ev.status === "rejected") return { status: 400, body: { deliveryId: d.id, status: d.status, error: "The body does not match the trigger's contract", errors: ev.errors }, delivery: d };
    if (ev.status === "duplicate") return { status: 200, body: { deliveryId: ev.duplicateOf, status: d.status, duplicateDeliveryId: d.id }, delivery: d };
    return { status: 202, body: { deliveryId: d.id, status: d.status }, delivery: d };
  }

  /** A test delivery (dashboard, API, tools): recorded with test: true, through contract, filter, dedupe and mapping (no auth, no rate limit). */
  test(id: string, sample: TriggerSample): TriggerDelivery {
    const t = this.require(id);
    const kind = sample.contentType ?? "json";
    if (!TRIGGER_CONTENT_TYPES.includes(kind)) throw new TriggerError("contentType: json, form, multipart or text", 400);
    const headers = storableHeaders({ "content-type": kind === "json" ? "application/json" : kind === "form" ? "application/x-www-form-urlencoded" : kind === "multipart" ? "multipart/form-data" : "text/plain", ...(sample.headers ?? {}) }, [t.auth.hmac?.header ?? ""].filter(Boolean));
    const query = storableQuery(new URLSearchParams(Object.entries(sample.query ?? {}).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])) as [string, string][]));
    const bytes = Buffer.byteLength(typeof sample.body === "string" ? sample.body : JSON.stringify(sample.body ?? null));
    if (bytes > t.contract.maxBodyBytes) throw new TriggerError(`The sample is larger than the contract's maxBodyBytes (${t.contract.maxBodyBytes})`, 400);
    return this.finish(t, { headers, query, bytes, kind, contentType: headers["content-type"] }, sample.body, true).delivery;
  }

  /** Run a sample (or a stored delivery: replay) through the contract, filter, dedupe and mapping without recording it; `draft` overrides unsaved parts. */
  dryRun(id: string, o: { sample?: TriggerSample; deliveryId?: string; draft?: TriggerDraft }): TriggerDryRun & { replayOf?: string } {
    const t = this.require(id);
    let scope: DeliveryScope;
    let kind: TriggerContentType | undefined;
    if (o.deliveryId) {
      const d = this.delivery(id, o.deliveryId);
      if (d.bodyTruncated) throw new TriggerError("That delivery's body was kept truncated: it cannot be replayed", 400);
      if (d.body === undefined) throw new TriggerError("That delivery has no body (it was refused before it was read): it cannot be replayed", 400);
      scope = { body: d.body, headers: d.headers, query: d.query };
      kind = d.kind;
    } else if (o.sample) {
      scope = { body: o.sample.body, headers: Object.fromEntries(Object.entries(o.sample.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])), query: o.sample.query ?? {} };
      kind = o.sample.contentType ?? "json";
    } else throw new TriggerError("Give a sample or a deliveryId", 400);
    let target: Pick<Trigger, "id" | "contract" | "contractVersion" | "filter" | "dedupe" | "mapping"> = t;
    if (o.draft) {
      const { next, problems } = this.normalize(t, { contract: o.draft.contract, filter: o.draft.filter, dedupe: o.draft.dedupe, mapping: o.draft.mapping });
      if (problems.length) throw new TriggerError(`Invalid draft: ${problems.join("; ")}`, 400, "VALIDATION_ERROR", problems);
      target = next;
    }
    const { dedupeHashValue: _h, ...result } = this.evaluate(target, scope, kind, { dryRun: true });
    return { ...result, ...(o.deliveryId ? { replayOf: o.deliveryId } : {}) };
  }

  /** A JSON Schema inferred from a sample or a stored delivery's body. */
  inferSchema(o: { sample?: unknown; triggerId?: string; deliveryId?: string }): Record<string, unknown> {
    if (o.deliveryId && o.triggerId) {
      const d = this.delivery(o.triggerId, o.deliveryId);
      if (d.body === undefined || d.bodyTruncated) throw new TriggerError("That delivery has no complete body to infer from", 400);
      return { $schema: "https://json-schema.org/draft/2020-12/schema", ...inferJsonSchema(d.body) };
    }
    if (o.sample === undefined) throw new TriggerError("Give a sample (or a deliveryId)", 400);
    return { $schema: "https://json-schema.org/draft/2020-12/schema", ...inferJsonSchema(o.sample) };
  }
}

/** One service per .polpo directory (the server and the tests share it). */
const services = new Map<string, TriggerService>();
export function triggerServiceFor(key: string, deps: TriggerServiceDeps): TriggerService {
  let s = services.get(key);
  if (!s) { s = new TriggerService(deps); services.set(key, s); }
  return s;
}
