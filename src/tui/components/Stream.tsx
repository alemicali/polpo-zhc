/**
 * Stream — scrollable log of events, user input, and responses.
 * Auto-scrolls to bottom on new entries.
 */

import { Box, Text } from "ink";
import { useStore, type StreamEntry } from "../store.js";
import { SegmentLine } from "./SegmentLine.js";

export function Stream({ height }: { height: number }) {
  const lines = useStore((s) => s.lines);

  // Show last N lines that fit the viewport
  const visible = lines.slice(-height);
  const emptyRows = Math.max(0, height - visible.length);

  return (
    <Box flexDirection="column" height={height}>
      {/* Empty padding at top when few lines */}
      {emptyRows > 0 && <Box height={emptyRows} />}

      {visible.map((entry, i) => (
        <Box key={lines.length - visible.length + i}>
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
        <Text>
          <Text color="cyan" bold>{"❯ "}</Text>
          <Text>{entry.text}</Text>
        </Text>
      );
    case "response":
      return <SegmentLine segs={entry.segs} />;
    case "system":
      return <Text color="gray">{entry.text}</Text>;
  }
}
