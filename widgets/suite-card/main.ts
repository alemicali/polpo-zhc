/**
 * Polpo agent suite card: an MCP App (https://modelcontextprotocol.io/extensions/apps/overview)
 * shown by `polpo_agent_suite_show` in Claude, ChatGPT and other hosts.
 *
 * - Suites: each suite with its last run (pass rate, score, regressions) and baseline; a suite opens
 *   to its latest run or its trend.
 * - Run: pass rate, overall score, cost and duration with the deltas versus the baseline; scores
 *   per scorer (mean, median, p10); each case with its failed checks, its change (▼ regressed,
 *   ▲ improved) and flakiness; the AI review. "Explain this run" asks the model (which calls
 *   polpo_agent_suite_review).
 * - Trend: the suite's runs as a chart (pass rate and score), by version.
 * - Open (full screen), Refresh. Several cards of the same view: the newest stays live.
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
import type { SuiteCard } from "../../src/server/mcp-suite-card.js";
import { renderView, stringsFor, type Strings } from "./view.js";
import { applyInstanceAppearance } from "../shared/theme.js";

type Args = { agent: string; suite?: string; run?: string; view?: "suites" | "run" | "trend" };

const app = new App({ name: "polpo-suite-card", version: "1.0.0" }, { availableDisplayModes: ["inline", "fullscreen"] });
const root = document.getElementById("root")!;

let ctx: McpUiHostContext = {};
let card: SuiteCard | undefined;
let args: Args | undefined;
let pending: string | undefined;
let error: string | undefined;
let busy = false;
let superseded = false;

const t = (): Strings => stringsFor(ctx.locale ?? navigator.language);
const fullscreen = () => ctx.displayMode === "fullscreen";
const canFullscreen = () => (ctx.availableDisplayModes ?? []).includes("fullscreen");

function render(): void {
  renderView(root, {
    card, pending, error, locale: ctx.locale ?? navigator.language,
    full: fullscreen(), canFullscreen: canFullscreen(), busy, superseded,
    onOpen: () => void openFull(), onAsk: () => void ask(), onRefresh: () => void load(args),
    onShow: (next) => { if (card) void load({ agent: card.agent, ...next }); },
  });
}

async function openFull(): Promise<void> {
  if (!superseded) await app.requestDisplayMode({ mode: "fullscreen" }).catch(() => {});
}

async function ask(): Promise<void> {
  if (superseded || !card) return;
  const text = card.kind === "run" ? t().explain(card.run.suiteName, card.run.id) : t().askAbout(card.agent);
  await app.sendMessage({ role: "user", content: [{ type: "text", text }] }).catch(() => {});
}

function adopt(next: unknown): void {
  const c = next as SuiteCard | undefined;
  if (!c || typeof c !== "object" || !["suites", "run", "trend"].includes((c as { kind?: string }).kind ?? "")) return;
  card = c;
  applyInstanceAppearance(c.appearance);
  error = undefined;
}

/** Load (or refresh) the card for these arguments through the same tool. */
async function load(next: Args | undefined): Promise<void> {
  if (!next || busy) return;
  busy = true;
  render();
  try {
    const res = await app.callServerTool({ name: "polpo_agent_suite_show", arguments: next as unknown as Record<string, unknown> });
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
  const text = c.kind === "run"
    ? `The person is looking at the suite run ${c.run.id} (${c.run.suiteName}, ${c.run.status}, ${c.run.passed}/${c.run.total} passed${c.run.score !== undefined ? `, score ${c.run.score.toFixed(2)}` : ""}) of ${c.agent} in Polpo`
      + `${c.baseline ? `; versus the baseline: ${c.baseline.regressions} regression(s)` : ""}; failing: ${c.cases.filter((x) => x.status !== "passed").map((x) => x.key).join(", ") || "none"}.`
    : c.kind === "trend"
      ? `The person is looking at the trend of ${c.agent}'s suite ${c.suiteId} in Polpo (${c.points.length} runs).`
      : `The person is looking at ${c.agent}'s suites in Polpo.`;
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
  const id = card.kind === "run" ? card.run.id : card.kind === "trend" ? card.suiteId : "suites";
  channel = new BroadcastChannel(`polpo-suite-card:${card.agent}:${card.kind}:${id}`);
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
  if (typeof a?.agent !== "string") return;
  args = {
    agent: a.agent,
    ...(typeof a.suite === "string" ? { suite: a.suite } : {}),
    ...(typeof a.run === "string" ? { run: a.run } : {}),
    ...(a.view === "suites" || a.view === "run" || a.view === "trend" ? { view: a.view } : {}),
  };
  if (!card) { pending = args.run ?? args.suite ?? args.agent; render(); }
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
    if (card && !args) args = { agent: (card as SuiteCard).agent };
    joinElection();
  }
  render();
});

render();
await app.connect();
applyContext(app.getHostContext() ?? {});
render();
