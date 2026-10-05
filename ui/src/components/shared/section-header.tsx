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
    <div className={cn("mb-3 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1", className)}>
      <Icon className="h-3.5 w-3.5 shrink-0 text-primary" />
      <h3 className="min-w-0 break-words text-xs font-semibold uppercase tracking-wider text-muted-foreground sm:tracking-widest">{title}</h3>
      {count != null && count > 0 && (
        <Badge variant="secondary" className="ml-1 shrink-0 text-[9px]">{count}</Badge>
      )}
    </div>
  );
}
