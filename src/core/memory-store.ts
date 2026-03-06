/**
 * Persistent project memory — shared context that survives across sessions.
 * Injected into every agent's prompt so they have project knowledge.
 */
export interface MemoryStore {
  /** Check if memory exists. */
  exists(): boolean;
  /** Read the full memory content. Returns empty string if none. */
  get(): string;
  /** Overwrite the memory content. */
  save(content: string): void;
  /** Append a line to the memory (with timestamp). */
  append(line: string): void;
  /** Replace a unique substring in the memory. Returns true if replaced, string error otherwise. */
  update(oldText: string, newText: string): true | string;
}
