/**
 * Small pieces of the search palette: matched text, the icon of each kind of result, status
 * badges and the keyboard hints. Colours, sizes and corners come from the look's tokens.
 */
import { createElement, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { SearchRange } from "@polpo-ai/react";
import { iconFor, type ResultKind } from "./search-icons";
import { cn } from "@/lib/utils";
import { missionStatusStyles, taskStatusStyles, tones, type Tone } from "@/lib/status-tokens";

/** Text with its matched ranges marked. */
export function Highlighted({ text, ranges, className }: { text: string; ranges?: SearchRange[]; className?: string }) {
  if (!ranges?.length) return <span className={className}>{text}</span>;
  const parts: ReactNode[] = [];
  let at = 0;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  sorted.forEach(([a, b], i) => {
    if (a < at || a >= text.length) return;
    if (a > at) parts.push(text.slice(at, a));
    parts.push(<mark key={i} className="rounded-xs bg-primary/15 px-px text-foreground">{text.slice(a, Math.min(b, text.length))}</mark>);
    at = Math.min(b, text.length);
  });
  if (at < text.length) parts.push(text.slice(at));
  return <span className={className}>{parts}</span>;
}

/** The icon of a result's kind (or the one given), as an element. */
export function KindIcon({ kind, meta, icon, className }: { kind: ResultKind; meta?: Record<string, unknown>; icon?: LucideIcon; className?: string }) {
  return createElement(icon ?? iconFor(kind, meta), { className });
}

/** A task's or mission's status as a small tinted badge (other kinds: a neutral one). */
export function StatusBadge({ kind, status }: { kind: string; status: unknown }) {
  if (typeof status !== "string" || !status) return null;
  const style = kind === "task"
    ? taskStatusStyles[status as keyof typeof taskStatusStyles]
    : kind === "mission" ? missionStatusStyles[status as keyof typeof missionStatusStyles] : undefined;
  const tone = style ?? tones[(["disabled", "paused"].includes(status) ? "warning" : ["enabled", "active", "running", "connected"].includes(status) ? "success" : "muted") as Tone];
  const label = style?.label ?? status.replace(/_/g, " ");
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-badge px-1.5 py-px text-micro font-medium", tone.bg, tone.color)}>
      <span className={cn("h-1.5 w-1.5 rounded-pill", tone.dot)} />
      {label}
    </span>
  );
}

/** A key as shown in hints (↵, Esc, Tab). */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-border bg-muted px-1 font-mono text-micro text-muted-foreground", className)}>
      {children}
    </kbd>
  );
}
