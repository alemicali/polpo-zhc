/**
 * Stream — scrollable log of events, user input, and responses.
 * Auto-scrolls to bottom on new entries.
 */

import { Box, Text } from "ink";
import { useStore, type StreamEntry } from "../store.js";
import { SegmentLine } from "./SegmentLine.js";

/** Count visual rows an entry occupies (embedded \n in segs). */
function entryRows(entry: StreamEntry): number {
  if (entry.type === "response" || entry.type === "event") {
    let n = 1;
    for (const s of entry.segs) {
      for (let j = 0; j < s.text.length; j++) {
        if (s.text[j] === "\n") n++;
      }
    }
    return n;
  }
  return 1;
}

/** Margin before entry: separate groups but not consecutive responses. */
function needsMargin(lines: StreamEntry[], idx: number): boolean {
  const t = lines[idx]!.type;
  if (t === "system") return false;
  if (idx === 0) return true;
  const prev = lines[idx - 1]!.type;
  if (t === "response" && prev === "response") return false;
  return true;
}

export function Stream({ height }: { height: number }) {
  const lines = useStore((s) => s.lines);

  // Walk backwards to find how many entries fit.
  // Always include the last entry even if it overflows (Ink clips at top).
  let rows = 0;
  let startIdx = lines.length;
  for (let i = lines.length - 1; i >= 0 && rows < height; i--) {
    const cost = entryRows(lines[i]!) + (needsMargin(lines, i) ? 1 : 0);
    if (rows + cost > height && i < lines.length - 1) break;
    rows += cost;
    startIdx = i;
  }
  const visible = lines.slice(startIdx);

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {visible.map((entry, i) => (
        <Box key={startIdx + i} marginTop={needsMargin(lines, startIdx + i) ? 1 : 0}>
          <StreamLine entry={entry} />
        </Box>
      ))}
    </Box>
  );
}

function StreamLine({ entry }: { entry: StreamEntry }) {
  switch (entry.type) {
    case "event":
      return <SegmentLine segs={entry.segs} />;
    case "user":
      return (
        <Text backgroundColor="#333333" color="white">
          {" ❯ "}{entry.text}{" "}
        </Text>
      );
    case "response":
      return <SegmentLine segs={entry.segs} />;
    case "system":
      return <Text color="gray">{entry.text}</Text>;
  }
}
