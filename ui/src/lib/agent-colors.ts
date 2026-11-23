/**
 * The agent colours: ten design tokens (--agent-1 … --agent-10, each with a readable
 * --agent-N-foreground), defined for light and dark by every palette and settable by a custom look
 * (Configuration → Appearance → Agents, settings.appearance.custom.*.agent1…). An agent gets one by
 * a stable hash of its name, or the one chosen in its identity (identity.color: "agent3").
 *
 * The classes are spelled out (Tailwind only generates what it reads in the source).
 */
import { useSyncExternalStore } from "react";
import { agentColorIndexFromName } from "@polpo-ai/core/appearance";

export const AGENT_COLOR_COUNT = 10;
export type AgentColorToken = `agent${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10}`;
export const AGENT_COLOR_TOKENS = Array.from({ length: AGENT_COLOR_COUNT }, (_, i) => `agent${i + 1}` as AgentColorToken);

/** The classes for one agent colour. */
export interface AgentColorClasses {
  /** e.g. 3 */
  index: number;
  token: AgentColorToken;
  /** the filled tile: bg-agent-3 text-agent-3-foreground */
  solid: string;
  /** a tinted badge or row: bg-agent-3/15 text-agent-3 */
  soft: string;
  text: string;
  bg: string;
  /** a dot or bar */
  dot: string;
  border: string;
  ring: string;
  /** the team cards' header wash */
  gradientFrom: string;
  gradientVia: string;
  badgeBg: string;
}

const C = (i: number, solid: string, soft: string, text: string, bg: string, dot: string, border: string, ring: string, gradientFrom: string, gradientVia: string, badgeBg: string): AgentColorClasses =>
  ({ index: i, token: `agent${i}` as AgentColorToken, solid, soft, text, bg, dot, border, ring, gradientFrom, gradientVia, badgeBg });

const CLASSES: AgentColorClasses[] = [
  C(1, "bg-agent-1 text-agent-1-foreground", "bg-agent-1/15 text-agent-1", "text-agent-1", "bg-agent-1/10", "bg-agent-1", "border-agent-1/30", "ring-agent-1/30", "from-agent-1/20", "via-agent-1/10", "bg-agent-1/20"),
  C(2, "bg-agent-2 text-agent-2-foreground", "bg-agent-2/15 text-agent-2", "text-agent-2", "bg-agent-2/10", "bg-agent-2", "border-agent-2/30", "ring-agent-2/30", "from-agent-2/20", "via-agent-2/10", "bg-agent-2/20"),
  C(3, "bg-agent-3 text-agent-3-foreground", "bg-agent-3/15 text-agent-3", "text-agent-3", "bg-agent-3/10", "bg-agent-3", "border-agent-3/30", "ring-agent-3/30", "from-agent-3/20", "via-agent-3/10", "bg-agent-3/20"),
  C(4, "bg-agent-4 text-agent-4-foreground", "bg-agent-4/15 text-agent-4", "text-agent-4", "bg-agent-4/10", "bg-agent-4", "border-agent-4/30", "ring-agent-4/30", "from-agent-4/20", "via-agent-4/10", "bg-agent-4/20"),
  C(5, "bg-agent-5 text-agent-5-foreground", "bg-agent-5/15 text-agent-5", "text-agent-5", "bg-agent-5/10", "bg-agent-5", "border-agent-5/30", "ring-agent-5/30", "from-agent-5/20", "via-agent-5/10", "bg-agent-5/20"),
  C(6, "bg-agent-6 text-agent-6-foreground", "bg-agent-6/15 text-agent-6", "text-agent-6", "bg-agent-6/10", "bg-agent-6", "border-agent-6/30", "ring-agent-6/30", "from-agent-6/20", "via-agent-6/10", "bg-agent-6/20"),
  C(7, "bg-agent-7 text-agent-7-foreground", "bg-agent-7/15 text-agent-7", "text-agent-7", "bg-agent-7/10", "bg-agent-7", "border-agent-7/30", "ring-agent-7/30", "from-agent-7/20", "via-agent-7/10", "bg-agent-7/20"),
  C(8, "bg-agent-8 text-agent-8-foreground", "bg-agent-8/15 text-agent-8", "text-agent-8", "bg-agent-8/10", "bg-agent-8", "border-agent-8/30", "ring-agent-8/30", "from-agent-8/20", "via-agent-8/10", "bg-agent-8/20"),
  C(9, "bg-agent-9 text-agent-9-foreground", "bg-agent-9/15 text-agent-9", "text-agent-9", "bg-agent-9/10", "bg-agent-9", "border-agent-9/30", "ring-agent-9/30", "from-agent-9/20", "via-agent-9/10", "bg-agent-9/20"),
  C(10, "bg-agent-10 text-agent-10-foreground", "bg-agent-10/15 text-agent-10", "text-agent-10", "bg-agent-10/10", "bg-agent-10", "border-agent-10/30", "ring-agent-10/30", "from-agent-10/20", "via-agent-10/10", "bg-agent-10/20"),
];

/** An agent colour token ("agent3", or 3), or null when it is not one. */
export function parseAgentColor(value: unknown): AgentColorToken | null {
  if (typeof value === "number") return Number.isInteger(value) && value >= 1 && value <= AGENT_COLOR_COUNT ? `agent${value}` as AgentColorToken : null;
  if (typeof value !== "string") return null;
  const m = /^agent(\d{1,2})$/.exec(value.trim());
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= AGENT_COLOR_COUNT ? `agent${n}` as AgentColorToken : null;
}

/** A stable 1…10 from a name (FNV-1a, the server's too: the MCP cards match): the same agent, the same colour, on every screen and reload. */
export { agentColorIndexFromName };

/** The agent's colour index: its chosen colour (identity.color) when valid, else by its name. */
export function agentColorIndex(name: string | undefined, chosen?: unknown): number {
  const token = parseAgentColor(chosen);
  if (token) return Number(token.slice(5));
  return agentColorIndexFromName(name ?? "");
}

/** The classes of a colour index (1-based, wraps). */
export function agentColorClasses(index: number): AgentColorClasses {
  const i = ((Math.round(index) - 1) % AGENT_COLOR_COUNT + AGENT_COLOR_COUNT) % AGENT_COLOR_COUNT;
  return CLASSES[i];
}

/** An agent's colour classes, from its name and chosen colour. */
export function agentColor(name: string | undefined, chosen?: unknown): AgentColorClasses {
  return agentColorClasses(agentColorIndex(name, chosen));
}

// ── The agents' chosen colours, shared by every avatar (kept in step by <AgentColorsSync />) ──

let chosenColors: Record<string, AgentColorToken> = {};
const listeners = new Set<() => void>();

/** Record the agents' chosen colours (name → identity.color); avatars re-render. */
export function setAgentColorChoices(agents: Array<{ name: string; identity?: { color?: unknown } | null }>): void {
  const next: Record<string, AgentColorToken> = {};
  for (const a of agents) {
    const token = parseAgentColor(a.identity?.color);
    if (token) next[a.name] = token;
  }
  const same = Object.keys(next).length === Object.keys(chosenColors).length && Object.entries(next).every(([k, v]) => chosenColors[k] === v);
  if (same) return;
  chosenColors = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** An agent's colour classes (its chosen colour, else by its name); `chosen` wins when given. */
export function useAgentColor(name: string | undefined, chosen?: unknown): AgentColorClasses {
  const choices = useSyncExternalStore(subscribe, () => chosenColors, () => chosenColors);
  return agentColor(name, parseAgentColor(chosen) ?? (name ? choices[name] : undefined));
}
