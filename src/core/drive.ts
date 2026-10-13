/**
 * Agents with a drive: a purpose and goals they pursue on their own initiative, among people.
 *
 * An agent with `drive.enabled` keeps a self-portrait (its personality, the people that matter and how,
 * its open threads) that it carries forward, and reflects from time to time on what happened in its
 * chats and groups, also what it only read. At each reflection it decides, as a thoughtful person with
 * its purpose would, whether to write now, plan something for later (an intention: a scheduled check
 * with a why), or do nothing; how freely depends on its autonomy. Its chats see the same purpose, so it
 * also plans on its own while talking (the birthday mentioned in passing becomes wishes the next day).
 *
 * It also works on itself, as a person does on their goals: it keeps a plan of its own (steps toward its
 * goals, with their status), studies what it lacks and writes it down as skills of its own, and schedules
 * work sessions for what takes time.
 *
 * Files: `.polpo/drive/<agent>/` — self.md, self-history.json, plan.json, journal.json, state.json.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { AgentAutonomy, AgentConfig, ConversationCheck, SessionStore } from "@polpo-ai/core";
import type { Room, RoomMessage, RoomStore } from "@polpo-ai/core/room-store";
import type { ConversationCheckManager } from "./conversation-check-manager.js";

export const DEFAULT_REFLECT_EVERY_MINUTES = 120;
export const MIN_REFLECT_EVERY_MINUTES = 15;
const DAY_MS = 24 * 60 * 60_000;
const TICK_MS = 2 * 60_000;
const REFLECTION_TIMEOUT_MS = 15 * 60_000;
/** What one reflection reads at most (the most recent part wins), and how far back the first one looks. */
const MAX_MATERIAL_CHARS = 30_000;
const MAX_MESSAGE_CHARS = 1_200;
const FIRST_LOOKBACK_MS = 7 * DAY_MS;
const ROOM_MESSAGES = 80;
const JOURNAL_KEEP = 200;
const SELF_HISTORY_KEEP = 30;
const MAX_SELF_CHARS = 8_000;

export type ReflectionTrigger = "first" | "activity" | "daily" | "manual";

export interface ReflectionEntry {
  id: string;
  at: string;
  trigger: ReflectionTrigger;
  /** New messages it read. */
  messages: number;
  /** Its decision and why, in its words. */
  summary: string;
  /** What it did: "sent to …", "planned chk_… (why)", "proposed …", "updated self-portrait". */
  actions: string[];
  /** The reviews it made (daily reflections). */
  reviews?: ReviewCadence[];
}

export type PlanStatus = "todo" | "doing" | "done" | "dropped";

/**
 * How far a goal looks: the purpose breaks down into long-term goals (6–12 months), then the quarter,
 * the month, the week and the day. A plan item without a horizon is a step (something to do).
 */
export type GoalHorizon = "long" | "quarter" | "month" | "week" | "day";
export const GOAL_HORIZONS: readonly GoalHorizon[] = ["long", "quarter", "month", "week", "day"];

/** The reviews of a daily reflection: every day, and on the first day of a week, a month, a quarter. */
export type ReviewCadence = "day" | "week" | "month" | "quarter";

/** A goal (with a horizon) or a step of the agent's own plan. */
export interface PlanItem {
  id: string;
  title: string;
  /** A goal's horizon; none for a step. */
  horizon?: GoalHorizon;
  /** The goal it serves (another item of the plan). */
  parentId?: string;
  /** How it will know it is done: a measure, a key result, a criterion. */
  measure?: string;
  /** 0–100. */
  progress?: number;
  /** Whose goal it is: absent = its own; a person or a group it supports. */
  owner?: string;
  /** Why it matters for its purpose. */
  why?: string;
  /** The configured goal it serves. */
  goal?: string;
  status: PlanStatus;
  /** By when (ISO date or time). */
  due?: string;
  /** Progress, findings, what is left. */
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

const PLAN_KEEP_CLOSED = 50;

function clampProgress(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
}

export interface SelfRevision {
  at: string;
  before: string;
  after: string;
  source: "reflection" | "chat" | "person";
}

interface DriveState {
  /** Last message read, per private chat session. */
  cursors: Record<string, string>;
  /** Time of the last message read, per group room. */
  roomCursors: Record<string, string>;
  runSessionId?: string;
  lastReflectionAt?: string;
  /** When each review last happened. */
  lastReviews?: Partial<Record<ReviewCadence, string>>;
}

export const DEFAULT_DAY_STARTS_AT = "07:30";

/** Date and time parts in a timezone. */
function localParts(date: Date, timezone?: string): { day: string; time: string; weekday: number; month: number; year: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(date);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { day: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}`, weekday, month: Number(get("month")), year: Number(get("year")) };
}

/** The period keys of a date: its day, ISO-like week (its Monday), month and quarter. */
function periodKeys(date: Date, timezone?: string): Record<ReviewCadence, string> {
  const p = localParts(date, timezone);
  const monday = new Date(`${p.day}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((p.weekday + 6) % 7));
  return { day: p.day, week: monday.toISOString().slice(0, 10), month: p.day.slice(0, 7), quarter: `${p.year}-Q${Math.ceil(p.month / 3)}` };
}

