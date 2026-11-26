/**
 * Where a task, a mission or a chat came from when a trigger's action started it: a link to that
 * delivery (its payload, its action runs) on the Triggers page.
 */
import { Link } from "react-router-dom";
import { Webhook } from "lucide-react";
import type { WorkOrigin } from "@polpo-ai/react";
import { deliveryHref } from "@/lib/triggers";
import { cn } from "@/lib/utils";

export function OriginLink({ origin, className }: { origin: WorkOrigin; className?: string }) {
  return (
    <Link to={deliveryHref(origin.triggerId, origin.deliveryId)} data-testid="origin-link"
      className={cn("inline-flex min-w-0 items-center gap-1 transition-colors hover:text-foreground", className)}
      title={`Started by the trigger ${origin.triggerName ?? origin.triggerId}, delivery ${origin.deliveryId}`}>
      <Webhook className="h-3 w-3 shrink-0" />
      <span className="truncate">Trigger {origin.triggerName ?? origin.triggerId}</span>
    </Link>
  );
}
