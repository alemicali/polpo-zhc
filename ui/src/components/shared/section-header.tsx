import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Reusable section header with icon, title, and optional count badge.
 * Used across agent-detail, task-detail, and other detail pages.
 *
 * The title is a label (text-label: caption size, semibold, the look's label case and tracking),
 * so it follows Configuration → Appearance → Typography.
 */
export function SectionHeader({ title, icon: Icon, count, actions, className }: {
  title: React.ReactNode;
  icon?: React.ElementType;
  count?: number;
  /** Right-aligned controls (buttons, filters). */
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1", className)}>
      {Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-primary" />}
      <h3 className="text-label min-w-0 break-words text-muted-foreground">{title}</h3>
      {count != null && count > 0 && (
        <Badge variant="secondary" className="ml-1 shrink-0 text-micro">{count}</Badge>
      )}
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
