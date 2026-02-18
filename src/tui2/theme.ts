import chalk from "chalk";
import type { MarkdownTheme, EditorTheme, SelectListTheme } from "@mariozechner/pi-tui";

// === Polpo Color Palette ===
const ACCENT = chalk.hex("#8B8FD4"); // Polpo light purple
const ACCENT_SOFT = chalk.hex("#6B6FA4"); // Softer purple
const PRIMARY = chalk.hex("#3B3E73"); // Polpo dark purple
const SUCCESS = chalk.green;
const ERROR = chalk.red;
const WARNING = chalk.yellow;
const INFO = chalk.cyan;

// === Theme Functions ===
export const theme = {
  // Text styles
  bold: (s: string) => chalk.bold(s),
  dim: (s: string) => chalk.dim(s),
  italic: (s: string) => chalk.italic(s),
  underline: (s: string) => chalk.underline(s),

  // Semantic colors
  accent: (s: string) => ACCENT(s),
  accentSoft: (s: string) => ACCENT_SOFT(s),
  primary: (s: string) => PRIMARY(s),
  success: (s: string) => SUCCESS(s),
  error: (s: string) => ERROR(s),
  warning: (s: string) => WARNING(s),
  info: (s: string) => INFO(s),

  // Component-specific
  header: (s: string) => chalk.bold(ACCENT(s)),
  footer: (s: string) => chalk.dim(s),
  system: (s: string) => chalk.dim.italic(s),

  // User messages - light purple background bubble
  userBg: (line: string) => chalk.bgHex("#2A2D50")(line),
  userText: (line: string) => chalk.hex("#E0E0FF")(line),

  // Assistant messages - no background, terminal default contrast
  assistantText: (line: string) => line,

  // Tool execution states
  toolPendingBg: (line: string) => chalk.bgHex("#1A1A2E")(line),
  toolSuccessBg: (line: string) => chalk.bgHex("#1A2E1A")(line),
  toolErrorBg: (line: string) => chalk.bgHex("#2E1A1A")(line),
  toolTitle: (s: string) => chalk.bold(s),
  toolOutput: (line: string) => chalk.dim(line),

  // Status colors
  pending: (s: string) => chalk.gray(s),
  assigned: (s: string) => chalk.blue(s),
  inProgress: (s: string) => chalk.yellow(s),
  review: (s: string) => chalk.magenta(s),
  done: (s: string) => chalk.green(s),
  failed: (s: string) => chalk.red(s),
  awaitingApproval: (s: string) => chalk.cyan(s),

  // Input mode colors
  chatMode: (s: string) => chalk.magenta(s),
  planMode: (s: string) => chalk.yellow(s),
  taskMode: (s: string) => chalk.blue(s),
};

// === pi-tui Markdown Theme ===
export const markdownTheme: MarkdownTheme = {
  heading: (s) => chalk.bold(ACCENT(s)),
  link: (s) => chalk.cyan.underline(s),
  linkUrl: (s) => chalk.dim(s),
  code: (s) => chalk.bgHex("#1A1A2E")(chalk.hex("#E0E0FF")(s)),
  codeBlock: (s) => chalk.hex("#C0C0E0")(s),
  codeBlockBorder: (s) => chalk.dim(s),
  quote: (s) => chalk.italic(chalk.dim(s)),
  quoteBorder: (s) => chalk.dim(s),
  hr: (s) => chalk.dim(s),
  listBullet: (s) => ACCENT(s),
  bold: (s) => chalk.bold(s),
  italic: (s) => chalk.italic(s),
  strikethrough: (s) => chalk.strikethrough(s),
  underline: (s) => chalk.underline(s),
};

// === pi-tui SelectList Theme ===
export const selectListTheme: SelectListTheme = {
  selectedPrefix: (s) => ACCENT(s),
  selectedText: (s) => chalk.bold(s),
  description: (s) => chalk.dim(s),
  scrollInfo: (s) => chalk.dim(s),
  noMatch: (s) => chalk.dim.italic(s),
};

// === pi-tui Editor Theme ===
export const editorTheme: EditorTheme = {
  borderColor: (s) => chalk.dim(s),
  selectList: selectListTheme,
};

// === Status Icons & Colors ===
export const STATUS_ICONS: Record<string, string> = {
  pending: "\u25CB",
  awaiting_approval: "\u25CE",
  assigned: "\u25C9",
  in_progress: "\u25CF",
  review: "\u25C8",
  done: "\u2713",
  failed: "\u2717",
};

export const STATUS_COLORS: Record<string, (s: string) => string> = {
  pending: theme.pending,
  awaiting_approval: theme.awaitingApproval,
  assigned: theme.assigned,
  in_progress: theme.inProgress,
  review: theme.review,
  done: theme.done,
  failed: theme.failed,
};

export function statusIcon(status: string): string {
  return STATUS_ICONS[status] ?? "?";
}

export function statusColor(status: string): (s: string) => string {
  return STATUS_COLORS[status] ?? theme.dim;
}
