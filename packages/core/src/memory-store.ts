/**
 * Persistent project memory — shared context that survives across sessions.
 * Injected into every agent's prompt so they have project knowledge.
 */
export interface MemoryStore {
  /** Check if memory exists. */
  exists(): Promise<boolean>;
  /** Read the full memory content. Returns empty string if none. */
  get(): Promise<string>;
  /** Overwrite the memory content. */
  save(content: string): Promise<void>;
  /** Append a line to the memory (with timestamp). */
  append(line: string): Promise<void>;
  /** Replace a unique substring in the memory. Returns true if replaced, string error otherwise. */
  update(oldText: string, newText: string): Promise<true | string>;
}
