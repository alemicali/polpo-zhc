import chalk from "chalk";
import type { Component } from "@mariozechner/pi-tui";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import { theme } from "../theme.js";

export interface ApprovalOptions {
  toolName: string;
  description: string;
  /** Key-value pairs for the main details */
  details: [string, string][];
  /** Key-value pairs for extra/secondary details */
  extraDetails?: [string, string][];
  onApprove: () => void;
  onReject: () => void;
}

/**
 * ApprovalOverlay — tool approval prompt.
 *
 * Shows tool details and two selectable options: Approve / Reject.
 * Navigate with Up/Down arrows, confirm with Enter, cancel with Esc.
 */
export class ApprovalOverlay implements Component {
  private toolName: string;
  private description: string;
  private details: [string, string][];
  private extraDetails: [string, string][];
  private onApprove: () => void;
  private onReject: () => void;
  private selected = 0; // 0 = Approve, 1 = Reject

  constructor(options: ApprovalOptions) {
    this.toolName = options.toolName;
    this.description = options.description;
    this.details = options.details;
    this.extraDetails = options.extraDetails ?? [];
    this.onApprove = options.onApprove;
    this.onReject = options.onReject;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const output: string[] = [];
    const sep = chalk.dim("\u2500".repeat(width));

    // Header
    output.push(theme.header(` Approve tool call?`));
    output.push(sep);

    // Tool info
    output.push("");
    output.push(` ${theme.warning("\u26A0")} ${theme.bold(this.description)}`);
    output.push("");

    // Details
    if (this.details.length > 0) {
      for (const [key, val] of this.details) {
        output.push(`   ${theme.bold(key)}: ${val}`);
      }
    }
    if (this.extraDetails.length > 0) {
      output.push("");
      for (const [key, val] of this.extraDetails) {
        output.push(`   ${theme.dim(key)}: ${val}`);
      }
    }

    output.push("");
    output.push(sep);
    output.push("");

    // Selection options
    const options = [
      { label: "Approve", icon: "\u2713", color: theme.done },
      { label: "Reject", icon: "\u2717", color: theme.failed },
    ];

    for (let i = 0; i < options.length; i++) {
      const opt = options[i]!;
      if (i === this.selected) {
        output.push(`  ${theme.accent("\u276F")} ${opt.color(chalk.bold(`${opt.icon} ${opt.label}`))}`);
      } else {
        output.push(`    ${chalk.dim(`${opt.icon} ${opt.label}`)}`);
      }
    }

    output.push("");
    output.push(theme.dim(` \u2191/\u2193: select \u00b7 Enter: confirm \u00b7 Esc: reject`));

    return output;
  }

  handleInput(data: string): void {
    // Confirm selection
    if (matchesKey(data, Key.enter)) {
      if (this.selected === 0) {
        this.onApprove();
      } else {
        this.onReject();
      }
      return;
    }

    // Escape = reject
    if (matchesKey(data, Key.escape)) {
      this.onReject();
      return;
    }

    // Navigate
    if (matchesKey(data, Key.up) || data === "k") {
      this.selected = 0;
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.selected = 1;
      return;
    }

    // Quick keys
    if (data === "y" || data === "Y") {
      this.onApprove();
      return;
    }
    if (data === "n" || data === "N") {
      this.onReject();
      return;
    }
  }
}
