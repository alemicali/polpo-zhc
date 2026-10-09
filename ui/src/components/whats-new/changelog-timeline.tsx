/**
 * The changelog as a timeline grouped by day: the Novità page and the What's new drawer.
 */
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MessageResponse } from "@/components/ai-elements/message";
import { ChangelogKindBadge } from "@/components/whats-new/changelog-kind";
import { formatChangelogDate, groupChangelogByDate, type ChangelogEntry } from "@/lib/changelog";
import { cn } from "@/lib/utils";

export function ChangelogTimeline({
  entries,
  onAction,
  compact = false,
}: {
  entries: ChangelogEntry[];
  /** An entry's button was pressed: go where it leads. */
  onAction: (to: string) => void;
  /** Tighter spacing, for the drawer. */
  compact?: boolean;
}) {
  const DAYS = groupChangelogByDate(entries);
  const navigate = onAction;
  return (
    <ol className={cn("relative pb-8", compact ? "space-y-7" : "space-y-10")}>
      {DAYS.map((day, dayIndex) => (
        <li key={day.date} className="relative pl-7 sm:pl-9">
          {/* Rail */}
          <span
            aria-hidden
            className={cn(
              "absolute left-[7px] top-2 w-px bg-border sm:left-[11px]",
              dayIndex === DAYS.length - 1 ? "h-[calc(100%-0.5rem)] bg-gradient-to-b from-border to-transparent" : "-bottom-10",
            )}
          />
          <span
            aria-hidden
            className={cn(
              "absolute left-0 top-1 flex h-[15px] w-[15px] items-center justify-center rounded-full border-2 sm:left-1",
              dayIndex === 0 ? "border-primary bg-primary/20" : "border-border bg-background",
            )}
          >
            {dayIndex === 0 && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
          </span>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <time dateTime={day.date}>{formatChangelogDate(day.date)}</time>
          </h2>

          <div className="space-y-3">
            {day.entries.map((entry) => (
              <article
                key={entry.id}
                id={entry.id}
                className={cn(
                  compact ? "rounded-xl border bg-card/80 p-3.5 shadow-sm" : "rounded-xl border bg-card/80 p-4 shadow-sm backdrop-blur-sm sm:p-5",
                  entry.highlight ? "border-primary/25" : "border-border/60",
                )}
              >
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <ChangelogKindBadge kind={entry.kind} />
                </div>
                <h3 className="text-base font-semibold leading-snug tracking-tight">{entry.title}</h3>
                <div className="mt-2 text-sm leading-relaxed text-foreground/90">
                  <MessageResponse mode="static">{entry.body}</MessageResponse>
                </div>
                {entry.cta && (
                  <Button
                    type="button"
                    size="sm"
                    className="mt-4 h-8 gap-1.5"
                    onClick={() => navigate(entry.cta!.to)}
                  >
                    {entry.cta.label}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Button>
                )}
              </article>
            ))}
          </div>
        </li>
      ))}
    </ol>
  );
}
