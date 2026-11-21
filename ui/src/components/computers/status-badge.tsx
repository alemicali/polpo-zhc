/** A computer's live status as a badge (spinner while it changes). */
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { STATUS_LABELS, statusTone, type Computer } from "@/lib/computers-api";
import { cn } from "@/lib/utils";

const TONE_CLASSES = {
  ok: "border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-400",
  idle: "border-border bg-muted/40 text-muted-foreground",
  busy: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  bad: "border-destructive/30 bg-destructive/10 text-destructive",
} as const;

export function StatusBadge({ computer, className }: { computer: Pick<Computer, "status">; className?: string }) {
  const tone = statusTone(computer.status);
  return (
    <Badge variant="outline" data-testid="computer-status" className={cn("gap-1 font-normal", TONE_CLASSES[tone], className)}>
      {tone === "busy" && <Loader2 className="h-3 w-3 animate-spin" />}
      {STATUS_LABELS[computer.status]}
    </Badge>
  );
}
