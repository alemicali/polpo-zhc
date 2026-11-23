import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { artifactsApi, type ArtifactType } from "@/lib/artifacts-api";
import { artifactPath } from "@/hooks/use-artifact-actions";
import { cn } from "@/lib/utils";
import { ArtifactIcon } from "./artifact-icon";
import { ArtifactPreparation } from "./artifact-preparation";

interface Template {
  label: string;
  title: string;
  tone: string;
  type: ArtifactType;
  kind?: string;
  load: () => Promise<string>;
}

const TEMPLATES: Template[] = [
  { label: "Docs", title: "Untitled document", tone: "document", type: "doc", load: async () => "" },
  { label: "Slides", title: "Untitled presentation", tone: "slides", type: "html", kind: "slides", load: () => import("./artifact-slides-format").then((m) => m.SLIDES_STARTER) },
  { label: "Sheets", title: "Untitled spreadsheet", tone: "sheets", type: "html", kind: "sheets", load: () => import("./artifact-sheets-model").then((m) => m.SHEETS_STARTER) },
  { label: "Design", title: "Untitled design", tone: "design", type: "html", kind: "design", load: () => import("./artifact-design-editor").then((m) => m.DESIGN_STARTER) },
  { label: "Motion", title: "Untitled animation", tone: "motion", type: "html", kind: "motion", load: () => import("./artifact-motion-model").then((m) => m.MOTION_STARTER) },
];

export function ArtifactTemplates() {
  const navigate = useNavigate();
  const [pending, setPending] = useState<Template>();
  const request = useRef(false);

  async function create(template: Template) {
    if (request.current) return;
    request.current = true;
    setPending(template);
    try {
      const content = await template.load();
      const artifact = await artifactsApi.create({ title: template.title, type: template.type, kind: template.kind, content });
      navigate(artifactPath(artifact.id), { state: { createdArtifact: artifact } });
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      request.current = false;
      setPending(undefined);
    }
  }

  return (
    <section aria-labelledby="artifact-templates-heading" className="min-w-0 shrink-0 py-1.5">
      <h2 id="artifact-templates-heading" className="mb-2.5 font-heading text-sm font-semibold text-foreground">
        Make something new
      </h2>
      <div className="-mx-1 grid auto-cols-[7rem] grid-flow-col gap-2 overflow-x-auto px-1 pb-1 sm:auto-cols-[7.5rem]">
        {TEMPLATES.map((template) => (
          <button key={template.label} type="button" disabled={!!pending} aria-label={`Create ${template.label}`}
            data-template={template.tone}
            className={cn(
              "artifact-template-art group relative flex h-[6rem] min-w-0 flex-col rounded-lg text-left transition-colors",
              "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-wait sm:h-[6.6875rem]",
              pending === template && "artifact-template-pending",
            )}
            onClick={() => void create(template)}>
            <span className="artifact-template-glyph relative grid min-h-0 flex-1 place-items-center overflow-hidden rounded-xl border">
              {pending === template
                ? <Loader2 className="relative size-6 motion-safe:animate-spin" aria-hidden="true" />
                : <ArtifactIcon artifact={template} className="relative size-7 sm:size-8" />}
            </span>
            <span className="truncate px-0.5 pt-1 text-left text-sm font-medium text-foreground">{template.label}</span>
          </button>
        ))}
      </div>
      {pending && <div className="mt-2"><ArtifactPreparation phase="Preparing" kind={pending.kind ?? pending.type} compact /></div>}
    </section>
  );
}
