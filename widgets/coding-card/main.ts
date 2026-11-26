/**
 * Polpo coding chat card: an MCP App (https://modelcontextprotocol.io/extensions/apps/overview)
 * shown by `polpo_coding_chat_show` in Claude, ChatGPT and other hosts.
 *
 * - A Claude Code / Codex session's latest messages, tool calls in one line each, status.
 * - Approvals waiting: approve / deny (polpo_coding_chat_control), then the card refreshes.
 * - While a turn runs the card refreshes itself every few seconds.
 * - Open (full screen), Ask, Refresh. Several cards of the same session: the newest stays live.
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
import type { CodingCard } from "../../src/server/mcp-coding-card.js";
import { renderView, stringsFor } from "./view.js";
import { applyInstanceAppearance } from "../shared/theme.js";

type Args = { id?: string; limit?: number };

const app = new App({ name: "polpo-coding-card", version: "1.0.0" }, { availableDisplayModes: ["inline", "fullscreen"] });
const root = document.getElementById("root")!;

let ctx: McpUiHostContext = {};
let card: CodingCard | undefined;
let args: Args = {};
let pending: string | undefined;
let error: string | undefined;
let busy = false;
let superseded = false;
let timer: ReturnType<typeof setTimeout> | undefined;

const fullscreen = () => ctx.displayMode === "fullscreen";
const canFullscreen = () => (ctx.availableDisplayModes ?? []).includes("fullscreen");

function render(): void {
  renderView(root, {
    card, pending, error, locale: ctx.locale ?? navigator.language,
    full: fullscreen(), canFullscreen: canFullscreen(), busy, superseded,
    onOpen: () => void openFull(), onAsk: () => void ask(), onRefresh: () => void load(args),
    onDecide: (approvalId, decision) => void decide(approvalId, decision),
  });
}

async function openFull(): Promise<void> {
  if (!superseded) await app.requestDisplayMode({ mode: "fullscreen" }).catch(() => {});
}

async function ask(): Promise<void> {
  if (superseded || !card) return;
  const text = stringsFor(ctx.locale ?? navigator.language).askAbout(card.session.title);
  await app.sendMessage({ role: "user", content: [{ type: "text", text }] }).catch(() => {});
}

function adopt(next: unknown): void {
  const c = next as CodingCard | undefined;
  if (!c || typeof c !== "object" || (c as { kind?: string }).kind !== "coding-chat") return;
  card = c;
  args = { ...args, id: c.session.id };
  applyInstanceAppearance(c.appearance);
  error = undefined;
  schedule();
}

/** While the program works, look again in a few seconds. */
function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (superseded || !card || card.session.status !== "running") return;
  timer = setTimeout(() => void load(args), 4000);
}

async function load(next: Args): Promise<void> {
  if (busy || !next.id) return;
  busy = true;
  render();
  try {
    const res = await app.callServerTool({ name: "polpo_coding_chat_show", arguments: next as Record<string, unknown> });
    if (res.isError) throw new Error(res.content?.map((x) => ("text" in x ? x.text : "")).join(" ") || "error");
    args = next;
    adopt(res.structuredContent);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    busy = false;
    render();
  }
}

async function decide(approvalId: string, decision: "approve" | "deny"): Promise<void> {
  if (busy || superseded || !card) return;
  busy = true;
  render();
  try {
    const res = await app.callServerTool({ name: "polpo_coding_chat_control", arguments: { id: card.session.id, action: decision, approval_id: approvalId } });
    if (res.isError) throw new Error(res.content?.map((x) => ("text" in x ? x.text : "")).join(" ") || "error");
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    busy = false;
  }
  await load(args);
}

// ── Newest card wins (per session, within the conversation) ──

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
  channel = new BroadcastChannel(`polpo-coding-card:${card.session.id}`);
  const me = () => ({ ...card!.key, instanceId });
  channel.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as { type?: string; createdAt?: number; seq?: number; instanceId?: string } | null;
    if (!msg || msg.instanceId === instanceId || typeof msg.createdAt !== "number" || typeof msg.seq !== "number" || !card) return;
    if (msg.type === "hello") channel!.postMessage({ type: "here", ...me() });
    peers.set(msg.instanceId!, { createdAt: msg.createdAt, seq: msg.seq, instanceId: msg.instanceId! });
    const was = superseded;
    superseded = [...peers.values()].some(isNewer);
    if (superseded && timer) { clearTimeout(timer); timer = undefined; }
    if (was !== superseded) render();
  };
  channel.postMessage({ type: "hello", ...me() });
}

// ── Host ──

function applyContext(next: Partial<McpUiHostContext>): void {
  const before = ctx.displayMode;
  ctx = { ...ctx, ...next };
  if (next.theme) applyDocumentTheme(next.theme);
  if (next.styles?.variables) applyHostStyleVariables(next.styles.variables);
  if (next.styles?.css?.fonts) applyHostFonts(next.styles.css.fonts);
  const inset = ctx.safeAreaInsets;
  if (inset) root.style.padding = `${inset.top}px ${inset.right}px ${inset.bottom}px ${inset.left}px`;
  if (next.displayMode && next.displayMode !== before && next.displayMode === "fullscreen") void load(args);
}

const fromInput = (a: Record<string, unknown> | undefined) => {
  if (!a) return;
  args = { ...(typeof a.id === "string" ? { id: a.id } : {}), ...(typeof a.limit === "number" ? { limit: a.limit } : {}) };
  if (!card) { pending = args.id; render(); }
};
app.addEventListener("hostcontextchanged", (changed) => { applyContext(changed); render(); });
app.addEventListener("toolinputpartial", (p) => fromInput(p.arguments));
app.addEventListener("toolinput", (p) => fromInput(p.arguments));
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
