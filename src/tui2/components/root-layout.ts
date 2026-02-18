import type { Component } from "@mariozechner/pi-tui";
import type { TUI } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";

const RESET = "\x1b[0m";

/**
 * RootLayout — single monolithic component that renders the entire TUI.
 *
 * Architecture:
 *   Row 0                    : header  | panel line 0
 *   Row 1..scrollH           : chat    | panel line 1..
 *   Row scrollH+1            : status  | panel line ..
 *   Row scrollH+2            : footer  | panel line ..
 *   Row scrollH+3..termH-1   : editor  | panel line ..
 *
 * The total output is ALWAYS exactly termHeight lines. This means:
 *  - No native terminal scrollback
 *  - The right panel appears on every row (sticky effect)
 *  - Chat has internal scroll (auto-follow, manual scroll)
 *
 * The chat area is rendered fully by the chatLog component, then
 * the last `scrollH` lines are extracted (or the scroll-offset slice).
 */
export class RootLayout implements Component {
  private tui: TUI;

  header: Component | null = null;
  chatLog: Component | null = null;
  status: Component | null = null;
  footer: Component | null = null;
  editor: Component | null = null;
  panel: Component | null = null;

  private _panelWidth = 0;
  private _panelVisible = true;

  // Scroll state for the chat log area
  private scrollOffset = -1; // -1 = auto-follow bottom
  private lastChatTotalLines = 0;
  private lastScrollH = 10;

  constructor(tui: TUI) {
    this.tui = tui;
  }

  setPanelWidth(w: number): void {
    this._panelWidth = Math.max(0, w);
  }

  setPanelVisible(v: boolean): void {
    this._panelVisible = v;
  }

  // --- Scroll API ---

  scrollUp(n = 1): void {
    if (this.scrollOffset === -1) {
      this.scrollOffset = Math.max(0, this.lastChatTotalLines - this.lastScrollH);
    }
    this.scrollOffset = Math.max(0, this.scrollOffset - n);
  }

  scrollDown(n = 1): void {
    if (this.scrollOffset === -1) return;
    this.scrollOffset += n;
    const maxOff = Math.max(0, this.lastChatTotalLines - this.lastScrollH);
    if (this.scrollOffset >= maxOff) {
      this.scrollOffset = -1;
    }
  }

  pageUp(): void { this.scrollUp(Math.max(1, this.lastScrollH - 2)); }
  pageDown(): void { this.scrollDown(Math.max(1, this.lastScrollH - 2)); }

  scrollToBottom(): void { this.scrollOffset = -1; }
  isAtBottom(): boolean { return this.scrollOffset === -1; }

  // --- Render ---

  invalidate(): void {
    this.header?.invalidate?.();
    this.chatLog?.invalidate?.();
    this.status?.invalidate?.();
    this.footer?.invalidate?.();
    this.editor?.invalidate?.();
    this.panel?.invalidate?.();
  }

  render(width: number): string[] {
    const termH = this.tui.terminal.rows;
    const showPanel = this._panelVisible && this._panelWidth > 0 && width >= 60;
    const panelW = showPanel ? this._panelWidth : 0;
    const leftW = showPanel ? Math.max(20, width - panelW) : width;

    // 1) Render fixed-height sections at leftW to measure their heights
    const headerLines = this.header ? this.header.render(leftW) : [];
    const statusLines = this.status ? this.status.render(leftW) : [];
    const footerLines = this.footer ? this.footer.render(leftW) : [];
    const editorLines = this.editor ? this.editor.render(leftW) : [];

    const fixedH = headerLines.length + statusLines.length + footerLines.length + editorLines.length;

    // 2) Chat scroll area gets whatever's left
    const scrollH = Math.max(3, termH - fixedH);
    this.lastScrollH = scrollH;

    // 3) Render chat fully, then extract the visible slice
    const allChatLines = this.chatLog ? this.chatLog.render(leftW) : [];
    this.lastChatTotalLines = allChatLines.length;

    let chatSlice: string[];
    if (allChatLines.length <= scrollH) {
      // Everything fits — pad to scrollH
      this.scrollOffset = -1;
      chatSlice = padToHeight(allChatLines, scrollH);
    } else {
      let start: number;
      if (this.scrollOffset === -1) {
        start = allChatLines.length - scrollH;
      } else {
        start = Math.min(this.scrollOffset, allChatLines.length - scrollH);
        start = Math.max(0, start);
      }
      chatSlice = allChatLines.slice(start, start + scrollH);
    }

    // 4) Assemble left column: header + chatSlice + status + footer + editor
    const leftLines: string[] = [
      ...headerLines,
      ...chatSlice,
      ...statusLines,
      ...footerLines,
      ...editorLines,
    ];

    // Ensure exactly termH (defensive)
    while (leftLines.length < termH) leftLines.push("");
    if (leftLines.length > termH) leftLines.length = termH;

    // 5) If no panel, return left lines directly
    if (!showPanel) {
      return leftLines;
    }

    // 6) Render panel and composite side-by-side
    const panelLines = this.panel ? this.panel.render(panelW) : [];

    const result: string[] = [];
    for (let i = 0; i < termH; i++) {
      const l = truncateToWidth(leftLines[i] ?? "", leftW, "", true);
      const r = truncateToWidth(panelLines[i] ?? "", panelW, "", true);
      result.push(l + RESET + r);
    }

    return result;
  }
}

function padToHeight(lines: string[], h: number): string[] {
  if (lines.length >= h) return lines.slice(0, h);
  const result = [...lines];
  while (result.length < h) result.push("");
  return result;
}
