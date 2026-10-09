/**
 * The What's new bar: a slim strip across the top of the app while there is news the person has
 * not seen. A click opens the What's new drawer; the X sets it all as seen.
 */
import { ChevronRight, Megaphone, X } from "lucide-react";
import { CHANGELOG, type ChangelogEntry } from "@/lib/changelog";
import { markAllChangelogSeen, useUnseenChangelog } from "@/hooks/use-whats-new";
import { openWhatsNew } from "@/hooks/use-whats-new-drawer";
import { cn } from "@/lib/utils";

export function WhatsNewBar({ className, entries = CHANGELOG }: { className?: string; entries?: ChangelogEntry[] }) {
  const unseen = useUnseenChangelog(entries);
  if (unseen.length === 0) return null;
  const newest = unseen.find((e) => e.highlight) ?? unseen[0]!;
  const more = unseen.length - 1;

  return (
    <div
      className={cn(
        "relative isolate flex h-9 shrink-0 items-center gap-2 overflow-hidden border-b border-primary/20 px-3 text-[13px]",
        "bg-gradient-to-r from-primary/15 via-primary/[0.07] to-transparent",
        className,
      )}
    >
      <div aria-hidden className="pointer-events-none absolute -left-10 top-1/2 -z-10 h-24 w-40 -translate-y-1/2 rounded-full bg-primary/25 blur-2xl motion-safe:animate-pulse" />
      <button
        type="button"
        onClick={openWhatsNew}
        className="group flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-none"
        aria-label={`Novità: ${newest.title}${more ? ` e altre ${more}` : ""}. Apri`}
      >
        <span className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary/20 text-primary">
          <Megaphone className="h-3 w-3" />
          <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary motion-safe:animate-ping" />
        </span>
        <span className="hidden shrink-0 rounded-full bg-primary px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-primary-foreground sm:inline">
          Novità
        </span>
        <span className="truncate font-medium text-foreground">{newest.title}</span>
        <span className="hidden truncate text-muted-foreground md:inline">· {newest.summary}</span>
        {more > 0 && (
          <span className="shrink-0 rounded-full border border-primary/30 px-1.5 text-[11px] text-primary">+{more}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-0.5 text-xs font-medium text-primary group-hover:underline">
          Scopri
          <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
      </button>
      <button
        type="button"
        onClick={() => markAllChangelogSeen(entries)}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground"
        aria-label="Nascondi le novità"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
