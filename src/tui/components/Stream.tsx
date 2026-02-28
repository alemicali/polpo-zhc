/**
 * Stream — scrollable log of events, user input, and responses.
 * Pre-flattens entries into visual terminal rows for pixel-perfect scrolling.
 *
 * Visual indicators:
 *   Response in progress → ● (blinking gray)  before text
 *   Response done        → ● (white)          before text
 *   Tool running         → ● (blinking gray)  toolName (info)
 *   Tool done            → ● (green)          toolName (info)
 *   Tool error           → ● (red)            toolName (info)
 */

import { useMemo, useEffect, useState } from "react";
import { Box, Text } from "ink";
import { useStore, type StreamEntry, type Seg } from "../store.js";
import { SegmentLine } from "./SegmentLine.js";

// ─── Types ──────────────────────────────────────────────

type VisualRow =
  | { kind: "content"; segs: Seg[] }
  | { kind: "tool"; name: string; info?: string; state: "running" | "done" | "error" }
  | { kind: "response-dot"; done: boolean }
  | { kind: "spacer" };

// ─── Entry → visual rows ────────────────────────────────

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
      if (text[pos] === "\n") {
        rows.push([]);
        col = 0;
        pos++;
        continue;
      }

      if (col >= w) {
        rows.push([]);
        col = 0;
      }

      const remaining = w - col;
      const nextNl = text.indexOf("\n", pos);
      const maxEnd = pos + remaining;
      const chunkEnd =
        nextNl !== -1 && nextNl < maxEnd
          ? nextNl
          : Math.min(maxEnd, text.length);

      const chunk = text.slice(pos, chunkEnd);
      if (chunk.length > 0) {
        rows[rows.length - 1]!.push({ text: chunk, ...style });
        col += chunk.length;
      }
      pos = chunkEnd;
    }
  }

  if (rows.length === 0) rows.push([]);
  return rows;
}

// ─── Margin rules ───────────────────────────────────────

function needsMarginTop(entries: StreamEntry[], idx: number): boolean {
  const t = entries[idx]!.type;
  if (t === "system") return false;
  if (idx === 0) return true;
  const prev = entries[idx - 1]!.type;
  if (t === "response" && prev === "response") return false;
  if (t === "tool" && prev === "tool") return false;
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
    const entry = entries[i]!;

    if (needsMarginTop(entries, i)) {
      flat.push({ kind: "spacer" });
    }

    if (entry.type === "tool") {
      flat.push({ kind: "tool", name: entry.name, info: entry.info, state: entry.state });
    } else if (entry.type === "response") {
      // Response dot row, then content rows
      flat.push({ kind: "response-dot", done: !!entry.done });
      const rows = splitSegsIntoRows(entry.segs, width - 2); // -2 for "  " indent under dot
      for (const row of rows) {
        // Indent response text under the dot
        flat.push({ kind: "content", segs: [{ text: "  " }, ...row] });
      }
    } else if (entry.type === "user") {
      const segs: Seg[] = [{ text: ` ❯ ${entry.text} `, bgColor: "#333333", color: "white" }];
      const rows = splitSegsIntoRows(segs, width);
      for (const row of rows) {
        flat.push({ kind: "content", segs: row });
      }
    } else if (entry.type === "system") {
      const segs: Seg[] = [{ text: entry.text, color: "gray" }];
      const rows = splitSegsIntoRows(segs, width);
      for (const row of rows) {
        flat.push({ kind: "content", segs: row });
      }
    } else {
      // "event" type
      const rows = splitSegsIntoRows(entry.segs, width);
      for (const row of rows) {
        flat.push({ kind: "content", segs: row });
      }
    }

    if (needsMarginBottom(entries, i)) {
      flat.push({ kind: "spacer" });
    }
  }

  return flat;
}

// ─── Blinking dot component ─────────────────────────────

function BlinkDot({ color }: { color: string }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setVisible((v) => !v), 500);
    return () => clearInterval(id);
  }, []);
  return <Text color={visible ? color : "black"}>●</Text>;
}

// ─── Row renderers ──────────────────────────────────────

function ToolRow({ name, info, state, blinkTick }: {
  name: string;
  info?: string;
  state: "running" | "done" | "error";
  blinkTick: boolean;
}) {
  const dotColor = state === "done" ? "green" : state === "error" ? "red" : "gray";
  const dotVisible = state === "running" ? blinkTick : true;

  return (
    <Text>
      <Text color={dotVisible ? dotColor : "black"}>● </Text>
      <Text bold>{name}</Text>
      {info ? <Text color="gray"> ({info})</Text> : null}
    </Text>
  );
}

function ResponseDotRow({ done, blinkTick }: { done: boolean; blinkTick: boolean }) {
  const dotVisible = done ? true : blinkTick;
  const dotColor = done ? "white" : "gray";
  return (
    <Text>
      <Text color={dotVisible ? dotColor : "black"}>●</Text>
    </Text>
  );
}

// ─── Stream component ───────────────────────────────────

export function Stream({ height, width }: { height: number; width: number }) {
  const lines = useStore((s) => s.lines);
  const scrollOffset = useStore((s) => s.scrollOffset);

  // Blink tick — toggles every 500ms, drives all blinking dots
  const [blinkTick, setBlinkTick] = useState(true);
  const streaming = useStore((s) => s.streaming);

  useEffect(() => {
    if (!streaming) return;
    const id = setInterval(() => setBlinkTick((v) => !v), 500);
    return () => clearInterval(id);
  }, [streaming]);

  // Usable width after paddingX={1} (1 char each side)
  const usableWidth = Math.max(1, width - 2);

  // Pre-flatten: recomputes only when lines or width change
  const flat = useMemo(() => flattenEntries(lines, usableWidth), [lines, usableWidth]);

  // Scroll
  const maxScroll = Math.max(0, flat.length - height);
  const clamped = Math.min(scrollOffset, maxScroll);

  useEffect(() => {
    if (scrollOffset > maxScroll && maxScroll >= 0) {
      useStore.getState().setScrollOffset(maxScroll);
    }
  }, [scrollOffset, maxScroll]);

  const startIdx = Math.max(0, flat.length - height - clamped);
  const visible = flat.slice(startIdx, startIdx + height);

  return (
    <Box flexDirection="column" height={height} overflow="hidden" paddingX={1}>
      {visible.map((row, i) => {
        const key = startIdx + i;
        switch (row.kind) {
          case "spacer":
            return <Box key={key} height={1} />;
          case "tool":
            return (
              <ToolRow
                key={key}
                name={row.name}
                info={row.info}
                state={row.state}
                blinkTick={blinkTick}
              />
            );
          case "response-dot":
            return (
              <ResponseDotRow
                key={key}
                done={row.done}
                blinkTick={blinkTick}
              />
            );
          case "content":
            return <SegmentLine key={key} segs={row.segs} />;
        }
      })}
    </Box>
  );
}
