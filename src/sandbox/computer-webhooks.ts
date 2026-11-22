/**
 * Provider webhooks for computers: the provider pushes its machines' state changes, so a machine
 * deleted (or stopped, or paused) outside Polpo shows at once instead of at the next reconcile.
 *
 * Provider-agnostic: each provider that has lifecycle webhooks is a `ComputerWebhookProvider`
 * (verify the signature, map an event to the machine it is about and, when the event says so, the
 * machine's new state). An event never writes a status by itself: it triggers the computer's full
 * check at its provider (ComputerManager.providerEvent → refresh), which is idempotent and
 * authoritative. Events about machines that are not this instance's computers are ignored.
 *
 * - Daytona: the person adds an endpoint in Daytona's dashboard (Webhooks → Add Endpoint) with the
 *   URL Polpo shows, and enters its signing secret (`whsec_…`) in Polpo (Settings → Computers; it
 *   goes to the vault, never through chat or MCP). Deliveries are signed Svix-style (headers
 *   svix-id / svix-timestamp / svix-signature, or webhook-id / webhook-timestamp /
 *   webhook-signature): HMAC-SHA256 of `<id>.<timestamp>.<body>` with the base64 key after `whsec_`,
 *   timestamps within 5 minutes. Events: sandbox.created, sandbox.state.updated (oldState →
 *   newState), snapshot.state.updated, snapshot.removed.
 * - E2B: Polpo registers the endpoint itself (POST https://api.e2b.app/events/webhooks with the
 *   project API key) with a secret it makes and keeps in the vault; deliveries carry
 *   `e2b-signature` = base64(sha256(secret + body)) without padding. Events
 *   sandbox.lifecycle.{created,killed,updated,paused,resumed,checkpointed}; the sandbox's metadata
 *   carries the computer's label.
 * - Vercel Sandbox (a future provider): no lifecycle webhooks; its computers rely on the reconcile.
 *
 * Replays: a delivery id (Svix) or event id (E2B) is accepted once (kept 24 h); Svix timestamps
 * older than 5 minutes and E2B events older than 24 h are refused. Each provider is rate limited
 * and bodies over 256 KB refused. The status (secret set, registered, last event, counts) is kept
 * in .polpo/computer-webhooks.json.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPUTER_LABEL, isRemoteComputer, type ComputerConfig, type VaultStore } from "@polpo-ai/core";
import { isComputerSnapshotName, type ComputerManager } from "./computers.js";

export type ComputerWebhookProviderId = "daytona" | "e2b";

/** One machine event, as a provider pushes it. */
export interface ComputerProviderEvent {
  /** Stable id of the event (idempotency). */
  id: string;
  /** The provider's event type (sandbox.state.updated, sandbox.lifecycle.killed…). */
  type: string;
  at?: string;
  /** The provider's machine id. */
  remoteId?: string;
  /** The machine's computer label (`<instance>:<id>`), when the event carries it (E2B metadata). */
  labelValue?: string;
  /** A snapshot's name (Daytona snapshot events). */
  snapshotName?: string;
  /** The provider's state after the event, when it says. */
  state?: string;
  /** The state before (Daytona). */
  from?: string;
  /** The event says the machine or snapshot is gone. */
  gone: boolean;
}

export type HeaderGet = (name: string) => string | undefined | null;

export type VerifyResult = { ok: true; deliveryId?: string } | { ok: false; reason: string };

export interface ComputerWebhookProvider {
  readonly id: ComputerWebhookProviderId;
  readonly label: string;
  /** "manual": the person adds the endpoint at the provider; "api": Polpo registers it. */
  readonly registration: "manual" | "api";
  verify(raw: string, header: HeaderGet, secret: string, now: number): VerifyResult;
  parse(body: unknown): ComputerProviderEvent[];
}