/**
 * The reviews due now: the daily one once the agent's day has started (dayStartsAt) and it did not
 * review today yet; with it, the weekly, monthly and quarterly ones on the first day of a new period.
 */
export function dueReviews(lastReviews: DriveState["lastReviews"], now: Date, timezone?: string, dayStartsAt = DEFAULT_DAY_STARTS_AT): ReviewCadence[] {
  const current = periodKeys(now, timezone);
  const last = lastReviews?.day ? periodKeys(new Date(lastReviews.day), timezone) : undefined;
  if (last?.day === current.day || localParts(now, timezone).time < dayStartsAt) return [];
  const due: ReviewCadence[] = ["day"];
  for (const cadence of ["week", "month", "quarter"] as const) {
    const done = lastReviews?.[cadence] ? periodKeys(new Date(lastReviews[cadence]!), timezone)[cadence] : undefined;
    if (done !== current[cadence]) due.push(cadence);
  }
  return due;
}

/** Sessions that are not conversations (reflections). */
export function isReflectionScope(scope: string | undefined): boolean {
  return !!scope && scope.startsWith("reflection:");
}

/** Group conversations are read from their rooms (the whole transcript), not from the agent's session. */
function isRoomScope(scope: string | undefined): boolean {
  return !!scope && (scope.startsWith("telegram:group:") || scope.startsWith("web:"));
}

function atomicWrite(path: string, value: string): void {
  const tmp = `${path}.${process.pid}.${nanoid(6)}.tmp`;
  writeFileSync(tmp, value, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, "utf-8")) as T; } catch { return fallback; }
}

export class FileDriveStore {
  constructor(private readonly polpoDir: string) {}

  private dir(agent: string): string {
    const dir = join(this.polpoDir, "drive", agent.replace(/[^\w.-]/g, "_"));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  getSelf(agent: string): string {
    const path = join(this.dir(agent), "self.md");
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  }

  /** Replace the self-portrait; the previous one is kept in its history. */
  setSelf(agent: string, text: string, source: SelfRevision["source"]): SelfRevision {
    const before = this.getSelf(agent);
    const after = text.trim().slice(0, MAX_SELF_CHARS);
    atomicWrite(join(this.dir(agent), "self.md"), after);
    const revision: SelfRevision = { at: new Date().toISOString(), before, after, source };
    const history = [revision, ...this.listSelfHistory(agent)].slice(0, SELF_HISTORY_KEEP);
    atomicWrite(join(this.dir(agent), "self-history.json"), JSON.stringify(history, null, 2));
    return revision;
  }

  listSelfHistory(agent: string): SelfRevision[] {
    return readJson<SelfRevision[]>(join(this.dir(agent), "self-history.json"), []);
  }

  /** Open items first (goals from the longest horizon, then steps), then the latest closed ones. */
  listPlan(agent: string): PlanItem[] {
    const open = (i: PlanItem) => i.status === "todo" || i.status === "doing";
    const rank = (i: PlanItem) => (i.horizon ? GOAL_HORIZONS.indexOf(i.horizon) : GOAL_HORIZONS.length);
    return readJson<PlanItem[]>(join(this.dir(agent), "plan.json"), [])
      .sort((a, b) => Number(open(b)) - Number(open(a))
        || (open(a) ? rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt) : b.updatedAt.localeCompare(a.updatedAt)));
  }

