/**
 * sandbox_volume_checkpoint (open Polpo): persist the changes made to hydrated volumes now,
 * instead of (or before) the end of the run. Added to runs whose remote sandbox has hydrated
 * read-write volumes; the write-back is guarded by the volume's revision (a concurrent writer
 * produces a conflict copy under .conflicts/, not a loss).
 */
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const SandboxVolumeCheckpointSchema = Type.Object({
  volume: Type.Optional(Type.String({
    minLength: 1,
    description: "Name of one attached hydrated volume. Omit to checkpoint every eligible volume.",
  })),
}, { additionalProperties: false });

export function createSandboxVolumeCheckpointTool(
  checkpoint: (name?: string) => Promise<void>,
): AgentTool<typeof SandboxVolumeCheckpointSchema> {
  return {
    name: "sandbox_volume_checkpoint",
    label: "Checkpoint Sandbox Volume",
    description:
      "Persist changes made to manually managed hydrated sandbox volumes. "
      + "Call this after completing a consistent set of filesystem updates.",
    parameters: SandboxVolumeCheckpointSchema,
    async execute(_toolCallId, params) {
      await checkpoint(params.volume);
      return {
        content: [{
          type: "text",
          text: params.volume ? `Sandbox volume checkpointed: ${params.volume}` : "Sandbox volumes checkpointed.",
        }],
        details: { checkpointed: true, ...(params.volume ? { volume: params.volume } : {}) },
      };
    },
  };
}
