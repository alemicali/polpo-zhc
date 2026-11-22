import { cn } from "@/lib/utils";
import { Eyebrow } from "@/components/shared/eyebrow";

/**
 * A page's title row: an optional eyebrow, the title (h1, text-h1 in the heading font, weight and
 * tracking of the look), an optional description, and actions on the right. Everything follows
 * Configuration → Appearance → Typography; use it instead of hand-sized <h1>s.
 */
export function PageHeader({ title, description, eyebrow, icon: Icon, actions, className, children }: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** A small label above the title (e.g. the section the page belongs to). */
  eyebrow?: React.ReactNode;
  icon?: React.ElementType;
  /** Right-aligned controls (buttons, filters); they wrap under the title on narrow screens. */
  actions?: React.ReactNode;
  className?: string;
  /** Extra content under the description (tabs, a toolbar…). */
  children?: React.ReactNode;
}) {
  return (
    <header data-slot="page-header" className={cn("flex min-w-0 flex-col gap-3", className)}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          {eyebrow && <Eyebrow className="mb-1">{eyebrow}</Eyebrow>}
          <h1 className="font-heading text-h1 flex min-w-0 items-center gap-2 break-words text-foreground">
            {Icon && <Icon className="h-[1em] w-[1em] shrink-0 text-primary" />}
            <span className="min-w-0">{title}</span>
          </h1>
          {description && <p className="text-body mt-1 max-w-prose text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}
