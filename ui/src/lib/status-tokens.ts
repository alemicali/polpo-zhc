import type { MissionStatus, TaskStatus } from "@polpo-ai/react";
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  CircleDashed,
  Clock,
  Eye,
  FileEdit,
  Hammer,
  HelpCircle,
  Loader2,
  Pause,
  Repeat,
  XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// ── Status → design tokens ──
// The one place where task, phase and mission states get their colours. Everything comes from the
// look's tokens (index.css / Configuration → Appearance): done → success, failed → destructive,
// review / awaiting → warning, running → status-running, queued → status-queued,
// assigned → status-assigned. Purely categorical accents (fix / clarification phases, recurring
// missions) use the chart palette.

/** Class names for one tone: text colour, tinted background, border, solid dot / bar, and a raw CSS colour for charts, SVG strokes and inline styles. */
export interface ToneClasses {
  /** text-* */
  color: string;
  /** Tinted background (…/10). */
  bg: string;
  /** Tinted border (…/40), e.g. graph nodes. */
  border: string;
  /** Solid fill for dots / bars. */
  dot: string;
  /** CSS colour (var(--token)) for recharts, SVG and inline styles. */
  css: string;
}

export type Tone =
  | "success"
  | "warning"
  | "info"
  | "destructive"
  | "running"
  | "queued"
  | "assigned"
  | "muted"
  | "primary"
  | "chart-1"
  | "chart-2"
  | "chart-3"
  | "chart-4"
  | "chart-5";

export const tones: Record<Tone, ToneClasses> = {
  success:     { color: "text-success",          bg: "bg-success/10",          border: "border-success/40",          dot: "bg-success",          css: "var(--success)" },
  warning:     { color: "text-warning",          bg: "bg-warning/10",          border: "border-warning/40",          dot: "bg-warning",          css: "var(--warning)" },
  info:        { color: "text-info",             bg: "bg-info/10",             border: "border-info/40",             dot: "bg-info",             css: "var(--info)" },
  destructive: { color: "text-destructive",      bg: "bg-destructive/10",      border: "border-destructive/40",      dot: "bg-destructive",      css: "var(--destructive)" },
  running:     { color: "text-status-running",   bg: "bg-status-running/10",   border: "border-status-running/40",   dot: "bg-status-running",   css: "var(--status-running)" },
  queued:      { color: "text-status-queued",    bg: "bg-status-queued/10",    border: "border-status-queued/40",    dot: "bg-status-queued",    css: "var(--status-queued)" },
  assigned:    { color: "text-status-assigned",  bg: "bg-status-assigned/10",  border: "border-status-assigned/40",  dot: "bg-status-assigned",  css: "var(--status-assigned)" },
  muted:       { color: "text-muted-foreground", bg: "bg-muted-foreground/10", border: "border-muted-foreground/40", dot: "bg-muted-foreground", css: "var(--muted-foreground)" },
  primary:     { color: "text-primary",          bg: "bg-primary/10",          border: "border-primary/40",          dot: "bg-primary",          css: "var(--primary)" },
  "chart-1":   { color: "text-chart-1",          bg: "bg-chart-1/10",          border: "border-chart-1/40",          dot: "bg-chart-1",          css: "var(--chart-1)" },
  "chart-2":   { color: "text-chart-2",          bg: "bg-chart-2/10",          border: "border-chart-2/40",          dot: "bg-chart-2",          css: "var(--chart-2)" },
  "chart-3":   { color: "text-chart-3",          bg: "bg-chart-3/10",          border: "border-chart-3/40",          dot: "bg-chart-3",          css: "var(--chart-3)" },
  "chart-4":   { color: "text-chart-4",          bg: "bg-chart-4/10",          border: "border-chart-4/40",          dot: "bg-chart-4",          css: "var(--chart-4)" },
  "chart-5":   { color: "text-chart-5",          bg: "bg-chart-5/10",          border: "border-chart-5/40",          dot: "bg-chart-5",          css: "var(--chart-5)" },
};

// ── Task status ──

