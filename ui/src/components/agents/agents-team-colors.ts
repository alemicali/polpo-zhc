/**
 * Team colors for visual distinction across agent views: the primary, then the look's categorical
 * chart colours (--chart-1 … --chart-5), so every palette and custom look recolours them.
 */

export const TEAM_COLORS = [
  { bg: "bg-primary/10", border: "border-primary/30", text: "text-primary", dot: "bg-primary", badgeBg: "bg-primary/20", gradientFrom: "from-primary/20", gradientVia: "via-primary/10" },
  { bg: "bg-chart-1/10", border: "border-chart-1/30", text: "text-chart-1", dot: "bg-chart-1", badgeBg: "bg-chart-1/20", gradientFrom: "from-chart-1/20", gradientVia: "via-chart-1/10" },
  { bg: "bg-chart-2/10", border: "border-chart-2/30", text: "text-chart-2", dot: "bg-chart-2", badgeBg: "bg-chart-2/20", gradientFrom: "from-chart-2/20", gradientVia: "via-chart-2/10" },
  { bg: "bg-chart-3/10", border: "border-chart-3/30", text: "text-chart-3", dot: "bg-chart-3", badgeBg: "bg-chart-3/20", gradientFrom: "from-chart-3/20", gradientVia: "via-chart-3/10" },
  { bg: "bg-chart-4/10", border: "border-chart-4/30", text: "text-chart-4", dot: "bg-chart-4", badgeBg: "bg-chart-4/20", gradientFrom: "from-chart-4/20", gradientVia: "via-chart-4/10" },
  { bg: "bg-chart-5/10", border: "border-chart-5/30", text: "text-chart-5", dot: "bg-chart-5", badgeBg: "bg-chart-5/20", gradientFrom: "from-chart-5/20", gradientVia: "via-chart-5/10" },
];

export type TeamColor = (typeof TEAM_COLORS)[number];

export function getTeamColor(index: number): TeamColor {
  return TEAM_COLORS[index % TEAM_COLORS.length];
}
