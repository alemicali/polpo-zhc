import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Reusable section header with icon, title, and optional count badge.
 * Used across agent-detail, task-detail, and other detail pages.
 */
export function SectionHeader({ title, icon: Icon, count, className }: {
  title: string;
  icon: React.ElementType;
  count?: number;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2 mb-3", className)}>
      <Icon className="h-3.5 w-3.5 text-primary" />
      <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{title}</h3>
      {count != null && count > 0 && (
        <Badge variant="secondary" className="text-[9px] ml-1">{count}</Badge>
      )}
    </div>
  );
}
