import { useTUIStore } from "../../tui/store.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * 1-line header status bar.
 * Content: ` project  |  ● N running  |  ✓ N done  |  ⠋ orchestrating`
 */
export function Header({ width }: { width: number }) {
  const state = useTUIStore((s) => s.state);
  const frame = useTUIStore((s) => s.frame);
  const config = useTUIStore((s) => s.config);

  const tasks = state?.tasks ?? [];
  const counts: Record<string, number> = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;

  const running =
    (counts["in_progress"] || 0) + (counts["assigned"] || 0) + (counts["review"] || 0);
  const done = counts["done"] || 0;
  const failed = counts["failed"] || 0;

  const hasActive = state?.processes?.some((p) => p.alive);
  const spin = SPINNER[frame % SPINNER.length];

  const parts: Array<{ text: string; fg?: string; bold?: boolean }> = [];
  if (config?.project) {
    parts.push({ text: config.project, fg: "#FFFFFF", bold: true });
  }
  if (running > 0) {
    parts.push({ text: "  |  ", fg: "#888888" });
    parts.push({ text: `● ${running} running`, fg: "#FFFF00" });
  }
  if (done > 0) {
    parts.push({ text: "  |  ", fg: "#888888" });
    parts.push({ text: `✓ ${done} done`, fg: "#00FF00" });
  }
  if (failed > 0) {
    parts.push({ text: "  |  ", fg: "#888888" });
    parts.push({ text: `✗ ${failed} failed`, fg: "#FF0000" });
  }
  if (hasActive) {
    parts.push({ text: "  |  ", fg: "#888888" });
    parts.push({ text: `${spin} orchestrating`, fg: "#00FFFF" });
  }

  return (
    <box style={{ width, height: 1 }}>
      <text>
        {" "}
        {parts.map((p, i) => (
          <span key={i} fg={p.fg} bold={p.bold}>{p.text}</span>
        ))}
      </text>
    </box>
  );
}
