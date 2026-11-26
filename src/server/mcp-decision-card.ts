/**
 * The decision card (an MCP App shown by polpo_decision_show): one decision's answers with
 * probability bars (yes / no, each option, each level, the ranked items), its model, cost and
 * whether it is calibrated; or the latest decisions. Built from the REST shapes; the widget
 * (widgets/decision-card) draws it, the text is for clients without MCP Apps.
 */
export interface DecisionCardKey { createdAt: number; seq: number }
type Appearance = { light?: Record<string, string>; dark?: Record<string, string> };

export interface DecisionCardBar { label: string; value: number; chosen?: boolean }

export interface DecisionCardAnswer {
  name: string;
  type: string;
  /** The answer in a few words: "yes", "billing", "2.3 · Blocking", "a > b > c". */
  headline: string;
  bars: DecisionCardBar[];
  confidence?: number;
  threshold?: number;
  uncertain: boolean;
  /** Bars are scores relative to the best (rank), not probabilities. */
  relative?: boolean;
}

export interface DecisionCardItem {
  id: string; at: string; caller: string; model: string; calibrated: boolean; costUsd: number; latencyMs: number;
  status: "ok" | "error"; error?: string; uncertain: boolean; answers: DecisionCardAnswer[];
  questions?: Array<{ name: string; type: string; instructions: string }>;
  state?: string;
}

export interface DecisionListCard { kind: "decisions"; key: DecisionCardKey; generatedAt: string; decisions: DecisionCardItem[]; total: number; link?: string; appearance?: Appearance }
export interface DecisionDetailCard { kind: "decision"; key: DecisionCardKey; generatedAt: string; decision: DecisionCardItem; link?: string; appearance?: Appearance }
export type DecisionCard = DecisionListCard | DecisionDetailCard;

/** The REST shapes the card reads (a log summary or entry). */
export interface DecisionAnswerShape {
  name: string; type: string; value?: boolean; probability?: number; choice?: string; score?: number; level?: string;
  probabilities?: Record<string, number>; ranking?: Array<{ id: string; label: string; score: number; confidence?: number }>;
  confidence?: number; threshold?: number; uncertain: boolean;
}
export interface DecisionShape {
  id: string; at: string; caller: { kind: string; id?: string; label?: string }; model: string; calibrated: boolean; costUsd: number; latencyMs: number;
  status: "ok" | "error"; error?: string; uncertain: boolean; answers: DecisionAnswerShape[];
  questions?: Array<{ name: string; type: string; instructions?: string }>; state?: string;
}

/** An answer as headline + bars. */
export function answerBars(a: DecisionAnswerShape): DecisionCardAnswer {
  const common = { name: a.name, type: a.type, uncertain: a.uncertain, ...(a.confidence !== undefined ? { confidence: a.confidence } : {}), ...(a.threshold !== undefined ? { threshold: a.threshold } : {}) };
  if (a.type === "predicate") {
    const p = a.probability ?? 0;
    return { ...common, headline: a.value ? "yes" : "no", bars: [{ label: "yes", value: p, chosen: p >= 0.5 }, { label: "no", value: 1 - p, chosen: p < 0.5 }] };
  }
  if (a.type === "choice") {
    const bars = a.probabilities
      ? Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).map(([label, value]) => ({ label, value, chosen: label === a.choice }))
      : [{ label: a.choice ?? "?", value: 1, chosen: true }];
    return { ...common, headline: a.choice ?? "?", bars };
  }
  if (a.type === "score") {
    const bars = a.probabilities ? Object.entries(a.probabilities).map(([label, value]) => ({ label, value, chosen: label === a.level })) : [];
    return { ...common, headline: `${(a.score ?? 0).toFixed(2)}${a.level ? ` · ${a.level}` : ""}`, bars };
  }
  const ranking = a.ranking ?? [];
  const best = Math.max(...ranking.map((r) => r.score), 0) || 1;
  return {
    ...common, relative: true, headline: ranking.slice(0, 3).map((r) => r.label).join(" > ") + (ranking.length > 3 ? " > …" : ""),
    bars: ranking.map((r, i) => ({ label: `${i + 1}. ${r.label}`, value: r.score / best, chosen: i === 0 })),
  };
}

function item(d: DecisionShape): DecisionCardItem {
  return {
    id: d.id, at: d.at, caller: [d.caller.kind, d.caller.id ?? d.caller.label].filter(Boolean).join(" · "), model: d.model, calibrated: d.calibrated,
    costUsd: d.costUsd, latencyMs: d.latencyMs, status: d.status, ...(d.error ? { error: d.error } : {}), uncertain: d.uncertain,
    answers: d.answers.map(answerBars),
    ...(d.questions?.some((q) => q.instructions) ? { questions: d.questions.map((q) => ({ name: q.name, type: q.type, instructions: q.instructions ?? "" })) } : {}),
    ...(d.state ? { state: d.state.slice(0, 4000) } : {}),
  };
}

export function buildDecisionListCard(o: { decisions: DecisionShape[]; total: number; key: DecisionCardKey; link?: string }): DecisionListCard {
  return { kind: "decisions", key: o.key, generatedAt: new Date().toISOString(), decisions: o.decisions.map(item), total: o.total, ...(o.link ? { link: o.link } : {}) };
}

export function buildDecisionDetailCard(o: { decision: DecisionShape; key: DecisionCardKey; link?: string }): DecisionDetailCard {
  return { kind: "decision", key: o.key, generatedAt: new Date().toISOString(), decision: item(o.decision), ...(o.link ? { link: o.link } : {}) };
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const answerText = (a: DecisionCardAnswer) => `${a.name}: ${a.headline}${a.confidence !== undefined ? ` (confidence ${a.confidence.toFixed(2)})` : ""}${a.uncertain ? " — uncertain" : ""}`
  + (a.bars.length && !a.relative ? ` [${a.bars.map((b) => `${b.label} ${pct(b.value)}`).join(", ")}]` : "");

/** The card as text (clients without MCP Apps). */
export function decisionCardText(card: DecisionCard): string {
  const head = (d: DecisionCardItem) => `${d.id} · ${d.at.slice(0, 16).replace("T", " ")} · ${d.caller} · ${d.model}${d.calibrated ? "" : " (uncalibrated)"} · $${d.costUsd.toFixed(5)}`;
  if (card.kind === "decisions") {
    if (!card.decisions.length) return "No decisions yet (polpo_decide).";
    return card.decisions.map((d) => `- ${head(d)}${d.status === "error" ? ` · ERROR ${d.error ?? ""}` : ` · ${d.answers.map((a) => `${a.name}: ${a.headline}${a.uncertain ? " (uncertain)" : ""}`).join("; ")}`}`).join("\n");
  }
  const d = card.decision;
  return [head(d), d.status === "error" ? `ERROR ${d.error ?? ""}` : "", ...d.answers.map(answerText)].filter(Boolean).join("\n");
}
