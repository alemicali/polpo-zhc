import { Box, Text } from "ink";
import { useTUIStore } from "../store.js";

/**
 * Processing status line — 1 line above the input box.
 * Shows shimmer wave animation matching old blessed TUI.
 */
export function StatusLine({ width }: { width: number }) {
  const frame = useTUIStore((s) => s.frame);
  const processingLabel = useTUIStore((s) => s.processingLabel);
  const processingDetail = useTUIStore((s) => s.processingDetail);
  const processingStart = useTUIStore((s) => s.processingStart);
  const inputMode = useTUIStore((s) => s.inputMode);

  const dots = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const dot = dots[frame % dots.length];

  const label =
    processingLabel ||
    (inputMode === "chat" ? "Thinking" : "Generating plan");

  // Elapsed time
  const elapsed = processingStart
    ? ((Date.now() - processingStart) / 1000).toFixed(0) + "s"
    : "";

  // Shimmer wave: a bright "highlight" sweeps across the text
  const wave = ["gray", "gray", "white", "yellow", "white", "gray", "gray"];
  const waveLen = wave.length;
  const offset = frame % (label.length + waveLen);

  const chars: Array<{ ch: string; color: string; bold: boolean }> = [];
  for (let i = 0; i < label.length; i++) {
    const wavePos = offset - i;
    let color = "gray";
    let bold = false;
    if (wavePos >= 0 && wavePos < waveLen) {
      color = wave[wavePos]!;
      if (color === "yellow") bold = true;
    }
    chars.push({ ch: label[i]!, color, bold });
  }

  // Detail (truncated)
  const detail = processingDetail
    ? processingDetail.slice(0, Math.max(10, width - label.length - 20))
    : "";

  return (
    <Box width={width} height={1}>
      <Text>
        {" "}
        <Text color="yellow">{dot}</Text>
        {" "}
        {chars.map((c, i) => (
          <Text key={i} color={c.color} bold={c.bold}>
            {c.ch}
          </Text>
        ))}
        <Text dimColor>...</Text>
        {"  "}
        <Text dimColor>{elapsed}</Text>
        {detail ? (
          <>
            {"  "}
            <Text dimColor>{detail}</Text>
          </>
        ) : null}
      </Text>
    </Box>
  );
}
