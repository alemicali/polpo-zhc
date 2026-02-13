import { useTUIStore } from "../../tui/store.js";

/**
 * Processing status line — 1 line above the input box.
 * Shows shimmer wave animation.
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

  // Shimmer wave colors (hex)
  const wave = ["#888888", "#888888", "#FFFFFF", "#FFFF00", "#FFFFFF", "#888888", "#888888"];
  const waveLen = wave.length;
  const offset = frame % (label.length + waveLen);

  const chars: Array<{ ch: string; fg: string; bold: boolean }> = [];
  for (let i = 0; i < label.length; i++) {
    const wavePos = offset - i;
    let fg = "#888888";
    let bold = false;
    if (wavePos >= 0 && wavePos < waveLen) {
      fg = wave[wavePos]!;
      if (fg === "#FFFF00") bold = true;
    }
    chars.push({ ch: label[i]!, fg, bold });
  }

  // Detail (truncated)
  const detail = processingDetail
    ? processingDetail.slice(0, Math.max(10, width - label.length - 20))
    : "";

  return (
    <box style={{ width, height: 1 }}>
      <text>
        {" "}
        <span fg="#FFFF00">{dot}</span>
        {" "}
        {chars.map((c, i) => (
          <span key={i} fg={c.fg} bold={c.bold}>{c.ch}</span>
        ))}
        <span fg="#888888">...</span>
        {"  "}
        <span fg="#888888">{elapsed}</span>
        {detail ? (
          <>
            {"  "}
            <span fg="#888888">{detail}</span>
          </>
        ) : null}
      </text>
    </box>
  );
}
