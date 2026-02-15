/**
 * Stream — scrollable log of events, user input, and responses.
 * Pre-flattens entries into visual terminal rows for pixel-perfect scrolling.
 * Auto-scrolls to bottom on new entries. Up/Down arrows to scroll.
 */

import { useMemo, useEffect } from "react";
import { Box } from "ink";
import { useStore, type StreamEntry, type Seg } from "../store.js";
import { SegmentLine } from "./SegmentLine.js";

// ─── Types ──────────────────────────────────────────────

type VisualRow =
  | { kind: "content"; segs: Seg[] }
  | { kind: "spacer" };

// ─── Entry → uniform Seg[] ──────────────────────────────

function entryToSegs(entry: StreamEntry): Seg[] {
  switch (entry.type) {
    case "user":
      return [{ text: ` ❯ ${entry.text} `, bgColor: "#333333", color: "white" }];
    case "system":
      return [{ text: entry.text, color: "gray" }];
    case "event":
    case "response":
      return entry.segs;
  }
}

// ─── Split styled segments into visual rows ─────────────

/**
 * Takes a Seg[] and splits it into rows of at most `width` characters.
 * Handles explicit \n and automatic wrapping. Preserves styling per chunk.
 */
function splitSegsIntoRows(segs: Seg[], width: number): Seg[][] {
  const w = Math.max(1, width);
  const rows: Seg[][] = [[]];
  let col = 0;

  for (const seg of segs) {
    const { text, ...style } = seg;
    let pos = 0;

    while (pos < text.length) {
      // Explicit newline
      if (text[pos] === "\n") {
        rows.push([]);
        col = 0;
        pos++;
        continue;
      }

      // Wrap if at width
      if (col >= w) {
        rows.push([]);
        col = 0;
      }

      // Find chunk end: stop at next \n or when we'd exceed width
      const remaining = w - col;
      const nextNl = text.indexOf("\n", pos);
      const maxEnd = pos + remaining;
      const chunkEnd =
        nextNl !== -1 && nextNl < maxEnd
          ? nextNl   // stop before \n (it'll be consumed next iteration)
          : Math.min(maxEnd, text.length);

      const chunk = text.slice(pos, chunkEnd);
      if (chunk.length > 0) {
        rows[rows.length - 1]!.push({ text: chunk, ...style });
        col += chunk.length;
      }
      pos = chunkEnd;
    }
  }

  // Ensure at least 1 row for empty entries
  if (rows.length === 0) rows.push([]);

  return rows;
}

// ─── Margin rules (unchanged logic) ─────────────────────

function needsMarginTop(entries: StreamEntry[], idx: number): boolean {
  const t = entries[idx]!.type;
  if (t === "system") return false;
  if (idx === 0) return true;
  const prev = entries[idx - 1]!.type;
  if (t === "response" && prev === "response") return false;
  return true;
}

function needsMarginBottom(entries: StreamEntry[], idx: number): boolean {
  const t = entries[idx]!.type;
  if (t !== "response") return false;
  if (idx + 1 < entries.length && entries[idx + 1]!.type === "response") return false;
  return true;
}

// ─── Flatten all entries into visual rows ────────────────

function flattenEntries(entries: StreamEntry[], width: number): VisualRow[] {
  const flat: VisualRow[] = [];

  for (let i = 0; i < entries.length; i++) {
    // Margin top → spacer row
    if (needsMarginTop(entries, i)) {
      flat.push({ kind: "spacer" });
    }

    // Split entry into visual rows
    const segs = entryToSegs(entries[i]!);
    const rows = splitSegsIntoRows(segs, width);
    for (const row of rows) {
      flat.push({ kind: "content", segs: row });
    }

    // Margin bottom → spacer row
    if (needsMarginBottom(entries, i)) {
      flat.push({ kind: "spacer" });
    }
  }

  return flat;
}

// ─── Stream component ───────────────────────────────────

export function Stream({ height, width }: { height: number; width: number }) {
  const lines = useStore((s) => s.lines);
  const scrollOffset = useStore((s) => s.scrollOffset);

  // Usable width after paddingX={1} (1 char each side)
  const usableWidth = Math.max(1, width - 2);

  // Pre-flatten: recomputes only when lines or width change
  const flat = useMemo(() => flattenEntries(lines, usableWidth), [lines, usableWidth]);

  // Scroll: simple slice on flat array
  // scrollOffset = 0 → bottom (latest), scrollOffset = N → skip N rows from bottom
  const maxScroll = Math.max(0, flat.length - height);
  const clamped = Math.min(scrollOffset, maxScroll);

  // Normalize oversized scrollOffset (e.g. after scrollUp(MAX_SAFE_INTEGER))
  // so that subsequent scrollDown(3) subtracts from the real clamped value.
  useEffect(() => {
    if (scrollOffset > maxScroll && maxScroll >= 0) {
      useStore.getState().setScrollOffset(maxScroll);
    }
  }, [scrollOffset, maxScroll]);

  const startIdx = Math.max(0, flat.length - height - clamped);
  const visible = flat.slice(startIdx, startIdx + height);

  return (
    <Box flexDirection="column" height={height} overflow="hidden" paddingX={1}>
      {visible.map((row, i) =>
        row.kind === "spacer" ? (
          <Box key={startIdx + i} height={1} />
        ) : (
          <SegmentLine key={startIdx + i} segs={row.segs} />
        ),
      )}
    </Box>
  );
}
