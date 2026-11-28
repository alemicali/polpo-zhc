/**
 * Who holds a computer's desktop, and the agents' requests for a person to take over.
 *
 * A computer's desktop (its virtual display, see desktop.ts) is the agent's by default: a person
 * watching it live sees it view-only. "Take control" gives it to that person (their live view
 * becomes interactive, the agent's browser tools wait); "Give back" returns it to the agent, with
 * an optional note the agent reads. An agent that needs a person (a login, 2FA, a CAPTCHA) asks
 * with request_computer_takeover and waits for the person to take control and give it back.
 *
 * The state lives in .polpo/computer-control.json, under a file lock: the server changes it (REST,
 * MCP, Polpo's chat tools, task runs over the notification socket) and every process reads it
 * (task runners poll it while their agent waits, browser tools check it before acting). Nothing
 * the person types goes through here: they type in the VNC session, never in Polpo.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { acquireFileLock } from "./file-lock.js";

export type ComputerControlHolder = "agent" | "person";

export type TakeoverRequestStatus = "pending" | "in_control" | "released" | "timeout" | "cancelled";

/**
 * How much the agent needs the person:
 * - soft (default): optional help; if nobody takes over in time the agent goes on without it and
 *   says in its result what it could not do;
 * - hard: blocking (a CAPTCHA, a phone or app verification, a login wall); if nobody takes over in
 *   time its task is paused ("waiting for takeover") and the request stays open: completing the
 *   takeover resumes the task.
 */
export type TakeoverLevel = "soft" | "hard";

/** An agent asking a person to take control of its computer for a moment. */
export interface ComputerTakeoverRequest {
  id: string;
  computerId: string;
  agent: string;
  /** Why (shown to the person): "Sign in to LinkedIn: it asks for a 2FA code". */
  reason: string;
  /** The page it is on, if any. */
  url?: string;
  /** What the person should do before giving control back. */
  whatToDo?: string;
  createdAt: string;
  /** When the agent stops waiting (timeout); for a hard request of a task, when its task pauses. */
  expiresAt: string;
  status: TakeoverRequestStatus;
  /** soft (absent: soft) or hard: see TakeoverLevel. */
  level?: TakeoverLevel;
  /**
   * A hard request nobody took in time: its task was paused ("waiting for takeover") and the request
   * stays open (it never expires) until a person completes it (the task resumes) or the task is
   * resumed or stopped by someone (the request is cancelled).
   */
  parkedAt?: string;
  taskId?: string;
  runId?: string;
  sessionId?: string;
  /** The person who took control while it was open. */
  takenBy?: string;
  takenAt?: string;
  /** When the person gave control back (released), or it timed out / was cancelled. */
  endedAt?: string;
  /** The person's note to the agent (release). */
  note?: string;
}

/** Who holds a computer's desktop now. */
export interface ComputerControl {
  computerId: string;
  holder: ComputerControlHolder;
  /** The person holding it (member email, or "someone" without member sign-in). */
  person?: string;
  /** Since when the current holder holds it. */
  since?: string;
  /** The last note a person left when giving control back. */
  lastNote?: string;
  lastReleasedAt?: string;
}

/** A computer's control and its requests, open first then the most recent. */
export interface ComputerControlView extends ComputerControl {
  requests: ComputerTakeoverRequest[];
  /** The requests still open (pending, or a person in control for them). */
  open: ComputerTakeoverRequest[];
}

interface Entry { control: ComputerControl; requests: ComputerTakeoverRequest[] }
interface StateFile { version: 1; computers: Record<string, Entry> }

/** Requests kept per computer (the open ones always). */
const KEEP_REQUESTS = 20;
/** The longest an agent may wait for a person. */
export const TAKEOVER_MAX_MINUTES = 24 * 60;
/** How long an agent waits by default: optional help (soft), and a blocking step (hard: its task pauses after). */
export const TAKEOVER_DEFAULT_MINUTES = 30;
export const TAKEOVER_HARD_DEFAULT_MINUTES = 15;
/**
 * A hard request of a task is not expired by the store when its wait ends: the agent's run parks it
 * (pausing the task). If the run is gone and never does, it expires this long after its wait.
 */
export const TAKEOVER_HARD_GRACE_MS = 2 * 60_000;
const MAX_TEXT = 2000;

