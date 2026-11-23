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
 * in .polpo/computer-webhooks.json; every delivery, whatever came of it, is in the provider's event
 * log (computer-webhook-events.ts: accepted / ignored / rejected / error, with what Polpo did).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPUTER_LABEL, isRemoteComputer, type ComputerConfig, type PolpoEventMap, type VaultStore } from "@polpo-ai/core";
import { isComputerSnapshotName, type ComputerManager } from "./computers.js";
import {
  ComputerWebhookEventLog, newWebhookEventId, safeWebhookHeaders, webhookPayloadPreview,
  type ComputerWebhookEventPage, type ComputerWebhookEventRecord, type ComputerWebhookOutcome, type ComputerWebhookSignature,
} from "./computer-webhook-events.js";

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
  /** Deliveries that passed the signature check (accepted, ignored or failed while applied). */
  received: number;
  rejected: number;
  ignored: number;
  /** Deliveries Polpo could not apply (the computer's check failed). */
  errors: number;
  /** The last problem since the provider was (re)configured; an error from before (e.g. "not configured") is not shown. */
  lastError?: string;
  lastErrorAt?: string;
  /** "receiving": events arrived in the last 24 h; "configured": ready, nothing received yet (or not lately); "not-configured". */
  state: "receiving" | "configured" | "not-configured";
  /** Configured but no delivery ever arrived: what to expect (e.g. Daytona v2 VMs send none). */
  waitingNote?: string;
}

interface ProviderCounters {
  lastEventAt?: string; lastEventType?: string;
  received: number; rejected: number; ignored: number; errors?: number;
  lastError?: string; lastErrorAt?: string;
  /** What kind of problem lastError is ("not-configured" disappears once the provider is configured). */
  lastErrorCode?: "not-configured" | "signature" | "body" | "rate" | "apply" | "register" | "internal";
  /** When the secret was saved or the endpoint registered: errors from before are stale. */
  configuredAt?: string;
  registerFailedAt?: string;
}

interface StatusFile {
  version: 1;
  providers: Partial<Record<ComputerWebhookProviderId, ProviderCounters>>;
  seen: Record<string, number>;
}

/** Shown while a configured provider has never sent a delivery. */
export const COMPUTER_WEBHOOK_WAITING_NOTES: Record<ComputerWebhookProviderId, string> = {
  daytona: "Waiting for the first event. Daytona currently sends webhooks only for its classic sandboxes (containers), not for Daytona v2 VMs, "
    + "so v2 computers may never produce one. Polpo also checks every computer at its provider every 5 minutes and whenever it is used.",
  e2b: "Waiting for the first event. E2B sends one when a sandbox is created, paused, resumed or killed. "
    + "Polpo also checks every computer at its provider every 5 minutes and whenever it is used.",
};

/** Legacy status files kept no error code: their "not configured" errors are recognised by text. */
const NOT_CONFIGURED_ERROR = /webhooks are not configured on this instance/;

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
  /** Announces each recorded delivery (the server emits computer:webhook). */
  emit?: (payload: PolpoEventMap["computer:webhook"]) => void;
}

export interface WebhookHandleResult {
  status: 200 | 202 | 400 | 401 | 404 | 413 | 429 | 500 | 503;
  body: Record<string, unknown>;
}

/** The public path a provider posts to (under the API). */
export const computerWebhookPath = (p: ComputerWebhookProviderId) => `/api/v1/computers/webhooks/${p}`;

export class ComputerWebhooks {
  private readonly buckets = new Map<string, { at: number; count: number }>();
  private readonly log: ComputerWebhookEventLog;
  constructor(private readonly o: ComputerWebhooksOptions) {
    this.log = new ComputerWebhookEventLog(o.polpoDir);
  }

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

  private bump(p: ComputerWebhookProviderId, fn: (s: ProviderCounters) => void): void {
    const f = this.read();
    const s = f.providers[p] ?? { received: 0, rejected: 0, ignored: 0 };
    fn(s);
    f.providers[p] = s;
    this.write(f);
  }

  /** The provider was (re)configured: earlier problems are history (they stay in the event log). */
  private configured(p: ComputerWebhookProviderId): void {
    this.bump(p, (s) => { delete s.lastError; delete s.lastErrorAt; delete s.lastErrorCode; s.configuredAt = new Date(this.now()).toISOString(); });
  }

  private async secretEntry(p: ComputerWebhookProviderId): Promise<Record<string, string> | undefined> {
    const entry = await this.o.vault()?.get(COMPUTER_WEBHOOK_VAULT_OWNER, computerWebhookVaultService(p)).catch(() => undefined);
    return entry?.credentials;
  }

