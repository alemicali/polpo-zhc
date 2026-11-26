/**
 * The org chart's communication lines overlay: the viewer's choice to show it (this browser only,
 * off by default) and the edges it draws (GET /agents/lines).
 */
import { MarkerType, type Edge } from "@xyflow/react";
import type { AgentLinesChart } from "@polpo-ai/react";

/** Where the viewer's choice to show the communication lines is kept (this browser only). */
export const SHOW_LINES_KEY = "polpo.orgChart.showLines";

export function readShowLines(): boolean {
  try { return globalThis.localStorage?.getItem(SHOW_LINES_KEY) === "1"; } catch { return false; }
}

export function writeShowLines(on: boolean): void {
  try { globalThis.localStorage?.setItem(SHOW_LINES_KEY, on ? "1" : "0"); } catch { /* storage unavailable */ }
}

const LINE_COLOR = "color-mix(in oklch, var(--chart-3) 70%, transparent)";

/**
 * The communication lines between the agents on the chart, one edge per pair (both directions:
 * arrows at both ends). Agents that talk to anyone ("open") get no edges (they would join
 * everyone): their node says so instead.
 */
export function communicationLineEdges(chart: AgentLinesChart, onChart: ReadonlySet<string>): Edge[] {
  const directed = chart.edges.filter((e) => e.kind !== "open" && onChart.has(e.from) && onChart.has(e.to));
  const has = new Set(directed.map((e) => `${e.from}>${e.to}`));
  const edges: Edge[] = [];
  const done = new Set<string>();
  for (const e of directed) {
    const pair = [e.from, e.to].sort().join("~");
    if (done.has(pair)) continue;
    done.add(pair);
    const both = has.has(`${e.to}>${e.from}`);
    const marker = { type: MarkerType.ArrowClosed, width: 12, height: 12, color: LINE_COLOR };
    edges.push({
      id: `line-${pair}`,
      source: e.from,
      target: e.to,
      type: "default",
      className: "communication-line",
      style: { stroke: LINE_COLOR, strokeWidth: 1.5, strokeDasharray: "3 4" },
      markerEnd: marker,
      ...(both ? { markerStart: { ...marker, orient: "auto-start-reverse" } } : {}),
      data: { kind: "communication", both },
    });
  }
  return edges;
}
