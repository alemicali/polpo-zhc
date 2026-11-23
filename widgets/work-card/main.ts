/**
 * Polpo task and mission cards: an MCP App (https://modelcontextprotocol.io/extensions/apps/overview)
 * shown by `polpo_task_show` and `polpo_mission_show` in Claude, ChatGPT and other hosts.
 *
 * - Task, inline: status, why it failed (the labelled reason; "not retried" when a re-run cannot
 *   help), the latest run (engine and model with their marks, authentication, computer, cost) and
 *   what it depends on. Full screen: every run (egress, session, duration, budget), its result
 *   and outcomes.
 * - Mission, inline: status, what it cost against its budget (a bar; paused when over), cost by
 *   engine, and its tasks with their latest run and failure. Full screen: every task, cost by agent.
 * - Actions: Open (full screen), Refresh, and Ask (a chat message, so the model follows up: why it
 *   failed, how it is going). Several cards of the same task or mission: the newest stays live.
 *
 * Built by widgets/build.mjs into one HTML file (src/server/mcp-widgets.generated.ts).
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { WorkCard } from "../../src/server/mcp-work-card.js";
import { renderView, stringsFor, type Strings } from "./view.js";
import { applyInstanceAppearance } from "../shared/theme.js";

// ── State ────────────────────────────────────────────────────────────────

const app = new App({ name: "polpo-work-card", version: "1.0.0" }, { availableDisplayModes: ["inline", "fullscreen"] });
const root = document.getElementById("root")!;

let ctx: McpUiHostContext = {};
let card: WorkCard | undefined;
let pending: string | undefined;
let error: string | undefined;
let busy = false;
let superseded = false;

const t = (): Strings => stringsFor(ctx.locale ?? navigator.language);
const fullscreen = () => ctx.displayMode === "fullscreen";
const canFullscreen = () => (ctx.availableDisplayModes ?? []).includes("fullscreen");

function render(): void {
  renderView(root, {
    card, pending, error, locale: ctx.locale ?? navigator.language, timeZone: ctx.timeZone,
    full: fullscreen(), canFullscreen: canFullscreen(), busy, superseded,
    onOpen: () => void openFull(), onAsk: () => void ask(), onRefresh: () => void refresh(),
  });
}

const usd = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? "" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

// ── Actions ──────────────────────────────────────────────────────────────

const cardId = (c: WorkCard) => (c.kind === "mission" ? c.mission.id : c.task.id);

async function openFull(): Promise<void> {
  if (!superseded) await app.requestDisplayMode({ mode: "fullscreen" }).catch(() => {});
}

async function ask(): Promise<void> {
  if (superseded || !card) return;
  const text = card.kind === "mission" ? t().askMission(card.mission.name) : t().askTask(card.task.title, card.task.status === "failed");
  await app.sendMessage({ role: "user", content: [{ type: "text", text }] }).catch(() => {});
}

function adopt(next: unknown): void {
  const c = next as WorkCard | undefined;
  if (!c || typeof c !== "object" || (c.kind !== "task" && c.kind !== "mission")) return;
  card = card ? { ...c, key: card.key } : c;
  applyInstanceAppearance(c.appearance);
  error = undefined;
}

async function refresh(): Promise<void> {
  if (!card || busy) return;
  busy = true;
  render();
  try {
    const res = await app.callServerTool({ name: card.kind === "mission" ? "polpo_mission_show" : "polpo_task_show", arguments: { id: cardId(card) } });
    if (res.isError) throw new Error(res.content?.map((x) => ("text" in x ? x.text : "")).join(" ") || "error");
    adopt(res.structuredContent);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    busy = false;
    render();
    tellModel();
  }
}

/** What the person sees full screen, for the model's next turn (only the live card speaks). */
function tellModel(): void {
  if (superseded || !card || !fullscreen()) return;
  const c = card;
  const text = c.kind === "mission"
    ? `The person is looking at mission ${c.mission.id} (${c.mission.name}, ${c.mission.status}) in Polpo: ${usd(c.cost?.usd)}${c.cost?.budgetUsd !== undefined ? ` of ${usd(c.cost.budgetUsd)}` : ""}; `
      + `failed tasks: ${c.tasks.filter((x) => x.failure).map((x) => `${x.id} (${x.failure!.reason})`).join("; ") || "none"}.`
    : `The person is looking at task ${c.task.id} (${c.task.title}, ${c.task.status}) in Polpo${c.task.failure ? `; it failed: ${c.task.failure.reason}${c.task.failure.retryable ? "" : " (not retried)"}` : ""}; `
      + `latest run: ${c.runs[0] ? `${c.runs[0].engineLabel} ${c.runs[0].modelLabel ?? ""} on ${c.runs[0].computer.label}` : "none"}.`;
  void app.updateModelContext({ content: [{ type: "text", text }] }).catch(() => {});
}