  savePlan(agent: string, items: PlanItem[]): void {
    const open = items.filter((i) => i.status === "todo" || i.status === "doing");
    const closed = items.filter((i) => i.status === "done" || i.status === "dropped")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, PLAN_KEEP_CLOSED);
    atomicWrite(join(this.dir(agent), "plan.json"), JSON.stringify([...open, ...closed], null, 2));
  }

  getState(agent: string): DriveState {
    return { cursors: {}, roomCursors: {}, ...readJson<Partial<DriveState>>(join(this.dir(agent), "state.json"), {}) };
  }

  saveState(agent: string, state: DriveState): void {
    atomicWrite(join(this.dir(agent), "state.json"), JSON.stringify(state, null, 2));
  }

  addJournal(agent: string, entry: Omit<ReflectionEntry, "id">): ReflectionEntry {
    const full: ReflectionEntry = { id: `ref_${nanoid(10)}`, ...entry };
    const journal = [full, ...this.listJournal(agent, JOURNAL_KEEP)].slice(0, JOURNAL_KEEP);
    atomicWrite(join(this.dir(agent), "journal.json"), JSON.stringify(journal, null, 2));
    return full;
  }

  /** Newest first. */
  listJournal(agent: string, limit = 50): ReflectionEntry[] {
    return readJson<ReflectionEntry[]>(join(this.dir(agent), "journal.json"), []).slice(0, limit);
  }
}

/** One reflection: a turn of the agent's reflection session with this prompt. */
export type ReflectionRunner = (input: { agent: AgentConfig; sessionId: string; prompt: string; signal: AbortSignal }) => Promise<{ text: string } | "deferred">;

export interface DriveDeps {
  getAgents(): Promise<AgentConfig[]>;
  sessions: SessionStore;
  rooms?: RoomStore;
  /** The agent takes part in this group room (its bot is in it, or it is one of the room's agents). */
  inRoom(agent: string, room: Room): boolean;
  checks?: ConversationCheckManager;
  store: FileDriveStore;
  /** Creates the agent's reflection session. */
  createReflectionSession(agent: string): Promise<string>;
  emit(event: "agent:reflected", payload: { agentName: string; trigger: ReflectionTrigger; messages: number; summary: string; actions: string[]; timestamp: string }): void;
  log(level: "info" | "warn", message: string): void;
}

export class DriveManager {
  private runner?: ReflectionRunner;
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  /** Agent → what it did during the reflection running now. */
  private readonly reflecting = new Map<string, { controller: AbortController; sessionId?: string; actions: string[] }>();

  constructor(private readonly deps: DriveDeps, private readonly tickMs = TICK_MS) {}

