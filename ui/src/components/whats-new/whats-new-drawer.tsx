/**
 * The What's new drawer: the changelog in a panel anchored to the right edge, over any page.
 * Opening it sets everything as seen (the top bar and the nav dot go away).
 */
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Megaphone } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CHANGELOG } from "@/lib/changelog";
import { markAllChangelogSeen } from "@/hooks/use-whats-new";
import { closeWhatsNew, setWhatsNewOpen, useWhatsNewOpen } from "@/hooks/use-whats-new-drawer";
import { ChangelogTimeline } from "./changelog-timeline";

export function WhatsNewDrawer() {
  const open = useWhatsNewOpen();
  const navigate = useNavigate();

  useEffect(() => {
    if (open) markAllChangelogSeen(CHANGELOG);
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={setWhatsNewOpen}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[440px]">
        <SheetHeader className="relative isolate shrink-0 overflow-hidden border-b border-primary/15 px-5 py-4 text-left">
          <div aria-hidden className="pointer-events-none absolute -right-16 -top-20 -z-10 h-44 w-44 rounded-full bg-primary/20 blur-3xl" />
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-inset ring-primary/25">
              <Megaphone className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <SheetTitle className="text-base">Novità</SheetTitle>
              <SheetDescription className="text-xs">Cosa è cambiato di recente, in breve.</SheetDescription>
            </div>
          </div>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-5">
          <ChangelogTimeline
            compact
            entries={CHANGELOG}
            onAction={(to) => {
              closeWhatsNew();
              navigate(to);
            }}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
