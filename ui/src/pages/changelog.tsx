/**
 * /changelog — "Novità": every changelog entry on a timeline grouped by day.
 * Opening the page marks everything as seen (clears the nav dot and banner).
 */
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Megaphone } from "lucide-react";
import { ChangelogTimeline } from "@/components/whats-new/changelog-timeline";
import { markAllChangelogSeen } from "@/hooks/use-whats-new";
import { CHANGELOG } from "@/lib/changelog";


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

        <ChangelogTimeline entries={CHANGELOG} onAction={(to) => navigate(to)} />
      </div>
    </div>
  );
}
