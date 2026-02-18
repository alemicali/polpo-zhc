import { Box, Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { markdownTheme, theme } from "../theme.js";

const PREVIEW_LINES = 12;

function formatArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  try {
    const str = JSON.stringify(args);
    return str.length > 200 ? str.slice(0, 200) + "…" : str;
  } catch {
    return "";
  }
}

function extractResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const rec = result as Record<string, unknown>;
  if (typeof rec.content === "string") return rec.content;
  if (Array.isArray(rec.content)) {
    return rec.content
      .filter((c: any) => c?.type === "text" && typeof c?.text === "string")
      .map((c: any) => c.text as string)
      .join("\n")
      .trim();
  }
  try {
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

export class ToolExecutionComponent extends Container {
  private box: Box;
  private header: Text;
  private argsLine: Text;
  private output: Markdown;
  private toolName: string;
  private args: unknown;
  private result?: unknown;
  private expanded = false;
  private isError = false;
  private isPartial = true;

  constructor(toolName: string, args: unknown) {
    super();
    this.toolName = toolName;
    this.args = args;
    this.box = new Box(1, 1, (line) => theme.toolPendingBg(line));
    this.header = new Text("", 0, 0);
    this.argsLine = new Text("", 0, 0);
    this.output = new Markdown("", 0, 0, markdownTheme, {
      color: (line) => theme.toolOutput(line),
    });
    this.addChild(new Spacer(1));
    this.addChild(this.box);
    this.box.addChild(this.header);
    this.box.addChild(this.argsLine);
    this.box.addChild(this.output);
    this.refresh();
  }

  setArgs(args: unknown): void {
    this.args = args;
    this.refresh();
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.refresh();
  }

  setResult(result: unknown, opts?: { isError?: boolean }): void {
    this.result = result;
    this.isPartial = false;
    this.isError = Boolean(opts?.isError);
    this.refresh();
  }

  setPartialResult(result: unknown): void {
    this.result = result;
    this.isPartial = true;
    this.refresh();
  }

  private refresh(): void {
    const bg = this.isPartial
      ? theme.toolPendingBg
      : this.isError
        ? theme.toolErrorBg
        : theme.toolSuccessBg;
    this.box.setBgFn((line) => bg(line));

    const statusLabel = this.isPartial ? " (running)" : this.isError ? " (error)" : "";
    const icon = this.isPartial ? "⚙" : this.isError ? "✗" : "✓";
    this.header.setText(theme.toolTitle(theme.bold(`${icon} ${this.toolName}${statusLabel}`)));

    const argLine = formatArgs(this.args);
    this.argsLine.setText(argLine ? theme.dim(argLine) : theme.dim(" "));

    const raw = extractResultText(this.result);
    const text = raw || (this.isPartial ? "…" : "");
    if (!this.expanded && text) {
      const lines = text.split("\n");
      const preview =
        lines.length > PREVIEW_LINES
          ? `${lines.slice(0, PREVIEW_LINES).join("\n")}\n…`
          : text;
      this.output.setText(preview);
    } else {
      this.output.setText(text);
    }
  }
}