/** Svix: timestamps outside this window are refused. */
export const SVIX_TOLERANCE_MS = 5 * 60_000;
/** E2B (no signed timestamp): events older than this are refused. */
export const E2B_MAX_AGE_MS = 24 * 3_600_000;
/** Delivery and event ids are remembered this long. */
const SEEN_TTL_MS = 24 * 3_600_000;
const SEEN_MAX = 5_000;
export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
/** Requests per minute per provider. */
export const WEBHOOK_RATE_PER_MINUTE = 300;
/** Where the signing secrets live (a reserved owner: never an agent). */
export const COMPUTER_WEBHOOK_VAULT_OWNER = "$computers";
export const computerWebhookVaultService = (p: ComputerWebhookProviderId) => `webhook-${p}`;
export const E2B_WEBHOOKS_API = "https://api.e2b.app/events/webhooks";
export const E2B_WEBHOOK_EVENTS = [
  "sandbox.lifecycle.created", "sandbox.lifecycle.killed", "sandbox.lifecycle.updated",
  "sandbox.lifecycle.paused", "sandbox.lifecycle.resumed", "sandbox.lifecycle.checkpointed",
];

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Svix-style signature check (Daytona's webhooks). */
export function verifySvix(raw: string, header: HeaderGet, secret: string, now: number): VerifyResult {
  const id = header("svix-id") ?? header("webhook-id");
  const ts = header("svix-timestamp") ?? header("webhook-timestamp");
  const sig = header("svix-signature") ?? header("webhook-signature");
  if (!id || !ts || !sig) return { ok: false, reason: "missing signature headers (svix-id, svix-timestamp, svix-signature)" };
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) return { ok: false, reason: "bad timestamp" };
  if (Math.abs(now - seconds * 1000) > SVIX_TOLERANCE_MS) return { ok: false, reason: "timestamp outside the 5-minute window (a replay, or the clock is off)" };
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret, "utf8");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
  const match = sig.split(/\s+/).some((part) => {
    const [version, value] = part.split(",", 2);
    return version === "v1" && !!value && safeEqual(value, expected);
  });
  return match ? { ok: true, deliveryId: id } : { ok: false, reason: "signature does not match" };
}

/** E2B's signature: base64(sha256(secret + body)) without padding. */
export function e2bSignature(secret: string, raw: string): string {
  return createHash("sha256").update(secret + raw).digest("base64").replace(/=+$/, "");
}

const DAYTONA_GONE = /^(destroyed|destroying|deleted|removed)$/i;

export const daytonaWebhooks: ComputerWebhookProvider = {
  id: "daytona",
  label: "Daytona",
  registration: "manual",
  verify: verifySvix,
  parse(body) {
    const b = (body ?? {}) as Record<string, unknown>;
    const type = str(b.event);
    if (!type) return [];
    const at = str(b.updatedAt) ?? str(b.removedAt) ?? str(b.createdAt) ?? str(b.timestamp);
    const base = { type, ...(at ? { at } : {}) };
    const key = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(":");
    if (type === "sandbox.created" || type === "sandbox.state.updated") {
      const remoteId = str(b.id);
      if (!remoteId) return [];
      const state = str(b.newState) ?? str(b.state);
      const from = str(b.oldState);
      return [{ ...base, id: key(type, remoteId, from, state, at), remoteId, ...(state ? { state } : {}), ...(from ? { from } : {}), gone: !!state && DAYTONA_GONE.test(state) }];
    }
    if (type === "snapshot.removed" || type === "snapshot.state.updated" || type === "snapshot.created") {
      const name = str(b.name);
      if (!name) return [];
      const state = str(b.newState) ?? str(b.state);
      return [{ ...base, id: key(type, str(b.id) ?? name, state, at), snapshotName: name, ...(state ? { state } : {}), gone: type === "snapshot.removed" || (!!state && /remov|destroy|delet/i.test(state)) }];
    }
    return [];
  },
};

const E2B_STATES: Record<string, { state?: string; gone: boolean }> = {
  "sandbox.lifecycle.created": { state: "running", gone: false },
  "sandbox.lifecycle.resumed": { state: "running", gone: false },
  "sandbox.lifecycle.paused": { state: "paused", gone: false },
  "sandbox.lifecycle.killed": { gone: true },
  "sandbox.lifecycle.updated": { gone: false },
  "sandbox.lifecycle.checkpointed": { gone: false },
};

