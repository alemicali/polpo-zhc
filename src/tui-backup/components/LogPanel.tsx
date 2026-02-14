import { Box, Text } from "ink";
import { useTUIStore, type LogSeg, type LogEntry } from "../store.js";

/**
 * Borderless log panel — auto-scrolls to bottom.
 * Shows chat messages in chat mode, operational logs otherwise.
 */
export function LogPanel({ width, height }: { width: number; height: number }) {
  const logs = useTUIStore((s) => s.logs);
  const verboseLog = useTUIStore((s) => s.verboseLog);
  const inputMode = useTUIStore((s) => s.inputMode);
  const chatMessages = useTUIStore((s) => s.chatMessages);

  const innerW = width;

  // Chat mode: show conversation
  if (inputMode === "chat") {
    const tail = chatMessages.slice(-height);
    return (
      <Box flexDirection="column" width={width} height={height} overflow="hidden">
        {tail.length === 0 ? (
          <Text dimColor wrap="truncate"> Chat mode. Ask anything about the project state.</Text>
        ) : (
          tail.map((msg, i) =>
            msg.role === "user" ? (
              <Box key={i} width={innerW}>
                <Text backgroundColor="#333333" color="white">{` ${msg.content} `.slice(0, innerW)}</Text>
              </Box>
            ) : (
              <Text key={i} wrap="truncate">{`  ${msg.content}`.slice(0, innerW)}</Text>
            ),
          )
        )}
        {Array.from({ length: Math.max(0, height - Math.max(1, tail.length)) }).map((_, i) => (
          <Text key={`empty-${i}`}>{" ".repeat(innerW)}</Text>
        ))}
      </Box>
    );
  }

  // Task/plan mode: show operational logs
  const visibleLogs = verboseLog
    ? logs
    : logs.filter((l) => l.type === "event" || l.type === "always");

  const tail = visibleLogs.slice(-height);

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {tail.length === 0 ? (
        <Box width={innerW} overflow="hidden">
          <Text dimColor wrap="truncate"> No events yet. Submit a task or plan to get started.</Text>
        </Box>
      ) : (
        tail.map((entry, i) => (
          <Box key={i} width={innerW} overflow="hidden">
            <Text wrap="truncate">
              <RenderLogLine entry={entry} maxW={innerW} />
            </Text>
          </Box>
        ))
      )}
      {Array.from({ length: Math.max(0, height - Math.max(1, tail.length)) }).map((_, i) => (
        <Text key={`empty-${i}`}>{" ".repeat(innerW)}</Text>
      ))}
    </Box>
  );
}

/** Render a log line — uses segments if available, otherwise plain text. */
function RenderLogLine({ entry, maxW }: { entry: LogEntry; maxW: number }) {
  if (entry.segments && entry.segments.length > 0) {
    return <RenderSegs segs={entry.segments} maxW={maxW} />;
  }

  // Plain text fallback — strip any lingering blessed tags
  const text = stripBlessedTags(entry.text);
  const padded = text.slice(0, maxW).padEnd(maxW);
  return <Text>{padded}</Text>;
}

/** Render an array of colored segments, padding to maxW */
function RenderSegs({ segs, maxW }: { segs: LogSeg[]; maxW: number }) {
  const totalLen = segs.reduce((sum, s) => sum + s.text.length, 0);
  const pad = Math.max(0, maxW - totalLen);

  return (
    <>
      {segs.map((s, i) => (
        <Text key={i} color={s.color} bold={s.bold} dimColor={s.dim}>
          {totalLen > maxW && i === segs.length - 1
            ? s.text.slice(0, Math.max(0, s.text.length - (totalLen - maxW)))
            : s.text}
        </Text>
      ))}
      {pad > 0 ? <Text>{" ".repeat(pad)}</Text> : null}
    </>
  );
}

/** Strip {color-fg}...{/} blessed tags and return plain text. */
function stripBlessedTags(text: string): string {
  return text
    .replace(/\{[^}]*-fg\}/g, "")
    .replace(/\{\/[^}]*-fg\}/g, "")
    .replace(/\{[^}]*-bg\}/g, "")
    .replace(/\{\/[^}]*-bg\}/g, "")
    .replace(/\{bold\}/g, "")
    .replace(/\{\/bold\}/g, "")
    .replace(/\{open\}/g, "{")
    .replace(/\{close\}/g, "}")
    .replace(/\{[^}]*\}/g, "");
}
