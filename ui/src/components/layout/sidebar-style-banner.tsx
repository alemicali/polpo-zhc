/**
 * A small card at the bottom of the sidebar: on the classic sidebar it offers the drill-in one,
 * on the drill-in one it offers the way back. Dismissible (per style); after that the switch stays
 * in Configuration → Appearance and in the header's look menu.
 */
import { ListTree, PanelLeft, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { dismissSidebarStyleBanner, setSidebarStyle, useSidebarStyleState } from "@/hooks/use-sidebar-style";

export function SidebarStyleBanner({ className }: { className?: string }) {
  const { style, dismissed } = useSidebarStyleState();
  if (dismissed.has(style)) return null;
  const classic = style === "classic";

  return (
    <div
      role="region"
      aria-label={classic ? "New sidebar" : "Sidebar style"}
      className={cn(
        "relative flex items-start gap-2 rounded-lg border border-sidebar-border bg-sidebar-accent/40 p-2.5 pr-7 text-sidebar-foreground",
        className,
      )}
    >
      {classic
        ? <ListTree className="mt-0.5 h-4 w-4 shrink-0 text-sidebar-primary" />
        : <PanelLeft className="mt-0.5 h-4 w-4 shrink-0 text-sidebar-foreground/70" />}
      <div className="min-w-0 text-caption leading-snug">
        {classic ? (
          <>
            <p className="font-medium">Try the new sidebar</p>
            <p className="text-sidebar-foreground/60">Pages grouped in levels: Work, Team, Content, Tools, Settings.</p>
            <button
              type="button"
              onClick={() => setSidebarStyle("drill-in")}
              className="mt-1 font-medium text-sidebar-primary underline-offset-2 hover:underline"
            >
              Try it
            </button>
          </>
        ) : (
          <p>
            <span className="text-sidebar-foreground/70">You're using the new sidebar · </span>
            <button
              type="button"
              onClick={() => setSidebarStyle("classic")}
              className="font-medium text-sidebar-primary underline-offset-2 hover:underline"
            >
              Switch back
            </button>
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => dismissSidebarStyleBanner(style)}
        aria-label="Dismiss"
        title="Dismiss (the switch stays in Configuration → Appearance)"
        className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-md text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