// ── Newest card wins (per task or mission, within the conversation) ──────

let channel: BroadcastChannel | undefined;
const instanceId = Math.random().toString(36).slice(2);
const peers = new Map<string, { createdAt: number; seq: number; instanceId: string }>();

function isNewer(other: { createdAt: number; seq: number; instanceId: string }): boolean {
  const mine = card!.key;
  if (other.createdAt !== mine.createdAt) return other.createdAt > mine.createdAt;
  if (other.seq !== mine.seq) return other.seq > mine.seq;
  return other.instanceId > instanceId;
}

function joinElection(): void {
  if (channel || !card || typeof BroadcastChannel === "undefined") return;
  channel = new BroadcastChannel(`polpo-work-card:${card.kind}:${cardId(card)}`);
  const me = () => ({ ...card!.key, instanceId });
  channel.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as { type?: string; createdAt?: number; seq?: number; instanceId?: string } | null;
    if (!msg || msg.instanceId === instanceId || typeof msg.createdAt !== "number" || typeof msg.seq !== "number" || !card) return;
    if (msg.type === "hello") channel!.postMessage({ type: "here", ...me() });
    peers.set(msg.instanceId!, { createdAt: msg.createdAt, seq: msg.seq, instanceId: msg.instanceId! });
    const was = superseded;
    superseded = [...peers.values()].some(isNewer);
    if (was !== superseded) render();
  };
  channel.postMessage({ type: "hello", ...me() });
}

// ── Host ─────────────────────────────────────────────────────────────────

function applyContext(next: Partial<McpUiHostContext>): void {
  const before = ctx.displayMode;
  ctx = { ...ctx, ...next };
  if (next.theme) applyDocumentTheme(next.theme);
  if (next.styles?.variables) applyHostStyleVariables(next.styles.variables);
  if (next.styles?.css?.fonts) applyHostFonts(next.styles.css.fonts);
  const inset = ctx.safeAreaInsets;
  if (inset) root.style.padding = `${inset.top}px ${inset.right}px ${inset.bottom}px ${inset.left}px`;
  if (next.displayMode && next.displayMode !== before && next.displayMode === "fullscreen") void refresh();
}

const pendingFrom = (args: Record<string, unknown> | undefined) => { if (!card && typeof args?.id === "string") { pending = args.id; render(); } };
app.addEventListener("hostcontextchanged", (changed) => { applyContext(changed); render(); });
app.addEventListener("toolinputpartial", (p) => pendingFrom(p.arguments));
app.addEventListener("toolinput", (p) => pendingFrom(p.arguments));
app.addEventListener("toolresult", (result) => {
  if (result.isError) {
    error = result.content?.map((x) => ("text" in x ? x.text : "")).join(" ") || "error";
  } else {
    card = undefined;
    adopt(result.structuredContent);
    joinElection();
  }
  render();
});

render();
await app.connect();
applyContext(app.getHostContext() ?? {});
render();
