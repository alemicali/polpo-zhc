/**
 * The orchestrator's name as people see it (settings.orchestratorName): in the chats, the group
 * member list, the messaging channels, MCP replies and its own system prompt. "Polpo" when unset.
 * It is a display name only: "Polpo" stays the product/platform name, and the instance's branding
 * (settings.branding.productName) never renames the orchestrator.
 */

export const DEFAULT_ORCHESTRATOR_NAME = "Polpo";
export const ORCHESTRATOR_NAME_MAX_LENGTH = 40;

/** A valid name (trimmed, 1–40 characters, no line breaks), or undefined. */
export function normalizeOrchestratorName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (!name || name.length > ORCHESTRATOR_NAME_MAX_LENGTH || /[\r\n]/.test(name)) return undefined;
  return name;
}

/** The orchestrator's display name for these settings ("Polpo" when none is set). */
export function orchestratorName(settings?: { orchestratorName?: string } | null): string {
  return normalizeOrchestratorName(settings?.orchestratorName) ?? DEFAULT_ORCHESTRATOR_NAME;
}
