/**
 * /changelog — "Novità": every changelog entry on a timeline grouped by day.
 * Opening the page marks everything as seen (clears the nav dot and banner).
 */
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Megaphone } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { ChangelogTimeline } from "@/components/whats-new/changelog-timeline";
import { markAllChangelogSeen, useChangelogUnreadSnapshot } from "@/hooks/use-whats-new";
import { CHANGELOG } from "@/lib/changelog";

export function ChangelogPage() {
  const navigate = useNavigate();
  // /changelog#<entry-id>: open that entry and its day, and scroll to it
  const { hash } = useLocation();
  const focusId = hash.length > 1 ? safeDecode(hash.slice(1)) : undefined;
  // what arrived since the last visit, read before opening the page marks it all as seen
  const unreadIds = useChangelogUnreadSnapshot(true);

  useEffect(() => {
    markAllChangelogSeen(CHANGELOG);
  }, []);

  return (
    <div className="flex-1 min-h-0 overflow-auto pb-bottom-nav lg:pb-0">
      <div className="mx-auto w-full max-w-3xl">
        {/* Hero */}
        <header className="relative isolate mb-8 overflow-hidden rounded-xl border border-primary/20 bg-card/70 px-5 py-6 sm:px-6">
          <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-br from-primary/12 via-transparent to-transparent" />
          <div aria-hidden className="pointer-events-none absolute -right-20 -top-24 -z-10 h-56 w-56 rounded-pill bg-primary/20 blur-glow" />
          <div className="flex items-center gap-3.5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-inset ring-primary/25">
              <Megaphone className="h-5 w-5" />
            </div>
            <PageHeader className="min-w-0 flex-1" title="Novità" description="Cosa è cambiato di recente, in breve." />
          </div>
        </header>

        <ChangelogTimeline entries={CHANGELOG} unreadIds={unreadIds} focusId={focusId} onAction={(to) => navigate(to)} />
      </div>
    </div>
  );
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