export const e2bWebhooks: ComputerWebhookProvider = {
  id: "e2b",
  label: "E2B",
  registration: "api",
  verify(raw, header, secret, now) {
    const sig = header("e2b-signature");
    if (!sig) return { ok: false, reason: "missing e2b-signature header" };
    if (!safeEqual(sig.replace(/=+$/, ""), e2bSignature(secret, raw))) return { ok: false, reason: "signature does not match" };
    try {
      const at = Date.parse(str((JSON.parse(raw) as Record<string, unknown>).timestamp) ?? "");
      if (Number.isFinite(at) && now - at > E2B_MAX_AGE_MS) return { ok: false, reason: "event older than 24 h (a replay)" };
    } catch { /* the body is checked when parsed */ }
    return { ok: true };
  },
  parse(body) {
    const b = (body ?? {}) as Record<string, unknown>;
    const type = str(b.type);
    const id = str(b.id);
    const remoteId = str(b.sandbox_id);
    if (!type || !id || !remoteId || !E2B_STATES[type]) return [];
    const data = (b.event_data ?? {}) as Record<string, unknown>;
    const metadata = (data.sandbox_metadata ?? {}) as Record<string, unknown>;
    const labelValue = str(metadata[COMPUTER_LABEL]);
    const m = E2B_STATES[type]!;
    const at = str(b.timestamp);
    return [{ id, type, remoteId, ...(labelValue ? { labelValue } : {}), ...(m.state ? { state: m.state } : {}), ...(at ? { at } : {}), gone: m.gone }];
  },
};

/** Providers with lifecycle webhooks. (Vercel Sandbox has none: reconcile only.) */
export const COMPUTER_WEBHOOK_PROVIDERS: Record<ComputerWebhookProviderId, ComputerWebhookProvider> = {
  daytona: daytonaWebhooks,
  e2b: e2bWebhooks,
};

export interface ComputerWebhookProviderStatus {
  provider: ComputerWebhookProviderId;
  label: string;
  registration: "manual" | "api";
  /** The signing secret is in the vault. */
  secretSet: boolean;
  /** E2B: Polpo registered the endpoint (its webhook id). */
  registered?: boolean;
  webhookId?: string;
  /** The URL the provider must call (POLPO_PUBLIC_URL), when known. */
  url?: string;
  /** This instance has computers on this provider. */
  inUse: boolean;
  lastEventAt?: string;
  lastEventType?: string;
  received: number;
  rejected: number;
  ignored: number;
  lastError?: string;
  lastErrorAt?: string;
  /** "receiving": events arrived in the last 24 h; "configured": ready, nothing received yet (or not lately); "not-configured". */
  state: "receiving" | "configured" | "not-configured";
}

interface StatusFile {
  version: 1;
  providers: Partial<Record<ComputerWebhookProviderId, { lastEventAt?: string; lastEventType?: string; received: number; rejected: number; ignored: number; lastError?: string; lastErrorAt?: string; registerFailedAt?: string }>>;
  seen: Record<string, number>;
}

export interface ComputerWebhooksOptions {
  polpoDir: () => string;
  manager: () => ComputerManager;
  computers: () => readonly ComputerConfig[];
  vault: () => VaultStore | undefined | null;
  /** The instance's public base URL (POLPO_PUBLIC_URL), for the endpoint's URL. */
  publicBase?: () => string | undefined;
  /** The E2B API key (to register its webhook). */
  e2bApiKey?: () => Promise<string | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (level: "info" | "warn", message: string) => void;
}

export interface WebhookHandleResult {
  status: 200 | 202 | 400 | 401 | 404 | 413 | 429 | 503;
  body: Record<string, unknown>;
}

/** The public path a provider posts to (under the API). */
export const computerWebhookPath = (p: ComputerWebhookProviderId) => `/api/v1/computers/webhooks/${p}`;

export class ComputerWebhooks {
  private readonly buckets = new Map<string, { at: number; count: number }>();
  constructor(private readonly o: ComputerWebhooksOptions) {}

  private now(): number { return (this.o.now ?? Date.now)(); }
  private get file(): string { return join(this.o.polpoDir(), "computer-webhooks.json"); }

  private read(): StatusFile {
    try {
      if (existsSync(this.file)) {
        const d = JSON.parse(readFileSync(this.file, "utf8")) as StatusFile;
        if (d?.version === 1) return { version: 1, providers: d.providers ?? {}, seen: d.seen ?? {} };
      }
    } catch { /* a broken file starts over */ }
    return { version: 1, providers: {}, seen: {} };
  }

  private write(f: StatusFile): void {
    const now = this.now();
    const seen = Object.entries(f.seen).filter(([, at]) => now - at < SEEN_TTL_MS).sort((a, b) => b[1] - a[1]).slice(0, SEEN_MAX);
    f.seen = Object.fromEntries(seen);
    mkdirSync(this.o.polpoDir(), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(f, null, 2));
    renameSync(tmp, this.file);
  }

