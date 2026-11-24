/**
 * The chat history's look on each surface it sits on — all tokens, the same row shape as the
 * main navigation (rounded-lg, px-3, hover and active states).
 *
 * - "sidebar": the drill-in sidebar's Chat level (sidebar tokens);
 * - "sheet": the drill-in navigation in the mobile sheet;
 * - "panel": the chat page's own thread column (classic layout, mobile overlay, compact chat).
 */
import { cn } from "@/lib/utils";

export type HistorySurface = "sidebar" | "sheet" | "panel";

export interface HistoryStyles {
  /** a row: shape + idle/hover tone (active adds `active`) */
  row: string;
  rowIdle: string;
  rowActive: string;
  /** a small muted section label */
  label: string;
  /** the opaque background sticky labels need to cover the rows scrolling under them */
  stickyBg: string;
  /** muted text (counts, hints) */
  muted: string;
  /** the search field */
  search: string;
  /** small icon buttons (⋯, +, organize) */
  iconButton: string;
}

const ROW = "relative flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-small outline-none transition-colors duration-200 focus-visible:ring-2";

export function historyStyles(surface: HistorySurface): HistoryStyles {
  if (surface === "sidebar") {
    return {
      row: cn(ROW, "focus-visible:ring-sidebar-ring"),
      rowIdle: "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      rowActive: "bg-sidebar-primary/10 text-sidebar-primary font-medium",
      label: "text-caption font-medium text-sidebar-foreground/50",
      stickyBg: "bg-sidebar",
      muted: "text-sidebar-foreground/50",
      search: "bg-transparent text-sidebar-foreground placeholder:text-sidebar-foreground/50 hover:bg-sidebar-accent focus-within:bg-sidebar-accent",
      iconButton: "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
    };
  }
  return {
    row: cn(ROW, "focus-visible:ring-ring"),
    rowIdle: "text-foreground/80 hover:bg-accent hover:text-accent-foreground",
    rowActive: "bg-primary/10 text-primary font-medium",
    label: "text-caption font-medium text-muted-foreground",
    stickyBg: "bg-background",
    muted: "text-muted-foreground",
    search: "bg-transparent text-foreground placeholder:text-muted-foreground hover:bg-accent focus-within:bg-accent",
    iconButton: "text-muted-foreground hover:bg-accent hover:text-foreground",
  };
}
