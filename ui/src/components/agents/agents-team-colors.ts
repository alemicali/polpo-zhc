/**
 * Team colors for visual distinction across agent views: the look's agent colour tokens
 * (--agent-1 … --agent-10, lib/agent-colors.ts), so every palette and custom look recolours them.
 */
import { AGENT_COLOR_COUNT, agentColorClasses } from "@/lib/agent-colors";

export const TEAM_COLORS = Array.from({ length: AGENT_COLOR_COUNT }, (_, i) => {
  const c = agentColorClasses(i + 1);
  return { bg: c.bg, border: c.border, text: c.text, dot: c.dot, badgeBg: c.badgeBg, gradientFrom: c.gradientFrom, gradientVia: c.gradientVia };
});

export type TeamColor = (typeof TEAM_COLORS)[number];

export function getTeamColor(index: number): TeamColor {
  return TEAM_COLORS[((index % TEAM_COLORS.length) + TEAM_COLORS.length) % TEAM_COLORS.length];
}
