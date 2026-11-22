import { cn } from "@/lib/utils";
import { Eyebrow } from "@/components/shared/eyebrow";

export type StatTone = "default" | "success" | "warning" | "info" | "destructive" | "muted";

const TONE: Record<StatTone, string> = {
  default: "text-foreground",
  success: "text-success",
  warning: "text-warning",
  info: "text-info",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

/**
 * A metric: a label (Eyebrow), the value (text-h1 in the heading font, tabular numbers, coloured by
 * a status tone), and an optional hint under it. For dashboard tiles and summary rows.
 */
export function StatValue({ label, value, hint, tone = "default", icon: Icon, size = "md", className }: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: StatTone;
  icon?: React.ElementType;
  /** md: text-h1; sm: text-h2 (dense rows). */
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div data-slot="stat-value" className={cn("flex min-w-0 flex-col gap-1", className)}>
      <Eyebrow className="flex items-center gap-1.5">
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
        {label}
      </Eyebrow>
      <div className={cn("font-heading tabular-nums", size === "sm" ? "text-h2" : "text-h1", TONE[tone])}>{value}</div>
      {hint && <div className="text-caption text-muted-foreground">{hint}</div>}
    </div>
  );
}
