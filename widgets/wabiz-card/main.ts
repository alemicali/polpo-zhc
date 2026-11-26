/**
 * Polpo WhatsApp Business card: an MCP App (https://modelcontextprotocol.io/extensions/apps/overview)
 * shown by `polpo_wabiz_show` in Claude, ChatGPT and other hosts.
 *
 * - Overview: the channel's status, the templates waiting for approval (approve / reject: the click
 *   is the person's decision, sent through polpo_wabiz_approval), the recent conversations.
 * - Transcript: one conversation as it looks in WhatsApp; back to the overview.
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
import type { WabizCard } from "../../src/server/mcp-wabiz-card.js";
import { renderView, stringsFor } from "./view.js";
import { applyInstanceAppearance } from "../shared/theme.js";

type Args = { channel?: string; to?: string; limit?: number };

const app = new App({ name: "polpo-wabiz-card", version: "1.0.0" }, { availableDisplayModes: ["inline", "fullscreen"] });
const root = document.getElementById("root")!;

let ctx: McpUiHostContext = {};
let card: WabizCard | undefined;
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
    onShow: (next) => void load({ ...(card ? { channel: card.channel } : {}), ...(next.to ? { to: next.to } : {}) }),
    onDecide: (id, approve) => void decide(id, approve),
  });
}

async function openFull(): Promise<void> {
  if (!superseded) await app.requestDisplayMode({ mode: "fullscreen" }).catch(() => {});
}

async function ask(): Promise<void> {
  if (superseded || !card) return;
  const t = stringsFor(ctx.locale ?? navigator.language);
  const text = card.transcript ? t.askAbout(card.transcript.name ?? card.transcript.masked) : t.askAll;
  await app.sendMessage({ role: "user", content: [{ type: "text", text }] }).catch(() => {});
}

function adopt(next: unknown): void {
  const c = next as WabizCard | undefined;
  if (!c || typeof c !== "object" || (c as { kind?: string }).kind !== "wabiz") return;
  card = c;
  applyInstanceAppearance(c.appearance);
  error = undefined;
}

const textOf = (res: { content?: Array<{ type: string; text?: string }> }) => res.content?.map((x) => ("text" in x ? x.text : "")).join(" ") || "error";

/** Load (or refresh) the card for these arguments through the same tool. */
async function load(next: Args): Promise<void> {
  if (busy || superseded) return;
  busy = true;
  render();
  try {
    const res = await app.callServerTool({ name: "polpo_wabiz_show", arguments: next as Record<string, unknown> });
    if (res.isError) throw new Error(textOf(res));
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

/** Approve (send now) or reject a queued template: the person clicked, so it is confirmed. */
async function decide(id: string, approve: boolean): Promise<void> {
  if (busy || superseded || !card) return;
  busy = true;
  render();
  try {
    const res = await app.callServerTool({
      name: "polpo_wabiz_approval",
      arguments: { channel: card.channel, action: approve ? "approve" : "reject", id, confirm: true },
    });
    if (res.isError) throw new Error(textOf(res));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    busy = false;
  }
  await load(args);
}

/** What the person sees full screen, for the model's next turn. */
function tellModel(): void {
  if (superseded || !card || !fullscreen()) return;
  const c = card;
  const text = c.transcript
    ? `The person is looking at the WhatsApp Business conversation with ${c.transcript.name ?? c.transcript.masked} on ${c.channel} (${c.transcript.messages.length} messages, window ${c.transcript.windowOpen ? "open" : "closed"}).`
    : `The person is looking at the WhatsApp Business channel ${c.channel}: ${c.status.state}, ${c.pending.length} template(s) waiting for approval, ${c.conversations.length} recent conversation(s).`;
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
  channel = new BroadcastChannel(`polpo-wabiz-card:${card.channel}`);
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
  args = {
    ...(typeof a.channel === "string" ? { channel: a.channel } : {}), ...(typeof a.to === "string" ? { to: a.to } : {}),
    ...(typeof a.limit === "number" ? { limit: a.limit } : {}),
  };
  if (!card) { pending = args.to ?? args.channel ?? "wabiz"; render(); }
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
