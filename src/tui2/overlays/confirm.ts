import type { Component } from "@mariozechner/pi-tui";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import { theme } from "../theme.js";

export interface ConfirmOptions {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export class ConfirmOverlay implements Component {
  private message: string;
  private onConfirm: () => void;
  private onCancel: () => void;

  constructor(options: ConfirmOptions) {
    this.message = options.message;
    this.onConfirm = options.onConfirm;
    this.onCancel = options.onCancel;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return [
      "",
      theme.warning(` ${this.message}`),
      "",
      theme.dim(" y/Enter to confirm · n/Esc to cancel"),
      "",
    ];
  }

  handleInput(data: string): void {
    if (data === "y" || data === "Y" || matchesKey(data, Key.enter)) {
      this.onConfirm();
      return;
    }
    if (data === "n" || data === "N" || matchesKey(data, Key.escape)) {
      this.onCancel();
      return;
    }
  }
}
