/**
 * Suite roles (the judge, the simulated user, the generator, the reviewer): what kind of player a
 * role value names, and who it is in words.
 */
import type { SuiteRole } from "@polpo-ai/react";
import { agentEngineInfo } from "@/lib/engine-mark";

export type SuiteRoleKind = "polpo" | "agent" | "block";

export function roleKind(role: SuiteRole | undefined): SuiteRoleKind {
  if (role?.agent) return "agent";
  if (role && (role.model || role.reasoning || role.engine)) return "block";
  return "polpo";
}

/** "Polpo", "agent judge-bot@1.2.0", "openai:gpt-x · Codex CLI": who plays a role, in words. */
export function describeRole(role: SuiteRole | undefined, fallback = "Polpo"): string {
  const kind = roleKind(role);
  if (kind === "polpo") return fallback;
  if (kind === "agent") return `agent ${role!.agent}`;
  const { engine, model } = agentEngineInfo({ model: role!.model, engine: role!.engine });
  return [model, engine.label].filter(Boolean).join(" · ");
}
