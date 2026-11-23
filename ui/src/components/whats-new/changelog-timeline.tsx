/**
 * The changelog as a timeline grouped by day: the Novità page and the What's new drawer.
 *
 * Each day is a collapsible group whose header stays pinned while its entries scroll; each entry is
 * one row (kind, title, time, unread dot) that expands to its summary, details and button.
 */
import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { ArrowRight, ChevronDown, ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MessageResponse } from "@/components/ai-elements/message";
import { ChangelogKindBadge, ChangelogKindDot } from "@/components/whats-new/changelog-kind";
import { changelogPublishedAtMap } from "@/hooks/use-whats-new";
import { useChangelogAccordion } from "@/hooks/use-changelog-accordion";
import {
  changelogPublishedAt,
  formatChangelogDateTime,
  formatChangelogDayLong,
  formatChangelogTime,
  groupChangelogByDate,
  type ChangelogEntry,
  type ChangelogPublishedAt,
} from "@/lib/changelog";
import { cn } from "@/lib/utils";

/** Height animation for a collapsible panel (grid rows 0fr ↔ 1fr), off with reduced motion. */
const COLLAPSIBLE = "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none";

export function ChangelogTimeline({
  entries,
  onAction,
  compact = false,
  publishedAt: publishedAtProp,
  unreadIds,
  focusId,
}: {
  entries: ChangelogEntry[];
  /** An entry's button was pressed: go where it leads. */
  onAction: (to: string) => void;
  /** Tighter spacing, for the drawer. */
  compact?: boolean;
  /** When each entry went online on this instance (from runtime-config.js by default). */
  publishedAt?: ChangelogPublishedAt;
  /** Entries that arrived since the person's last visit: marked "Non letta". */
  unreadIds?: ReadonlySet<string>;
  /** Open this entry (and its day) and scroll to it: the page's #<entry-id>. */
  focusId?: string;
}) {
  const publishedAt = useMemo(() => publishedAtProp ?? changelogPublishedAtMap(), [publishedAtProp]);
  const days = useMemo(() => groupChangelogByDate(entries, publishedAt), [entries, publishedAt]);
  const accordion = useChangelogAccordion(days, focusId);
  const listRef = useRef<HTMLOListElement>(null);

  // deep link: bring the entry into view once its day and details are open
  useEffect(() => {
    if (!focusId) return;
    const target = document.getElementById(focusId);
    if (!target || !listRef.current?.contains(target)) return;
    target.scrollIntoView?.({ block: "start" });
    target.querySelector<HTMLButtonElement>("[data-changelog-trigger]")?.focus({ preventScroll: true });
  }, [focusId]);

  // ↑ ↓ Home End move between the visible rows and day headers (Enter / Space toggle: native buttons)
  const onKeyDown = (event: KeyboardEvent<HTMLOListElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const triggers = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-changelog-trigger]") ?? [])]
      .filter((el) => !el.closest("[inert]"));
    const index = triggers.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0
      : event.key === "End" ? triggers.length - 1
      : event.key === "ArrowDown" ? Math.min(index + 1, triggers.length - 1)
      : Math.max(index - 1, 0);
    triggers[next]?.focus();
  };

  return (
    <div className="pb-8">
      <div className="mb-2 flex items-center justify-end gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
          disabled={accordion.allExpanded}
          onClick={accordion.expandAll}
        >
          <ChevronsUpDown className="h-3.5 w-3.5" />
          Espandi tutto
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
          disabled={accordion.noneExpanded}
          onClick={accordion.collapseAll}
        >
          <ChevronsDownUp className="h-3.5 w-3.5" />
          Comprimi tutto
        </Button>
      </div>

      <ol ref={listRef} onKeyDown={onKeyDown} className={cn(compact ? "space-y-2" : "space-y-3")}>
        {days.map((day, dayIndex) => {
          const open = accordion.isDayOpen(day.date);
          const unread = day.entries.filter((entry) => unreadIds?.has(entry.id)).length;
          const panelId = `changelog-day-${day.date}`;
          return (
            <li key={day.date} className="relative" data-changelog-day={day.date}>
              <h2 className="sticky top-0 z-10 -mx-1 bg-background/95 px-1 py-1 backdrop-blur-surface supports-[backdrop-filter]:bg-background/80">
                <button
                  type="button"
                  data-changelog-trigger
                  aria-expanded={open}
                  aria-controls={panelId}
                  onClick={() => accordion.toggleDay(day.date)}
                  className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded-pill border-2",
                      dayIndex === 0 ? "border-primary bg-primary/20" : "border-border bg-background",
                    )}
                  >
                    {dayIndex === 0 && <span className="h-1.5 w-1.5 rounded-pill bg-primary" />}
                  </span>
                  <time dateTime={day.date} className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">
                    {formatChangelogDayLong(day.date)}
                  </time>
                  {unread > 0 && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-pill bg-primary/15 px-1.5 py-px text-micro font-semibold text-primary">
                      <span aria-hidden className="h-1.5 w-1.5 rounded-pill bg-primary" />
                      {unread === 1 ? "1 non letta" : `${unread} non lette`}
                    </span>
                  )}
                  <span className="shrink-0 text-caption tabular-nums text-muted-foreground">{day.entries.length} novità</span>
                  <ChevronDown
                    aria-hidden
                    className={cn(
                      "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
                      open && "rotate-180",
                    )}
                  />
                </button>
              </h2>

              <div
                id={panelId}
                inert={!open}
                className={cn(COLLAPSIBLE, open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}
              >
                <div className="min-h-0 overflow-hidden">
                  <ol className="relative ml-4 space-y-2 border-l border-border/70 pb-2 pl-4 pt-1">
                    {day.entries.map((entry) => (
                      <ChangelogRow
                        key={entry.id}
                        entry={entry}
                        compact={compact}
                        online={changelogPublishedAt(entry, publishedAt)}
                        unread={unreadIds?.has(entry.id) ?? false}
                        open={accordion.isEntryOpen(entry.id)}
                        mounted={accordion.isEntryMounted(entry.id)}
                        onToggle={() => accordion.toggleEntry(entry.id)}
                        onAction={onAction}
                      />
                    ))}
                  </ol>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ChangelogRow({
  entry,
  compact,
  online,
  unread,
  open,
  mounted,
  onToggle,
  onAction,
}: {
  entry: ChangelogEntry;
  compact: boolean;
  online: Date | undefined;
  unread: boolean;
  open: boolean;
  mounted: boolean;
  onToggle: () => void;
  onAction: (to: string) => void;
}) {
  const triggerId = `${entry.id}-trigger`;
  const panelId = `${entry.id}-panel`;
  return (
    <li className="relative">
      <ChangelogKindDot kind={entry.kind} className="absolute -left-[21.5px] top-[15px]" />
      <article
        id={entry.id}
        className={cn(
          "scroll-mt-14 rounded-card border bg-card/80 shadow-card transition-colors",
          unread ? "border-primary/30 bg-primary/5" : entry.highlight ? "border-primary/20" : "border-border/60",
        )}
      >
        <h3>
          <button
            id={triggerId}
            type="button"
            data-changelog-trigger
            aria-expanded={open}
            aria-controls={panelId}
            onClick={onToggle}
            className={cn(
              "flex w-full items-center gap-2 rounded-card text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              compact ? "px-3 py-2" : "px-3.5 py-2.5",
            )}
          >
            <ChangelogKindBadge kind={entry.kind} className="shrink-0" />
            <span className={cn("min-w-0 flex-1 text-sm leading-snug", unread ? "font-semibold" : "font-medium")}>
              {entry.title}
            </span>
            {unread && (
              <span className="shrink-0" title="Non letta">
                <span aria-hidden className="block h-2 w-2 rounded-pill bg-primary" />
                <span className="sr-only">Non letta</span>
              </span>
            )}
            {online && (
              <time
                dateTime={online.toISOString()}
                title={`Online su questa istanza: ${formatChangelogDateTime(online)}`}
                className="shrink-0 text-caption tabular-nums text-muted-foreground"
              >
                {formatChangelogTime(online)}
              </time>
            )}
            <ChevronDown
              aria-hidden
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
                open && "rotate-180",
              )}
            />
          </button>
        </h3>
        <div
          id={panelId}
          role="region"
          aria-labelledby={triggerId}
          inert={!open}
          className={cn(COLLAPSIBLE, open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}
        >
          <div className="min-h-0 overflow-hidden">
            {mounted && (
              <div className={cn("border-t border-border/50", compact ? "px-3 pb-3.5 pt-2.5" : "px-3.5 pb-4 pt-3")}>
                {entry.summary && <p className="text-sm font-medium leading-relaxed text-foreground">{entry.summary}</p>}
                {entry.body && (
                  <div className="mt-2 text-sm leading-relaxed text-foreground/90">
                    <MessageResponse mode="static">{entry.body}</MessageResponse>
                  </div>
                )}
                {(entry.cta || online) && (
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    {entry.cta && (
                      <Button type="button" size="sm" className="h-8 gap-1.5" onClick={() => onAction(entry.cta!.to)}>
                        {entry.cta.label}
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {online && (
                      <span className="ml-auto text-caption tabular-nums text-muted-foreground">
                        Online il {formatChangelogDateTime(online)}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </article>
    </li>
  );
}
