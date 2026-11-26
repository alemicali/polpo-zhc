/**
 * Polpo decision card: an MCP App (https://modelcontextprotocol.io/extensions/apps/overview) shown by
 * `polpo_decision_show` in Claude, ChatGPT and other hosts.
 *
 * - Decision: each answer with probability bars, confidence and whether it is uncertain; model, cost.
 * - Decisions: the latest ones; one opens.
 * - Open (full screen), Ask, Refresh. Several cards of the same view: the newest stays live.
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
import type { DecisionCard } from "../../src/server/mcp-decision-card.js";
import { renderView, stringsFor } from "./view.js";
import { applyInstanceAppearance } from "../shared/theme.js";

type Args = { id?: string };

const app = new App({ name: "polpo-decision-card", version: "1.0.0" }, { availableDisplayModes: ["inline", "fullscreen"] });
const root = document.getElementById("root")!;

let ctx: McpUiHostContext = {};
let card: DecisionCard | undefined;
let args: Args = {};
let pending: string | undefined;
let error: string | undefined;
let busy = false;
let superseded = false;

const fullscreen = () => ctx.displayMode === "fullscreen";
const canFullscreen = () => (ctx.availableDisplayModes ?? []).includes("fullscreen");

function render(): void {
  renderView(root, {
    card, pending, error, locale: ctx.locale ?? navigator.language,
    full: fullscreen(), canFullscreen: canFullscreen(), busy, superseded,
    onOpen: () => void openFull(), onAsk: () => void ask(), onRefresh: () => void load(args),
    onShow: (next) => void load(next),
  });
}

async function openFull(): Promise<void> {
  if (!superseded) await app.requestDisplayMode({ mode: "fullscreen" }).catch(() => {});
}

async function ask(): Promise<void> {
  if (superseded || !card) return;
  const t = stringsFor(ctx.locale ?? navigator.language);
  const text = card.kind === "decision" ? t.askAbout(card.decision.id) : t.askAll;
  await app.sendMessage({ role: "user", content: [{ type: "text", text }] }).catch(() => {});
}

function adopt(next: unknown): void {
  const c = next as DecisionCard | undefined;
  if (!c || typeof c !== "object" || !["decisions", "decision"].includes((c as { kind?: string }).kind ?? "")) return;
  card = c;
  applyInstanceAppearance(c.appearance);
  error = undefined;
}

/** Load (or refresh) the card for these arguments through the same tool. */
async function load(next: Args): Promise<void> {
  if (busy) return;
  busy = true;
  render();
  try {
    const res = await app.callServerTool({ name: "polpo_decision_show", arguments: next as Record<string, unknown> });
    if (res.isError) throw new Error(res.content?.map((x) => ("text" in x ? x.text : "")).join(" ") || "error");
    args = next;
    adopt(res.structuredContent);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    busy = false;
    render();
    tellModel();
  }
}

/** What the person sees full screen, for the model's next turn. */
function tellModel(): void {
  if (superseded || !card || !fullscreen()) return;
  const c = card;
  const text = c.kind === "decision"
    ? `The person is looking at the decision ${c.decision.id} in Polpo: ${c.decision.answers.map((a) => `${a.name} ${a.headline}${a.uncertain ? " (uncertain)" : ""}`).join("; ")}.`
    : `The person is looking at the latest decisions in Polpo (${c.decisions.length}).`;
  void app.updateModelContext({ content: [{ type: "text", text }] }).catch(() => {});
}

// ── Newest card wins (per view, within the conversation) ──

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
  channel = new BroadcastChannel(`polpo-decision-card:${card.kind === "decision" ? card.decision.id : "list"}`);
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
  args = typeof a.id === "string" ? { id: a.id } : {};
  if (!card) { pending = args.id ?? "decisions"; render(); }
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