  url(p: ComputerWebhookProviderId): string | undefined {
    const base = this.o.publicBase?.()?.replace(/\/+$/, "");
    return base ? `${base}${computerWebhookPath(p)}` : undefined;
  }

  /** Every provider's webhook status (never a secret), from the current configuration. */
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
      // an error is shown only while it still says something: not "not configured" once configured, nothing from before the configuration
      const notConfiguredError = s.lastErrorCode === "not-configured" || (!s.lastErrorCode && !!s.lastError && NOT_CONFIGURED_ERROR.test(s.lastError));
      const beforeConfig = !!s.configuredAt && !!s.lastErrorAt && Date.parse(s.lastErrorAt) < Date.parse(s.configuredAt);
      const showError = !!s.lastError && !(ready && notConfiguredError) && !beforeConfig;
      const state = ready ? (recent ? "receiving" : "configured") : "not-configured";
      return {
        provider: prov.id, label: prov.label, registration: prov.registration, secretSet,
        ...(registered !== undefined ? { registered } : {}), ...(creds?.webhookId ? { webhookId: creds.webhookId } : {}),
        ...(url ? { url } : {}), inUse: kinds.has(prov.id),
        ...(s.lastEventAt ? { lastEventAt: s.lastEventAt } : {}), ...(s.lastEventType ? { lastEventType: s.lastEventType } : {}),
        received: s.received, rejected: s.rejected, ignored: s.ignored, errors: s.errors ?? 0,
        ...(showError ? { lastError: s.lastError, lastErrorAt: s.lastErrorAt } : {}),
        state,
        ...(state === "configured" && !s.lastEventAt ? { waitingNote: COMPUTER_WEBHOOK_WAITING_NOTES[prov.id] } : {}),
      } satisfies ComputerWebhookProviderStatus;
    }));
  }

  /**
   * Whether every provider this instance's computers use pushes their state (events arrived in the
   * last 24 h): the reconcile can then run less often. A provider configured but silent (e.g.
   * Daytona, which sends nothing for v2 VMs) keeps the 5-minute check.
   */
  async pushing(): Promise<boolean> {
    const kinds = [...new Set(this.o.computers().filter(isRemoteComputer).map((c) => c.kind))];
    if (!kinds.length) return false;
    const all = await this.status();
    return kinds.every((k) => all.find((s) => s.provider === k)?.state === "receiving");
  }

  /** The person's signing secret (Daytona), into the vault; null removes it. */
  async setSecret(p: ComputerWebhookProviderId, secret: string | null): Promise<void> {
    const vault = this.o.vault();
    if (!vault) throw new Error("This instance has no vault: the signing secret cannot be stored");
    const service = computerWebhookVaultService(p);
    if (secret === null) {
      await vault.remove(COMPUTER_WEBHOOK_VAULT_OWNER, service);
      this.bump(p, (s) => { delete s.lastError; delete s.lastErrorAt; delete s.lastErrorCode; delete s.configuredAt; });
      return;
    }
    const value = secret.trim();
    if (value.length < 16 || /\s/.test(value)) throw new Error("That does not look like a signing secret (Daytona's start with whsec_)");
    await vault.set(COMPUTER_WEBHOOK_VAULT_OWNER, service, { type: "custom", label: `${COMPUTER_WEBHOOK_PROVIDERS[p].label} webhook signing secret (computers)`, credentials: { secret: value } });
    this.configured(p);
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
      this.bump("e2b", (s) => { s.registerFailedAt = new Date(this.now()).toISOString(); s.lastError = `Registration refused (${res.status}): ${text.slice(0, 200)}`; s.lastErrorAt = s.registerFailedAt; s.lastErrorCode = "register"; });
      throw new Error(`E2B refused the webhook (${res.status}): ${text.slice(0, 200)}`);
    }
    let webhookId = "";
    try { webhookId = String((JSON.parse(text) as { id?: unknown }).id ?? ""); } catch { /* checked below */ }
    if (!webhookId) throw new Error("E2B registered the webhook but returned no id");
    await vault.set(COMPUTER_WEBHOOK_VAULT_OWNER, computerWebhookVaultService("e2b"), {
      type: "custom", label: "E2B webhook (computers): signing secret and id", credentials: { secret, webhookId, url },
    });
    this.bump("e2b", (s) => { delete s.registerFailedAt; });
    this.configured("e2b");
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

  /** Requests in the provider's current minute (above WEBHOOK_RATE_PER_MINUTE: refused). */
  private hit(p: string): number {
    const now = this.now();
    const b = this.buckets.get(p);
    if (!b || now - b.at >= 60_000) { this.buckets.set(p, { at: now, count: 1 }); return 1; }
    return ++b.count;
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

  // ── The event log ─────────────────────────────────────────────────

  /** A page of a provider's recorded deliveries (newest first, no payloads). */
  events(p: ComputerWebhookProviderId, o: { limit?: number; cursor?: string; outcomes?: readonly ComputerWebhookOutcome[] } = {}): ComputerWebhookEventPage {
    return this.log.list(p, o);
  }

  /** One recorded delivery, with its redacted payload and safe headers. */
  event(p: ComputerWebhookProviderId, id: string): ComputerWebhookEventRecord | undefined {
    return this.log.get(p, id);
  }

  /**
   * Record a delivery in the provider's log and count it (the status' counters follow the log):
   * rejected → rejected (and the last error); anything that passed the signature → received (and
   * the last event); ignored → ignored; accepted clears the last error.
   */
  private record(
    p: ComputerWebhookProviderId,
    d: { raw: string; header: HeaderGet; receivedAt: number; t0: number; keepPayload?: boolean },
    r: Omit<ComputerWebhookEventRecord, "id" | "provider" | "receivedAt" | "processingMs" | "bytes" | "payload" | "payloadTruncated" | "headers">,
    code?: ProviderCounters["lastErrorCode"],
  ): ComputerWebhookEventRecord {
    const receivedAt = new Date(d.receivedAt).toISOString();
    const preview = d.keepPayload === false ? {} : webhookPayloadPreview(d.raw);
    const rec: ComputerWebhookEventRecord = {
      id: newWebhookEventId(d.receivedAt), provider: p, receivedAt, ...r,
      processingMs: Math.max(0, Math.round(performance.now() - d.t0)), bytes: Buffer.byteLength(d.raw),
      ...(preview.payload !== undefined ? { payload: preview.payload } : {}), ...(preview.truncated ? { payloadTruncated: true } : {}),
      headers: safeWebhookHeaders(d.header),
    };
    try {
      this.log.add(rec);
      this.bump(p, (s) => {
        if (rec.outcome === "rejected") {
          s.rejected++;
          s.lastError = rec.reason ?? "Rejected";
          s.lastErrorAt = receivedAt;
          s.lastErrorCode = code ?? "internal";
          return;
        }
        s.received++;
        s.lastEventAt = receivedAt;
        if (rec.eventType) s.lastEventType = rec.eventType;
        if (rec.outcome === "ignored") s.ignored++;
        if (rec.outcome === "error") {
          s.errors = (s.errors ?? 0) + 1;
          s.lastError = rec.reason ?? "Error";
          s.lastErrorAt = receivedAt;
          s.lastErrorCode = code ?? "internal";
        }
        if (rec.outcome === "accepted") { delete s.lastError; delete s.lastErrorAt; delete s.lastErrorCode; }
      });
    } catch (err) {
      this.o.log?.("warn", `${COMPUTER_WEBHOOK_PROVIDERS[p].label} webhook: the delivery could not be recorded: ${(err as Error).message}`);
    }
    this.announce(rec, "recorded");
    return rec;
  }

  private announce(rec: ComputerWebhookEventRecord, action: "recorded" | "updated"): void {
    try {
      this.o.emit?.({ provider: rec.provider, id: rec.id, action, outcome: rec.outcome, ...(rec.eventType ? { eventType: rec.eventType } : {}), ...(rec.computerId ? { computerId: rec.computerId } : {}) });
    } catch { /* listeners never change the delivery */ }
  }

  /** A body over the limit, refused before it is read (the route checks content-length). */
  refuseTooLarge(provider: string, bytes: number, header: HeaderGet): WebhookHandleResult {
    const prov = COMPUTER_WEBHOOK_PROVIDERS[provider as ComputerWebhookProviderId];
    if (prov) {
      this.record(prov.id, { raw: "", header, receivedAt: this.now(), t0: performance.now(), keepPayload: false },
        { outcome: "rejected", httpStatus: 413, signature: "not-checked", reason: tooLarge(bytes) }, "body");
    }
    return { status: 413, body: { ok: false, error: "Body too large" } };
  }

  /** One delivery: limits, signature, replay, then each event to its computer; every delivery is recorded. */
  async handle(provider: string, raw: string, header: HeaderGet): Promise<WebhookHandleResult> {
    const prov = COMPUTER_WEBHOOK_PROVIDERS[provider as ComputerWebhookProviderId];
    // an unknown provider is not recorded (anyone can post to any path)
    if (!prov) return { status: 404, body: { ok: false, error: `No webhooks for provider "${provider}"` } };
    const d = { raw, header, receivedAt: this.now(), t0: performance.now() };
    const bytes = Buffer.byteLength(raw);
    if (bytes > WEBHOOK_MAX_BODY_BYTES) {
      this.record(prov.id, { ...d, keepPayload: false }, { outcome: "rejected", httpStatus: 413, signature: "not-checked", reason: tooLarge(bytes) }, "body");
      return { status: 413, body: { ok: false, error: "Body too large" } };
    }
    const hits = this.hit(prov.id);
    if (hits > WEBHOOK_RATE_PER_MINUTE) {
      // a flood is recorded once a minute, not once a request
      if (hits === WEBHOOK_RATE_PER_MINUTE + 1) {
        this.record(prov.id, { ...d, keepPayload: false }, { outcome: "rejected", httpStatus: 429, signature: "not-checked", reason: `Too many requests (over ${WEBHOOK_RATE_PER_MINUTE} a minute: the rest of this minute's are refused without being recorded)` }, "rate");
      }
      return { status: 429, body: { ok: false, error: "Too many requests" } };
    }
    try {
      return await this.receive(prov, d);
    } catch (err) {
      this.record(prov.id, d, { outcome: "error", httpStatus: 500, signature: "not-checked", reason: `Internal error: ${(err as Error).message}` }, "internal");
      return { status: 500, body: { ok: false, error: "Internal error" } };
    }
  }

  private async receive(prov: ComputerWebhookProvider, d: { raw: string; header: HeaderGet; receivedAt: number; t0: number }): Promise<WebhookHandleResult> {
    const { raw, header } = d;
    const deliveryHeader = header("svix-id") ?? header("webhook-id") ?? undefined;
    const reject = (status: 400 | 401 | 503, error: string, signature: ComputerWebhookSignature, code: ProviderCounters["lastErrorCode"]): WebhookHandleResult => {
      this.record(prov.id, d, { outcome: "rejected", httpStatus: status, signature, reason: error, ...(deliveryHeader ? { deliveryId: deliveryHeader } : {}), ...typeOf(raw) }, code);
      return { status, body: { ok: false, error } };
    };
    const secret = (await this.secretEntry(prov.id))?.secret;
    if (!secret) return reject(503, `${prov.label} webhooks are not configured on this instance`, "not-checked", "not-configured");
    const v = prov.verify(raw, header, secret, this.now());
    if (!v.ok) return reject(401, `Signature refused: ${v.reason}`, /missing/.test(v.reason) ? "missing" : "invalid", "signature");
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return reject(400, "Not JSON", "valid", "body"); }
    const events = prov.parse(body);
    const first = events[0];
    const type = first?.type ?? str((body as Record<string, unknown>)?.event) ?? str((body as Record<string, unknown>)?.type);
    const base = {
      httpStatus: 200, signature: "valid" as const, events: events.length,
      ...(type ? { eventType: type } : {}), ...(v.deliveryId ? { deliveryId: v.deliveryId } : {}),
      ...(first ? describeEvent(first) : {}),
    };
    const f = this.read();
    const deliveryKey = v.deliveryId ? `${prov.id}:delivery:${v.deliveryId}` : undefined;
    if (deliveryKey && f.seen[deliveryKey]) {
      this.record(prov.id, d, { ...base, outcome: "ignored", reason: "Duplicate delivery: already received (the provider retried it)", action: "Nothing: it was handled the first time" });
      return { status: 200, body: { ok: true, duplicate: true } };
    }
    const now = this.now();
    const fresh = events.filter((e) => !f.seen[`${prov.id}:${e.id}`]);
    for (const e of events) f.seen[`${prov.id}:${e.id}`] = now;
    if (deliveryKey) f.seen[deliveryKey] = now;
    this.write(f);
    if (events.length && !fresh.length) {
      this.record(prov.id, d, { ...base, outcome: "ignored", reason: "Duplicate event: the same event already came in another delivery", action: "Nothing: it was handled the first time" });
      return { status: 200, body: { ok: true, duplicate: true } };
    }
    if (!events.length) {
      this.record(prov.id, d, { ...base, outcome: "ignored", reason: type ? `Not an event Polpo acts on (${type})` : "No event Polpo recognises in the body", action: "Nothing" });
      return { status: 200, body: { ok: true, matched: [], ignored: 1 } };
    }
    const manager = this.o.manager();
    const matched: Array<{ c: ComputerConfig; e: ComputerProviderEvent }> = [];
    let ignored = 0;
    for (const e of fresh) {
      const c = this.computerFor(e, prov.id);
      if (!c) { ignored++; continue; }
      matched.push({ c, e });
    }
    if (!matched.length) {
      const what = first?.snapshotName ? `snapshot ${first.snapshotName}` : first?.remoteId ? `sandbox ${first.remoteId}` : "the machine";
      this.record(prov.id, d, { ...base, outcome: "ignored", reason: `Not about one of this instance's computers (${what})`, action: "Nothing: Polpo only follows its own computers" });
      return { status: 200, body: { ok: true, matched: [], ignored } };
    }
    const target = matched[0]!;
    const from = manager.live(target.c.id).status;
    const ids = [...new Set(matched.map((m) => m.c.id))];
    const rec = this.record(prov.id, d, {
      ...base, ...describeEvent(target.e), eventType: target.e.type, outcome: "accepted", computerId: target.c.id,
      statusChange: { from },
      action: `Checking computer "${ids.join('", "')}" at ${prov.label}${ignored ? ` (${ignored} other event${ignored === 1 ? "" : "s"} not about a computer)` : ""}`,
    });
    // answered at once (providers retry slow endpoints); each computer is then checked at its provider
    const work = (async () => {
      let to: string | undefined;
      let failure: string | undefined;
      for (const { c, e } of matched) {
        try {
          const live = await manager.providerEvent(c, e);
          if (c.id === target.c.id) to = live?.status;
        } catch (err) {
          failure = (err as Error).message;
          this.o.log?.("warn", `Computer "${c.id}": ${prov.label} event ${e.type} could not be applied: ${failure}`);
        }
      }
      const appliedAt = new Date(this.now()).toISOString();
      const statusChange = { from, ...(to ? { to } : {}), ...(failure ? { error: failure } : {}), appliedAt };
      const patch: Partial<ComputerWebhookEventRecord> = failure
        ? { outcome: "error", reason: `Could not apply it: ${failure}`, statusChange, action: `Checked computer "${ids.join('", "')}" at ${prov.label}: failed` }
        : { statusChange, action: `Checked computer "${target.c.id}" at ${prov.label}: ${to && to !== from ? `${from} → ${to}` : `no change (${to ?? from})`}` };
      try {
        if (this.log.update(prov.id, rec.id, patch)) {
          if (failure) this.bump(prov.id, (s) => { s.errors = (s.errors ?? 0) + 1; s.lastError = patch.reason; s.lastErrorAt = appliedAt; s.lastErrorCode = "apply"; });
          this.announce({ ...rec, ...patch }, "updated");
        }
      } catch (err) {
        this.o.log?.("warn", `${prov.label} webhook: the delivery's result could not be recorded: ${(err as Error).message}`);
      }
    })();
    this.inflight = Promise.all([this.inflight, work]).then(() => undefined);
    return { status: 200, body: { ok: true, matched: ids, ignored } };
  }

  private inflight: Promise<void> = Promise.resolve();

  /** Resolves when the events received so far were applied (tests, shutdown). */
  idle(): Promise<void> {
    return this.inflight;
  }
}

