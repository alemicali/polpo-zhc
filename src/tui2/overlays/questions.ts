import chalk from "chalk";
import type { Component } from "@mariozechner/pi-tui";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import { theme } from "../theme.js";

export interface QuestionOption {
  label: string;
  value: string;
}

export interface Question {
  question: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface QuestionsOptions {
  questions: Question[];
  onSubmit: (answers: Map<number, string[]>) => void;
  onCancel: () => void;
}

export class QuestionsOverlay implements Component {
  private questions: Question[];
  private currentTab = 0;
  private optionIndex = 0;
  private selections: Map<number, Set<number>> = new Map();
  private customTexts: Map<number, string> = new Map();
  private onSubmit: (answers: Map<number, string[]>) => void;
  private onCancel: () => void;

  constructor(options: QuestionsOptions) {
    this.questions = options.questions;
    this.onSubmit = options.onSubmit;
    this.onCancel = options.onCancel;
    // Initialize selections
    for (let i = 0; i < this.questions.length; i++) {
      this.selections.set(i, new Set());
      this.customTexts.set(i, "");
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const output: string[] = [];

    // Tab bar
    const tabs: string[] = [];
    for (let i = 0; i < this.questions.length; i++) {
      const selected = this.selections.get(i);
      const answered = selected && selected.size > 0;
      const indicator = answered ? theme.done("✓") : " ";
      const label = `${indicator} Q${i + 1}`;
      tabs.push(i === this.currentTab ? chalk.bold.underline(label) : theme.dim(label));
    }
    output.push(` ${tabs.join("  ")}`);
    output.push(chalk.dim("─".repeat(width)));

    // Current question
    const q = this.questions[this.currentTab];
    if (!q) return output;

    output.push("");
    output.push(chalk.bold(` ${q.question}`));
    output.push("");

    // Options
    const currentSelections = this.selections.get(this.currentTab) ?? new Set();
    const optionCount = q.options.length + 1; // +1 for "Other..."

    for (let i = 0; i < q.options.length; i++) {
      const isSelected = currentSelections.has(i);
      const checkbox = isSelected ? theme.done("☑") : "☐";
      const prefix = i === this.optionIndex ? theme.accent("❯ ") : "  ";
      output.push(`${prefix}${checkbox} ${q.options[i]!.label}`);
    }

    // "Other..." option
    const isOther = this.optionIndex === q.options.length;
    const otherPrefix = isOther ? theme.accent("❯ ") : "  ";
    const otherChecked = currentSelections.has(q.options.length);
    const otherCheckbox = otherChecked ? theme.done("☑") : "☐";
    const customText = this.customTexts.get(this.currentTab) ?? "";
    const otherLabel = isOther && customText
      ? `Other: ${customText}▎`
      : "Other...";
    output.push(`${otherPrefix}${otherCheckbox} ${otherLabel}`);

    // Footer
    output.push("");
    const answeredCount = [...this.selections.values()].filter(s => s.size > 0).length;
    output.push(theme.dim(` ${this.currentTab + 1}/${this.questions.length} questions | ${answeredCount} answered`));
    output.push(theme.dim(" Tab/Shift+Tab switch · Space toggle · Enter submit · Esc cancel"));

    return output;
  }

  handleInput(data: string): void {
    const q = this.questions[this.currentTab];
    if (!q) return;

    const optionCount = q.options.length + 1;
    const isOnOther = this.optionIndex === q.options.length;

    // Navigation
    if (matchesKey(data, Key.escape)) {
      this.onCancel();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.currentTab = (this.currentTab + 1) % this.questions.length;
      this.optionIndex = 0;
      return;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      this.currentTab = (this.currentTab - 1 + this.questions.length) % this.questions.length;
      this.optionIndex = 0;
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.optionIndex = Math.max(0, this.optionIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.optionIndex = Math.min(optionCount - 1, this.optionIndex + 1);
      return;
    }

    // Space: toggle selection
    if (data === " ") {
      const sel = this.selections.get(this.currentTab)!;
      if (!q.multiSelect) sel.clear();
      if (sel.has(this.optionIndex)) {
        sel.delete(this.optionIndex);
      } else {
        sel.add(this.optionIndex);
      }
      return;
    }

    // Enter: submit
    if (matchesKey(data, Key.enter)) {
      const answers = new Map<number, string[]>();
      for (let i = 0; i < this.questions.length; i++) {
        const sel = this.selections.get(i) ?? new Set();
        const qq = this.questions[i]!;
        const values: string[] = [];
        for (const idx of sel) {
          if (idx < qq.options.length) {
            values.push(qq.options[idx]!.value);
          } else {
            const custom = this.customTexts.get(i)?.trim();
            if (custom) values.push(custom);
          }
        }
        answers.set(i, values);
      }
      this.onSubmit(answers);
      return;
    }

    // Typing on "Other..."
    if (isOnOther && data.length === 1 && !data.match(/[\x00-\x1f]/)) {
      const current = this.customTexts.get(this.currentTab) ?? "";
      this.customTexts.set(this.currentTab, current + data);
      // Auto-select "Other" when typing
      this.selections.get(this.currentTab)!.add(q.options.length);
      return;
    }

    // Backspace on "Other..."
    if (isOnOther && matchesKey(data, Key.backspace)) {
      const current = this.customTexts.get(this.currentTab) ?? "";
      if (current.length > 0) {
        this.customTexts.set(this.currentTab, current.slice(0, -1));
      }
      return;
    }
  }
}