  private bump(p: ComputerWebhookProviderId, fn: (s: NonNullable<StatusFile["providers"][ComputerWebhookProviderId]>) => void): void {
    const f = this.read();
    const s = f.providers[p] ?? { received: 0, rejected: 0, ignored: 0 };
    fn(s);
    f.providers[p] = s;
    this.write(f);
  }

  private async secretEntry(p: ComputerWebhookProviderId): Promise<Record<string, string> | undefined> {
    const entry = await this.o.vault()?.get(COMPUTER_WEBHOOK_VAULT_OWNER, computerWebhookVaultService(p)).catch(() => undefined);
    return entry?.credentials;
  }

  url(p: ComputerWebhookProviderId): string | undefined {
    const base = this.o.publicBase?.()?.replace(/\/+$/, "");
    return base ? `${base}${computerWebhookPath(p)}` : undefined;
  }

  /** Every provider's webhook status (never a secret). */
  async status(): Promise<ComputerWebhookProviderStatus[]> {
    const f = this.read();
    const kinds = new Set(this.o.computers().filter(isRemoteComputer).map((c) => c.kind));
    return Promise.all(Object.values(COMPUTER_WEBHOOK_PROVIDERS).map(async (prov) => {
      const creds = await this.secretEntry(prov.id);
      const s = f.providers[prov.id] ?? { received: 0, rejected: 0, ignored: 0 };
      const secretSet = !!creds?.secret;
      const registered = prov.registration === "api" ? !!creds?.webhookId : undefined;
      const ready = secretSet && (prov.registration === "manual" || !!registered);
      const recent = !!s.lastEventAt && this.now() - Date.parse(s.lastEventAt) < 24 * 3_600_000;
      const url = this.url(prov.id);
      return {
        provider: prov.id, label: prov.label, registration: prov.registration, secretSet,
        ...(registered !== undefined ? { registered } : {}), ...(creds?.webhookId ? { webhookId: creds.webhookId } : {}),
        ...(url ? { url } : {}), inUse: kinds.has(prov.id),
        ...(s.lastEventAt ? { lastEventAt: s.lastEventAt } : {}), ...(s.lastEventType ? { lastEventType: s.lastEventType } : {}),
        received: s.received, rejected: s.rejected, ignored: s.ignored,
        ...(s.lastError ? { lastError: s.lastError, lastErrorAt: s.lastErrorAt } : {}),
        state: ready ? (recent ? "receiving" : "configured") : "not-configured",
      } satisfies ComputerWebhookProviderStatus;
    }));
  }

  /**
   * Whether every provider this instance's computers use pushes their state (its webhook is set
   * up): the reconcile can then run less often.
   */
  async pushing(): Promise<boolean> {
    const kinds = [...new Set(this.o.computers().filter(isRemoteComputer).map((c) => c.kind))];
    if (!kinds.length) return false;
    const all = await this.status();
    return kinds.every((k) => all.find((s) => s.provider === k)?.state !== "not-configured");
  }

  /** The person's signing secret (Daytona), into the vault; null removes it. */
  async setSecret(p: ComputerWebhookProviderId, secret: string | null): Promise<void> {
    const vault = this.o.vault();
    if (!vault) throw new Error("This instance has no vault: the signing secret cannot be stored");
    const service = computerWebhookVaultService(p);
    if (secret === null) { await vault.remove(COMPUTER_WEBHOOK_VAULT_OWNER, service); return; }
    const value = secret.trim();
    if (value.length < 16 || /\s/.test(value)) throw new Error("That does not look like a signing secret (Daytona's start with whsec_)");
    await vault.set(COMPUTER_WEBHOOK_VAULT_OWNER, service, { type: "custom", label: `${COMPUTER_WEBHOOK_PROVIDERS[p].label} webhook signing secret (computers)`, credentials: { secret: value } });
  }

