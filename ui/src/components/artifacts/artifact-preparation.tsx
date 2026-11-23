import { FileText, ScanLine, Table2 } from "lucide-react";
import { useProjectInfo } from "@/hooks/use-polpo";
import { productName, useInstanceBranding } from "@/lib/branding";
import { cn } from "@/lib/utils";
import "./artifact-workspace.css";

export function ArtifactPreparation({ phase = "Opening", kind, compact }: {
  phase?: "Opening" | "Preparing" | "Saving";
  kind?: string;
  compact?: boolean;
}) {
  const { info } = useProjectInfo();
  const brand = productName(useInstanceBranding());
  const instance = info?.project || brand;
  const sheet = kind === "sheets";
  const message = `${phase} ${sheet ? "spreadsheet" : "artifact"}`;

  return (
    <div role="status" className={cn(
      "flex min-w-0 items-center gap-3 text-left",
      compact ? "rounded-lg border border-border bg-card/80 px-3 py-2.5" : "h-full min-h-40 justify-center p-5",
    )}>
      <span aria-hidden="true" className="artifact-preparation-mark relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg border border-primary/20 bg-primary/10 text-primary">
        {sheet ? <Table2 className="size-4" /> : <FileText className="size-4" />}
        <ScanLine className="artifact-preparation-scan absolute inset-x-0 size-10 motion-reduce:hidden" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{message}</span>
        <span className="block truncate text-xs text-muted-foreground">{instance}</span>
      </span>
    </div>
  );
}
