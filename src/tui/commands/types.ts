/**
 * Command API — what every command receives.
 * Store for UI actions, polpo for business logic.
 */

import type { Orchestrator } from "../../core/orchestrator.js";
import type { TUIStore } from "../store.js";

export interface CommandAPI {
  polpo: Orchestrator;
  store: TUIStore;
  args: string[];
}
