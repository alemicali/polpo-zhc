/**
 * Polpo computer card: an MCP App (https://modelcontextprotocol.io/extensions/apps/overview) shown by
 * `polpo_computer_show` in Claude, ChatGPT and other hosts.
 *
 * A remote computer's live view and who holds its desktop, its agents' requests for a person,
 * Take control / Give back (polpo_computer_takeover / polpo_computer_release) and a link to the live
 * view in the dashboard. Several cards of the same computer: the newest stays live.
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
import type { ComputerCard } from "../../src/server/mcp-computer-card.js";
import { renderView, stringsFor } from "./view.js";
import { applyInstanceAppearance } from "../shared/theme.js";

const app = new App({ name: "polpo-computer-card", version: "1.0.0" }, { availableDisplayModes: ["inline", "fullscreen"] });
const root = document.getElementById("root")!;

let ctx: McpUiHostContext = {};
let card: ComputerCard | undefined;
let id: string | undefined;
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
    onOpen: () => void openFull(), onAsk: () => void ask(), onRefresh: () => void load(),
    onTake: () => void act("polpo_computer_takeover", {}), onGive: (note) => void act("polpo_computer_release", note ? { note } : {}),
    onLink: (url) => void app.openLink({ url }).catch(() => {}),
  });
}

async function openFull(): Promise<void> {
  if (!superseded) await app.requestDisplayMode({ mode: "fullscreen" }).catch(() => {});
}

async function ask(): Promise<void> {
  if (superseded || !card) return;
  const t = stringsFor(ctx.locale ?? navigator.language);
  await app.sendMessage({ role: "user", content: [{ type: "text", text: t.askAbout(card.computer.name) }] }).catch(() => {});
}

function adopt(next: unknown): void {
  const c = next as ComputerCard | undefined;
  if (!c || typeof c !== "object" || (c as { kind?: string }).kind !== "computer") return;
  card = c;
  id = c.computer.id;
  applyInstanceAppearance(c.appearance);
  error = undefined;
}

const text = (res: { content?: Array<{ type: string; text?: string }> }) => res.content?.map((x) => x.text ?? "").join(" ") || "error";

async function load(): Promise<void> {
  if (busy || !id) return;
  busy = true;
  render();
  try {
    const res = await app.callServerTool({ name: "polpo_computer_show", arguments: { id } });
    if (res.isError) throw new Error(text(res as never));
    adopt(res.structuredContent);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    busy = false;
    render();
  }
}

/** Take control / give it back, then show the new state. */
async function act(tool: "polpo_computer_takeover" | "polpo_computer_release", extra: Record<string, unknown>): Promise<void> {
  if (busy || !id || superseded) return;
  busy = true;
  render();
  try {
    const res = await app.callServerTool({ name: tool, arguments: { id, ...extra } });
    if (res.isError) throw new Error(text(res as never));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    busy = false;
  }
  await load();
}

// ── Newest card wins (per computer, within the conversation) ──

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
  channel = new BroadcastChannel(`polpo-computer-card:${card.computer.id}`);
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
  ctx = { ...ctx, ...next };
  if (next.theme) applyDocumentTheme(next.theme);
  if (next.styles?.variables) applyHostStyleVariables(next.styles.variables);
  if (next.styles?.css?.fonts) applyHostFonts(next.styles.css.fonts);
  const inset = ctx.safeAreaInsets;
  if (inset) root.style.padding = `${inset.top}px ${inset.right}px ${inset.bottom}px ${inset.left}px`;
}

const fromInput = (a: Record<string, unknown> | undefined) => {
  if (!a || typeof a.id !== "string") return;
  id = a.id;
  if (!card) { pending = id; render(); }
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
