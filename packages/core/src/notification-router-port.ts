/**
 * NotificationRouterPort — minimal interface consumed by core managers.
 *
 * The full NotificationRouter implementation lives in the shell (src/notifications/).
 * Core managers only need the ability to register notification rules dynamically.
 */
import type { NotificationRule } from "./types.js";

export interface NotificationRouterPort {
  addRule(rule: NotificationRule): void;
}
