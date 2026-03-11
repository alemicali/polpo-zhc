/**
 * Persistent project memory — shared context that survives across sessions.
 * Injected into every agent's prompt so they have project knowledge.
 *
 * Memory supports optional scoping via the `scope` parameter:
 * - No scope (undefined) → shared memory visible to all agents
 * - `scope = "agent:<name>"` → private memory for a specific agent
 */
export interface MemoryStore {
  /** Check if memory exists. Pass scope to check agent-specific memory. */
  exists(scope?: string): Promise<boolean>;
  /** Read the full memory content. Returns empty string if none. Pass scope for agent-specific memory. */
  get(scope?: string): Promise<string>;
  /** Overwrite the memory content. Pass scope to write agent-specific memory. */
  save(content: string, scope?: string): Promise<void>;
  /** Append a line to the memory (with timestamp). Pass scope for agent-specific memory. */
  append(line: string, scope?: string): Promise<void>;
  /** Replace a unique substring in the memory. Returns true if replaced, string error otherwise. */
  update(oldText: string, newText: string, scope?: string): Promise<true | string>;
}

/** Build a memory scope key for a specific agent. */
export function agentMemoryScope(agentName: string): string {
  return `agent:${agentName}`;
}
