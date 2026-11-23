/** Empty, error and loading states of the Data area (Lumea's EmptyTabContent and connection-error screens, on Polpo's tokens). */
import type { ComponentType } from "react";
import { AlertCircle, Database, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function DataEmpty({ icon: Icon = Database, title, description, action, compact }: {
  icon?: ComponentType<{ className?: string }>; title: string; description?: string; action?: React.ReactNode; compact?: boolean;
}) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col items-center justify-center text-center", compact ? "px-3 py-8" : "p-10")}>
      <div className="mb-4 flex size-12 items-center justify-center rounded-card bg-muted"><Icon className="size-6 text-muted-foreground" /></div>
      <h3 className="text-sm font-medium">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-xs text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function DataError({ title, message, onRetry, children }: { title: string; message: string; onRetry?: () => void; children?: React.ReactNode }) {
  return (
    <div role="alert" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 p-8 text-center">
      <div className="flex size-14 items-center justify-center rounded-card bg-destructive/10"><AlertCircle className="size-7 text-destructive" /></div>
      <div className="max-w-md space-y-1.5">
        <h3 className="text-h3 font-semibold">{title}</h3>
        <p className="break-words text-xs text-muted-foreground">{message}</p>
      </div>
      {children}
      {onRetry && <Button variant="outline" size="sm" onClick={onRetry}><RefreshCw /> Retry</Button>}
    </div>
  );
}

export function DataLoading({ label }: { label?: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8" aria-busy="true">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
      {label && <p className="text-xs text-muted-foreground">{label}</p>}
    </div>
  );
}
