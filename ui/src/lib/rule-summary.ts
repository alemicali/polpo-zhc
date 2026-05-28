/**
 * Build a one-sentence English summary of a notification rule.
 *
 * Used by the rule form dialog (live preview) and the Rules tab card so the
 * user can immediately see what a rule will actually do.
 */

import { getHookEventDef, HOOK_EVENT_GLOBS } from "@polpo-ai/core/hook-events";

export interface RuleSummaryInput {
  name?: string;
  events?: string[];
  channels?: string[];
  severity?: string;
  condition?: Record<string, unknown> | null;
  cooldownMs?: number;
  includeOutcomes?: boolean;
  actions?: Array<Record<string, unknown>>;
}

/** Human label for one event entry — prefer catalog label, fall back to name. */
function eventPhrase(name: string): string {
  const def = getHookEventDef(name);
  if (def) return def.label.toLowerCase();
  const glob = HOOK_EVENT_GLOBS.find(g => g.pattern === name);
  if (glob) return glob.label.toLowerCase();
  return name;
}

/** Join events into a natural phrase: "A, B or C". */
function joinEvents(events: string[]): string {
  if (events.length === 0) return "nothing";
  if (events.length === 1) return eventPhrase(events[0]);
  if (events.length === 2) return `${eventPhrase(events[0])} or ${eventPhrase(events[1])}`;
  const head = events.slice(0, -1).map(eventPhrase).join(", ");
  return `${head}, or ${eventPhrase(events[events.length - 1])}`;
}

/** Walk a condition object and collect every dotted field referenced. */
function collectConditionKeys(condition: unknown, out: Set<string>): void {
  if (!condition || typeof condition !== "object") return;
  const c = condition as Record<string, unknown>;
  if (Array.isArray(c.and)) c.and.forEach(child => collectConditionKeys(child, out));
  if (Array.isArray(c.or)) c.or.forEach(child => collectConditionKeys(child, out));
  if (c.not) collectConditionKeys(c.not, out);
  if (typeof c.field === "string") out.add(c.field);
}

function formatCooldown(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}min`;
  if (ms >= 1000) return `${Math.round(ms / 1000)}s`;
  return `${ms}ms`;
}

export function summarizeRule(input: RuleSummaryInput): string {
  const events = input.events ?? [];
  const channels = input.channels ?? [];
  const actions = input.actions ?? [];
  const sev = input.severity && input.severity !== "info" ? ` [${input.severity}]` : "";

  // Lead clause — what triggers the rule and where it ends up.
  const trigger = `When ${joinEvents(events)}${sev}`;
  const tail = channels.length > 0
    ? `notify via ${channels.join(", ")}`
    : actions.length > 0
      ? `run ${actions.length} action${actions.length === 1 ? "" : "s"}`
      : "do nothing (no channels, no actions)";

  const parts: string[] = [`${trigger} → ${tail}.`];

  // Cooldown.
  if (input.cooldownMs && input.cooldownMs > 0) {
    parts.push(`Min ${formatCooldown(input.cooldownMs)} between fires.`);
  }

  // Condition.
  if (input.condition && Object.keys(input.condition).length > 0) {
    const keys = new Set<string>();
    collectConditionKeys(input.condition, keys);
    if (keys.size > 0) {
      const list = [...keys].slice(0, 4).join(", ");
      parts.push(`Only when ${list} match.`);
    } else {
      parts.push("Only when the condition matches.");
    }
  }

  // Outcomes.
  if (input.includeOutcomes) {
    parts.push("Includes task outcomes.");
  }

  // Actions (only mention when we also notify; otherwise the lead clause covers it).
  if (actions.length > 0 && channels.length > 0) {
    const types = [...new Set(actions.map(a => String(a.type ?? "?")))].join(", ");
    parts.push(`Also runs ${actions.length} action${actions.length === 1 ? "" : "s"} (${types}).`);
  }

  return parts.join(" ");
}
