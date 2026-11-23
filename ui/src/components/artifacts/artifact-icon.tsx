import { BarChart3, Clapperboard, FileText, GitBranch, Globe2, Image, LayoutDashboard, Palette, Presentation, Table2 } from "lucide-react";
import type { ArtifactSummary } from "@/lib/artifacts-api";

export function ArtifactIcon({ artifact, className = "size-4" }: {
  artifact: Pick<ArtifactSummary, "type" | "kind">;
  className?: string;
}) {
  const icon = artifact.type === "doc" ? FileText :
    artifact.type === "mermaid" ? GitBranch :
    artifact.type === "svg" ? Image :
    artifact.type === "view" ? BarChart3 :
    artifact.kind === "dashboard" ? LayoutDashboard :
    artifact.kind === "design" ? Palette :
    artifact.kind === "slides" ? Presentation :
    artifact.kind === "sheets" ? Table2 :
    artifact.kind === "motion" ? Clapperboard : Globe2;
  const Icon = icon;
  return <Icon className={className} aria-hidden="true" />;
}
