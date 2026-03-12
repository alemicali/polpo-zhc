/**
 * PlaybookStore — abstract interface for playbook persistence.
 *
 * Playbooks are parameterized, reusable mission templates stored as JSON.
 * This interface decouples playbook CRUD from the storage backend
 * (file system, database, etc.).
 *
 * Pure logic (validateParams, instantiatePlaybook, validatePlaybookDefinition)
 * is NOT part of this interface — those remain standalone functions.
 */

// ── Types (re-declared here to avoid depending on the shell package) ────

export interface PlaybookParameter {
  name: string;
  description: string;
  type?: "string" | "number" | "boolean";
  required?: boolean;
  default?: string | number | boolean;
  enum?: (string | number)[];
}

export interface PlaybookDefinition {
  name: string;
  description: string;
  mission: Record<string, unknown>;
  parameters?: PlaybookParameter[];
  version?: string;
  author?: string;
  tags?: string[];
}

export interface PlaybookInfo {
  name: string;
  description: string;
  parameters: PlaybookParameter[];
  /** Absolute path (file backend) or opaque location identifier. */
  path: string;
}

// ── Interface ──────────────────────────────────────────────────────────

export interface PlaybookStore {
  /**
   * List all available playbooks (lightweight metadata, no mission body).
   */
  list(): Promise<PlaybookInfo[]>;

  /**
   * Load a full playbook definition by name.
   * Returns null if not found.
   */
  get(name: string): Promise<PlaybookDefinition | null>;

  /**
   * Save (create or overwrite) a playbook.
   * Implementations should validate the definition before persisting.
   * @returns An opaque location string (e.g. directory path for file backend).
   */
  save(definition: PlaybookDefinition): Promise<string>;

  /**
   * Delete a playbook by name.
   * @returns true if deleted, false if not found.
   */
  delete(name: string): Promise<boolean>;
}
