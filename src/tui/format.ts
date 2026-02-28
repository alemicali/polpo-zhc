/**
 * Formatters — single source of truth for styled text segments.
 * Every piece of UI uses Seg[] for styled output.
 */

import type { Seg } from "./store.js";

// ─── Segment factory ────────────────────────────────────

export const seg = (
  text: string,
  color?: string,
  bold?: boolean,
  dim?: boolean,
): Seg => ({ text, color, bold, dim });

// ─── Markdown → Seg[] parser ───────────────────────────

/**
 * Parse markdown text into styled Seg[].
 * Renders bold, italic, inline code, code blocks, headers,
 * lists, blockquotes, and horizontal rules as terminal styles.
 */
export function parseMarkdown(text: string): Seg[] {
  if (!text) return [{ text: "" }];

  const segs: Seg[] = [];
  const lines = text.split("\n");
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    if (i > 0) segs.push({ text: "\n" });
    const line = lines[i]!;
    const trimmed = line.trimStart();

    // Code block fence
    if (trimmed.startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        const lang = trimmed.slice(3).trim();
        if (lang) segs.push({ text: ` ${lang}`, color: "gray", dim: true });
      } else {
        inCodeBlock = false;
      }
      continue;
    }

    // Inside code block — indented, cyan
    if (inCodeBlock) {
      segs.push({ text: `  ${line}`, color: "cyan" });
      continue;
    }

    // Horizontal rule (---, ***, ___)
    if (/^[-*_]{3,}\s*$/.test(trimmed) && trimmed.length >= 3) {
      segs.push({ text: "─".repeat(40), color: "gray", dim: true });
      continue;
    }

    // Header
    const hMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (hMatch) {
      parseInlineTo(hMatch[2]!, segs, { bold: true });
      continue;
    }

    // Blockquote
    if (trimmed.startsWith("> ")) {
      segs.push({ text: "│ ", color: "gray", dim: true });
      parseInlineTo(trimmed.slice(2), segs);
      continue;
    }

    // Bullet list (- item, * item, + item)
    const listMatch = line.match(/^(\s*)([-*+])\s+(.*)/);
    if (listMatch) {
      segs.push({ text: `${listMatch[1]}• ` });
      parseInlineTo(listMatch[3]!, segs);
      continue;
    }

    // Numbered list (1. item)
    const numMatch = line.match(/^(\s*)(\d+\.)\s+(.*)/);
    if (numMatch) {
      segs.push({ text: `${numMatch[1]}${numMatch[2]} ` });
      parseInlineTo(numMatch[3]!, segs);
      continue;
    }

    // Normal line
    parseInlineTo(line, segs);
  }

  return segs;
}

/** Parse inline markdown (bold, italic, code) into Seg[], with optional base style. */
function parseInlineTo(text: string, segs: Seg[], baseStyle?: Partial<Seg>): void {
  if (text.length === 0) return;

  // Order: backtick code, then ***bold+italic***, then **bold**, then *italic*
  const re = /`([^`]+)`|\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*/g;
  let lastIdx = 0;
  let match;

  while ((match = re.exec(text)) !== null) {
    // Plain text before match
    if (match.index > lastIdx) {
      segs.push({ text: text.slice(lastIdx, match.index), ...baseStyle });
    }

    if (match[1] !== undefined) {
      // `inline code`
      segs.push({ text: match[1], color: "cyan", ...baseStyle });
    } else if (match[2] !== undefined) {
      // ***bold italic***
      segs.push({ text: match[2], bold: true, italic: true, ...baseStyle });
    } else if (match[3] !== undefined) {
      // **bold**
      segs.push({ text: match[3], bold: true, ...baseStyle });
    } else if (match[4] !== undefined) {
      // *italic*
      segs.push({ text: match[4], italic: true, ...baseStyle });
    }

    lastIdx = match.index + match[0].length;
  }

  // Remaining text after last match
  if (lastIdx < text.length) {
    segs.push({ text: text.slice(lastIdx), ...baseStyle });
  }
}