  /** E2B: register this instance's endpoint with a fresh secret (kept in the vault). */
  async registerE2b(): Promise<ComputerWebhookProviderStatus> {
    const url = this.url("e2b");
    if (!url) throw new Error("POLPO_PUBLIC_URL is not set: E2B needs a public URL to call (and, behind Tailscale Funnel, the /api/v1/computers/webhooks/ path exposed)");
    const key = await this.o.e2bApiKey?.();
    if (!key) throw new Error("E2B has no API key on this server (Settings → Sandbox)");
    const vault = this.o.vault();
    if (!vault) throw new Error("This instance has no vault: the webhook secret cannot be stored");
    const doFetch = this.o.fetch ?? fetch;
    const current = await this.secretEntry("e2b");
    if (current?.webhookId) await this.unregisterE2b().catch(() => undefined);
    const secret = randomBytes(32).toString("base64url");
    const res = await doFetch(E2B_WEBHOOKS_API, {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ name: `Polpo computers (${new URL(url).host})`, url, enabled: true, events: E2B_WEBHOOK_EVENTS, signatureSecret: secret }),
    });
    const text = await res.text();
    if (!res.ok) {
      this.bump("e2b", (s) => { s.registerFailedAt = new Date(this.now()).toISOString(); s.lastError = `Registration refused (${res.status}): ${text.slice(0, 200)}`; s.lastErrorAt = s.registerFailedAt; });
      throw new Error(`E2B refused the webhook (${res.status}): ${text.slice(0, 200)}`);
    }
    let webhookId = "";
    try { webhookId = String((JSON.parse(text) as { id?: unknown }).id ?? ""); } catch { /* checked below */ }
    if (!webhookId) throw new Error("E2B registered the webhook but returned no id");
    await vault.set(COMPUTER_WEBHOOK_VAULT_OWNER, computerWebhookVaultService("e2b"), {
      type: "custom", label: "E2B webhook (computers): signing secret and id", credentials: { secret, webhookId, url },
    });
    this.bump("e2b", (s) => { delete s.registerFailedAt; delete s.lastError; delete s.lastErrorAt; });
    this.o.log?.("info", `E2B webhook registered (${url})`);
    return (await this.status()).find((s) => s.provider === "e2b")!;
  }

  async unregisterE2b(): Promise<void> {
    const current = await this.secretEntry("e2b");
    if (current?.webhookId) {
      const key = await this.o.e2bApiKey?.();
      if (key) {
        const res = await (this.o.fetch ?? fetch)(`${E2B_WEBHOOKS_API}/${encodeURIComponent(current.webhookId)}`, { method: "DELETE", headers: { "X-API-Key": key } });
        if (!res.ok && res.status !== 404) throw new Error(`E2B refused to delete the webhook (${res.status})`);
      }
    }
    await this.o.vault()?.remove(COMPUTER_WEBHOOK_VAULT_OWNER, computerWebhookVaultService("e2b"));
  }

  /**
   * Register E2B's webhook when E2B computers exist, the key and a public URL are there and it is
   * not registered (a failure waits an hour). Never throws.
   */
  async autoRegister(): Promise<void> {
    try {
      if (!this.o.computers().some((c) => c.kind === "e2b") || !this.url("e2b")) return;
      if ((await this.secretEntry("e2b"))?.webhookId) return;
      const failed = this.read().providers.e2b?.registerFailedAt;
      if (failed && this.now() - Date.parse(failed) < 3_600_000) return;
      if (!(await this.o.e2bApiKey?.())) return;
      await this.registerE2b();
    } catch (err) {
      this.o.log?.("warn", `E2B webhook registration failed: ${(err as Error).message}`);
    }
  }

  private limited(p: string): boolean {
    const now = this.now();
    const b = this.buckets.get(p);
    if (!b || now - b.at >= 60_000) { this.buckets.set(p, { at: now, count: 1 }); return false; }
    b.count++;
    return b.count > WEBHOOK_RATE_PER_MINUTE;
  }

  /** The computer an event is about, if it is one of this instance's. */
  private computerFor(ev: ComputerProviderEvent, provider: ComputerWebhookProviderId): ComputerConfig | undefined {
    const manager = this.o.manager();
    const mine = this.o.computers().filter((c) => c.kind === provider);
    if (ev.labelValue) return mine.find((c) => manager.labelValue(c.id) === ev.labelValue);
    if (ev.remoteId) {
      const state = manager.read();
      const byId = mine.find((c) => state[c.id]?.remoteId === ev.remoteId);
      if (byId) return byId;
    }
    if (ev.snapshotName) return mine.find((c) => isComputerSnapshotName(manager.labelValue(c.id), ev.snapshotName!));
    return undefined;
  }

  /** One delivery: limits, signature, replay, then each event to its computer. */
  async handle(provider: string, raw: string, header: HeaderGet): Promise<WebhookHandleResult> {
    const prov = COMPUTER_WEBHOOK_PROVIDERS[provider as ComputerWebhookProviderId];
    if (!prov) return { status: 404, body: { ok: false, error: `No webhooks for provider "${provider}"` } };
    if (Buffer.byteLength(raw) > WEBHOOK_MAX_BODY_BYTES) return { status: 413, body: { ok: false, error: "Body too large" } };
    if (this.limited(prov.id)) return { status: 429, body: { ok: false, error: "Too many requests" } };
    const reject = (status: 400 | 401 | 503, error: string): WebhookHandleResult => {
      this.bump(prov.id, (s) => { s.rejected++; s.lastError = error; s.lastErrorAt = new Date(this.now()).toISOString(); });
      return { status, body: { ok: false, error } };
    };
    const secret = (await this.secretEntry(prov.id))?.secret;
    if (!secret) return reject(503, `${prov.label} webhooks are not configured on this instance`);
    const v = prov.verify(raw, header, secret, this.now());
    if (!v.ok) return reject(401, `Signature refused: ${v.reason}`);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return reject(400, "Not JSON"); }
    const events = prov.parse(body);
    const f = this.read();
    const deliveryKey = v.deliveryId ? `${prov.id}:delivery:${v.deliveryId}` : undefined;
    if (deliveryKey && f.seen[deliveryKey]) return { status: 200, body: { ok: true, duplicate: true } };
    const now = this.now();
    const fresh = events.filter((e) => !f.seen[`${prov.id}:${e.id}`]);
    for (const e of events) f.seen[`${prov.id}:${e.id}`] = now;
    if (deliveryKey) f.seen[deliveryKey] = now;
    const s = f.providers[prov.id] ?? { received: 0, rejected: 0, ignored: 0 };
    s.received++;
    s.lastEventAt = new Date(now).toISOString();
    const type = events[0]?.type ?? str((body as Record<string, unknown>)?.event) ?? str((body as Record<string, unknown>)?.type);
    if (type) s.lastEventType = type;
    f.providers[prov.id] = s;
    this.write(f);
    if (events.length && !fresh.length) return { status: 200, body: { ok: true, duplicate: true } };
    const matched: Array<{ c: ComputerConfig; e: ComputerProviderEvent }> = [];
    let ignored = 0;
    for (const e of fresh) {
      const c = this.computerFor(e, prov.id);
      if (!c) { ignored++; continue; }
      matched.push({ c, e });
    }
    if (ignored || !events.length) this.bump(prov.id, (x) => { x.ignored += ignored || 1; });
    // answered at once (providers retry slow endpoints); each computer is then checked at its provider
    const work = (async () => {
      for (const { c, e } of matched) {
        await this.o.manager().providerEvent(c, e).catch((err) => this.o.log?.("warn", `Computer "${c.id}": ${prov.label} event ${e.type} could not be applied: ${(err as Error).message}`));
      }
    })();
    this.inflight = Promise.all([this.inflight, work]).then(() => undefined);
    return { status: 200, body: { ok: true, matched: [...new Set(matched.map((m) => m.c.id))], ignored } };
  }

  private inflight: Promise<void> = Promise.resolve();

  /** Resolves when the events received so far were applied (tests, shutdown). */
  idle(): Promise<void> {
    return this.inflight;
  }
}

