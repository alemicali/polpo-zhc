/** A computer's live status as a badge (spinner while it changes; a pulsing dot while it runs, with `live`). */
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { STATUS_LABELS, STATUS_SHORT_LABELS, statusTone, type Computer } from "@/lib/computers-api";
import { cn } from "@/lib/utils";

const TONE_CLASSES = {
  ok: "border-success/30 bg-success/10 text-success",
  idle: "border-border bg-muted/40 text-muted-foreground",
  busy: "border-warning/30 bg-warning/10 text-warning",
  bad: "border-destructive/30 bg-destructive/10 text-destructive",
} as const;

export function StatusBadge({ computer, className, live = false, short = false }: {
  computer: Pick<Computer, "status">;
  className?: string;
  /** A pulsing dot while it runs (the list). */
  live?: boolean;
  /** The short label ("Hibernated"), with the long one as a tooltip. */
  short?: boolean;
}) {
  const tone = statusTone(computer.status);
  return (
    <Badge variant="outline" data-testid="computer-status" title={short ? STATUS_LABELS[computer.status] : undefined}
      className={cn("gap-1 font-normal", TONE_CLASSES[tone], className)}>
      {tone === "busy" && <Loader2 className="h-3 w-3 animate-spin" />}
      {live && computer.status === "running" && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-pill bg-success" aria-hidden />}
      {(short ? STATUS_SHORT_LABELS : STATUS_LABELS)[computer.status]}
    </Badge>
  );
}