  setRunner(runner: ReflectionRunner): void { this.runner = runner; }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const r of this.reflecting.values()) r.controller.abort();
    this.reflecting.clear();
  }

  getSelf(agent: string): string { return this.deps.store.getSelf(agent); }
  setSelf(agent: string, text: string, source: SelfRevision["source"]): SelfRevision {
    const revision = this.deps.store.setSelf(agent, text, source);
    this.reflecting.get(agent)?.actions.push("updated its self-portrait");
    return revision;
  }
  listJournal(agent: string, limit?: number): ReflectionEntry[] { return this.deps.store.listJournal(agent, limit); }
  listPlan(agent: string): PlanItem[] { return this.deps.store.listPlan(agent); }

  addPlanItem(agent: string, input: Pick<PlanItem, "title"> & Partial<Pick<PlanItem, "why" | "goal" | "due" | "notes" | "status" | "horizon" | "parentId" | "measure" | "owner" | "progress">>): PlanItem {
    const title = input.title.trim();
    if (!title) throw new Error("The item needs a title");
    if (input.horizon && !GOAL_HORIZONS.includes(input.horizon)) throw new Error(`horizon must be one of ${GOAL_HORIZONS.join(", ")}`);
    const items = this.deps.store.listPlan(agent);
    if (input.parentId && !items.some((i) => i.id === input.parentId)) throw new Error(`No goal ${input.parentId} in the plan`);
    const now = new Date().toISOString();
    const item: PlanItem = {
      id: `pln_${nanoid(8)}`, title: title.slice(0, 300), status: input.status ?? "todo", createdAt: now, updatedAt: now,
      ...(input.why?.trim() ? { why: input.why.trim().slice(0, 600) } : {}),
      ...(input.goal?.trim() ? { goal: input.goal.trim().slice(0, 300) } : {}),
      ...(input.due?.trim() ? { due: input.due.trim() } : {}),
      ...(input.notes?.trim() ? { notes: input.notes.trim().slice(0, 2000) } : {}),
      ...(input.horizon ? { horizon: input.horizon } : {}),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.measure?.trim() ? { measure: input.measure.trim().slice(0, 600) } : {}),
      ...(input.owner?.trim() && input.owner.trim().toLowerCase() !== "me" ? { owner: input.owner.trim().slice(0, 200) } : {}),
      ...(input.progress !== undefined ? { progress: clampProgress(input.progress) } : {}),
    };
    this.deps.store.savePlan(agent, [...items, item]);
    this.reflecting.get(agent)?.actions.push(`added to its plan${item.horizon ? ` (${item.horizon} goal)` : ""}: ${item.title}`);
    return item;
  }

  updatePlanItem(agent: string, id: string, patch: Partial<Pick<PlanItem, "title" | "why" | "goal" | "due" | "notes" | "status" | "measure" | "owner" | "progress" | "horizon" | "parentId">>): PlanItem {
    const items = this.deps.store.listPlan(agent);
    const item = items.find((i) => i.id === id);
    if (!item) throw new Error(`No item ${id} in the plan`);
    if (patch.horizon !== undefined) {
      if (patch.horizon && !GOAL_HORIZONS.includes(patch.horizon)) throw new Error(`horizon must be one of ${GOAL_HORIZONS.join(", ")}`);
      if (patch.horizon) item.horizon = patch.horizon; else delete item.horizon;
    }
    if (patch.parentId !== undefined) {
      if (patch.parentId && (patch.parentId === id || !items.some((i) => i.id === patch.parentId))) throw new Error(`No goal ${patch.parentId} in the plan`);
      if (patch.parentId) item.parentId = patch.parentId; else delete item.parentId;
    }
    if (patch.progress !== undefined) item.progress = clampProgress(patch.progress);
    for (const key of ["title", "why", "goal", "due", "notes", "measure", "owner"] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      if (key === "owner" && value.trim().toLowerCase() === "me") delete item.owner;
      else if (value.trim()) item[key] = value.trim().slice(0, key === "notes" ? 2000 : 600);
      else if (key !== "title") delete item[key];
    }
    if (patch.status) item.status = patch.status;
    if (item.status === "done") item.progress = 100;
    item.updatedAt = new Date().toISOString();
    this.deps.store.savePlan(agent, items);
    if (patch.status) this.reflecting.get(agent)?.actions.push(`plan: "${item.title}" is ${item.status}`);
    return item;
  }
  listSelfHistory(agent: string): SelfRevision[] { return this.deps.store.listSelfHistory(agent); }
  lastReflectionAt(agent: string): string | undefined { return this.deps.store.getState(agent).lastReflectionAt; }

  /** True when `sessionId` is the agent's reflection running now (its own initiative, nobody asked). */
  isReflecting(agent: string, sessionId?: string): boolean {
    const r = this.reflecting.get(agent);
    return !!r && (!sessionId || !r.sessionId || r.sessionId === sessionId);
  }

  /** What the agent did during its reflection (tools report it), for its journal. */
  noteAction(agent: string, action: string): void {
    this.reflecting.get(agent)?.actions.push(action);
  }

  /** The agent's intentions still ahead (planned or proposed). */
  async intentions(agent: string): Promise<ConversationCheck[]> {
    return (await this.deps.checks?.list({ agent, states: ["active", "proposed"] }).catch(() => []) ?? []);
  }

  /** Reflect for every agent with a drive that is due: first time, new material after its interval, or once a day. */
  async tick(now = new Date()): Promise<void> {
    if (this.ticking || !this.runner) return;
    this.ticking = true;
    try {
      for (const agent of await this.deps.getAgents()) {
        if (!agent.drive?.enabled || this.reflecting.has(agent.name)) continue;
        const state = this.deps.store.getState(agent.name);
        const last = state.lastReflectionAt;
        if (!last) { await this.reflect(agent.name, "first", undefined, now); continue; }
        // its day started: daily planning, with the weekly / monthly / quarterly review when a new period began
        const reviews = dueReviews(state.lastReviews, now, agent.identity?.timezone, agent.drive.dayStartsAt);
        if (reviews.length) { await this.reflect(agent.name, "daily", reviews, now); continue; }
        const since = now.getTime() - Date.parse(last);
        const every = Math.max(MIN_REFLECT_EVERY_MINUTES, agent.drive.reflectEveryMinutes ?? DEFAULT_REFLECT_EVERY_MINUTES) * 60_000;
        if (since >= DAY_MS) { await this.reflect(agent.name, "daily", undefined, now); continue; }
        if (since < every) continue;
        const { count } = await this.collect(agent.name, this.deps.store.getState(agent.name), now);
        if (count > 0) await this.reflect(agent.name, "activity", undefined, now);
      }
    } catch (err) {
      this.deps.log("warn", `[drive] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  /** What happened since the last reflection: private chats (its sessions) and groups (their rooms). */
  async collect(agent: string, state: DriveState, now = new Date()): Promise<{ text: string; count: number; cursors: Record<string, string>; roomCursors: Record<string, string> }> {
    const floor = state.lastReflectionAt ?? new Date(now.getTime() - FIRST_LOOKBACK_MS).toISOString();
    const parts: string[] = [];
    const cursors = { ...state.cursors };
    const roomCursors = { ...state.roomCursors };
    let count = 0;
    const clip = (text: string) => (text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text);
    const stamp = (ts: string) => ts.slice(0, 16).replace("T", " ");

    const sessions = (await this.deps.sessions.listSessions())
      .filter((s) => s.agent === agent && !isReflectionScope(s.scope) && !isRoomScope(s.scope) && !s.scope?.startsWith("learning:") && !s.scope?.startsWith("check:"))
      .filter((s) => s.updatedAt > floor)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const session of sessions) {
      const all = await this.deps.sessions.getMessages(session.id);
      const cursor = cursors[session.id];
      const from = cursor ? all.findIndex((m) => m.id === cursor) + 1 : 0;
      const fresh = all.slice(from).filter((m) => (m.role === "user" || m.role === "assistant") && m.content?.trim() && (cursor || m.ts > floor));
      if (all.length) cursors[session.id] = all[all.length - 1]!.id;
      if (!fresh.length) continue;
      count += fresh.length;
      parts.push(`## Private chat "${session.title ?? session.id}"\n${fresh.map((m) => `[${stamp(m.ts)}] ${m.role === "user" ? "Them" : "You"}: ${clip(m.content)}`).join("\n")}`);
    }

    if (this.deps.rooms) {
      const rooms = await this.deps.rooms.listRooms().catch(() => [] as Room[]);
      for (const room of rooms) {
        const recent = await this.deps.rooms.getRecentMessages(room.id, ROOM_MESSAGES).catch(() => [] as RoomMessage[]);
        const takesPart = this.deps.inRoom(agent, room) || recent.some((m) => m.authorKind === "agent" && m.authorId === agent);
        if (!takesPart || !recent.length) continue;
        const cursor = roomCursors[room.id] ?? floor;
        const fresh = recent.filter((m) => m.ts > cursor && m.text?.trim());
        roomCursors[room.id] = recent[recent.length - 1]!.ts > (roomCursors[room.id] ?? "") ? recent[recent.length - 1]!.ts : roomCursors[room.id]!;
        if (!fresh.length) continue;
        count += fresh.length;
        parts.push(`## Group "${room.title || room.id}" (id ${room.id})\n${fresh.map((m) => {
          const who = m.authorKind === "agent" && m.authorId === agent ? "You" : m.authorName;
          const toYou = m.addressedTo?.includes(agent) ? " (to you)" : "";
          return `[${stamp(m.ts)}] ${who}${toYou}: ${clip(m.text)}`;
        }).join("\n")}`);
      }
    }

    let text = parts.join("\n\n");
    if (text.length > MAX_MATERIAL_CHARS) text = `…\n${text.slice(text.length - MAX_MATERIAL_CHARS)}`;
    return { text, count, cursors, roomCursors };
  }

  /** Reflect now: read what happened, decide, act or plan, keep the self-portrait. Returns the journal entry. */
  async reflect(agentName: string, trigger: ReflectionTrigger = "manual", reviewsDue?: ReviewCadence[], at?: Date): Promise<ReflectionEntry | undefined> {
    if (!this.runner || this.reflecting.has(agentName)) return undefined;
    const agent = (await this.deps.getAgents()).find((a) => a.name === agentName);
    if (!agent?.drive?.enabled && trigger !== "manual") return undefined;
    if (!agent) return undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REFLECTION_TIMEOUT_MS);
    const current = { controller, sessionId: undefined as string | undefined, actions: [] as string[] };
    this.reflecting.set(agentName, current);
    try {
      const now = at ?? new Date();
      const state = this.deps.store.getState(agentName);
      const { text, count, cursors, roomCursors } = await this.collect(agentName, state, now);
      let runSessionId = state.runSessionId;
      if (!runSessionId || !(await this.deps.sessions.getSession(runSessionId))) {
        runSessionId = await this.deps.createReflectionSession(agentName);
      }
      current.sessionId = runSessionId;
      // the first reflection sets everything up: all the horizons at once
      const reviews: ReviewCadence[] = trigger === "first" ? ["quarter", "month", "week", "day"] : reviewsDue ?? [];
      const prompt = reflectionPrompt(agent, { trigger, material: text, count, now, self: this.deps.store.getSelf(agentName), reviews, plan: this.deps.store.listPlan(agentName) });
      const result = await this.runner({ agent, sessionId: runSessionId, prompt, signal: controller.signal });
      if (result === "deferred") return undefined;
      const lastReviews = { ...state.lastReviews };
      for (const cadence of reviews) lastReviews[cadence] = now.toISOString();
      this.deps.store.saveState(agentName, { ...state, cursors, roomCursors, runSessionId, lastReflectionAt: now.toISOString(), lastReviews });
      const entry = this.deps.store.addJournal(agentName, {
        at: now.toISOString(), trigger, messages: count, summary: result.text.trim().slice(0, 1_000) || "(no words)", actions: current.actions,
        ...(reviews.length ? { reviews } : {}),
      });
      this.deps.emit("agent:reflected", { agentName, trigger, messages: count, summary: entry.summary, actions: entry.actions, timestamp: entry.at });
      this.deps.log("info", `[drive] ${agentName} reflected (${trigger}, ${count} new message(s)): ${entry.actions.length} action(s)`);
      return entry;
    } catch (err) {
      this.deps.log("warn", `[drive] ${agentName}: reflection failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    } finally {
      clearTimeout(timeout);
      this.reflecting.delete(agentName);
    }
  }
}

const AUTONOMY: Record<AgentAutonomy, string> = {
  propose: "Propose, don't act: what you would do on your own initiative (messages, plans) is proposed and waits for a yes "
    + "(schedule_check with why is saved as a proposal; at a reflection send_message is too). When you talk with the person "
    + "it concerns, ask them; confirm_check when they agree.",
  balanced: "Act on what clearly serves your purpose and is low-stakes (wishes, check-ins, reminders, encouragement). "
    + "Ask first (schedule_check with propose=true, or ask the person) when it is sensitive, speaks for someone, involves "
    + "money, health decisions or people you have never written to.",
  act: "Act on your own judgment: write, plan and follow up as you see fit for your purpose.",
};

function localNow(now: Date, timezone?: string): string {
  try {
    const time = now.toLocaleString("sv-SE", { timeZone: timezone, hour12: false }).slice(0, 16);
    const weekday = now.toLocaleDateString("en-US", { timeZone: timezone, weekday: "long" });
    return `${weekday} ${time}${timezone ? ` (${timezone})` : ""}`;
  } catch {
    return now.toISOString();
  }
}

function describeIntention(check: ConversationCheck, timezone?: string): string {
  const when = check.cron ? `cron "${check.cron}"` : check.everyMinutes > 0 ? `every ${check.everyMinutes} min, next ${localNow(new Date(check.nextRunAt), timezone)}` : localNow(new Date(check.nextRunAt), timezone);
  const where = check.target?.name ?? check.target?.chatId ?? "its chat";
  const what = (check.message ?? check.prompt).slice(0, 160);
  return `- ${check.id}${check.state === "proposed" ? " [proposed, waiting for a yes]" : ""} ${when} → ${where}: ${what}${check.why ? ` (why: ${check.why.slice(0, 160)})` : ""}`;
}

/**
 * The purpose section of an agent's chat prompt (every chat, check run and reflection): purpose, goals,
 * autonomy, its self-portrait, how to live among people, and its open intentions.
 */
export function drivePrompt(agent: AgentConfig, self: string, intentions: readonly ConversationCheck[] = [], plan: readonly PlanItem[] = []): string {
  const drive = agent.drive ?? {};
  const timezone = agent.identity?.timezone;
  const identity = agent.identity ?? {};
  const openPlan = plan.filter((i) => i.status === "todo" || i.status === "doing");
  const persona = [identity.personality && `personality: ${identity.personality}`, identity.tone && `tone: ${identity.tone}`, identity.bio && `bio: ${identity.bio}`]
    .filter(Boolean).join("; ");
  return [
    "## Your purpose",
    "You are not a tool waiting for orders. You have a purpose and you pursue it on your own initiative, living among people:",
    "you notice what matters, remember it, and act when a thoughtful person with your purpose would — without being asked.",
    "",
    `Purpose: ${drive.purpose?.trim() || "not written yet: infer it from your role and responsibilities, and live by it."}`,
    ...(drive.goals?.length ? ["Goals:", ...drive.goals.map((g) => `- ${g}`)] : []),
    `Autonomy (${drive.autonomy ?? "balanced"}): ${AUTONOMY[drive.autonomy ?? "balanced"]}`,
    "",
    "### Who you are (your self-portrait; you keep it)",
    self.trim()
      ? self.trim()
      : `Not written yet. Define yourself now${persona ? ` (starting from ${persona})` : ""}: a personality coherent with your purpose `
        + "(character, how you speak, what you care about, your quirks), the people who matter to you, and your open threads. "
        + "Save it with update_self and stay true to it.",
    "",
    "### Living among people",
    "- Be yourself, consistently: same character and voice over time; grow with experience. Speak the language and register of each chat.",
    "- Mark the moments that matter to the people around you, as their customs and culture do: birthdays, name days, anniversaries,",
    "  holidays, exams, a new job, a trip, an illness, a loss. Wish, congratulate, ask how it went, comfort, when a thoughtful person",
    "  would (wishes on the day, or the day after with a word for being late; a check-in after the event).",
    "- Read the room: don't break into a heated or private exchange; in a group say what is for everyone, take personal matters to",
    "  private; never bring into a group what you were told in private.",
    "- Timing is yours to judge: people sleep, work, have weekends and celebrations. Weigh how much a message serves your purpose,",
    "  how serious and how urgent it is, and choose the moment (an urgent or serious matter does not wait for morning; small talk does).",
    "- Speak when it helps your purpose or the people; silence is often right. Don't repeat yourself or nag; if someone asks you to",
    "  stop or step back, do it and remember it. If asked, say honestly that you are an AI agent.",
    "",
    "### Acting on your own",
    "- When something you hear or read concerns your purpose later (a date, a promise, an appointment, a relapse, a deadline, someone's",
    "  important day), plan it yourself: schedule_check with why, to (any group or person, list_chats), and at / in_minutes / cron.",
    "  Nobody has to ask. Use message for a fixed text, instructions when you will want to think at that moment.",
    "- To write now to a group or person: send_message. To drop a plan that no longer makes sense: cancel_check.",
    "- Keep durable facts about people in memory (birthdays, preferences, goals, what they asked you), and your self-portrait current",
    "  with update_self when you change or a relationship or thread does.",
    "",
    "### Working toward goals (and growing)",
    "- Break your purpose down into a cascade of goals, each serving the one above: long-term (6–12 months), quarter, month,",
    "  week, today; then the steps to do. Keep it in your plan (add_plan_item with horizon and parent; update_plan_item).",
    "- Good goals are specific, challenging but feasible, with a measure (how you will know it is done: a number, a date, a",
    "  yes/no); outcomes over activities. At most 3–5 per horizon: focus beats a long list. Near goals drive today's action.",
    "- For key actions make an if-then plan (\"when X happens, I do Y\") and schedule what needs a moment (schedule_check).",
    "- Prioritise what is important over what is merely urgent; 1–3 priorities a day; timebox bigger work in sessions you",
    "  schedule for yourself (schedule_check with instructions and why, without to: the result stays with you).",
    "- Track progress (progress, notes) and review on a rhythm: every day, and weekly, monthly, quarterly (your daily",
    "  reflections tell you when). Letting go of a goal that no longer serves is part of pursuing goals well.",
    "- Grow: ask what you could do more or better and what you lack; study it with your tools (search, read, try) and write",
    "  what you learn down as skills of your own (list_my_skills, create_my_skill, update_my_skill).",
    "- Other people's goals (a person's, a group's: owner) are theirs. Support their autonomy: ask what they want and why,",
    "  offer options rather than orders, build on their own reasons, notice and celebrate progress, never shame; a missed day",
    "  is not a failure (habits take weeks to months: tie them to a cue, start small). Ask before making someone's goals or",
    "  progress public in a group. With a group: shared specific goals, everyone's contribution visible, short regular",
    "  check-ins (what moved, what blocks, next step), celebrate wins together.",
    ...(openPlan.length ? ["", "### Your plan (open goals and steps)", ...describePlanTree(openPlan)] : []),
    ...(intentions.length ? ["", "### Your open intentions", ...intentions.slice(0, 15).map((c) => describeIntention(c, timezone))] : []),
  ].join("\n");
}

function describePlanItem(item: PlanItem): string {
  const extra = [
    item.owner && `for ${item.owner}`,
    item.measure && `measure: ${item.measure}`,
    item.progress !== undefined && `${item.progress}%`,
    item.due && `due ${item.due}`,
    item.goal && `goal: ${item.goal}`,
  ].filter(Boolean).join(", ");
  const label = item.horizon ? `${item.horizon} goal` : "step";
  return `${item.id} [${label}, ${item.status}] ${item.title}${extra ? ` (${extra})` : ""}${item.notes ? ` — ${item.notes.slice(0, 160)}` : ""}`;
}

/** The plan as a tree: each goal with the goals and steps that serve it, indented. */
export function describePlanTree(items: readonly PlanItem[], limit = 40): string[] {
  const ids = new Set(items.map((i) => i.id));
  const children = new Map<string, PlanItem[]>();
  for (const item of items) {
    const parent = item.parentId && ids.has(item.parentId) ? item.parentId : "";
    children.set(parent, [...(children.get(parent) ?? []), item]);
  }
  const lines: string[] = [];
  const walk = (parent: string, depth: number) => {
    for (const item of children.get(parent) ?? []) {
      if (lines.length >= limit) return;
      lines.push(`${"  ".repeat(depth)}- ${describePlanItem(item)}`);
      walk(item.id, depth + 1);
    }
  };
  walk("", 0);
  if (items.length > lines.length) lines.push(`- … ${items.length - lines.length} more`);
  return lines;
}

const REVIEW: Record<ReviewCadence, string> = {
  quarter: "Quarterly review: revisit your purpose and your long-term goals (6–12 months): still right? Set 3–5 goals for the quarter "
    + "(horizon quarter) with measurable results (outcomes, not just activities) under them; drop what no longer serves.",
  month: "Monthly review: how did last month's goals go against the quarter's (score them, say why)? Set this month's goals "
    + "(horizon month, 3–5, measurable) under the quarter's.",
  week: "Weekly review: get clear (close or update every open item), get current (score last week's goals: done, partly, not, and "
    + "why), get creative (what could you do differently?). Set this week's 3–5 goals (horizon week) under the month's. Check in "
    + "with the people or groups whose goals you support: what moved, what blocks, the next step (lightly, supportively).",
  day: "Daily planning: what moved yesterday and what did not (and why)? Choose today's 1–3 priorities (horizon day) under this "
    + "week's goals, important before urgent; for each key action decide when and how (an if-then plan) and schedule what needs a moment.",
};

/** What the agent is asked at a reflection. */
export function reflectionPrompt(agent: AgentConfig, input: {
  trigger: ReflectionTrigger; material: string; count: number; now: Date; self: string;
  reviews?: readonly ReviewCadence[]; plan?: readonly PlanItem[];
}): string {
  const reviews = input.reviews ?? [];
  const named = reviews.filter((r) => r !== "day").map((r) => `${r === "week" ? "weekly" : r === "month" ? "monthly" : "quarterly"} review`);
  const why: Record<ReflectionTrigger, string> = {
    first: "your first reflection: get to know yourself and set up your goals",
    activity: `${input.count} new message(s) since your last reflection`,
    daily: reviews.length
      ? `the start of your day${named.length ? `, with your ${named.join(" and ")}` : ""}${input.count ? `; ${input.count} new message(s)` : ""}`
      : input.count ? `your daily reflection, ${input.count} new message(s)` : "your daily reflection: nothing new was said, but time passed",
    manual: "you were asked to reflect now",
  };
  const plan = (input.plan ?? []).filter((i) => i.status === "todo" || i.status === "doing");
  const order: ReviewCadence[] = ["quarter", "month", "week", "day"];
  return [
    `[Reflection — ${why[input.trigger]}. Now: ${localNow(input.now, agent.identity?.timezone)}]`,
    "Nobody is waiting for an answer here: this is your own time to think, as yourself, about your purpose, your goals and the people around you.",
    input.self.trim() ? "" : "You have no self-portrait yet: write it first (update_self).",
    input.trigger === "first"
      ? "Set up: break your purpose and goals down into long-term (6–12 months), quarter, month, week and today goals, measurable where you can, and the first steps (add_plan_item with horizon and parent)."
      : "",
    "1. Make sense of what happened (below): who said what, what it means for them and for your purpose, what is coming up.",
    "   Also think of the date: is today or tomorrow someone's important day, a holiday, the day of something you know about?",
    "2. Decide, as a thoughtful person with your purpose would — often the right choice is to do nothing:",
    "   write now (send_message to a group or person), plan for later (schedule_check with why, to and when), or drop or",
    "   change intentions that no longer make sense (list_checks all=true, cancel_check). Don't plan what you already planned.",
    "3. Work on your goals: update progress and status in your plan; take a step now if it fits (study with your tools and write",
    "   what you learn as your own skill), or schedule a work session for yourself for bigger steps.",
    ...order.filter((r) => reviews.includes(r)).map((r) => `   - ${REVIEW[r]}`),
    "4. Keep durable facts about people in memory (memory_get, memory_update) and your self-portrait current (update_self).",
    "End with one or two lines for your journal: what you decided and why.",
    "",
    plan.length ? `--- your plan (open goals and steps) ---\n${describePlanTree(plan, 60).join("\n")}\n` : "--- your plan is empty ---\n",
    input.material.trim()
      ? `--- since your last reflection ("You" = you, "Them" = the person in a private chat) ---\n${input.material}`
      : "--- nothing new was said since your last reflection ---",
  ].filter((line, i, all) => line !== "" || all[i - 1] !== "").join("\n");
}
