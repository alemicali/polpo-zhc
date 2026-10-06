/**
 * Notice under the Network field: what the chosen mode means, with a warning for "unrestricted".
 */
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SandboxNetworkMode } from "@/lib/sandbox-api";

export function NetworkNotice({ mode }: { mode?: SandboxNetworkMode }) {
  if (mode === "unrestricted") {
    return (
      <p className={cn("flex items-start gap-1.5 text-[10px] leading-tight text-amber-500")}>
        <AlertTriangle className="h-3 w-3 mt-px shrink-0" />
        Commands can reach this machine's own services (the Polpo APIs on localhost, databases, anything on the private network or Tailscale), most of which answer without a password. Use it only for agents you trust completely.
      </p>
    );
  }
  if (mode === "open" || mode === undefined) {
    return (
      <p className="text-[10px] text-muted-foreground leading-tight">
        Public destinations only: this machine's own services, the private network and Tailscale are never reachable. Refused destinations show up in Settings → Sandbox.
      </p>
    );
  }
  return null;
}