export interface TaskStatusStyle extends ToneClasses {
  tone: Tone;
  icon: LucideIcon;
  label: string;
  /** Compact label (graph nodes, tight badges). */
  short: string;
}

function style<T extends object>(tone: Tone, rest: T): ToneClasses & { tone: Tone } & T {
  return { tone, ...tones[tone], ...rest };
}

export const taskStatusStyles: Record<TaskStatus, TaskStatusStyle> = {
  draft:             style("muted",       { icon: FileEdit,      label: "Draft",             short: "Draft" }),
  pending:           style("queued",      { icon: Clock,         label: "Queued",            short: "Queued" }),
  awaiting_approval: style("warning",     { icon: Clock,         label: "Awaiting Approval", short: "Awaiting" }),
  assigned:          style("assigned",    { icon: Clock,         label: "Assigned",          short: "Assigned" }),
  in_progress:       style("running",     { icon: Loader2,       label: "Running",           short: "Running" }),
  review:            style("warning",     { icon: Eye,           label: "Review",            short: "Review" }),
  done:              style("success",     { icon: CheckCircle2,  label: "Done",              short: "Done" }),
  failed:            style("destructive", { icon: AlertTriangle, label: "Failed",            short: "Failed" }),
};

/**
 * A task a mission decision node left out (its branch was not taken): closed as done without
 * running. Muted and dashed — never the done colour (lib/task-not-reached.ts decides which tasks).
 */
export const taskNotReachedStyle: TaskStatusStyle = style("muted", { icon: CircleDashed, label: "Not reached", short: "Not reached" });

// ── Task phase (execution → review → fix / clarification) ──

export interface TaskPhaseStyle extends ToneClasses {
  tone: Tone;
  icon: LucideIcon;
  /** Progressive label ("Reviewing"). */
  label: string;
  /** Noun label ("Review"). */
  short: string;
}

export const taskPhaseStyles: Record<string, TaskPhaseStyle> = {
  execution:     style("running", { icon: Loader2,    label: "Executing",  short: "Execution" }),
  review:        style("warning", { icon: Eye,        label: "Reviewing",  short: "Review" }),
  fix:           style("chart-2", { icon: Hammer,     label: "Fixing",     short: "Fix" }),
  clarification: style("chart-5", { icon: HelpCircle, label: "Clarifying", short: "Clarifying" }),
};

// ── Mission status ──

export interface MissionStatusStyle extends ToneClasses {
  tone: Tone;
  label: string;
  icon: LucideIcon;
}

export const missionStatusStyles: Record<MissionStatus, MissionStatusStyle> = {
  draft:     style("muted",       { label: "Draft",     icon: Clock }),
  scheduled: style("info",        { label: "Scheduled", icon: Calendar }),
  recurring: style("chart-5",     { label: "Recurring", icon: Repeat }),
  active:    style("running",     { label: "Running",   icon: Loader2 }),
  paused:    style("warning",     { label: "Paused",    icon: Pause }),
  completed: style("success",     { label: "Completed", icon: CheckCircle2 }),
  failed:    style("destructive", { label: "Failed",    icon: AlertTriangle }),
  cancelled: style("muted",       { label: "Cancelled", icon: XCircle }),
};

export interface MissionStatusFilterOption {
  value: MissionStatus;
  label: string;
  color: string;
}

const MISSION_FILTER_ORDER: MissionStatus[] = ["active", "scheduled", "recurring", "paused", "draft", "completed", "failed", "cancelled"];

export const missionStatusFilterOptions: MissionStatusFilterOption[] = MISSION_FILTER_ORDER.map((value) => ({
  value,
  label: missionStatusStyles[value].label,
  color: missionStatusStyles[value].color,
}));

// ── Scores (assessment 0–5 / percentages) ──

/** Tone for a percentage score: ≥ 80 success, ≥ 60 warning, else destructive. */
export function scoreTone(pct: number): Tone {
  return pct >= 80 ? "success" : pct >= 60 ? "warning" : "destructive";
}
