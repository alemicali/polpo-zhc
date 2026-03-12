/**
 * FilePlaybookStore — file-system backed PlaybookStore.
 *
 * Wraps the existing discovery/persistence logic from src/core/playbook.ts
 * behind the async PlaybookStore interface.
 *
 * Discovery paths (in priority order, first occurrence wins by name):
 *   1. <polpoDir>/playbooks/          — project-level
 *   2. <cwd>/.polpo/playbooks/        — alias when polpoDir != .polpo
 *   3. ~/.polpo/playbooks/            — user-level
 *
 * Also scans legacy templates/ directories for backward compatibility.
 */

import type { PlaybookStore } from "../core/playbook-store.js";
import type { PlaybookDefinition, PlaybookInfo } from "../core/playbook.js";
import {
  discoverPlaybooks,
  loadPlaybook,
  savePlaybook,
  deletePlaybook,
} from "../core/playbook.js";

export class FilePlaybookStore implements PlaybookStore {
  constructor(
    private readonly cwd: string,
    private readonly polpoDir: string,
  ) {}

  async list(): Promise<PlaybookInfo[]> {
    return discoverPlaybooks(this.cwd, this.polpoDir);
  }

  async get(name: string): Promise<PlaybookDefinition | null> {
    return loadPlaybook(this.cwd, this.polpoDir, name);
  }

  async save(definition: PlaybookDefinition): Promise<string> {
    return savePlaybook(this.polpoDir, definition);
  }

  async delete(name: string): Promise<boolean> {
    return deletePlaybook(this.cwd, this.polpoDir, name);
  }
}
