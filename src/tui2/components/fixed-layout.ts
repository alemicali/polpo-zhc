import type { Component } from "@mariozechner/pi-tui";
import type { TUI } from "@mariozechner/pi-tui";
import { ScrollableLog } from "./scrollable-log.js";

/**
 * FixedLayout — a root-level container that fits exactly within `termHeight`.
 *
 * It renders all children, but adjusts the ScrollableLog's maxHeight
 * dynamically so the total output never exceeds `termHeight`.
 *
 * Children are split into two groups:
 *  - "fixed" children (header, status, footer, editor) → render at natural height
 *  - the ScrollableLog → gets the remaining height after fixed children
 *
 * This ensures zero terminal scrollback, keeping SplitPane panels sticky.
 */
export class FixedLayout implements Component {
  private tui: TUI;
  private fixedBefore: Component[] = []; // above the scroll area
  private scrollable: ScrollableLog;
  private fixedAfter: Component[] = []; // below the scroll area

  constructor(
    tui: TUI,
    fixedBefore: Component[],
    scrollable: ScrollableLog,
    fixedAfter: Component[],
  ) {
    this.tui = tui;
    this.fixedBefore = fixedBefore;
    this.scrollable = scrollable;
    this.fixedAfter = fixedAfter;
  }

  invalidate(): void {
    for (const c of this.fixedBefore) c.invalidate?.();
    this.scrollable.invalidate?.();
    for (const c of this.fixedAfter) c.invalidate?.();
  }

  render(width: number): string[] {
    const termHeight = this.tui.terminal.rows;

    // 1) Render fixed children to measure their heights
    const beforeLines: string[][] = this.fixedBefore.map(c => c.render(width));
    const afterLines: string[][] = this.fixedAfter.map(c => c.render(width));

    const beforeTotal = beforeLines.reduce((s, l) => s + l.length, 0);
    const afterTotal = afterLines.reduce((s, l) => s + l.length, 0);

    // 2) Compute remaining height for the scrollable area
    const scrollHeight = Math.max(3, termHeight - beforeTotal - afterTotal);
    this.scrollable.setMaxHeight(scrollHeight);

    // 3) Render the scrollable area
    const scrollLines = this.scrollable.render(width);

    // 4) Assemble output — must be exactly termHeight lines
    const result: string[] = [];
    for (const group of beforeLines) result.push(...group);
    result.push(...scrollLines);
    for (const group of afterLines) result.push(...group);

    // Trim to exactly termHeight (safety net)
    if (result.length > termHeight) {
      return result.slice(0, termHeight);
    }
    // Pad if needed (shouldn't normally happen since ScrollableLog pads)
    while (result.length < termHeight) {
      result.push("");
    }

    return result;
  }
}
