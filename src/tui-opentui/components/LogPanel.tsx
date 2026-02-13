import { useTUIStore, type LogSeg, type LogEntry } from "../../tui/store.js";

/**
 * Scrollable log panel — auto-scrolls to bottom.
 * Renders colored LogSeg[] segments via OpenTUI <text>/<span>.
 */
export function LogPanel({ width, height }: { width: number; height: number }) {
  const logs = useTUIStore((s) => s.logs);
  const verboseLog = useTUIStore((s) => s.verboseLog);

  const visibleLogs = verboseLog
    ? logs
    : logs.filter((l) => l.type === "event" || l.type === "always");

  // Auto-scroll: show last N lines
  const tail = visibleLogs.slice(-height);

  return (
    <box style={{ flexDirection: "column", width, height, overflow: "hidden" }}>
      {tail.length === 0 ? (
        <text fg="#888888"> No events yet. Submit a task or plan to get started.</text>
      ) : (
        tail.map((entry, i) => (
          <RenderLogLine key={i} entry={entry} maxW={width} />
        ))
      )}
    </box>
  );
}

/** Render a log line — uses segments if available, otherwise plain text. */
function RenderLogLine({ entry, maxW }: { entry: LogEntry; maxW: number }) {
  if (entry.segments && entry.segments.length > 0) {
    return <RenderSegs segs={entry.segments} maxW={maxW} />;
  }

  const text = stripBlessedTags(entry.text);
  return <text>{text}</text>;
}

/** Map LogSeg color names to hex for OpenTUI */
function colorToHex(color?: string): string | undefined {
  if (!color) return undefined;
  const map: Record<string, string> = {
    cyan: "#00FFFF",
    green: "#00FF00",
    red: "#FF0000",
    yellow: "#FFFF00",
    magenta: "#FF00FF",
    blue: "#0088FF",
    gray: "#888888",
    grey: "#888888",
    white: "#FFFFFF",
  };
  return map[color] ?? (color.startsWith("#") ? color : undefined);
}

/** Render an array of colored segments */
function RenderSegs({ segs, maxW: _maxW }: { segs: LogSeg[]; maxW: number }) {
  return (
    <text>
      {segs.map((s, i) => (
        <span key={i} fg={s.dim ? "#555555" : colorToHex(s.color)} bold={s.bold}>
          {s.text}
        </span>
      ))}
    </text>
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
