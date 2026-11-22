/** A computer's live status as a badge (spinner while it changes). */
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { STATUS_LABELS, statusTone, type Computer } from "@/lib/computers-api";
import { cn } from "@/lib/utils";

const TONE_CLASSES = {
  ok: "border-success/30 bg-success/10 text-success",
  idle: "border-border bg-muted/40 text-muted-foreground",
  busy: "border-warning/30 bg-warning/10 text-warning",
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
