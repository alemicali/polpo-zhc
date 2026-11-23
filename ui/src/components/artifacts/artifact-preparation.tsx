import { FileText, ScanLine } from "lucide-react";
import { useProjectInfo } from "@/hooks/use-polpo";
import { productName, useInstanceBranding } from "@/lib/branding";
import { cn } from "@/lib/utils";
import { ArtifactIcon } from "./artifact-icon";
import "./artifact-workspace.css";

const descriptions: Record<string, string> = {
  doc: "document",
  slides: "presentation",
  sheets: "spreadsheet",
  design: "design",
  motion: "animation",
};

export function ArtifactPreparation({ phase = "Opening", kind, compact }: {
  phase?: "Opening" | "Preparing" | "Saving";
  kind?: string;
  compact?: boolean;
}) {
  const { info } = useProjectInfo();
  const brand = productName(useInstanceBranding());
  const instance = info?.project || brand;
  const description = kind ? descriptions[kind] ?? "artifact" : "artifact";

  return (
    <div role="status" className={cn(
      "flex min-w-0 justify-center",
      compact ? "items-center text-left" : "h-full min-h-0 items-center px-4 py-3",
    )}>
      <div data-phase={phase.toLowerCase()} className={cn(
        "relative flex items-center gap-3 overflow-hidden rounded-lg border border-border bg-card",
        compact ? "w-full px-3 py-2.5" : "w-full max-w-72 px-4 py-4",
      )}>
        <span aria-hidden="true" className="artifact-preparation-mark relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg border border-primary/20 bg-primary/10 text-primary">
          {kind ? <ArtifactIcon artifact={{ type: kind === "doc" ? "doc" : "html", kind }} /> : <FileText className="size-4" />}
          <ScanLine className="artifact-preparation-scan absolute inset-x-0 size-10 motion-reduce:hidden" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-xs font-medium text-muted-foreground">{instance}</span>
          <span className="block truncate text-sm font-medium text-foreground">{phase} {description}…</span>
        </span>
        <span aria-hidden="true" className="artifact-preparation-track pointer-events-none absolute inset-x-0 bottom-0 overflow-hidden motion-reduce:hidden" />
      </div>
    </div>
  );
}
