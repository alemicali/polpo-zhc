/**
 * The event log of the computers' provider webhooks: every delivery a provider (Daytona, E2B)
 * sends to this instance, whatever came of it — accepted (a computer was checked at its provider),
 * ignored (not about one of this instance's computers, a duplicate, nothing Polpo acts on),
 * rejected (signature, replay, size, rate, not configured) or an error — with what Polpo did.
 *
 * Kept as a capped file per provider (.polpo/computer-webhook-events/<provider>.json, newest first,
 * the last COMPUTER_WEBHOOK_EVENTS_MAX entries), like the webhooks' status
 * (.polpo/computer-webhooks.json) and the sync history (.polpo/sync-history.jsonl): per-instance
 * diagnostics, bounded and never queried across instances, so it lives next to the status whatever
 * the instance's store (file, SQLite or Postgres) and needs no table or migration.
 *
 * Payloads are redacted before they are written (any key that looks like a secret, token, password,
 * key, signature, cookie or env; any value that looks like a signing secret or a bearer token) and
 * capped (COMPUTER_WEBHOOK_PAYLOAD_MAX_BYTES); of the headers only the safe ones are kept (never a
 * signature or an authorization).
 */
import { randomBytes } from "node:crypto";
import { CappedWebhookEventLog } from "../core/webhook-event-log.js";

export type ComputerWebhookOutcome = "accepted" | "ignored" | "rejected" | "error";
export const COMPUTER_WEBHOOK_OUTCOMES: readonly ComputerWebhookOutcome[] = ["accepted", "ignored", "rejected", "error"];

/** How the delivery's signature fared. */
export type ComputerWebhookSignature = "valid" | "invalid" | "missing" | "not-checked";

/** Entries kept per provider. */
export const COMPUTER_WEBHOOK_EVENTS_MAX = 200;
/** A payload larger than this (redacted, as JSON) is kept truncated. */
export const COMPUTER_WEBHOOK_PAYLOAD_MAX_BYTES = 4 * 1024;
/** The headers worth keeping (no signature, no authorization, no cookie). */
export const COMPUTER_WEBHOOK_SAFE_HEADERS = [
  "content-type", "content-length", "user-agent", "svix-id", "svix-timestamp", "webhook-id", "webhook-timestamp", "x-forwarded-for",
] as const;

/** One delivery, as the log keeps it. */
export interface ComputerWebhookEventRecord {
  id: string;
  provider: string;
  receivedAt: string;
  outcome: ComputerWebhookOutcome;
  /** Why it was ignored or rejected, or what went wrong. */
  reason?: string;
  /** What Polpo answered the provider. */
  httpStatus: number;
  signature: ComputerWebhookSignature;
  /** The provider's event type (sandbox.state.updated, sandbox.lifecycle.killed…). */
  eventType?: string;
  /** The provider's event id (E2B) or the event's idempotency key (Daytona). */
  providerEventId?: string;
  /** The delivery's id (Svix: svix-id / webhook-id). */
  deliveryId?: string;
  /** The provider's machine id. */
  sandboxId?: string;
  snapshotName?: string;
  /** This instance's computer the event is about. */
  computerId?: string;
  /** The provider's states the event reports (Daytona: oldState → newState). */
  providerState?: { from?: string; to?: string };
  /** The computer's status in Polpo before and after Polpo applied the event (it checks the computer at its provider). */
  statusChange?: { from?: string; to?: string; error?: string; appliedAt?: string };
  /** What Polpo did, in a line. */
  action?: string;
  /** Events in the delivery (a delivery usually carries one). */
  events?: number;
  /** Time to verify and route the delivery (the computer's check runs after the answer). */
  processingMs: number;
  bytes: number;
  /** The redacted payload (JSON) or, when it was not JSON, a redacted text preview. */
  payload?: unknown;
  payloadTruncated?: boolean;
  headers?: Record<string, string>;
}

/** A log entry without its payload and headers (the list). */
export type ComputerWebhookEventSummary = Omit<ComputerWebhookEventRecord, "payload" | "headers">;

