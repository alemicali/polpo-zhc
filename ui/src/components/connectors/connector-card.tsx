/**
 * The two shapes every connector takes on the Connectors page, shared by the catalog (Browse), the
 * connected list, the ready-made hosted connectors and the hosted servers so they look the same:
 *
 * - ConnectorCard: a catalog card — icon, name, a subtitle (category…), the status pill, two lines
 *   of description, optional details, and a footer of badges and actions (h-7 buttons, the main one last);
 * - ConnectorListRow: a list row — icon, name with its badges, a one-line summary, the status pill
 *   and the "Manage" gear that opens the item's detail sheet.
 */
import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ConnectorCard({
  testId, icon, title, subtitle, status, description, children, footer, className,
}: {
  testId?: string;
  icon: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** The status pill (StateBadge, HostedStatusPill). */
  status?: React.ReactNode;
  description?: React.ReactNode;
  /** Extra lines between the description and the footer. */
  children?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <div data-slot="connector-card" data-testid={testId} className={cn("flex flex-col gap-3 rounded-card border bg-card p-4 transition-colors hover:border-foreground/20", className)}>
      <div className="flex items-start gap-3">
        {icon}
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium leading-tight">{title}</p>
          {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {status}
      </div>
      {description && <p className="line-clamp-2 min-h-[2.5rem] text-sm text-muted-foreground">{description}</p>}
      {children}
      {footer && <div className="mt-auto flex flex-wrap items-center gap-1.5">{footer}</div>}
    </div>
  );
}

export function ConnectorListRow({
  testId, icon, title, badges, summary, status, actions, onOpen, manageLabel,
}: {
  testId?: string;
  icon: React.ReactNode;
  title: React.ReactNode;
  /** Next to the name: account, "Hosted by …", "Custom", visibility… */
  badges?: React.ReactNode;
  summary?: React.ReactNode;
  /** The status pill (shown from sm up). */
  status?: React.ReactNode;
  /** Buttons before the gear (e.g. "Sign in"). */
  actions?: React.ReactNode;
  /** Opens the detail sheet (the row's text and the gear). */
  onOpen: () => void;
  manageLabel: string;
}) {
  return (
    <div data-slot="connector-row" data-testid={testId} className="flex items-center gap-3 rounded-card border bg-card px-3 py-3 sm:px-4">
      {icon}
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium">{title}</span>
          {badges}
        </span>
        {summary && <span className="block truncate text-xs text-muted-foreground">{summary}</span>}
      </button>
      {status && <span className="hidden sm:inline-flex">{status}</span>}
      {actions}
      {/* always reachable: the sheet has every action */}
      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onOpen} aria-label={manageLabel}>
        <Settings2 className="h-4 w-4" />
      </Button>
    </div>
  );
}
