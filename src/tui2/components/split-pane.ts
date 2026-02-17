import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";

/**
 * SplitPane — renders two components side by side.
 *
 * The right component gets a fixed width; the left component fills the rest.
 * Both are rendered independently, then composed line-by-line. The shorter
 * side is padded with blank lines so they always match heights.
 *
 * When the right side is hidden (rightWidth = 0), the left side gets full width.
 */
export class SplitPane implements Component {
  private left: Component;
  private right: Component;
  private _rightWidth = 0;

  constructor(left: Component, right: Component) {
    this.left = left;
    this.right = right;
  }

  /** Set the right panel width. 0 = hidden (left gets full width). */
  setRightWidth(w: number): void {
    this._rightWidth = Math.max(0, w);
  }

  getRightWidth(): number {
    return this._rightWidth;
  }

  invalidate(): void {
    this.left.invalidate?.();
    this.right.invalidate?.();
  }

  render(width: number): string[] {
    if (this._rightWidth <= 0 || width < 40) {
      // No right panel — render left at full width
      return this.left.render(width);
    }

    const rightW = this._rightWidth;
    const leftW = Math.max(20, width - rightW);

    // Render both sides
    const leftLines = this.left.render(leftW);
    const rightLines = this.right.render(rightW);

    // The LEFT side (FixedLayout) is the height authority — it produces exactly
    // termHeight lines. The right side is clipped to the same height so total
    // output never exceeds termHeight, preventing native terminal scrollback.
    const totalLines = leftLines.length;
    const RESET = "\x1b[0m";

    const result: string[] = [];
    for (let i = 0; i < totalLines; i++) {
      const lRaw = leftLines[i] ?? "";
      const rRaw = rightLines[i] ?? "";

      // Truncate left to leftW and pad to exact leftW.
      // truncateToWidth with pad=true handles ANSI-aware padding.
      const lPadded = truncateToWidth(lRaw, leftW, "", true);

      // Truncate right to rightW and pad to exact rightW.
      const rPadded = truncateToWidth(rRaw, rightW, "", true);

      // RESET between left and right to prevent ANSI color leakage.
      result.push(lPadded + RESET + rPadded);
    }

    return result;
  }
}

/**
 * WidthLimiter — wraps a component and constrains its render width.
 * Kept for backward compatibility.
 */
export class WidthLimiter implements Component {
  private child: Component;
  private reservedRight = 0;

  constructor(child: Component) {
    this.child = child;
  }

  setReservedRight(cols: number): void {
    this.reservedRight = cols;
  }

  getReservedRight(): number {
    return this.reservedRight;
  }

  invalidate(): void {
    this.child.invalidate?.();
  }

  render(width: number): string[] {
    const effectiveWidth = this.reservedRight > 0
      ? Math.max(20, width - this.reservedRight)
      : width;

    const lines = this.child.render(effectiveWidth);

    if (this.reservedRight > 0) {
      return lines.map(line => truncateToWidth(line, effectiveWidth, "", true));
    }
    return lines;
  }
}
