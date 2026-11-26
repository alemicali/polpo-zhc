/**
 * Decisions in the dashboard: an answer as headline + probability bars, the playground's question
 * drafts and state, and the Settings form ↔ settings.decisionModel / settings.decisions.
 */
import type { DecideRequest, DecisionAnswer, DecisionModelSetting, DecisionQuestion, DecisionQuestionType, DecisionSettings } from "@polpo-ai/react";
import type { VaultRef } from "@/lib/vault-ref";

export interface AnswerBar { label: string; value: number; chosen?: boolean }

/** An answer's headline and bars (the same reading as the MCP decision card). */
export function answerBars(a: DecisionAnswer): { headline: string; bars: AnswerBar[]; relative?: boolean } {
  if (a.type === "predicate") {
    const p = a.probability ?? 0;
    return { headline: a.value ? "Yes" : "No", bars: [{ label: "yes", value: p, chosen: p >= 0.5 }, { label: "no", value: 1 - p, chosen: p < 0.5 }] };
  }
  if (a.type === "choice") {
    const bars = a.probabilities
      ? Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).map(([label, value]) => ({ label, value, chosen: label === a.choice }))
      : [{ label: a.choice ?? "?", value: 1, chosen: true }];
    return { headline: a.choice ?? "?", bars };
  }
  if (a.type === "score") {
    const bars = a.probabilities ? Object.entries(a.probabilities).map(([label, value]) => ({ label, value, chosen: label === a.level })) : [];
    return { headline: `${(a.score ?? 0).toFixed(2)}${a.level ? ` · ${a.level}` : ""}`, bars };
  }
  const ranking = a.ranking ?? [];
  const best = Math.max(...ranking.map((r) => r.score), 0) || 1;
  return {
    headline: ranking.map((r) => r.label).slice(0, 3).join(" > ") + (ranking.length > 3 ? " > …" : ""),
    bars: ranking.map((r, i) => ({ label: `${i + 1}. ${r.label}`, value: r.score / best, chosen: i === 0 })), relative: true,
  };
}

// ── Playground ──

export interface QuestionDraft { name: string; type: DecisionQuestionType; instructions: string; list: string; threshold: string }

export const newQuestionDraft = (i: number): QuestionDraft => ({ name: `q${i}`, type: "predicate", instructions: "", list: "", threshold: "" });

/** A draft as the API's question (lines → choices "value: description", levels or items). */
export function draftToQuestion(d: QuestionDraft): DecisionQuestion {
  const lines = d.list.split("\n").map((l) => l.trim()).filter(Boolean);
  const threshold = d.threshold.trim() ? Number(d.threshold) : undefined;
  return {
    name: d.name.trim(), type: d.type, instructions: d.instructions.trim(),
    ...(d.type === "choice" ? { choices: lines.map((l) => { const i = l.indexOf(":"); return i > 0 ? { value: l.slice(0, i).trim(), description: l.slice(i + 1).trim() } : { value: l }; }) } : {}),
    ...(d.type === "score" ? { levels: lines } : {}),
    ...(d.type === "rank" ? { items: lines } : {}),
    ...(threshold !== undefined && Number.isFinite(threshold) ? { threshold } : {}),
  };
}

/** The state as typed: JSON when it parses as an object or array, else the text. */
export function parseDecisionState(text: string): DecideRequest["state"] {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try { return JSON.parse(t) as Record<string, unknown>; } catch { /* text */ }
  }
  return text;
}

/** One answer in a few words (the log's rows). */
export function shortAnswer(a: DecisionAnswer): string {
  const v = a.type === "predicate" ? (a.value ? "yes" : "no") : a.type === "choice" ? a.choice : a.type === "score" ? a.level ?? a.score?.toFixed(2) : (a.ranking ?? []).map((r) => r.label).join(" > ");
  return `${a.name}: ${v ?? "?"}`;
}

// ── Settings ──

export interface DecisionForm {
  gateway: string;
  model: string;
  credentialRef: VaultRef | null;
  credentialField: string;
  fallbackModel: string;
  fallbackBelow: string;
  zeroDataRetention: boolean;
  unconfigured: "error" | "orchestrator";
  retention: string;
  retentionDays: string;
  storeInputs: "capped" | "hash";
}

/** The form from the saved settings. */
export function decisionFormFrom(model: DecisionModelSetting | undefined, s: DecisionSettings | undefined): DecisionForm {
  const obj = typeof model === "object" && model ? model : undefined;
  const str = typeof model === "string" ? model : undefined;
  const i = str ? str.indexOf(":") : -1;
  const fb = obj?.fallback;
  return {
    gateway: obj?.gateway ?? (str && i > 0 ? str.slice(0, i) : "vercel-ai-gateway"),
    model: obj?.model ?? (str ? (i > 0 ? str.slice(i + 1) : str) : ""),
    credentialRef: obj?.credentialRef ?? null,
    credentialField: obj?.credentialField ?? "",
    fallbackModel: typeof fb === "string" ? fb : fb?.model ?? "",
    fallbackBelow: typeof fb === "object" && fb?.confidenceBelow !== undefined ? String(fb.confidenceBelow) : "",
    zeroDataRetention: !!obj?.zeroDataRetention,
    unconfigured: s?.unconfigured ?? "error",
    retention: s?.retention ? String(s.retention) : "",
    retentionDays: s?.retentionDays !== undefined ? String(s.retentionDays) : "",
    storeInputs: s?.storeInputs ?? "capped",
  };
}

/** The settings PATCH from the form (an empty model removes the decision model). */
export function decisionPatchFrom(f: DecisionForm): { decisionModel: DecisionModelSetting | null; decisions: DecisionSettings | null } {
  const below = f.fallbackBelow.trim() ? Number(f.fallbackBelow) : undefined;
  const fallback = f.fallbackModel.trim() ? (below !== undefined && Number.isFinite(below) ? { model: f.fallbackModel.trim(), confidenceBelow: below } : f.fallbackModel.trim()) : undefined;
  const decisionModel: DecisionModelSetting | null = f.model.trim() ? {
    gateway: f.gateway, model: f.model.trim(),
    ...(f.credentialRef ? { credentialRef: f.credentialRef } : {}), ...(f.credentialRef && f.credentialField.trim() ? { credentialField: f.credentialField.trim() } : {}),
    ...(fallback ? { fallback } : {}), ...(f.zeroDataRetention ? { zeroDataRetention: true } : {}),
  } : null;
  const decisions: DecisionSettings = {
    ...(f.unconfigured !== "error" ? { unconfigured: f.unconfigured } : {}),
    ...(f.retention.trim() && Number(f.retention) >= 1 ? { retention: Math.floor(Number(f.retention)) } : {}),
    ...(f.retentionDays.trim() && Number(f.retentionDays) >= 0 ? { retentionDays: Math.floor(Number(f.retentionDays)) } : {}),
    ...(f.storeInputs !== "capped" ? { storeInputs: f.storeInputs } : {}),
  };
  return { decisionModel, decisions: Object.keys(decisions).length ? decisions : null };
}
