import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { artifactsApi, type ArtifactType } from "@/lib/artifacts-api";
import { cn } from "@/lib/utils";
import { ArtifactIcon } from "./artifact-icon";

const TEMPLATES: { label: string; detail: string; type: ArtifactType; kind?: string; load: () => Promise<string> }[] = [
  { label: "Docs", detail: "Rich-text documents", type: "doc", load: async () => "# New document\n\nStart writing here.\n" },
  { label: "Slides", detail: "Editable presentations", type: "html", kind: "slides", load: () => import("./artifact-slides-format").then((m) => m.SLIDES_STARTER) },
  { label: "Sheets", detail: "Workbooks with formulas", type: "html", kind: "sheets", load: () => import("./artifact-sheets-model").then((m) => m.SHEETS_STARTER) },
  { label: "Design", detail: "Pages and prototypes", type: "html", kind: "design", load: () => import("./artifact-design-editor").then((m) => m.DESIGN_STARTER) },
  { label: "Motion", detail: "Animated scenes", type: "html", kind: "motion", load: () => import("./artifact-motion-model").then((m) => m.MOTION_STARTER) },
];

export function ArtifactCreateButton() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState(TEMPLATES[0]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const content = await template.load();
      const artifact = await artifactsApi.create({
        title: title.trim() || `Untitled ${template.kind ?? "document"}`,
        type: template.type,
        kind: template.kind,
        content,
      });
      setOpen(false);
      navigate(`/artifacts/${encodeURIComponent(artifact.id)}`, { state: { edit: true } });
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(value) => {
      if (busy) return;
      setOpen(value);
      if (value) { setTemplate(TEMPLATES[0]); setTitle(""); }
    }}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus className="size-4" /> New artifact</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New artifact</DialogTitle>
          <DialogDescription>Choose a workspace to start from.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void create(event)} className="grid gap-4">
          <div className="grid gap-2 sm:grid-cols-2" aria-label="Artifact format">
            {TEMPLATES.map((item) => (
              <button key={item.label} type="button" aria-pressed={item === template} disabled={busy}
                className={cn("flex items-center gap-3 rounded-md border p-2.5 text-left focus-visible:outline-2 focus-visible:outline-primary",
                  item === template ? "border-primary/70 bg-primary/10" : "border-border hover:bg-muted/60")}
                onClick={() => setTemplate(item)}>
                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-background text-primary"><ArtifactIcon artifact={item} /></span>
                <span><span className="block text-sm font-medium">{item.label}</span><span className="block text-xs text-muted-foreground">{item.detail}</span></span>
              </button>
            ))}
          </div>
          <label className="grid gap-1.5 text-sm font-medium">
            Title
            <Input value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} placeholder="Add a title" />
          </label>
          <DialogFooter>
            <Button type="submit" disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" />} Create artifact</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
