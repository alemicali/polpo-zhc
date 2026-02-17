import type { Component } from "@mariozechner/pi-tui";

/**
 * ScrollableLog — a fixed-height viewport that wraps another component.
 *
 * It renders the child fully (which may produce hundreds of lines),
 * then clips output to exactly `maxHeight` lines. By default it auto-scrolls
 * to the bottom so the latest content is visible. The user can scroll up/down
 * via `scrollUp()` / `scrollDown()` / `pageUp()` / `pageDown()`.
 *
 * This prevents content from exceeding terminal height, which means the
 * terminal never creates native scrollback — keeping SplitPane panels
 * "sticky" on every visible row.
 */
export class ScrollableLog implements Component {
  private child: Component;
  private _maxHeight = 20;
  private scrollOffset = -1; // -1 means "auto-follow bottom"
  private lastTotalLines = 0;

  constructor(child: Component) {
    this.child = child;
  }

  /** Set the maximum visible height in lines. */
  setMaxHeight(h: number): void {
    this._maxHeight = Math.max(1, h);
  }

  getMaxHeight(): number {
    return this._maxHeight;
  }

  /** Scroll up by `n` lines. */
  scrollUp(n = 1): void {
    if (this.scrollOffset === -1) {
      // Switch from auto-follow to manual: pin to current bottom view
      this.scrollOffset = Math.max(0, this.lastTotalLines - this._maxHeight);
    }
    this.scrollOffset = Math.max(0, this.scrollOffset - n);
  }

  /** Scroll down by `n` lines. */
  scrollDown(n = 1): void {
    if (this.scrollOffset === -1) return; // already at bottom
    this.scrollOffset += n;
    const maxOffset = Math.max(0, this.lastTotalLines - this._maxHeight);
    if (this.scrollOffset >= maxOffset) {
      // Snap back to auto-follow
      this.scrollOffset = -1;
    }
  }

  /** Scroll up by one page. */
  pageUp(): void {
    this.scrollUp(Math.max(1, this._maxHeight - 2));
  }

  /** Scroll down by one page. */
  pageDown(): void {
    this.scrollDown(Math.max(1, this._maxHeight - 2));
  }

  /** Jump to the bottom (re-enable auto-follow). */
  scrollToBottom(): void {
    this.scrollOffset = -1;
  }

  /** Whether auto-follow is active (pinned to bottom). */
  isAtBottom(): boolean {
    return this.scrollOffset === -1;
  }

  invalidate(): void {
    this.child.invalidate?.();
  }

  render(width: number): string[] {
    // Render child fully
    const allLines = this.child.render(width);
    this.lastTotalLines = allLines.length;

    const maxH = this._maxHeight;

    // If content fits, just return it (padded to maxH for stable layout)
    if (allLines.length <= maxH) {
      this.scrollOffset = -1; // nothing to scroll
      return padLines(allLines, maxH);
    }

    // Compute the visible slice
    let start: number;
    if (this.scrollOffset === -1) {
      // Auto-follow: show the last maxH lines
      start = allLines.length - maxH;
    } else {
      start = Math.min(this.scrollOffset, allLines.length - maxH);
      start = Math.max(0, start);
    }

    const visible = allLines.slice(start, start + maxH);
    return padLines(visible, maxH);
  }
}

/** Pad an array of lines to exactly `height` lines (with empty strings). */
function padLines(lines: string[], height: number): string[] {
  if (lines.length >= height) return lines.slice(0, height);
  const result = [...lines];
  while (result.length < height) {
    result.push("");
  }
  return result;
}
