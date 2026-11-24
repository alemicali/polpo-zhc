/**
 * WhatsNewStack — the latest What's new entries as a small stack of cards at the bottom of the
 * sidebar (and in the mobile navigation drawer).
 *
 * - Unread entries first (with the unread dot), then the most recent; a handful at most.
 * - Called "Novità" (the What's new content is Italian).
 * - The front card shows the kind (a small, quiet badge) and the title; two more peek out behind
 *   it, clearly lower, smaller and fainter at each step (a 3D stack), within the sidebar width. It moves to the next card every few seconds, pauses
 *   while hovered or focused, and moves with ← / → or a swipe.
 * - prefers-reduced-motion: no auto-advance and no animation (the arrows and swipe still work).
 * - A card opens the What's new drawer at that entry.
 * - The icon rail (collapsed sidebar): one icon with the unread dot, opening the drawer.
 * - In the drill-in sidebar it shows on the top level only (the caller decides, see DrillInNav).
 *
 * Every colour, corner and shadow is a token (bg-card, border-border, rounded-card, rounded-badge,
 * shadow-card).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type TouchEvent } from "react";
import { Megaphone } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CHANGELOG, CHANGELOG_KIND_LABEL, type ChangelogEntry } from "@/lib/changelog";
import { useHasUnseenChangelog, useSeenChangelogIds, whatsNewStackEntries } from "@/hooks/use-whats-new";
import { openWhatsNew, openWhatsNewAt } from "@/hooks/use-whats-new-drawer";
import { ChangelogKindIcon } from "./changelog-kind";

/** How long a card stays in front before the next one comes. */
export const WHATS_NEW_STACK_INTERVAL_MS = 6000;
/** How many cards are visible (the front one and those peeking behind it). */
const VISIBLE_DEPTH = 3;
/** A swipe needs this many pixels sideways. */
const SWIPE_PX = 30;
/** The name of the stack (its label, aria-label and tooltip). */
export const WHATS_NEW_STACK_LABEL = "Novità";
/** Each card behind: this much lower (rem), smaller and fainter than the one before it. */
const STEP_OFFSET_REM = 0.7;
const STEP_SCALE = 0.07;
const STEP_OPACITY = 0.22;
const STEP_TILT_DEG = 6;

/** The kind badge: small and quiet (a muted chip, the icon tinted by the kind). */
export const KIND_BADGE_CLASS =
  "inline-flex shrink-0 items-center gap-1 rounded-badge border border-border/60 bg-muted/60 px-1.5 py-px text-micro font-medium leading-none text-muted-foreground";
const KIND_ICON_TONE = {
  new: "text-primary/80",
  improved: "text-success/80",
  fixed: "text-warning/80",
} as const;

function usePrefersReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const read = () => {
    try {
      return typeof window !== "undefined" && !!window.matchMedia?.(query).matches;
    } catch {
      return false;
    }
  };
  const [reduced, setReduced] = useState(read);
  useEffect(() => {
    let list: MediaQueryList | undefined;
    try { list = window.matchMedia?.(query); } catch { list = undefined; }
    if (!list?.addEventListener) return;
    const onChange = () => setReduced(list!.matches);
    list.addEventListener("change", onChange);
    return () => list!.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export interface WhatsNewStackProps {
  /** sidebar: the desktop sidebar; sheet: the mobile navigation drawer. */
  variant?: "sidebar" | "sheet";
  /** The icon rail: a single icon. */
  collapsed?: boolean;
  /** After opening the drawer (the mobile sheet closes). */
  onOpen?: () => void;
  className?: string;
  /** Tests and stories: the entries (the app's changelog by default). */
  entries?: ChangelogEntry[];
  intervalMs?: number;
}

export function WhatsNewStack({
  variant = "sidebar",
  collapsed = false,
  onOpen,
  className,
  entries = CHANGELOG,
  intervalMs = WHATS_NEW_STACK_INTERVAL_MS,
}: WhatsNewStackProps) {
  const seen = useSeenChangelogIds();
  const items = useMemo(() => whatsNewStackEntries(entries, seen), [entries, seen]);
  const hasUnseen = useHasUnseenChangelog(entries);
  const reducedMotion = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const touchX = useRef<number | null>(null);
  const sheet = variant === "sheet";

  // a new order (entries read, a deploy): start again from the front
  const orderKey = items.map((e) => e.id).join("|");
  const [seenOrder, setSeenOrder] = useState(orderKey);
  if (seenOrder !== orderKey) {
    setSeenOrder(orderKey);
    setIndex(0);
  }

  const count = items.length;
  const paused = hovered || focused || reducedMotion || count < 2;
  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % count), intervalMs);
    return () => window.clearInterval(timer);
  }, [paused, count, intervalMs]);

  if (collapsed) {
    return (
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={WHATS_NEW_STACK_LABEL}
            data-testid="whats-new-rail"
            onClick={() => { openWhatsNew(); onOpen?.(); }}
            className={cn(
              "relative flex h-10 w-10 items-center justify-center rounded-lg text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              className,
            )}
          >
            <Megaphone className="h-4 w-4" />
            {hasUnseen && <span aria-label="Unread" role="status" className="absolute right-1.5 top-1.5 h-2 w-2 rounded-pill bg-primary ring-2 ring-sidebar" />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="text-xs font-medium">{WHATS_NEW_STACK_LABEL}</TooltipContent>
      </Tooltip>
    );
  }

  if (count === 0) return null;

  const move = (step: number) => setIndex((i) => (i + step + count) % count);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation(); // not the sidebar's own arrow keys
    move(event.key === "ArrowRight" ? 1 : -1);
  };
  const onTouchStart = (event: TouchEvent<HTMLDivElement>) => { touchX.current = event.touches[0]?.clientX ?? null; };
  const onTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    const start = touchX.current;
    touchX.current = null;
    const end = event.changedTouches[0]?.clientX;
    if (start === null || end === undefined || Math.abs(end - start) < SWIPE_PX) return;
    move(end < start ? 1 : -1);
  };

  const unreadCount = items.filter((e) => !seen.has(e.id)).length;

  return (
    <div
      role="region"
      aria-roledescription="carousel"
      aria-label={WHATS_NEW_STACK_LABEL}
      data-testid="whats-new-stack"
      data-paused={paused ? "true" : "false"}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}
      onKeyDown={onKeyDown}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      className={cn("shrink-0", className)}
    >
      <div className={cn("mb-1 flex items-center gap-1.5 px-1 text-label", sheet ? "text-muted-foreground/70" : "text-sidebar-foreground/50")}>
        <Megaphone aria-hidden className="h-3 w-3" />
        <span className="flex-1">{WHATS_NEW_STACK_LABEL}</span>
        {unreadCount > 0 && <span className="text-primary">{unreadCount} unread</span>}
        {count > 1 && <span aria-hidden className="tabular-nums">{index + 1}/{count}</span>}
      </div>
      {/* the cards: the front one, two more behind it (lower, smaller, fainter) */}
      <div className="relative h-[6.25rem] [perspective:40rem]" aria-live={paused ? "polite" : "off"}>
        {items.map((entry, i) => {
          const depth = (i - index + count) % count;
          const front = depth === 0;
          const shown = depth < VISIBLE_DEPTH;
          const unread = !seen.has(entry.id);
          return (
            <button
              key={entry.id}
              type="button"
              data-depth={depth}
              data-entry={entry.id}
              aria-hidden={front ? undefined : true}
              tabIndex={front ? 0 : -1}
              aria-label={front ? `${CHANGELOG_KIND_LABEL[entry.kind]}: ${entry.title}${unread ? " (unread)" : ""}. Open in ${WHATS_NEW_STACK_LABEL}` : undefined}
              onClick={() => { openWhatsNewAt(entry.id); onOpen?.(); }}
              style={{
                // lower, smaller and tilted away: the cards behind peek out under the front one
                transform: `translateY(${depth * STEP_OFFSET_REM}rem) scale(${1 - depth * STEP_SCALE}) rotateX(${depth * STEP_TILT_DEG}deg)`,
                opacity: shown ? 1 - depth * STEP_OPACITY : 0,
                zIndex: count - depth,
              }}
              className={cn(
                "absolute inset-x-0 top-0 flex h-[4.75rem] origin-bottom flex-col justify-center gap-1.5 overflow-hidden rounded-card border px-3 py-2.5 text-left outline-none",
                "transition-[transform,opacity] duration-500 ease-out motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring",
                sheet ? "border-border/60 bg-card text-card-foreground" : "border-sidebar-border bg-card text-card-foreground",
                front ? "shadow-card hover:bg-accent" : "pointer-events-none",
                !shown && "invisible",
              )}
            >
              {/* behind the front card only the edges show */}
              <span className={cn("flex min-w-0 items-center gap-1.5", !front && "invisible")}>
                <span data-testid="whats-new-stack-kind" className={KIND_BADGE_CLASS}>
                  <ChangelogKindIcon kind={entry.kind} className={cn("h-2.5 w-2.5 shrink-0", KIND_ICON_TONE[entry.kind])} />
                  {CHANGELOG_KIND_LABEL[entry.kind]}
                </span>
                {unread && <span data-testid="whats-new-stack-unread" aria-hidden className="ml-auto h-2 w-2 shrink-0 rounded-pill bg-primary" />}
              </span>
              <span className={cn("line-clamp-2 text-caption font-medium leading-normal", !front && "invisible")}>{entry.title}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
