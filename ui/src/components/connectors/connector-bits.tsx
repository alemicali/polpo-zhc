/** Small pieces shared by the Connectors page, the detail sheet and the agent page. */
import { AlertTriangle, ArrowUpCircle, CheckCircle2, CircleDashed, ExternalLink, FilePen, KeyRound, Loader2, PauseCircle, RotateCw, type LucideIcon } from "lucide-react";
import type { HostedPill } from "@/lib/mcp-servers";
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
        "peer inline-flex h-5 w-9 shrink-0 items-center rounded-pill border border-transparent shadow-control transition-colors outline-none",
        "focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80",
        className,
      )}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block h-3.5 w-3.5 rounded-pill bg-background shadow-card ring-0 transition-transform",
          "data-[state=checked]:translate-x-[1.125rem] data-[state=unchecked]:translate-x-0.5",
          "dark:data-[state=unchecked]:bg-foreground dark:data-[state=checked]:bg-primary-foreground",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export type PillTone = "success" | "warning" | "destructive" | "muted";

const TONE: Record<PillTone, string> = {
  success: "border-success/40 bg-success/10 text-success",
  warning: "border-warning/40 bg-warning/10 text-warning",
  destructive: "border-destructive/40 bg-destructive/10 text-destructive",
  muted: "border-border text-muted-foreground",
};

/**
 * The status pill of every connector card and row ("Connected", "Sign-in needed", and the hosted
 * servers' "Installed v1.1.0", "Update available", "Available"): one look, by tone.
 */
export function StatusPill({ tone, icon: Icon, label, busy, className }: {
  tone: PillTone; icon: LucideIcon; label: string; busy?: boolean; className?: string;
}) {
  const Shown = busy ? Loader2 : Icon;
  return (
    <Badge variant="outline" data-slot="status-pill" data-tone={tone} className={cn("gap-1 text-caption font-medium", TONE[tone], className)}>
      <Shown className={cn("h-3 w-3", busy && "animate-spin")} />
      {label}
    </Badge>
  );
}

const STATE_STYLE: Record<ConnectorCardState, { tone: PillTone; icon: LucideIcon }> = {
  connect: { tone: "muted", icon: CircleDashed },
  needs_setup: { tone: "warning", icon: KeyRound },
  connected: { tone: "success", icon: CheckCircle2 },
  needs_auth: { tone: "warning", icon: KeyRound },
  needs_reauth: { tone: "warning", icon: RotateCw },
  error: { tone: "destructive", icon: AlertTriangle },
  disabled: { tone: "muted", icon: PauseCircle },
  not_connected: { tone: "muted", icon: CircleDashed },
};

export function StateBadge({ state, busy, className }: { state: ConnectorCardState; busy?: boolean; className?: string }) {
  const style = STATE_STYLE[state];
  return <StatusPill tone={style.tone} icon={style.icon} label={STATE_LABEL[state]} busy={busy} className={className} />;
}

const HOSTED_ICON: Record<HostedPill["kind"], LucideIcon> = {
  installed: CheckCircle2, update: ArrowUpCircle, unfinished: KeyRound, available: CircleDashed, draft: FilePen, off: PauseCircle,
};

/** A ready-made template's or a hosted server's status, in the connectors' pill. */
export function HostedStatusPill({ pill, className }: { pill: HostedPill; className?: string }) {
  return <StatusPill tone={pill.tone} icon={HOSTED_ICON[pill.kind]} label={pill.label} className={className} />;
}
