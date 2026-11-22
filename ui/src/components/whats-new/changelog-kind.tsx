/**
 * Kind icon + badge for changelog entries (Nuovo / Migliorato / Corretto).
 */
import { Sparkles, Wrench, Zap } from "lucide-react";
import { CHANGELOG_KIND_LABEL, type ChangelogKind } from "@/lib/changelog";
import { cn } from "@/lib/utils";

const KIND_ICON = { new: Sparkles, improved: Zap, fixed: Wrench } as const;

const KIND_BADGE: Record<ChangelogKind, string> = {
  new: "border-primary/30 bg-primary/10 text-primary",
  improved: "border-success/30 bg-success/10 text-success",
  fixed: "border-warning/30 bg-warning/10 text-warning",
};

export function ChangelogKindIcon({ kind, className }: { kind: ChangelogKind; className?: string }) {
  const Icon = KIND_ICON[kind];
  return <Icon className={className} aria-hidden />;
}

export function ChangelogKindBadge({ kind, className }: { kind: ChangelogKind; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-label",
        KIND_BADGE[kind],
        className,
      )}
    >
      <ChangelogKindIcon kind={kind} className="h-3 w-3" />
      {CHANGELOG_KIND_LABEL[kind]}
    </span>
  );
}
