/**
 * Re-export from @polpo-ai/core.
 * Shell layer extends with TypedEmitter-specific context.
 */
export type { OrchestratorContext, AssessFn, CheckProgressEvent } from "@polpo-ai/core/orchestrator-context";

// For backward compatibility, also re-export the old-style import path
// (code that imported CheckProgressEvent from assessor.ts can now use this)
