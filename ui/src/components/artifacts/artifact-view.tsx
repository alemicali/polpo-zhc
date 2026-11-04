/**
 * ArtifactView — an artifact's content, drawn by type: Markdown (doc), an isolated page (html),
 * an image (svg, so its scripts never run), a diagram (mermaid), or a data view (the former Views).
 */
import { useMemo } from "react";
import { RichStreamdown } from "@/components/ai-elements/rich-streamdown";
import { MermaidFilePreview } from "@/components/shared/mermaid-file-preview";
import { DataViewRenderer } from "@/components/data/data-view-renderer";
import type { DataView } from "@/hooks/use-data";
import type { Artifact } from "@/lib/artifacts-api";
import { ArtifactFrame } from "./artifact-frame";

export function ArtifactView({ artifact, content, refreshKey }: {
  artifact: Pick<Artifact, "id" | "title" | "type" | "refreshSeconds" | "createdAt" | "updatedAt" | "description" | "sessionId">;
  /** The content to show (the current one, or an earlier version's). */
  content: string;
  refreshKey?: number;
}) {
  const view = useMemo<DataView | null>(() => {
    if (artifact.type !== "view") return null;
    try {
      const spec = JSON.parse(content) as Omit<DataView, "id" | "name" | "createdAt" | "updatedAt">;
      return { ...spec, id: artifact.id.replace(/^view:/, ""), name: artifact.title, description: artifact.description, createdAt: artifact.createdAt, updatedAt: artifact.updatedAt } as DataView;
    } catch {
      return null;
    }
  }, [artifact, content]);

  switch (artifact.type) {
    case "html":
      return <ArtifactFrame artifactId={artifact.id} html={content} refreshSeconds={artifact.refreshSeconds} refreshKey={refreshKey} title={artifact.title} />;
    case "doc":
      return (
        <div className="h-full overflow-auto">
          <article className="prose prose-sm dark:prose-invert mx-auto max-w-3xl px-4 py-6 sm:px-8">
            <RichStreamdown>{content}</RichStreamdown>
          </article>
        </div>
      );
    case "svg":
      return (
        <div className="flex h-full items-center justify-center overflow-auto bg-muted/10 p-4">
          <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`} alt={artifact.title} className="max-h-full max-w-full" />
        </div>
      );
    case "mermaid":
      return <MermaidFilePreview content={content} />;
    case "view":
      return view
        ? <div className="h-full overflow-auto p-4"><DataViewRenderer view={view} sessionId={artifact.sessionId ?? null} /></div>
        : <p className="p-4 text-sm text-destructive">This view could not be read.</p>;
    default:
      return <pre className="h-full overflow-auto p-4 text-xs">{content}</pre>;
  }
}
