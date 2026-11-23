import { lazy } from "react";
import type { Artifact } from "@/lib/artifacts-api";
import type { LiveArtifactKind } from "@/lib/artifact-stream";

const Doc = lazy(() => import("./artifact-doc-editor").then(m => ({ default: m.ArtifactDocEditor })));
const Design = lazy(() => import("./artifact-design-editor").then(m => ({ default: m.ArtifactDesignEditor })));
const Slides = lazy(() => import("./artifact-slides-editor").then(m => ({ default: m.ArtifactSlidesEditor })));
const Sheets = lazy(() => import("./artifact-sheets-editor").then(m => ({ default: m.ArtifactSheetsEditor })));
const Motion = lazy(() => import("./artifact-motion-editor").then(m => ({ default: m.ArtifactMotionEditor })));
const ignoreChange = () => {};

interface Props {
  kind: LiveArtifactKind;
  artifact: Pick<Artifact, "id" | "title" | "refreshSeconds">;
  content: string;
  streaming?: boolean;
  appearanceVersion?: number;
  refreshKey?: number;
  instanceName?: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onShowHistory?: () => void;
  onAskAssistant?: (selection?: string) => void;
}

export function ArtifactLiveWorkspace({ kind, artifact, content, streaming, readOnly, onChange, ...options }: Props) {
  const edit = streaming || readOnly ? undefined : onChange;
  switch (kind) {
    case "doc":
      return <Doc content={content} streaming={streaming} readOnly={readOnly} instanceName={options.instanceName}
        onAskAssistant={options.onAskAssistant} onChange={edit ?? ignoreChange} />;
    case "slides":
      return <Slides content={content} streaming={streaming} title={artifact.title} onChange={edit} />;
    case "sheets":
      return <Sheets content={content} streaming={streaming} onChange={edit}
        appearanceVersion={options.appearanceVersion} onShowHistory={options.onShowHistory} />;
    case "motion":
      return <Motion content={content} streaming={streaming} title={artifact.title} onChange={edit} />;
    case "design":
      return <Design artifact={artifact} content={content} streaming={streaming} onChange={edit} refreshKey={options.refreshKey} />;
  }
}
