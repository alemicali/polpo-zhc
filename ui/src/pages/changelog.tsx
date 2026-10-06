/**
 * /changelog — "Novità": every changelog entry on a timeline grouped by day.
 * Opening the page marks everything as seen (clears the nav dot and banner).
 */
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Megaphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MessageResponse } from "@/components/ai-elements/message";
import { ChangelogKindBadge } from "@/components/whats-new/changelog-kind";
import { markAllChangelogSeen } from "@/hooks/use-whats-new";
import { CHANGELOG, formatChangelogDate, groupChangelogByDate } from "@/lib/changelog";
import { cn } from "@/lib/utils";

const DAYS = groupChangelogByDate(CHANGELOG);

export function ChangelogPage() {
  const navigate = useNavigate();

  useEffect(() => {
    markAllChangelogSeen(CHANGELOG);
  }, []);

  return (
    <div className="flex-1 min-h-0 overflow-auto pb-bottom-nav lg:pb-0">
      <div className="mx-auto w-full max-w-3xl">
        {/* Hero */}
        <header className="relative isolate mb-8 overflow-hidden rounded-xl border border-primary/20 bg-card/70 px-5 py-6 sm:px-6">
          <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-br from-primary/12 via-transparent to-transparent" />
          <div aria-hidden className="pointer-events-none absolute -right-20 -top-24 -z-10 h-56 w-56 rounded-full bg-primary/20 blur-3xl" />
          <div className="flex items-center gap-3.5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-inset ring-primary/25">
              <Megaphone className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Novità</h1>
              <p className="mt-0.5 text-sm text-muted-foreground">Cosa è cambiato di recente, in breve.</p>
            </div>
          </div>
        </header>

        {/* Timeline */}
        <ol className="relative space-y-10 pb-8">
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
                      "rounded-xl border bg-card/80 p-4 shadow-sm backdrop-blur-sm sm:p-5",
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
      </div>
    </div>
  );
}
