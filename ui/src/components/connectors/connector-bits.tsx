/** Small pieces shared by the Connectors page, the detail sheet and the agent page. */
import { AlertTriangle, CheckCircle2, CircleDashed, ExternalLink, KeyRound, Loader2, PauseCircle, RotateCw } from "lucide-react";
import { errorActionUrl } from "@polpo-ai/core/error-action";
import { Switch as SwitchPrimitive } from "radix-ui";
import { Badge } from "@/components/ui/badge";
import { STATE_LABEL, type ConnectorCardState } from "@/lib/connectors-api";
import { cn } from "@/lib/utils";

/**
 * "Fix it": the link an error message tells the person to open (e.g. Slack's "Please enable it
 * here: https://api.slack.com/apps/…/app-assistant"). Nothing when the message has none.
 */
export function FixItLink({ message, className }: { message?: string | null; className?: string }) {
  const url = errorActionUrl(message);
  if (!url) return null;
  return (
    <a
      href={url} target="_blank" rel="noreferrer noopener" title={url}
      className={cn("inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline", className)}
    >
      Fix it on {new URL(url).hostname} <ExternalLink className="h-3 w-3" />
    </a>
  );
}

/**
 * The shadcn switch (Radix primitive, the look's tokens: primary when on, input when off), with a
 * required accessible label. Also used by the coding settings and the sandbox editor.
 */
export function Switch({
  checked, onChange, label, disabled, className,
}: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean; className?: string }) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      disabled={disabled}
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-colors outline-none",
        "focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80",
        className,
      )}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block h-3.5 w-3.5 rounded-full bg-background shadow-card ring-0 transition-transform",
          "data-[state=checked]:translate-x-[1.125rem] data-[state=unchecked]:translate-x-0.5",
          "dark:data-[state=unchecked]:bg-foreground dark:data-[state=checked]:bg-primary-foreground",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

const STATE_STYLE: Record<ConnectorCardState, { className: string; icon: typeof CheckCircle2 }> = {
  connect: { className: "border-border text-muted-foreground", icon: CircleDashed },
  needs_setup: { className: "border-warning/40 bg-warning/10 text-warning", icon: KeyRound },
  connected: { className: "border-success/40 bg-success/10 text-success", icon: CheckCircle2 },
  needs_auth: { className: "border-warning/40 bg-warning/10 text-warning", icon: KeyRound },
  needs_reauth: { className: "border-warning/40 bg-warning/10 text-warning", icon: RotateCw },
  error: { className: "border-destructive/40 bg-destructive/10 text-destructive", icon: AlertTriangle },
  disabled: { className: "border-border text-muted-foreground", icon: PauseCircle },
  not_connected: { className: "border-border text-muted-foreground", icon: CircleDashed },
};

export function StateBadge({ state, busy, className }: { state: ConnectorCardState; busy?: boolean; className?: string }) {
  const style = STATE_STYLE[state];
  const Icon = busy ? Loader2 : style.icon;
  return (
    <Badge variant="outline" className={cn("gap-1 text-caption font-medium", style.className, className)}>
      <Icon className={cn("h-3 w-3", busy && "animate-spin")} />
      {STATE_LABEL[state]}
    </Badge>
  );
}
