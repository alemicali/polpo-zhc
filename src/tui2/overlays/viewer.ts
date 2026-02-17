import chalk from "chalk";
import type { Component } from "@mariozechner/pi-tui";
import { Key, matchesKey, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import { theme } from "../theme.js";

export interface ViewerAction {
  label: string;
  handler: () => void;
}

export interface ViewerOptions {
  title: string;
  content: string;
  actions?: ViewerAction[];
  onClose: () => void;
}

/**
 * ViewerOverlay — scrollable content viewer with selectable action buttons.
 *
 * Navigation:
 *   j/k or PgUp/PgDn — scroll content
 *   Left/Right or Tab  — cycle through actions
 *   Enter              — execute selected action
 *   Esc                — close
 *   1-9                — direct action selection
 */
export class ViewerOverlay implements Component {
  private lines: string[] = [];
  private scrollOffset = 0;
  private selectedAction = 0;
  private title: string;
  private actions: ViewerAction[];
  private onClose: () => void;

  // Track the actual render height for scroll calculations
  private lastContentHeight = 20;

  constructor(options: ViewerOptions) {
    this.title = options.title;
    this.lines = options.content.split("\n");
    this.actions = options.actions ?? [];
    this.onClose = options.onClose;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const output: string[] = [];
    const sep = chalk.dim("\u2500".repeat(width));

    // Header
    output.push(theme.header(` ${this.title}`));
    output.push(sep);

    // Content area — use available height dynamically.
    // Reserve: header(2) + scroll-indicator(1) + sep(1) + actions + hint(1) + padding(1)
    const actionLines = this.actions.length > 0 ? 3 : 0; // action bar + sep + blank
    const reserved = 2 + 1 + 1 + actionLines + 1;
    // Use a reasonable default; the overlay system constrains via maxHeight anyway
    this.lastContentHeight = Math.max(5, 30 - reserved);

    const visibleLines = this.lines.slice(
      this.scrollOffset,
      this.scrollOffset + this.lastContentHeight,
    );
    for (const line of visibleLines) {
      output.push(` ${line}`);
    }

    // Pad short content
    for (let i = visibleLines.length; i < this.lastContentHeight; i++) {
      output.push("");
    }

    // Scroll indicator
    const total = this.lines.length;
    const endLine = Math.min(this.scrollOffset + this.lastContentHeight, total);
    if (total > this.lastContentHeight) {
      const pct = Math.round(((this.scrollOffset + this.lastContentHeight / 2) / total) * 100);
      output.push(
        theme.dim(` ${this.scrollOffset + 1}-${endLine} of ${total} (${Math.min(pct, 100)}%)`),
      );
    } else {
      output.push(theme.dim(` ${total} line${total !== 1 ? "s" : ""}`));
    }
    output.push(sep);

    // Action bar — horizontal, all on one line
    if (this.actions.length > 0) {
      const parts: string[] = [];
      for (let i = 0; i < this.actions.length; i++) {
        const label = this.actions[i]!.label;
        if (i === this.selectedAction) {
          parts.push(theme.accent(chalk.bold(`[${label}]`)));
        } else {
          parts.push(chalk.dim(` ${label} `));
        }
      }
      output.push(` ${parts.join("  ")}`);
      output.push("");
    }

    // Hint
    const hints: string[] = ["j/k: scroll"];
    if (this.actions.length > 1) hints.push("\u2190/\u2192: actions");
    hints.push("Enter: select", "Esc: close");
    output.push(theme.dim(` ${hints.join(" \u00b7 ")}`));

    return output;
  }

  handleInput(data: string): void {
    // Close
    if (matchesKey(data, Key.escape)) {
      this.onClose();
      return;
    }

    // Execute selected action
    if (matchesKey(data, Key.enter) && this.actions.length > 0) {
      this.actions[this.selectedAction]?.handler();
      return;
    }

    // Action navigation — left/right/tab
    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      if (this.actions.length > 1) {
        this.selectedAction = (this.selectedAction + 1) % this.actions.length;
      }
      return;
    }
    if (matchesKey(data, Key.left)) {
      if (this.actions.length > 1) {
        this.selectedAction =
          (this.selectedAction - 1 + this.actions.length) % this.actions.length;
      }
      return;
    }

    // Content scroll — j/k/up/down/pgup/pgdn
    const maxScroll = Math.max(0, this.lines.length - this.lastContentHeight);
    if (data === "j" || matchesKey(data, Key.down)) {
      this.scrollOffset = Math.min(this.scrollOffset + 1, maxScroll);
      return;
    }
    if (data === "k" || matchesKey(data, Key.up)) {
      this.scrollOffset = Math.max(this.scrollOffset - 1, 0);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset = Math.min(this.scrollOffset + this.lastContentHeight, maxScroll);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset = Math.max(this.scrollOffset - this.lastContentHeight, 0);
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.scrollOffset = 0;
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.scrollOffset = maxScroll;
      return;
    }

    // Direct action selection by number key (1-9)
    const num = parseInt(data, 10);
    if (num >= 1 && num <= this.actions.length) {
      this.actions[num - 1]?.handler();
    }
  }
}
