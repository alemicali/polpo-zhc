import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { artifactsApi, type ArtifactType } from "@/lib/artifacts-api";
import { artifactPath } from "@/hooks/use-artifact-actions";
import { cn } from "@/lib/utils";
import { ArtifactIcon } from "./artifact-icon";
import { ArtifactPreparation } from "./artifact-preparation";

interface Template {
  label: string;
  title: string;
  detail: string;
  type: ArtifactType;
  kind?: string;
  load: () => Promise<string>;
}

const TEMPLATES: Template[] = [
  { label: "Docs", title: "Untitled document", detail: "Write and format", type: "doc", load: async () => "# New document\n" },
  { label: "Slides", title: "Untitled presentation", detail: "Build a deck", type: "html", kind: "slides", load: () => import("./artifact-slides-format").then((m) => m.SLIDES_STARTER) },
  { label: "Sheets", title: "Untitled spreadsheet", detail: "Work with data", type: "html", kind: "sheets", load: () => import("./artifact-sheets-model").then((m) => m.SHEETS_STARTER) },
  { label: "Design", title: "Untitled design", detail: "Prototype a page", type: "html", kind: "design", load: () => import("./artifact-design-editor").then((m) => m.DESIGN_STARTER) },
  { label: "Motion", title: "Untitled animation", detail: "Animate scenes", type: "html", kind: "motion", load: () => import("./artifact-motion-model").then((m) => m.MOTION_STARTER) },
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
    <section aria-labelledby="artifact-templates-heading" className="shrink-0 rounded-xl border border-border/70 bg-card/55 p-3 sm:p-4">
      <h2 id="artifact-templates-heading" className="mb-3 font-heading text-sm font-semibold tracking-tight text-foreground">
        Create an artifact
      </h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        {TEMPLATES.map((template) => (
          <button key={template.label} type="button" disabled={!!pending} aria-label={`Create ${template.label}`}
            className={cn(
              "group relative flex min-w-0 items-center justify-between gap-2 overflow-hidden rounded-lg border border-border bg-background px-3 py-2.5 text-left transition-colors",
              "hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:min-h-[68px]",
              pending === template && "border-primary/50 bg-primary/5",
            )}
            onClick={() => void create(template)}>
            <span className="artifact-template-art pointer-events-none absolute inset-y-0 right-0 w-20 opacity-70" aria-hidden="true" />
            <span className="relative min-w-0">
              <span className="block truncate text-sm font-medium">{template.label}</span>
              <span className="block truncate text-xs text-muted-foreground">{template.detail}</span>
            </span>
            <span className="relative grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
              {pending === template
                ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
                : <ArtifactIcon artifact={template} />}
            </span>
            <ArrowUpRight className="absolute right-1.5 top-1.5 size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
          </button>
        ))}
      </div>
      {pending && <div className="mt-3"><ArtifactPreparation phase="Preparing" kind={pending.kind} compact /></div>}
    </section>
  );
}
