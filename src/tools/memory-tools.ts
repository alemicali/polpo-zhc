/**
 * Memory tools for agents — scoped to a single agent's private memory.
 *
 * These tools let an agent read and write its own persistent memory
 * during direct-chat sessions. The agent scope is baked in at creation
 * time so the agent cannot access other agents' or shared memory.
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { MemoryStore } from "@polpo-ai/core";
import { agentMemoryScope } from "@polpo-ai/core";

// ── Tool names ──

export const ALL_MEMORY_TOOL_NAMES = [
  "memory_get",
  "memory_save",
  "memory_append",
  "memory_update",
] as const;

export type MemoryToolName = (typeof ALL_MEMORY_TOOL_NAMES)[number];

// ── Schemas ──

const MemoryGetSchema = Type.Object({});

const MemorySaveSchema = Type.Object({
  content: Type.String({ description: "The full memory content to save (overwrites existing)" }),
});

const MemoryAppendSchema = Type.Object({
  text: Type.String({ description: "Text to append to your memory" }),
});

const MemoryUpdateSchema = Type.Object({
  old_text: Type.String({ description: "Exact substring in your memory to find" }),
  new_text: Type.String({ description: "Replacement text" }),
});

// ── Factory ──

/**
 * Create memory tools for an agent, scoped to that agent's private memory.
 *
 * @param store   The MemoryStore instance
 * @param agent   The agent name — tools will only access `agent:<name>` scope
 */
export function createMemoryTools(
  store: MemoryStore,
  agent: string,
): AgentTool<any>[] {
  const scope = agentMemoryScope(agent);

  const memoryGet: AgentTool<typeof MemoryGetSchema> = {
    name: "memory_get",
    label: "Read Memory",
    description:
      "Read your persistent memory. This memory survives across sessions " +
      "and contains your personal notes, learnings, and context. " +
      "Returns empty string if you have no saved memory yet.",
    parameters: MemoryGetSchema,
    async execute() {
      const content = await store.get(scope);
      return {
        content: [{ type: "text" as const, text: content || "(no memory saved yet)" }],
        details: { scope },
      };
    },
  };

  const memorySave: AgentTool<typeof MemorySaveSchema> = {
    name: "memory_save",
    label: "Save Memory",
    description:
      "Overwrite your entire persistent memory with new content. " +
      "Use this when you want to restructure or rewrite your memory completely. " +
      "For adding a single note, prefer memory_append instead.",
    parameters: MemorySaveSchema,
    async execute(_toolCallId, params) {
      await store.save(params.content, scope);
      return {
        content: [{ type: "text" as const, text: `Memory saved (${params.content.length} chars).` }],
        details: { scope, chars: params.content.length },
      };
    },
  };

  const memoryAppend: AgentTool<typeof MemoryAppendSchema> = {
    name: "memory_append",
    label: "Append to Memory",
    description:
      "Append a timestamped line to your persistent memory. " +
      "Good for quick notes, learnings, or observations you want to remember.",
    parameters: MemoryAppendSchema,
    async execute(_toolCallId, params) {
      await store.append(params.text, scope);
      return {
        content: [{ type: "text" as const, text: `Appended to memory: "${params.text}"` }],
        details: { scope },
      };
    },
  };

  const memoryUpdate: AgentTool<typeof MemoryUpdateSchema> = {
    name: "memory_update",
    label: "Update Memory",
    description:
      "Find and replace a specific section in your memory. " +
      "The old_text must be an exact unique substring of your current memory.",
    parameters: MemoryUpdateSchema,
    async execute(_toolCallId, params) {
      const result = await store.update(params.old_text, params.new_text, scope);
      if (result === true) {
        return {
          content: [{ type: "text" as const, text: "Memory updated successfully." }],
          details: { scope, success: true },
        };
      }
      return {
        content: [{ type: "text" as const, text: `Failed to update memory: ${result}` }],
        details: { scope, success: false },
      };
    },
  };

  return [memoryGet, memorySave, memoryAppend, memoryUpdate];
}