/** What the server gives the webhooks (the orchestrator, structurally). */
export interface ComputerWebhooksHost {
  getPolpoDir(): string;
  getConfig(): { settings?: { computers?: ComputerConfig[] } } | null | undefined;
  getVaultStore?(): VaultStore | null | undefined;
}

const instances = new Map<string, ComputerWebhooks>();

/**
 * The project's webhooks (one per .polpo directory and process): the server's route, its upkeep
 * and the settings share it. `manager`: the project's computer manager (with its events).
 */
export function computerWebhooksFor(host: ComputerWebhooksHost, manager: () => ComputerManager, log?: (level: "info" | "warn", message: string) => void): ComputerWebhooks {
  const dir = host.getPolpoDir();
  let w = instances.get(dir);
  if (!w) {
    w = new ComputerWebhooks({
      polpoDir: () => host.getPolpoDir(),
      manager,
      computers: () => host.getConfig()?.settings?.computers ?? [],
      vault: () => host.getVaultStore?.(),
      publicBase: () => process.env.POLPO_PUBLIC_URL?.trim() || undefined,
      e2bApiKey: async () => (await import("./remote-providers.js")).remoteProviderCredentials("e2b").then((c) => c?.apiKey),
      log,
    });
    instances.set(dir, w);
  }
  return w;
}
