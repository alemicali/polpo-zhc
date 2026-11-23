import { use, useEffect, useMemo, useRef, useState } from "react";
import type { ToolCallInfo } from "./use-polpo";
import { ChatStateContext } from "./chat-context";
import { artifactsApi, type Artifact } from "@/lib/artifacts-api";
import { artifactStreamArgs } from "@/lib/artifact-stream-text";
import { liveArtifactKind, projectLiveArtifact } from "@/lib/artifact-stream";

export function useSampledTool(tool: ToolCallInfo | undefined) {
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
  if (!tool) return;
  if (tool.state !== "preparing" || sample?.id !== tool.id) return tool;
  return sample;
}

/** A temporarily incomplete JSON or HTML unit keeps the last renderable frame for this revision. */
export function useLastFrame(key: string | undefined, content: string | undefined) {
  const [last, setLast] = useState<{ key: string; content: string }>();
  if (key === undefined && last) setLast(undefined);
  if (key !== undefined && content !== undefined && (last?.key !== key || last.content !== content)) {
    setLast({ key, content });
  }
  return content ?? (key && last?.key === key ? last.content : undefined);
}

/** The committed record and the user's draft live in ArtifactDetail. A partial never enters either. */
export function useLiveArtifactUpdate(artifact: Artifact | null, follow: boolean, onCommitted: (value: Artifact) => void) {
  const chat = use(ChatStateContext);
  const id = artifact?.id;
  const message = chat?.messages.at(-1);
  const candidate = id && follow ? message?.toolCalls?.slice().reverse().find(call => call.name === "artifact_update" &&
    (call.arguments?.id === id || /"id"\s*:\s*"(art_[\w-]+)"/.exec(call.argumentsText ?? "")?.[1] === id)) : undefined;
  const generating = !!chat?.isLoading && (candidate?.state === "preparing" || candidate?.state === "calling");
  const receipt = candidate?.state === "completed" ? Number(/\(now v(\d+)\)/.exec(candidate.result ?? "")?.[1]) : 0;
  const [failedFetch, setFailedFetch] = useState<string>();
  const awaitingCommit = !!artifact && receipt > artifact.version && failedFetch !== candidate?.id;
  const tool = generating || awaitingCommit ? candidate : undefined;
  const sample = useSampledTool(tool);
  const [baseline, setBaseline] = useState<{ callId: string; version: number }>();
  const callId = candidate?.id;
  const version = artifact?.version;
  if (generating && callId && version !== undefined && baseline?.callId !== callId) {
    setBaseline({ callId, version });
  }
  useEffect(() => {
    if (!id || !awaitingCommit) return;
    let active = true;
    void artifactsApi.get(id).then(value => {
      if (active) onCommitted(value);
    }, () => { if (active) setFailedFetch(callId); });
    return () => { active = false; };
  }, [id, awaitingCommit, callId, onCommitted]);

  const preview = useMemo(() => {
    if (!sample || !artifact) return;
    const args = artifactStreamArgs(sample);
    if (args.id !== artifact.id) return;
    if (typeof args.expectedVersion === "number" && args.expectedVersion !== artifact.version) return;
    if (baseline?.callId === sample.id && baseline.version !== artifact.version) return;
    return projectLiveArtifact(liveArtifactKind(artifact.type, artifact.kind), sample, args, artifact.content);
  }, [sample, artifact, baseline]);
  const frame = useLastFrame(sample && artifact ? `${sample.id}:${artifact.id}:${artifact.version}` : undefined, preview);
  return { preview: frame, generating: generating && frame !== undefined, tick: -(sample?.argumentsText?.length || 1) };
}
