/**
 * Team colors for visual distinction across agent views.
 */

export const TEAM_COLORS = [
  { bg: "bg-primary/10", border: "border-primary/30", text: "text-primary", dot: "bg-primary", badgeBg: "bg-primary/20", gradientFrom: "from-primary/20", gradientVia: "via-primary/10" },
  { bg: "bg-violet-500/10", border: "border-violet-500/30", text: "text-violet-400", dot: "bg-violet-400", badgeBg: "bg-violet-500/20", gradientFrom: "from-violet-500/20", gradientVia: "via-violet-500/10" },
  { bg: "bg-emerald-500/10", border: "border-emerald-500/30", text: "text-emerald-400", dot: "bg-emerald-400", badgeBg: "bg-emerald-500/20", gradientFrom: "from-emerald-500/20", gradientVia: "via-emerald-500/10" },
  { bg: "bg-amber-500/10", border: "border-amber-500/30", text: "text-amber-400", dot: "bg-amber-400", badgeBg: "bg-amber-500/20", gradientFrom: "from-amber-500/20", gradientVia: "via-amber-500/10" },
  { bg: "bg-rose-500/10", border: "border-rose-500/30", text: "text-rose-400", dot: "bg-rose-400", badgeBg: "bg-rose-500/20", gradientFrom: "from-rose-500/20", gradientVia: "via-rose-500/10" },
  { bg: "bg-cyan-500/10", border: "border-cyan-500/30", text: "text-cyan-400", dot: "bg-cyan-400", badgeBg: "bg-cyan-500/20", gradientFrom: "from-cyan-500/20", gradientVia: "via-cyan-500/10" },
];

export type TeamColor = (typeof TEAM_COLORS)[number];

export function getTeamColor(index: number): TeamColor {
  return TEAM_COLORS[index % TEAM_COLORS.length];
}