export interface ComputerWebhookEventPage {
  events: ComputerWebhookEventSummary[];
  /** Pass as `cursor` for the next (older) page. */
  nextCursor?: string;
  /** Entries kept for this provider (any outcome). */
  total: number;
  /** Entries kept per outcome. */
  counts: Record<ComputerWebhookOutcome, number>;
}

const SECRET_KEY = /secret|token|passw|api[-_]?key|apikey|authori[sz]ation|signature|cookie|credential|private[-_]?key|^env$|^envs$|env[-_]?vars/i;
const SECRET_VALUE = /\b(whsec_[A-Za-z0-9+/=]+|e2b_[A-Za-z0-9]{16,}|dtn_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{16,}|(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,})/g;
const REDACTED = "[redacted]";

function redactString(s: string): string {
  return s.replace(SECRET_VALUE, REDACTED);
}

/** A copy of a JSON value with anything that looks secret replaced by "[redacted]". */
export function redactWebhookPayload(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[…]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactWebhookPayload(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && v !== null && v !== undefined && v !== "" ? REDACTED : redactWebhookPayload(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** The raw body, redacted and capped: the parsed JSON when it fits, else a truncated text. */
export function webhookPayloadPreview(raw: string): { payload?: unknown; truncated?: boolean } {
  if (!raw) return {};
  let parsed: unknown;
  let json = false;
  try { parsed = JSON.parse(raw); json = true; } catch { /* not JSON: a text preview */ }
  if (json) {
    const redacted = redactWebhookPayload(parsed);
    const text = JSON.stringify(redacted);
    if (Buffer.byteLength(text) <= COMPUTER_WEBHOOK_PAYLOAD_MAX_BYTES) return { payload: redacted };
    return { payload: `${text.slice(0, COMPUTER_WEBHOOK_PAYLOAD_MAX_BYTES)}…`, truncated: true };
  }
  const text = redactString(raw);
  return text.length > 512 ? { payload: `${text.slice(0, 512)}…`, truncated: true } : { payload: text };
}

/** The safe headers of a delivery. */
export function safeWebhookHeaders(header: (name: string) => string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of COMPUTER_WEBHOOK_SAFE_HEADERS) {
    const v = header(name);
    if (v) out[name] = v.slice(0, 300);
  }
  return out;
}

export const newWebhookEventId = (now: number) => `whe_${now.toString(36)}${randomBytes(4).toString("hex")}`;

/** The capped per-provider log (newest first): the shared webhook event log, one file per provider. */
export class ComputerWebhookEventLog {
  private readonly log: CappedWebhookEventLog<ComputerWebhookEventRecord, ComputerWebhookEventSummary>;
  constructor(polpoDir: () => string, max = COMPUTER_WEBHOOK_EVENTS_MAX) {
    this.log = new CappedWebhookEventLog(polpoDir, "computer-webhook-events", max, ({ payload: _p, headers: _h, ...summary }) => summary);
  }

  /** Every kept entry, newest first. */
  all(provider: string): ComputerWebhookEventRecord[] { return this.log.all(provider); }

  /** Add an entry (the oldest beyond the cap are dropped). */
  add(record: ComputerWebhookEventRecord): void { this.log.add(record.provider, record); }

  /** Change an entry (what Polpo did, once applied); false when it is no longer kept. */
  update(provider: string, id: string, patch: Partial<ComputerWebhookEventRecord>): boolean { return this.log.update(provider, id, patch); }

  get(provider: string, id: string): ComputerWebhookEventRecord | undefined { return this.log.get(provider, id); }

  /** Entries kept per outcome, and in all. */
  counts(provider: string): { total: number; counts: Record<ComputerWebhookOutcome, number> } { return this.log.counts(provider); }

  /** A page of summaries, newest first; `cursor`: the last id of the previous page. */
  list(provider: string, o: { limit?: number; cursor?: string; outcomes?: readonly ComputerWebhookOutcome[] } = {}): ComputerWebhookEventPage {
    return this.log.list(provider, o);
  }
}
