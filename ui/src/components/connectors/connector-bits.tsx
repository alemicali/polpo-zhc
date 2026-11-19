/** Small pieces shared by the Connectors page, the detail sheet and the agent page. */
import { AlertTriangle, CheckCircle2, CircleDashed, KeyRound, Loader2, PauseCircle, RotateCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { STATE_LABEL, type ConnectorCardState } from "@/lib/connectors-api";
import { cn } from "@/lib/utils";

export function Switch({
  checked, onChange, label, disabled, className,
}: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean; className?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-emerald-500/80" : "bg-muted-foreground/25",
        className,
      )}
    >
      <span className={cn("inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform", checked ? "translate-x-[1.125rem]" : "translate-x-0.5")} />
    </button>
  );
}

const STATE_STYLE: Record<ConnectorCardState, { className: string; icon: typeof CheckCircle2 }> = {
  connect: { className: "border-border text-muted-foreground", icon: CircleDashed },
  needs_setup: { className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400", icon: KeyRound },
  connected: { className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400", icon: CheckCircle2 },
  needs_auth: { className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400", icon: KeyRound },
  needs_reauth: { className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400", icon: RotateCw },
  error: { className: "border-destructive/40 bg-destructive/10 text-destructive", icon: AlertTriangle },
  disabled: { className: "border-border text-muted-foreground", icon: PauseCircle },
  not_connected: { className: "border-border text-muted-foreground", icon: CircleDashed },
};

export function StateBadge({ state, busy, className }: { state: ConnectorCardState; busy?: boolean; className?: string }) {
  const style = STATE_STYLE[state];
  const Icon = busy ? Loader2 : style.icon;
  return (
    <Badge variant="outline" className={cn("gap-1 text-[11px] font-medium", style.className, className)}>
      <Icon className={cn("h-3 w-3", busy && "animate-spin")} />
      {STATE_LABEL[state]}
    </Badge>
  );
}
