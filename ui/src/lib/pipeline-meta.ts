// Labels, icons and status styles for pipeline steps, shared by the pipeline
// editor (agent page) and the run view (task page).

import { GitBranch, GitFork, Repeat, UserCheck } from "lucide-react";
import type { PipelineStepStatus } from "@polpo-ai/react";
import type { StepKind } from "@/lib/pipeline-edit";

export const KIND_META: Record<StepKind, { label: string; icon: React.ElementType; color: string; description: string }> = {
  loop: { label: "Loop", icon: Repeat, color: "text-primary", description: "An LLM session of this agent with the loop's prompt, tools and model." },
  human: { label: "Human approval", icon: UserCheck, color: "text-amber-500", description: "Waits until someone approves or rejects it on the Approvals page." },
  switch: { label: "Switch", icon: GitBranch, color: "text-violet-500", description: "Runs the first case whose condition is true (or the default)." },
  parallel: { label: "Parallel", icon: GitFork, color: "text-sky-500", description: "Runs its branches at the same time and joins them." },
};

export const STATUS_META: Record<PipelineStepStatus, { label: string; border: string; text: string; bg: string }> = {
  running: { label: "Running", border: "border-blue-400", text: "text-blue-400", bg: "bg-blue-500/10" },
  waiting: { label: "Waiting for approval", border: "border-amber-400", text: "text-amber-500", bg: "bg-amber-500/10" },
  done: { label: "Done", border: "border-emerald-400/80", text: "text-emerald-500", bg: "bg-emerald-500/5" },
  failed: { label: "Failed", border: "border-red-400", text: "text-red-500", bg: "bg-red-500/10" },
  skipped: { label: "Skipped", border: "border-border", text: "text-muted-foreground", bg: "" },
  cancelled: { label: "Stopped", border: "border-border", text: "text-muted-foreground", bg: "" },
};
