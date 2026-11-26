/**
 * Slack text helpers, pure: Slack's markup in (mentions, links, entities) to plain text the gateway
 * reads, Markdown out to Slack's mrkdwn, reply buttons as Block Kit, thread timestamps as the
 * numeric topic ids the gateway keys conversations with.
 */
import type { ReplyButton } from "./channel-gateway.js";

/** Slack's limit on a section block's text; longer replies are split into several messages. */
export const SLACK_SECTION_MAX = 3000;
/** Slack's limit on a button's label and value. */
const BUTTON_TEXT_MAX = 75;
const BUTTON_VALUE_MAX = 2000;
/** A Block Kit message has at most 50 blocks; an actions block at most 25 elements. */
const MAX_BLOCKS = 50;
const MAX_ACTIONS = 25;

/**
 * A thread's timestamp ("1712345678.123456") as a number the gateway uses as the topic id
 * (1712345678123456: 16 digits, exact as a double). Undefined for anything that is not a ts.
 */
export function encodeThreadTs(ts: string | undefined): number | undefined {
  const m = /^(\d{1,10})\.(\d{6})$/.exec(ts ?? "");
  if (!m) return undefined;
  const n = Number(`${m[1]}${m[2]}`);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** The thread timestamp back from a topic id. */
export function decodeThreadTs(id: number | undefined): string | undefined {
  if (id === undefined || !Number.isSafeInteger(id) || id < 1_000_000) return undefined;
  const s = String(id);
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
}

/**
 * A Slack message's text as the gateway reads it: the bot's own mention removed (and whether it was
 * there), other mentions as @id, channel links as #name, links as "label (url)", entities decoded.
 */
export function slackToPlain(raw: string, botUserId?: string): { text: string; mentioned: boolean } {
  let mentioned = false;
  let text = raw.replace(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => {
    if (botUserId && id === botUserId) { mentioned = true; return ""; }
    return `@${label || id}`;
  });
  text = text
    .replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, name?: string) => `#${name || id}`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_m, name?: string) => name ?? "@team")
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, (_m, url: string, label: string) => (label === url ? url : `${label} (${url})`))
    .replace(/<(mailto:[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  text = text.replace(/[ \t]{2,}/g, " ").replace(/^[\s,:]+/, "").trim();
  return { text, mentioned };
}

/** Escape what Slack treats as markup in plain text. */
function escapeSlack(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Markdown (what agents write) as Slack mrkdwn: **bold** → *bold*, __x__ → _x_, ~~x~~ → ~x~,
 * [label](url) → <url|label>, headings → bold lines, bullets → •. Code blocks are left as they are.
 */
export function markdownToMrkdwn(md: string): string {
  const parts = md.split(/(```[\s\S]*?```)/g);
  return parts.map((part, i) => {
    if (i % 2 === 1) return part;
    // inline code spans stay untouched
    return part.split(/(`[^`\n]+`)/g).map((seg, j) => {
      if (j % 2 === 1) return seg;
      let s = escapeSlack(seg);
      s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, "<$2|$1>");
      s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "<$2|$1>");
      s = s.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, "\u0000$1\u0000");
      s = s.replace(/\*\*([^*\n]+)\*\*/g, "\u0000$1\u0000");
      s = s.replace(/__([^_\n]+)__/g, "_$1_");
      s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1_$2_");
      s = s.replace(/\u0000/g, "*");
      s = s.replace(/~~([^~\n]+)~~/g, "~$1~");
      s = s.replace(/^(\s*)[-+]\s+/gm, "$1• ");
      return s;
    }).join("");
  }).join("");
}

/** Split a reply into Slack-sized pieces: at paragraphs, then lines, then hard. */
export function splitSlackText(text: string, max = SLACK_SECTION_MAX): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n\n");
    if (cut < max / 3) cut = window.lastIndexOf("\n");
    if (cut < max / 3) cut = window.lastIndexOf(" ");
    if (cut < max / 3) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.trim() || out.length === 0) out.push(rest);
  return out;
}

/** The action_id prefix of reply buttons (block_actions carry it back with the value). */
export const SLACK_BUTTON_ACTION = "polpo_reply";

/** A reply's text and buttons as Block Kit: a section with the text, an actions block per row. */
export function replyBlocks(text: string, buttons: ReplyButton[][] | undefined): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  if (text.trim()) blocks.push({ type: "section", text: { type: "mrkdwn", text: text.slice(0, SLACK_SECTION_MAX) } });
  (buttons ?? []).forEach((row, r) => {
    const elements = row.slice(0, MAX_ACTIONS).map((b, i) => ({
      type: "button",
      text: { type: "plain_text", text: (b.text || b.data).slice(0, BUTTON_TEXT_MAX), emoji: true },
      action_id: `${SLACK_BUTTON_ACTION}:${r}:${i}`,
      value: b.data.slice(0, BUTTON_VALUE_MAX),
    }));
    if (elements.length && blocks.length < MAX_BLOCKS) blocks.push({ type: "actions", elements });
  });
  return blocks;
}

/** The kind of an inbound Slack file, as the gateway names attachments. */
export function attachmentKind(mimeType: string, subtype?: string): "photo" | "document" | "voice" | "audio" | "video" {
  if (subtype === "slack_audio") return "voice";
  if (mimeType.startsWith("image/")) return "photo";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

/** Mask anything that looks like a Slack token (for logs: tokens are never written anywhere). */
export function redactSlackTokens(s: string): string {
  return s.replace(/\bx(?:app|oxb|oxp|oxa|oxe|oxr|oxs)-[A-Za-z0-9-]+/g, (t) => `${t.slice(0, 5)}…`);
}
