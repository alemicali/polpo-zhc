import { Suspense, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ArrowLeft, Expand } from "lucide-react";
import { useLastFrame, useSampledTool } from "@/hooks/use-live-artifact";
import type { ToolCallInfo } from "@/hooks/use-polpo";
import { useProjectInfo } from "@/hooks/use-polpo";
import { productName, useInstanceBranding } from "@/lib/branding";
import { sidebarActions, useChatState } from "@/hooks/chat-context";
import { artifactIdOf, artifactsApi, type Artifact } from "@/lib/artifacts-api";
import { artifactStreamArgs } from "@/lib/artifact-stream-text";
import { liveArtifactKind, projectLiveArtifact, type LiveArtifactKind } from "@/lib/artifact-stream";
import { ArtifactPreparation } from "./artifact-preparation";
import { ArtifactLiveWorkspace } from "./artifact-live-workspace";

const labels: Record<LiveArtifactKind, string> = {
  doc: "document", slides: "presentation", sheets: "spreadsheet", design: "design", motion: "animation",
};

export function ArtifactGeneration({ tool, expanded = false }: { tool: ToolCallInfo; expanded?: boolean }) {
  const sample = useSampledTool(tool) ?? tool;
  const args = useMemo(() => artifactStreamArgs(sample), [sample]);
  const id = sample.name === "artifact_update" && typeof args.id === "string" && /^art_[\w-]+$/.test(args.id)
    ? args.id : undefined;
  const [existing, setExisting] = useState<Artifact>();
  useEffect(() => {
    if (!id) return;
    let alive = true;
    void artifactsApi.get(id).then(value => { if (alive) setExisting(value); }, () => {});
    return () => { alive = false; };
  }, [id]);
  const base = id && existing?.id === id ? existing : undefined;
  const kind = liveArtifactKind(base?.type ?? args.type, base?.kind ?? args.kind);
  const projection = useMemo(() => {
    if (sample.name === "artifact_update" && (!base || (typeof args.expectedVersion === "number" && base.version !== args.expectedVersion))) return;
    return projectLiveArtifact(kind, sample, args, base?.content);
  }, [kind, sample, args, base]);
  const content = useLastFrame(`${sample.id}:${id ?? ""}:${base?.version ?? 0}`, projection);
  const status = <ArtifactPreparation phase={tool.state === "calling" ? "Saving" : "Preparing"} kind={kind} compact />;
  const { info } = useProjectInfo();
  const product = productName(useInstanceBranding());
  if ((content === undefined || !kind) && !expanded) return status;
  const title = typeof args.title === "string" ? args.title : base?.title;
  return (
    <section className={expanded ? "flex h-full min-h-0 flex-col" : "my-2 overflow-hidden rounded-lg border bg-background"}>
      <div className="flex min-h-11 items-center justify-between gap-2 border-b px-2">
        {expanded && <Link aria-label="Back to artifacts" to="/artifacts" className="p-2"><ArrowLeft className="size-4" /></Link>}
        <div className="min-w-0 flex-1">{status}</div>
        {title && <span className="truncate text-sm">{title}</span>}
        {!expanded && kind && <Link aria-label={`Open live ${labels[kind]}`} className="p-2" to={`/artifacts/preparing/${encodeURIComponent(tool.id)}`}
          onClick={() => sidebarActions.setSidebarOpen(true)}><Expand className="size-4" /></Link>}
      </div>
      {kind && content !== undefined && <div className={expanded ? "min-h-0 flex-1" : "h-72"}>
        <Suspense fallback={null}><ArtifactLiveWorkspace kind={kind} streaming content={content}
          artifact={{ id: id ?? `preparing-${tool.id}`, title: title ?? labels[kind] }}
          instanceName={info?.project || product} appearanceVersion={sample.argumentsText?.length ?? 0} /></Suspense>
      </div>}
    </section>
  );
}

export function ArtifactGenerationPage() {
  const { toolId } = useParams();
  const { messages, messagesLoading, isLoading } = useChatState();
  const tool = messages.flatMap(message => message.toolCalls ?? []).find(call => call.id === toolId);
  const id = tool?.state === "completed" ? artifactIdOf(tool.result) : undefined;
  if (id) return <Navigate to={`/artifacts/${encodeURIComponent(id)}`} replace />;
  if (isLoading && tool && (tool.state === "preparing" || tool.state === "calling")) return <ArtifactGeneration tool={tool} expanded />;
  if (!tool && (messagesLoading || isLoading)) return <ArtifactPreparation />;
  return <div className="m-auto space-y-2 text-center text-sm">
    <p>{tool?.state === "error" ? "Artifact generation failed." : "This live preview has ended."}</p>
    <Link to="/artifacts" className="underline">Back to artifacts</Link>
  </div>;
}
