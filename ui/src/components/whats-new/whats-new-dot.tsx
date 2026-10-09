/**
 * Small dot shown next to the "Novità" nav entries while something is unseen.
 */
import { useHasUnseenChangelog } from "@/hooks/use-whats-new";
import { cn } from "@/lib/utils";

export function WhatsNewDot({ className }: { className?: string }) {
  const unseen = useHasUnseenChangelog();
  if (!unseen) return null;
  return (
    <span
      className={cn("h-2 w-2 shrink-0 rounded-full bg-primary ring-2 ring-background bio-pulse", className)}
      aria-label="Novità da leggere"
      role="status"
    />
  );
}
