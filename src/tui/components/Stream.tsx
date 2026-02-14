/**
 * Stream — scrollable log of events, user input, and responses.
 * Auto-scrolls to bottom on new entries.
 */

import { Box, Text } from "ink";
import { useStore, type StreamEntry } from "../store.js";
import { SegmentLine } from "./SegmentLine.js";

export function Stream({ height }: { height: number }) {
  const lines = useStore((s) => s.lines);

  // Each user message takes 2 rows (1 content + 1 margin-top), others take 1
  // Walk backwards to find how many entries fit
  let rows = 0;
  let startIdx = lines.length;
  for (let i = lines.length - 1; i >= 0 && rows < height; i--) {
    const t = lines[i]!.type;
    const cost = (t === "user" || t === "event" || t === "response") ? 2 : 1;
    if (rows + cost > height) break;
    rows += cost;
    startIdx = i;
  }
  const visible = lines.slice(startIdx);

  return (
    <Box flexDirection="column" height={height}>
      {visible.map((entry, i) => (
        <Box key={startIdx + i} marginTop={entry.type === "system" ? 0 : 1}>
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