export class ComputerControlError extends Error {
  constructor(message: string, readonly code: "NOT_HELD" | "CONFLICT" | "NOT_FOUND" | "INVALID") {
    super(message);
    this.name = "ComputerControlError";
  }
}

const isOpen = (r: ComputerTakeoverRequest) => r.status === "pending" || r.status === "in_control";
/** An open request whose wait is over: never a parked one; a hard one of a task gets a grace (its run parks it). */
const isExpired = (r: ComputerTakeoverRequest, now: number) => isOpen(r) && !r.parkedAt
  && Date.parse(r.expiresAt) + (r.level === "hard" && r.taskId ? TAKEOVER_HARD_GRACE_MS : 0) <= now;
const clip = (s: string | undefined, max = MAX_TEXT) => (typeof s === "string" && s.trim() ? s.trim().slice(0, max) : undefined);

/** The control state of the computers of one .polpo directory (file-backed, shared by every process). */
export class ComputerControlStore {
  private readonly file: string;

  constructor(readonly polpoDir: string, private readonly clock: () => number = Date.now) {
    this.file = join(polpoDir, "computer-control.json");
  }

  private iso(): string {
    return new Date(this.clock()).toISOString();
  }

  private readAll(): Record<string, Entry> {
    if (!existsSync(this.file)) return {};
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as StateFile;
      return data?.computers && typeof data.computers === "object" ? data.computers : {};
    } catch {
      return {};
    }
  }

  private entry(all: Record<string, Entry>, id: string): Entry {
    return all[id] ?? { control: { computerId: id, holder: "agent" }, requests: [] };
  }

  /** Change one computer's entry under the lock; expired requests are closed on the way. */
  private async change<T>(id: string, fn: (e: Entry) => T): Promise<T> {
    const release = await acquireFileLock(`${this.file}.lock`, { busyMessage: "The computers' control state is locked by another process" });
    try {
      const all = this.readAll();
      const e = this.entry(all, id);
      this.expire(e);
      const out = fn(e);
      const open = e.requests.filter(isOpen);
      const closed = e.requests.filter((r) => !isOpen(r)).slice(-Math.max(0, KEEP_REQUESTS - open.length));
      e.requests = [...closed, ...open].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      all[id] = e;
      mkdirSync(this.polpoDir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, computers: all } satisfies StateFile, null, 2));
      renameSync(tmp, this.file);
      return out;
    } finally {
      release();
    }
  }

  /** Requests past their wait end as "timeout" (the agent stopped waiting). */
  private expire(e: Entry): ComputerTakeoverRequest[] {
    const now = this.clock();
    const expired: ComputerTakeoverRequest[] = [];
    for (const r of e.requests) {
      if (isExpired(r, now)) {
        r.status = "timeout";
        r.endedAt = new Date(now).toISOString();
        expired.push(r);
      }
    }
    return expired;
  }

  /** One computer's control and requests (read-only: never waits for the lock). */
  get(id: string): ComputerControlView {
    const e = this.entry(this.readAll(), id);
    const now = this.clock();
    const requests = e.requests.map((r) => (isExpired(r, now) ? { ...r, status: "timeout" as const } : r));
    const open = requests.filter(isOpen);
    return { ...e.control, requests: [...open, ...requests.filter((r) => !isOpen(r)).reverse()], open };
  }

  /** Every computer with an entry. */
  list(): ComputerControlView[] {
    return Object.keys(this.readAll()).map((id) => this.get(id));
  }

  /** One request, wherever it is. */
  request(requestId: string): ComputerTakeoverRequest | undefined {
    for (const e of Object.values(this.readAll())) {
      const r = e.requests.find((x) => x.id === requestId);
      if (r) return isExpired(r, this.clock()) ? { ...r, status: "timeout" } : r;
    }
    return undefined;
  }

  /** Whether a person holds the computer now (the agent's browser waits). */
  heldByPerson(id: string): ComputerControl | undefined {
    const c = this.entry(this.readAll(), id).control;
    return c.holder === "person" ? c : undefined;
  }

  /**
   * A person takes control. Their open requests (pending ones) become "in_control". Taking it from
   * another person needs force (a person who walked away); taking it again is a no-op.
   */
  async takeover(id: string, person: string, o: { force?: boolean } = {}): Promise<{ control: ComputerControl; requests: ComputerTakeoverRequest[] }> {
    const who = clip(person, 320) ?? "someone";
    return this.change(id, (e) => {
      if (e.control.holder === "person" && e.control.person !== who && !o.force) {
        throw new ComputerControlError(`${e.control.person ?? "Someone"} has control of computer "${id}" since ${e.control.since ?? "a moment ago"}: ask them to give it back (or take it over with force)`, "CONFLICT");
      }
      const at = this.iso();
      if (!(e.control.holder === "person" && e.control.person === who)) e.control = { ...e.control, holder: "person", person: who, since: at };
      const linked: ComputerTakeoverRequest[] = [];
      for (const r of e.requests) {
        if (r.status !== "pending") continue;
        r.status = "in_control";
        r.takenBy = who;
        r.takenAt = at;
        linked.push({ ...r });
      }
      return { control: { ...e.control }, requests: linked };
    });
  }

  /**
   * The person gives control back to the agent, with an optional note (what they did, what the
   * agent should know). The requests they held become "released" with that note; requests still
   * pending (made after they took control) are released too: the person was there.
   */
  async release(id: string, person: string | undefined, note?: string, o: { force?: boolean } = {}): Promise<{ control: ComputerControl; requests: ComputerTakeoverRequest[] }> {
    const who = clip(person, 320) ?? "someone";
    const text = clip(note);
    return this.change(id, (e) => {
      if (e.control.holder !== "person") throw new ComputerControlError(`Nobody has taken control of computer "${id}": the agent has it`, "NOT_HELD");
      if (e.control.person && e.control.person !== who && !o.force) {
        throw new ComputerControlError(`${e.control.person} has control of computer "${id}": only they can give it back (or use force)`, "CONFLICT");
      }
      const at = this.iso();
      const released: ComputerTakeoverRequest[] = [];
      for (const r of e.requests) {
        if (!isOpen(r)) continue;
        r.status = "released";
        r.takenBy ??= e.control.person ?? who;
        r.takenAt ??= e.control.since ?? at;
        r.endedAt = at;
        if (text) r.note = text;
        released.push({ ...r });
      }
      e.control = { computerId: id, holder: "agent", since: at, ...(text ? { lastNote: text } : {}), lastReleasedAt: at };
      return { control: { ...e.control }, requests: released };
    });
  }

  /** An agent asks a person to take over. While a person already holds control it is theirs at once. */
  async open(req: {
    computerId: string; agent: string; reason: string; url?: string; whatToDo?: string; timeoutMinutes?: number;
    level?: TakeoverLevel; taskId?: string; runId?: string; sessionId?: string;
  }): Promise<ComputerTakeoverRequest> {
    const reason = clip(req.reason);
    if (!reason) throw new ComputerControlError("Say why a person should take over (reason)", "INVALID");
    const level: TakeoverLevel = req.level === "hard" ? "hard" : "soft";
    const minutes = Math.min(TAKEOVER_MAX_MINUTES, Math.max(1, Math.round(req.timeoutMinutes ?? (level === "hard" ? TAKEOVER_HARD_DEFAULT_MINUTES : TAKEOVER_DEFAULT_MINUTES))));
    return this.change(req.computerId, (e) => {
      const now = this.clock();
      const held = e.control.holder === "person";
      const r: ComputerTakeoverRequest = {
        id: `tko_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        computerId: req.computerId, agent: req.agent, reason,
        ...(clip(req.url, 2048) ? { url: clip(req.url, 2048) } : {}),
        ...(clip(req.whatToDo) ? { whatToDo: clip(req.whatToDo) } : {}),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + minutes * 60_000).toISOString(),
        status: held ? "in_control" : "pending",
        level,
        ...(held ? { takenBy: e.control.person, takenAt: new Date(now).toISOString() } : {}),
        ...(req.taskId ? { taskId: req.taskId } : {}),
        ...(req.runId ? { runId: req.runId } : {}),
        ...(req.sessionId ? { sessionId: req.sessionId } : {}),
      };
      e.requests.push(r);
      return { ...r };
    });
  }

  /**
   * A hard request's wait ended with nobody done: it stays open, never expiring, while its task is
   * paused. Only an open request is parked (the returned request says whether it was).
   */
  async park(requestId: string): Promise<ComputerTakeoverRequest | undefined> {
    const found = Object.entries(this.readAll()).find(([, e]) => e.requests.some((r) => r.id === requestId));
    if (!found) return undefined;
    return this.change(found[0], (e) => {
      const r = e.requests.find((x) => x.id === requestId);
      if (!r) return undefined;
      // a hard request of a task is still open in its grace (change() expired the others)
      if (isOpen(r) && !r.parkedAt) r.parkedAt = this.iso();
      return { ...r };
    });
  }

  /**
   * The agent stops waiting: timeout, or cancelled (its run ended). A closed request is left as it
   * is; so is a parked one (its run was stopped by the pause), unless `parked` (its task was resumed
   * or stopped by someone: the request is cancelled).
   */
  async close(requestId: string, status: "timeout" | "cancelled", o: { parked?: boolean } = {}): Promise<ComputerTakeoverRequest | undefined> {
    const found = Object.entries(this.readAll()).find(([, e]) => e.requests.some((r) => r.id === requestId));
    if (!found) return undefined;
    return this.change(found[0], (e) => {
      const r = e.requests.find((x) => x.id === requestId);
      if (!r) return undefined;
      if (isOpen(r) && (!r.parkedAt || o.parked)) {
        r.status = status;
        r.endedAt = this.iso();
      }
      return { ...r };
    });
  }
}

/** "12 min left", "1 h 5 min left", "time is up". */
export function minutesLeft(expiresAt: string, now = Date.now()): string {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "time is up";
  const min = Math.ceil(ms / 60_000);
  return min < 60 ? `${min} min left` : `${Math.floor(min / 60)} h ${min % 60} min left`;
}

/**
 * How an open request waits, in a line (MCP, Polpo's chat, notifications): its level, until when
 * and what happens then; a parked one says its task is paused until a person completes it.
 */
export function describeTakeoverWait(r: Pick<ComputerTakeoverRequest, "level" | "expiresAt" | "parkedAt" | "taskId"> & { status: string }, now = Date.now()): string {
  if (r.status !== "pending" && r.status !== "in_control") return r.level === "hard" ? "blocking" : "optional";
  if (r.parkedAt) return `blocking · nobody took over in time: its task is paused (waiting for takeover) since ${r.parkedAt}; completing the takeover resumes it`;
  if (r.level === "hard") return `blocking · waits until ${r.expiresAt} (${minutesLeft(r.expiresAt, now)}), then ${r.taskId ? "its task pauses until a person does it" : "the agent stops and reports it is blocked"}`;
  return `optional · waits until ${r.expiresAt} (${minutesLeft(r.expiresAt, now)}), then the agent goes on without it`;
}

const stores = new Map<string, ComputerControlStore>();

/** The control store of a .polpo directory (one per process). */
export function computerControlStore(polpoDir: string): ComputerControlStore {
  let s = stores.get(polpoDir);
  if (!s) stores.set(polpoDir, (s = new ComputerControlStore(polpoDir)));
  return s;
}

/** Tests: replace (or drop) the store of a .polpo directory. */
export function setComputerControlStore(polpoDir: string, store: ComputerControlStore | undefined): void {
  if (store) stores.set(polpoDir, store);
  else stores.delete(polpoDir);
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); }
  signal?.addEventListener("abort", done, { once: true });
});

/** How long the agent's browser waits for a person to give control back before giving up. */
export const BROWSER_CONTROL_WAIT_MS = 30 * 60_000;

/**
 * Before the agent's browser acts on a computer: while a person holds it, wait until they give it
 * back (polling, abortable). Resolves undefined when the agent may act, else why not (the person
 * still holds it after maxWaitMs, or the run was stopped).
 */
export async function waitForAgentControl(
  store: Pick<ComputerControlStore, "heldByPerson">, computerId: string,
  o: { signal?: AbortSignal; pollMs?: number; maxWaitMs?: number; now?: () => number; onWait?: (c: ComputerControl) => void } = {},
): Promise<string | undefined> {
  const now = o.now ?? Date.now;
  let held = store.heldByPerson(computerId);
  if (!held) return undefined;
  o.onWait?.(held);
  const until = now() + (o.maxWaitMs ?? BROWSER_CONTROL_WAIT_MS);
  while (held) {
    if (o.signal?.aborted) return `Stopped while ${held.person ?? "a person"} had control of computer "${computerId}"`;
    if (now() >= until) {
      return `${held.person ?? "A person"} has control of computer "${computerId}" since ${held.since ?? "a while"}: the browser did not act. `
        + "Wait for them to give it back (request_computer_takeover waits for that) and try again.";
    }
    await sleep(o.pollMs ?? 2000, o.signal);
    held = store.heldByPerson(computerId);
  }
  return undefined;
}