const tooLarge = (bytes: number) => `Body too large (${Math.round(bytes / 1024)} KB; at most ${WEBHOOK_MAX_BODY_BYTES / 1024} KB)`;

/** The fields of the log entry an event gives. */
function describeEvent(e: ComputerProviderEvent): Partial<ComputerWebhookEventRecord> {
  return {
    providerEventId: e.id,
    ...(e.remoteId ? { sandboxId: e.remoteId } : {}),
    ...(e.snapshotName ? { snapshotName: e.snapshotName } : {}),
    ...(e.from || e.state ? { providerState: { ...(e.from ? { from: e.from } : {}), ...(e.state ? { to: e.state } : {}) } } : {}),
  };
}

/** The event type of a body not (yet) trusted, for a rejected delivery's entry. */
function typeOf(raw: string): { eventType?: string } {
  try {
    const b = JSON.parse(raw) as Record<string, unknown>;
    const t = str(b?.event) ?? str(b?.type);
    return t ? { eventType: t.slice(0, 100) } : {};
  } catch {
    return {};
  }
}

/** What the server gives the webhooks (the orchestrator, structurally). */
export interface ComputerWebhooksHost {
  getPolpoDir(): string;
  getConfig(): { settings?: { computers?: ComputerConfig[] } } | null | undefined;
  getVaultStore?(): VaultStore | null | undefined;
  /** The orchestrator's bus: each recorded delivery is announced as computer:webhook (SSE). */
  emit?(event: "computer:webhook", payload: PolpoEventMap["computer:webhook"]): unknown;
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
      emit: (payload) => { host.emit?.("computer:webhook", payload); },
    });
    instances.set(dir, w);
  }
  return w;
}
