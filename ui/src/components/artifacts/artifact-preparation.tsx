import { useProjectInfo } from "@/hooks/use-polpo";
import { productName, useInstanceBranding } from "@/lib/branding";
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
  const message = `${phase} ${description}…`;
  const spinner = <span aria-hidden="true" className="artifact-preparation-spinner block size-5 shrink-0 rounded-full" />;

  if (compact) {
    return (
      <div role="status" data-phase={phase.toLowerCase()} className="flex min-w-0 items-center gap-2 text-xs">
        {spinner}
        <span className="min-w-0 truncate text-muted-foreground">
          <span className="font-medium text-foreground">{instance}</span>{" "}
          <span aria-hidden="true">·</span>{" "}{message}
        </span>
      </div>
    );
  }

  return (
    <div role="status" data-phase={phase.toLowerCase()} className="artifact-preparation-stage flex h-full min-h-0 items-center justify-center text-center">
      <span className="relative">
        {spinner}
        <span className="absolute left-1/2 top-full mt-4 -translate-x-1/2 whitespace-nowrap text-caption font-medium text-muted-foreground">
          {instance}<span className="sr-only"> {message}</span>
        </span>
      </span>
    </div>
  );
}
