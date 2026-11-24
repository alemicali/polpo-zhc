/**
 * Where the search palette opens from: a search field at the top of the sidebar (above Dashboard,
 * both sidebar styles), a search icon in the collapsed rail, and one in the mobile header.
 */
import { Search } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { openSearchPalette, searchShortcutLabel } from "@/hooks/use-search-palette";
import { cn } from "@/lib/utils";
import { Kbd } from "./search-parts";

export function SidebarSearchButton({ collapsed, className }: { collapsed?: boolean; className?: string }) {
  const shortcut = searchShortcutLabel();
  if (collapsed) {
    return (
      <div className={cn("flex shrink-0 justify-center pt-3", className)}>
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => openSearchPalette()}
              className="flex h-10 w-10 items-center justify-center rounded-lg text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              aria-label={`Search (${shortcut})`}
            >
              <Search className="h-[18px] w-[18px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="text-xs font-medium">Search <span className="ml-1 opacity-70">{shortcut}</span></TooltipContent>
        </Tooltip>
      </div>
    );
  }
  return (
    <div className={cn("shrink-0 px-3 pt-3", className)}>
      <button
        type="button"
        onClick={() => openSearchPalette()}
        className="flex h-9 w-full items-center gap-2.5 rounded-control border border-sidebar-border bg-sidebar-accent/40 px-3 text-small text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        aria-label={`Search (${shortcut})`}
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="flex-1 truncate text-left">Search…</span>
        <Kbd className="border-sidebar-border bg-sidebar">{shortcut}</Kbd>
      </button>
    </div>
  );
}

/** The search icon of the mobile header (the palette opens full screen). */
export function MobileSearchButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => openSearchPalette()}
      className={cn("inline-flex h-9 w-9 items-center justify-center rounded-lg text-foreground hover:bg-accent/50", className)}
      aria-label="Search"
    >
      <Search className="h-5 w-5" />
    </button>
  );
}
