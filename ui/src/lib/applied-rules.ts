/**
 * Resolve which notification rules apply to a given task or mission.
 *
 * Mirrors the runtime logic in src/notifications/index.ts (resolveRules +
 * matchGlob) so the UI can show exactly what would fire — including which
 * scope wins and which rules end up shadowed.
 *
 * Pure data — no React, no fetches. Just deterministic resolution.
 */

import { HOOK_EVENT_CATALOG } from "@polpo-ai/core/hook-events";

export type RuleScope = "task" | "mission" | "global";

/** Minimal NotificationRule shape — matches what the UI receives over the API. */
export interface AnyRule {
  id: string;
  name?: string;
  events: string[];
  channels?: string[];
  severity?: string;
  template?: string;
  condition?: Record<string, unknown> | null;
  cooldownMs?: number;
  includeOutcomes?: boolean;
  actions?: Array<{ type: string } & Record<string, unknown>>;
}

/** Scoped rules attached to a task or mission. */
export interface ScopedRules {
  rules?: AnyRule[];
  inherit?: boolean;
}

/** Result of applied-rule resolution. */
export interface AppliedRule {
  rule: AnyRule;
  scope: RuleScope;
  /** Events from the candidate pool that this rule actually matches. */
  matchedEvents: string[];
  /** Marked true when a more-specific scope would replace this rule (inherit:false). */
  shadowed?: boolean;
}

// ── Glob matcher — mirror runtime ─────────────────────────────────────

/**
 * Simple glob matcher for event names.
 * Supports "*" as single-segment wildcard and "**" as multi-segment.
 * Mirrors src/notifications/index.ts matchGlob exactly.
 */
export function matchGlob(pattern: string, event: string): boolean {
  if (pattern === event) return true;
  if (pattern === "*") return true;
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__GLOBSTAR__")
    .replace(/\*/g, "[^:]*")
    .replace(/__GLOBSTAR__/g, ".*");
  try {
    return new RegExp(`^${regexStr}$`).test(event);
  } catch {
    return false;
  }
}

// ── Default candidate pools (per UI surface) ─────────────────────────

/** Events a mission detail page wants to preview. */
const MISSION_LIFECYCLE_EVENTS: string[] = HOOK_EVENT_CATALOG
  .filter(e => e.category === "mission" || e.category === "schedule" || e.category === "checkpoint" || e.category === "delay" || e.category === "quality")
  .map(e => e.name);

/** Events a task detail page wants to preview. */
const TASK_LIFECYCLE_EVENTS: string[] = HOOK_EVENT_CATALOG
  .filter(e =>
    e.category === "task"
    || e.category === "agent"
    || e.category === "assessment"
    || e.category === "approval"
    || e.category === "sla"
    || e.category === "escalation"
    || e.category === "watcher",
  )
  .map(e => e.name);

// ── Resolution ────────────────────────────────────────────────────────

/** Return the rules from `pool` that match any event in `candidates`. */
function matchPool(
  pool: AnyRule[],
  candidates: string[],
): { rule: AnyRule; matchedEvents: string[] }[] {
  const out: { rule: AnyRule; matchedEvents: string[] }[] = [];
  for (const rule of pool) {
    const matched = candidates.filter(ev => rule.events.some(p => matchGlob(p, ev)));
    if (matched.length > 0) out.push({ rule, matchedEvents: matched });
  }
  return out;
}

/**
 * Resolve applied rules for a mission detail view.
 *
 * Precedence: mission-scoped wins. If missionScoped has matches AND
 * inherit:false, global rules are marked shadowed (still listed for
 * transparency, just dimmed).
 */
export function resolveAppliedRulesForMission(opts: {
  missionScoped?: ScopedRules;
  globalRules?: AnyRule[];
  candidateEvents?: string[];
}): AppliedRule[] {
  const candidates = opts.candidateEvents ?? MISSION_LIFECYCLE_EVENTS;
  const missionPool = opts.missionScoped?.rules ?? [];
  const globalPool = opts.globalRules ?? [];

  const missionMatches = matchPool(missionPool, candidates);
  const globalMatches = matchPool(globalPool, candidates);

  const missionShadowsGlobal =
    missionMatches.length > 0 && opts.missionScoped?.inherit === false;

  const out: AppliedRule[] = [];
  for (const m of missionMatches) {
    out.push({ rule: m.rule, scope: "mission", matchedEvents: m.matchedEvents });
  }
  for (const g of globalMatches) {
    out.push({
      rule: g.rule,
      scope: "global",
      matchedEvents: g.matchedEvents,
      shadowed: missionShadowsGlobal,
    });
  }
  return out;
}

/**
 * Resolve applied rules for a task detail view.
 *
 * Precedence: task > mission > global.
 *  - task w/ inherit:false → mission & global shadowed (when task has matches)
 *  - mission w/ inherit:false → global shadowed (when mission has matches)
 */
export function resolveAppliedRulesForTask(opts: {
  taskScoped?: ScopedRules;
  missionScoped?: ScopedRules;
  globalRules?: AnyRule[];
  candidateEvents?: string[];
}): AppliedRule[] {
  const candidates = opts.candidateEvents ?? TASK_LIFECYCLE_EVENTS;
  const taskPool = opts.taskScoped?.rules ?? [];
  const missionPool = opts.missionScoped?.rules ?? [];
  const globalPool = opts.globalRules ?? [];

  const taskMatches = matchPool(taskPool, candidates);
  const missionMatches = matchPool(missionPool, candidates);
  const globalMatches = matchPool(globalPool, candidates);

  const taskHasMatches = taskMatches.length > 0;
  const missionHasMatches = missionMatches.length > 0;

  // Task w/ inherit:false shadows everything below.
  const taskShadowsParents = taskHasMatches && opts.taskScoped?.inherit === false;
  // Mission w/ inherit:false shadows global (when mission has matches).
  // Note: if taskShadowsParents is true, mission is already going to be shadowed.
  const missionShadowsGlobal = missionHasMatches && opts.missionScoped?.inherit === false;

  const out: AppliedRule[] = [];
  for (const t of taskMatches) {
    out.push({ rule: t.rule, scope: "task", matchedEvents: t.matchedEvents });
  }
  for (const m of missionMatches) {
    out.push({
      rule: m.rule,
      scope: "mission",
      matchedEvents: m.matchedEvents,
      shadowed: taskShadowsParents,
    });
  }
  for (const g of globalMatches) {
    out.push({
      rule: g.rule,
      scope: "global",
      matchedEvents: g.matchedEvents,
      shadowed: taskShadowsParents || missionShadowsGlobal,
    });
  }
  return out;
}
