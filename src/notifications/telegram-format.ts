/**
 * Markdown → Telegram HTML (parse_mode "HTML").
 *
 * Telegram supports only b, i, u, s, code, pre, a, blockquote and tg-spoiler,
 * so block elements are mapped onto them: headings become bold lines, lists get
 * bullets, tables are rendered as aligned monospace text. Messages are split
 * into chunks under Telegram's 4096-character limit before conversion, so no
 * tag is ever cut in half.
 */

export const TELEGRAM_MESSAGE_LIMIT = 4096;
/** Markdown budget per message; conversion adds tags and entities. */
const CHUNK_SOURCE_LIMIT = 3500;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const escapeAttr = (text: string) => escapeHtml(text).replace(/"/g, "&quot;");

/** Inline formatting on already-escaped text (code spans are protected by the caller). */
function inline(text: string): string {
  return text
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) => `<a href="${escapeAttr(url.replace(/&amp;/g, "&"))}">${label}</a>`)
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, "<b>$1</b>")
    .replace(/__(?=\S)([^\n]*?\S)__/g, "<b>$1</b>")
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, "<s>$1</s>")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1<i>$2</i>")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1<i>$2</i>");
}

function renderTable(rows: string[]): string {
  const cells = rows
    .filter(row => !/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(row))
    .map(row => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim().replace(/\*\*|__|`/g, "")));
  const widths: number[] = [];
  for (const row of cells) row.forEach((c, i) => { widths[i] = Math.max(widths[i] ?? 0, c.length); });
  const lines = cells.map(row => row.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd());
  return `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
}

/** Convert one chunk of Markdown to Telegram HTML. */
export function markdownToTelegramHtml(markdown: string): string {
  const slots: string[] = [];
  const keep = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;

  // Fenced code blocks, then inline code: their content is never formatted.
  let text = markdown.replace(/```([\w+-]*)[^\S\n]*\n([\s\S]*?)```/g, (_, lang: string, code: string) =>
    keep(`<pre>${lang ? `<code class="language-${escapeAttr(lang)}">` : ""}${escapeHtml(code.replace(/\n$/, ""))}${lang ? "</code>" : ""}</pre>`));
  text = text.replace(/`([^`\n]+)`/g, (_, code: string) => keep(`<code>${escapeHtml(code)}</code>`));

  const out: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*\|.*\|\s*$/.test(line)) {
      const table: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) table.push(lines[i++]);
      i--;
      out.push(keep(renderTable(table)));
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      i--;
      out.push(`<blockquote>${quote.map(q => inline(escapeHtml(q))).join("\n")}</blockquote>`);
      continue;
    }

    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) { out.push(`<b>${inline(escapeHtml(heading[1]))}</b>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("──────────"); continue; }

    const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (task) { out.push(`${task[1]}${task[2] === " " ? "☐" : "☑"} ${inline(escapeHtml(task[3]))}`); continue; }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) { out.push(`${bullet[1]}• ${inline(escapeHtml(bullet[2]))}`); continue; }

    out.push(inline(escapeHtml(line)));
  }

  return out.join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\u0000(\d+)\u0000/g, (_, n: string) => slots[Number(n)]);
}

/**
 * Split Markdown into chunks that fit one Telegram message each, preferring
 * paragraph and line boundaries and never splitting a fenced code block
 * unless it alone exceeds the budget.
 */
export function splitMarkdown(markdown: string, limit = CHUNK_SOURCE_LIMIT): string[] {
  const blocks: string[] = [];
  const re = /```[\s\S]*?```/g;
  let last = 0;
  for (const m of markdown.matchAll(re)) {
    blocks.push(...markdown.slice(last, m.index).split(/\n{2,}/), m[0]);
    last = m.index! + m[0].length;
  }
  blocks.push(...markdown.slice(last).split(/\n{2,}/));

  const chunks: string[] = [];
  let current = "";
  const flush = () => { if (current.trim()) chunks.push(current.trim()); current = ""; };
  for (const block of blocks.filter(b => b.trim())) {
    if (block.length > limit) {
      flush();
      // Oversized block: cut on line boundaries, then hard-cut very long lines.
      let piece = "";
      for (const line of block.split("\n")) {
        for (let start = 0; start < Math.max(line.length, 1); start += limit) {
          const part = line.slice(start, start + limit);
          if (piece && piece.length + part.length + 1 > limit) { chunks.push(piece); piece = ""; }
          piece = piece ? `${piece}\n${part}` : part;
        }
      }
      if (piece.trim()) chunks.push(piece);
      continue;
    }
    if (current && current.length + block.length + 2 > limit) flush();
    current = current ? `${current}\n\n${block}` : block;
  }
  flush();
  return chunks.length > 0 ? chunks : [""];
}
