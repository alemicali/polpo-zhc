/**
 * "What's new" banner — the newest highlighted changelog entry the person has
 * not seen yet, with a CTA and a link to /changelog. Several unseen highlights
 * can be stepped through. Dismissing (X) marks the highlights as seen.
 *
 * Shown at the top of the Dashboard and in the empty chat, never inside a
 * conversation. Renders nothing once everything is seen.
 */
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CHANGELOG, formatChangelogDate, type ChangelogEntry } from "@/lib/changelog";
import { markChangelogSeen, useUnseenHighlights } from "@/hooks/use-whats-new";
import { cn } from "@/lib/utils";
import { ChangelogKindIcon } from "./changelog-kind";

export function WhatsNewBanner({ className, entries = CHANGELOG }: {
  className?: string;
  /** Defaults to the app changelog (overridable for tests). */
  entries?: ChangelogEntry[];
}) {
  const highlights = useUnseenHighlights(entries);
  const navigate = useNavigate();
  const [index, setIndex] = useState(0);

  if (highlights.length === 0) return null;
  const current = Math.min(index, highlights.length - 1);
  const entry = highlights[current];
  const many = highlights.length > 1;

  const step = (delta: number) => setIndex((current + delta + highlights.length) % highlights.length);
  const dismiss = () => markChangelogSeen(highlights.map((e) => e.id));
  const openCta = () => {
    if (!entry.cta) return;
    markChangelogSeen([entry.id]);
    navigate(entry.cta.to);
  };

  return (
    <section
      aria-label="Novità"
      aria-roledescription="carousel"
      className={cn(
        "relative isolate overflow-hidden rounded-xl border border-primary/25 bg-card/80 p-4 text-left shadow-sm backdrop-blur-sm glow-cyan sm:p-5",
        className,
      )}
    >
      {/* Brand wash, a slow glow and a hairline accent on top. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-br from-primary/15 via-primary/[0.04] to-transparent" />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-20 -z-10 h-52 w-52 rounded-full bg-primary/25 blur-3xl animate-pulse [animation-duration:5s] motion-reduce:animate-none"
      />
      <div aria-hidden className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-primary/70 to-transparent" />

      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={dismiss}
        aria-label="Chiudi le novità"
        title="Chiudi"
        className="absolute right-2 top-2 h-7 w-7 rounded-full text-muted-foreground hover:bg-background/60 hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </Button>

      <div key={entry.id} className="flex items-start gap-3.5 animate-in fade-in-0 slide-in-from-right-2 duration-300 motion-reduce:animate-none">
        <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-inset ring-primary/25">
          <ChangelogKindIcon kind={entry.kind} className="h-5 w-5" />
          <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60 motion-reduce:hidden" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-card" />
          </span>
        </div>

        <div className="min-w-0 flex-1 pr-6">
          <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="inline-flex items-center rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary-foreground">
              Novità
            </span>
            <span className="text-[11px] text-muted-foreground">{formatChangelogDate(entry.date)}</span>
          </div>
          <h3 className="text-[15px] font-semibold leading-snug tracking-tight text-foreground">{entry.title}</h3>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{entry.summary}</p>

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            {entry.cta && (
              <Button type="button" size="sm" className="h-8 gap-1.5" onClick={openCta}>
                {entry.cta.label}
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            )}
            <Link
              to="/changelog"
              className="text-xs font-medium text-primary underline-offset-4 transition-colors hover:underline"
            >
              Tutte le novità
            </Link>

            {many && (
              <div className="ml-auto flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 rounded-full text-muted-foreground hover:text-foreground"
                  onClick={() => step(-1)}
                  aria-label="Novità precedente"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <div className="flex items-center gap-1">
                  {highlights.map((h, i) => (
                    <button
                      key={h.id}
                      type="button"
                      onClick={() => setIndex(i)}
                      aria-label={`Novità ${i + 1} di ${highlights.length}`}
                      aria-current={i === current ? "true" : undefined}
                      className={cn(
                        "h-1.5 rounded-full transition-all",
                        i === current ? "w-4 bg-primary" : "w-1.5 bg-muted-foreground/30 hover:bg-muted-foreground/50",
                      )}
                    />
                  ))}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 rounded-full text-muted-foreground hover:text-foreground"
                  onClick={() => step(1)}
                  aria-label="Novità successiva"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
