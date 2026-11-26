/**
 * "Beta" — a small, muted pill next to a page still in beta (Artifacts), wherever its entry or
 * title appears: both sidebars, the chat-first tabs, the mobile drawer, the header and the page.
 */
import { cn } from "@/lib/utils";

export function BetaBadge({ className }: { className?: string }) {
  return (
    <span
      data-testid="beta-badge"
      className={cn(
        "inline-flex shrink-0 items-center rounded-badge border border-info/25 bg-info/10 px-1.5 py-px text-micro font-medium leading-none text-info",
        className,
      )}
    >
      Beta
    </span>
  );
}
