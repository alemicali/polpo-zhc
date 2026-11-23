import { BarChart3, File, GitBranch, Globe2, Image, LayoutDashboard, Palette, Presentation, Table } from "lucide-react";
import type { ArtifactSummary } from "@/lib/artifacts-api";

export function ArtifactIcon({ artifact, className = "size-4" }: {
  artifact: Pick<ArtifactSummary, "type" | "kind">;
  className?: string;
}) {
  const icon = artifact.type === "doc" ? File :
    artifact.type === "mermaid" ? GitBranch :
    artifact.type === "svg" ? Image :
    artifact.type === "view" ? BarChart3 :
    artifact.kind === "dashboard" ? LayoutDashboard :
    artifact.kind === "design" ? Palette :
    artifact.kind === "slides" ? Presentation :
    artifact.kind === "sheets" ? Table :
    Globe2;
  if (artifact.kind === "motion") return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="15" cy="12" r="6.4" /><path d="M3.6 8h2.7M1 12h3.8m-1.2 4h2.7" /></svg>;
  const Icon = icon;
  return <Icon className={className} aria-hidden="true" />;
}
