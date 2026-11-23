import { lazy, Suspense, useEffect, useMemo, useRef, useState, use } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ArrowLeft, Expand } from "lucide-react";
import type { ToolCallInfo } from "@/hooks/use-polpo";
import { ChatStateContext, sidebarActions, useChatState } from "@/hooks/chat-context";
import { artifactIdOf, artifactsApi, type Artifact } from "@/lib/artifacts-api";
import { artifactStreamArgs, streamingWorkbook } from "@/lib/artifact-sheet-stream";
import { ArtifactPreparation } from "./artifact-preparation";

const SheetEditor = lazy(() => import("./artifact-sheets-editor").then(m => ({ default: m.ArtifactSheetsEditor })));

function useSampledTool(tool: ToolCallInfo | undefined) {
  const [sample, setSample] = useState(() => tool ? { ...tool } : undefined);
  const pending = useRef(tool);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    pending.current = tool;
    if (!tool || timer.current !== undefined) return;
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      setSample(pending.current ? { ...pending.current } : undefined);
    }, 90);
  }, [tool, tool?.argumentsText, tool?.state]);
  useEffect(() => () => { window.clearTimeout(timer.current); timer.current = undefined; }, []);
  return sample?.id === tool?.id ? sample : undefined;
}

export function ActiveWorkbook({ artifactId, content, version, onChange, follow, onShowHistory, onCommitted }: {
  artifactId: string; content: string; version: number; follow: boolean; onChange?: (value: string) => void;
  onShowHistory: () => void; onCommitted: (artifact: Artifact) => void;
}) {
  const chat = use(ChatStateContext);
  const message = chat?.messages.at(-1);
  const candidate = follow ? message?.toolCalls?.slice().reverse().find(call =>
    call.name === "artifact_update" && (call.arguments?.id === artifactId ||
      /"id"\s*:\s*"(art_[\w-]+)"/.exec(call.argumentsText ?? "")?.[1] === artifactId)) : undefined;
  const committedVersion = candidate?.state === "completed" ? Number(/\(now v(\d+)\)/.exec(candidate.result ?? "")?.[1]) : 0;
  const awaitingCommit = committedVersion > version;
  const generating = !!chat?.isLoading && (candidate?.state === "preparing" || candidate?.state === "calling");
  const [failedFetch, setFailedFetch] = useState<string>();
  const tool = generating || (awaitingCommit && failedFetch !== candidate?.id) ? candidate : undefined;

  useEffect(() => {
    if (!awaitingCommit) return;
    let active = true;
    void artifactsApi.get(artifactId).then(value => {
      if (active) onCommitted(value);
    }, () => { if (active) setFailedFetch(candidate?.id); });
    return () => { active = false; };
  }, [artifactId, awaitingCommit, candidate?.id, onCommitted]);
  const sample = useSampledTool(tool);
  const preview = useMemo(() => {
    if (!sample) return;
    const args = artifactStreamArgs(sample);
    return args.id === artifactId ? streamingWorkbook(sample, args, content) : undefined;
  }, [sample, artifactId, content]);
  return <SheetEditor content={preview ?? content} streaming={generating && !!preview} onShowHistory={onShowHistory} onChange={preview ? undefined : onChange}
    appearanceVersion={preview ? -(sample?.argumentsText?.length ?? 1) : version} />;
}

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
  const base = existing && existing.id === id && existing.kind === "sheets" ? existing.content : undefined;
  const workbook = useMemo(() => streamingWorkbook(sample, args, base), [sample, args, base]);
  const tick = sample.argumentsText?.length ?? 0;
  const kind = workbook ? "sheets" : typeof args.kind === "string" ? args.kind : undefined;
  const status = <ArtifactPreparation phase={tool.state === "calling" ? "Saving" : "Preparing"} kind={kind} compact />;
  if (!workbook && !expanded) return status;
  return (
    <section className={expanded ? "flex h-full min-h-0 flex-col" : "my-2 overflow-hidden rounded-lg border bg-background"}>
      <div className="flex min-h-11 items-center justify-between gap-2 border-b px-2">
        {expanded && <Link aria-label="Back to artifacts" to="/artifacts" className="p-2"><ArrowLeft className="size-4" /></Link>}
        <div className="min-w-0 flex-1">{status}</div>
        {typeof args.title === "string" && <span className="truncate text-sm">{args.title}</span>}
        {!expanded && <Link aria-label="Open live spreadsheet" className="p-2" to={`/artifacts/preparing/${encodeURIComponent(tool.id)}`}
          onClick={() => sidebarActions.setSidebarOpen(true)}><Expand className="size-4" /></Link>}
      </div>
      {workbook && <div className={expanded ? "min-h-0 flex-1" : "h-72"}>
        <Suspense fallback={null}><SheetEditor content={workbook} streaming appearanceVersion={tick} /></Suspense>
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
  if (tool && (tool.state === "preparing" || tool.state === "calling")) return <ArtifactGeneration tool={tool} expanded />;
  if (!tool && (messagesLoading || isLoading)) return <ArtifactPreparation />;
  return <div className="m-auto space-y-2 text-center text-sm">
    <p>{tool?.state === "error" ? "Artifact creation failed." : "This live preview has ended."}</p>
    <Link to="/artifacts" className="underline">Back to artifacts</Link>
  </div>;
}
