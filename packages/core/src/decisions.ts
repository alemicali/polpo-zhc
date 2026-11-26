/**
 * Decisions: typed judgments with probabilities about a state, from a decision model ("System
 * One" models such as TypeSafe's Jev) — not a chat completion.
 *
 *   decide({ state, questions }) → { answers, model, usage, costUsd, calibrated, latencyMs }
 *
 * Question types (Polpo's neutral shape, mapped to each provider's own):
 *   predicate  yes / no → P(yes)
 *   choice     options with descriptions → the choice and a probability per option
 *   score      ordered levels (lowest first) → a fractional score and a probability per level
 *   rank       a list of items → sorted, composed of one score question per item (no provider
 *              has a native rank)
 *
 * A question's `threshold` (or the request's `thresholds`) marks an answer `uncertain` when its
 * confidence is below it. Providers today: Vercel AI Gateway's Decisions API (POST /v1/decisions,
 * see `decisionsRequestBody` / `parseDecisionsResponse`); the same questions map to TypeSafe's
 * native schema (`typeSafeRequestBody`; Upstage Solar Decide and Ollama's /v1/systemone take it
 * too), so other providers can be added. Without a decision model, Polpo's own chat can answer
 * through the chat pipeline (`fallbackDecisionPrompt`), flagged `calibrated: false`.
 *
 * Pure: no Node API, no network. The service (src/decisions/service.ts) does the calls.
 */
import { parseJsonLoose } from "./agent-suite-evals.js";
import type { GatewayCredential } from "./gateways.js";
import { normalizeVaultRef } from "./vault-ref.js";
import type { MissionDecision } from "./types.js";

// ── Questions ────────────────────────────────────────────────────────

export const DECISION_QUESTION_TYPES = ["predicate", "choice", "score", "rank"] as const;
export type DecisionQuestionType = (typeof DECISION_QUESTION_TYPES)[number];

export const DECISION_LIMITS = {
  maxQuestions: 16,
  /** Questions sent to the model once ranks are expanded (one per item). */
  maxWireQuestions: 40,
  maxChoices: 20,
  maxLevels: 11,
  maxItems: 20,
  maxInstructionChars: 4000,
  maxDescriptionChars: 1000,
  /** The state as text (JSON serialized). */
  maxStateChars: 100_000,
  /** The state kept in the decision log (the rest is hashed only). */
  storedStateChars: 8_000,
  defaultRetention: 1000,
  maxRetention: 20_000,
  defaultRetentionDays: 30,
} as const;

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export interface DecisionChoice { value: string; description?: string }
export interface DecisionLevel { label: string; description?: string }
export interface DecisionItem { id: string; label: string; description?: string }

export interface DecisionQuestion {
  /** Unique in the request: letters, digits, _ and -, starting with a letter. */
  name: string;
  type: DecisionQuestionType;
  instructions: string;
  /** choice: the options. */
  choices?: DecisionChoice[];
  /** score (and rank: the scale each item is rated on): ordered levels, lowest first. */
  levels?: DecisionLevel[];
  /** rank: the items to sort. */
  items?: DecisionItem[];
  /** Confidence (0..1) below which the answer is `uncertain`. */
  threshold?: number;
}

/** The state questions are about: text, a JSON object, or a JSON array. */
export type DecisionState = string | Record<string, unknown> | unknown[];

/** A rerun with another model when confidence is low (Vercel AI Gateway's conditional fallback). */
export interface DecisionFallbackModel {
  model: string;
  /** Rerun when the confidence of any answer is below it; absent: only when the first model fails. */
  confidenceBelow?: number;
}

/** A decision model: a gateway, its model, and where the gateway's key is. */
export interface DecisionModelConfig extends GatewayCredential {
  /** A gateway with the decisions capability (gateways.ts), e.g. "vercel-ai-gateway". */
  gateway: string;
  /** The gateway's model id, e.g. "typesafe-ai/jev". */
  model: string;
  fallback?: DecisionFallbackModel;
  /** Ask the gateway to route only to providers that retain no data. */
  zeroDataRetention?: boolean;
}

/** `settings.decisionModel`: "vercel-ai-gateway:typesafe-ai/jev", or the object. */
export type DecisionModelSetting = string | (Omit<DecisionModelConfig, "fallback"> & { fallback?: string | DecisionFallbackModel });

/** Without a decision model: refuse (default), or let Polpo's own chat answer (uncalibrated). */
export type DecisionUnconfiguredPolicy = "error" | "orchestrator";

/** `settings.decisions`. */
export interface DecisionSettings {
  unconfigured?: DecisionUnconfiguredPolicy;
  /** Decisions kept in the log (default 1000). */
  retention?: number;
  /** Days decisions are kept (default 30; 0 keeps them until `retention` pushes them out). */
  retentionDays?: number;
  /** The log keeps the state capped ("capped", default) or only its hash ("hash"). */
  storeInputs?: "capped" | "hash";
}

export const DEFAULT_DECISION_GATEWAY = "vercel-ai-gateway";

export class DecisionError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "INVALID", readonly problems?: string[]) {
    super(message);
    this.name = "DecisionError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const prob = (v: unknown): number | undefined => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round = (n: number, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

function fallbackModel(v: unknown, where: string): DecisionFallbackModel | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "string") return { model: v.trim() };
  if (!isObj(v) || !str(v.model)) throw new DecisionError(`${where}.fallback must be a model id or { model, confidenceBelow? }`);
  const below = v.confidenceBelow === undefined ? undefined : prob(v.confidenceBelow);
  if (below !== undefined && (below < 0 || below > 1)) throw new DecisionError(`${where}.fallback.confidenceBelow must be between 0 and 1`);
  if (v.confidenceBelow !== undefined && below === undefined) throw new DecisionError(`${where}.fallback.confidenceBelow must be a number`);
  return { model: str(v.model)!, ...(below !== undefined ? { confidenceBelow: below } : {}) };
}

/**
 * Read a decision model setting: "gateway:model" (a model without a gateway goes to the default
 * gateway, Vercel AI Gateway) or { gateway?, model, fallback?, credentialRef?, credentialField?, zeroDataRetention? }.
 * Undefined when not set.
 */
export function parseDecisionModel(setting: unknown, where = "decisionModel"): DecisionModelConfig | undefined {
  if (setting === undefined || setting === null || setting === "") return undefined;
  if (typeof setting === "string") {
    const s = setting.trim();
    const i = s.indexOf(":");
    const gateway = i > 0 ? s.slice(0, i) : DEFAULT_DECISION_GATEWAY;
    const model = i > 0 ? s.slice(i + 1) : s;
    if (!model.trim()) throw new DecisionError(`${where} needs a model, e.g. ${DEFAULT_DECISION_GATEWAY}:typesafe-ai/jev`);
    return { gateway, model: model.trim() };
  }
  if (!isObj(setting)) throw new DecisionError(`${where} must be "gateway:model" or { gateway, model }`);
  const model = str(setting.model);
  if (!model) throw new DecisionError(`${where}.model is required, e.g. typesafe-ai/jev`);
  const ref = setting.credentialRef === undefined || setting.credentialRef === null ? undefined : normalizeVaultRef(setting.credentialRef);
  if (setting.credentialRef !== undefined && setting.credentialRef !== null && !ref) throw new DecisionError(`${where}.credentialRef must be { owner, service } (a vault entry)`);
  const fallback = fallbackModel(setting.fallback, where);
  return {
    gateway: str(setting.gateway) ?? DEFAULT_DECISION_GATEWAY, model,
    ...(ref ? { credentialRef: ref } : {}),
    ...(str(setting.credentialField) ? { credentialField: str(setting.credentialField) } : {}),
    ...(fallback ? { fallback } : {}),
    ...(setting.zeroDataRetention === true ? { zeroDataRetention: true } : {}),
  };
}

/** "gateway:model", as people read it. */
export function formatDecisionModel(c: Pick<DecisionModelConfig, "gateway" | "model">): string {
  return `${c.gateway}:${c.model}`;
}

/** Keep only well-formed decision settings (unknown keys dropped). */
export function normalizeDecisionSettings(raw: unknown): DecisionSettings | undefined {
  if (!isObj(raw)) return undefined;
  const out: DecisionSettings = {};
  if (raw.unconfigured === "error" || raw.unconfigured === "orchestrator") out.unconfigured = raw.unconfigured;
  const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);
  const retention = int(raw.retention);
  if (retention !== undefined && retention >= 1) out.retention = Math.min(retention, DECISION_LIMITS.maxRetention);
  const days = int(raw.retentionDays);
  if (days !== undefined) out.retentionDays = days;
  if (raw.storeInputs === "capped" || raw.storeInputs === "hash") out.storeInputs = raw.storeInputs;
  return Object.keys(out).length ? out : undefined;
}

// ── Validation ───────────────────────────────────────────────────────

export interface DecideInput {
  state: DecisionState;
  questions: DecisionQuestion[];
  /** Another model than settings.decisionModel. */
  model?: DecisionModelSetting;
  /** A confidence threshold for every question, or per question name (a question's own `threshold` wins). */
  thresholds?: number | Record<string, number>;
  /** Rerun with another model on low confidence (or failure). */
  fallback?: string | DecisionFallbackModel;
}

export interface ValidDecideInput {
  state: DecisionState;
  questions: DecisionQuestion[];
  model?: DecisionModelConfig;
  thresholds?: number | Record<string, number>;
  fallback?: DecisionFallbackModel;
}

function text(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

function readQuestion(raw: unknown, i: number, problems: string[]): DecisionQuestion | undefined {
  const at = `questions[${i}]`;
  if (!isObj(raw)) { problems.push(`${at} must be an object`); return undefined; }
  const name = str(raw.name);
  if (!name || !NAME.test(name)) problems.push(`${at}.name must start with a letter and have only letters, digits, _ and - (at most 64)`);
  const type = raw.type as DecisionQuestionType;
  if (!(DECISION_QUESTION_TYPES as readonly unknown[]).includes(type)) { problems.push(`${at}.type must be one of ${DECISION_QUESTION_TYPES.join(", ")}`); return undefined; }
  const instructions = text(raw.instructions, DECISION_LIMITS.maxInstructionChars);
  if (!instructions) problems.push(`${at}.instructions is required: what to decide`);
  const q: DecisionQuestion = { name: name ?? `q${i + 1}`, type, instructions: instructions ?? "" };
  const threshold = raw.threshold === undefined || raw.threshold === null ? undefined : prob(raw.threshold);
  if (raw.threshold !== undefined && raw.threshold !== null && (threshold === undefined || threshold < 0 || threshold > 1)) problems.push(`${at}.threshold must be between 0 and 1`);
  else if (threshold !== undefined) q.threshold = threshold;

  if (type === "choice") {
    const list = Array.isArray(raw.choices) ? raw.choices : isObj(raw.choices) ? Object.entries(raw.choices).map(([value, description]) => ({ value, description })) : undefined;
    if (!list || list.length < 2) problems.push(`${at}.choices needs at least 2 options ({ value, description })`);
    else if (list.length > DECISION_LIMITS.maxChoices) problems.push(`${at}.choices has more than ${DECISION_LIMITS.maxChoices} options`);
    else {
      q.choices = list.map((c, j) => {
        const value = typeof c === "string" ? str(c) : isObj(c) ? str(c.value) : undefined;
        if (!value) problems.push(`${at}.choices[${j}].value is required`);
        const description = isObj(c) ? text(c.description, DECISION_LIMITS.maxDescriptionChars) : undefined;
        return { value: (value ?? "").slice(0, 200), ...(description ? { description } : {}) };
      });
      const values = q.choices.map((c) => c.value);
      if (new Set(values).size !== values.length) problems.push(`${at}.choices values must be unique`);
    }
  }
  if (type === "score" || type === "rank") {
    const list = raw.levels;
    if (list === undefined && type === "rank") q.levels = DEFAULT_RANK_LEVELS.map((l) => ({ ...l }));
    else if (!Array.isArray(list) || list.length < 2) problems.push(`${at}.levels needs at least 2 ordered levels, lowest first ({ label, description })`);
    else if (list.length > DECISION_LIMITS.maxLevels) problems.push(`${at}.levels has more than ${DECISION_LIMITS.maxLevels} levels`);
    else {
      q.levels = list.map((l, j) => {
        const label = typeof l === "string" ? str(l) : isObj(l) ? str(l.label) : undefined;
        if (!label) problems.push(`${at}.levels[${j}].label is required`);
        const description = isObj(l) ? text(l.description, DECISION_LIMITS.maxDescriptionChars) : undefined;
        return { label: (label ?? "").slice(0, 200), ...(description ? { description } : {}) };
      });
      const labels = q.levels.map((l) => l.label);
      if (new Set(labels).size !== labels.length) problems.push(`${at}.levels labels must be unique`);
    }
  }
  if (type === "rank") {
    const list = raw.items;
    if (!Array.isArray(list) || list.length < 2) problems.push(`${at}.items needs at least 2 items to rank ({ id?, label, description? })`);
    else if (list.length > DECISION_LIMITS.maxItems) problems.push(`${at}.items has more than ${DECISION_LIMITS.maxItems} items`);
    else {
      q.items = list.map((it, j) => {
        const label = typeof it === "string" ? str(it) : isObj(it) ? str(it.label) ?? str(it.id) : undefined;
        if (!label) problems.push(`${at}.items[${j}].label is required`);
        const id = isObj(it) ? str(it.id) : undefined;
        const description = isObj(it) ? text(it.description, DECISION_LIMITS.maxDescriptionChars) : undefined;
        return { id: (id ?? String(j + 1)).slice(0, 100), label: (label ?? "").slice(0, 500), ...(description ? { description } : {}) };
      });
      const ids = q.items.map((x) => x.id);
      if (new Set(ids).size !== ids.length) problems.push(`${at}.items ids must be unique`);
    }
  }
  return q;
}

/** The scale every rank item is rated on when the question gives none. */
export const DEFAULT_RANK_LEVELS: readonly DecisionLevel[] = [
  { label: "Very poor fit" }, { label: "Poor fit" }, { label: "Neutral" }, { label: "Good fit" }, { label: "Excellent fit" },
];

/** The state as text: a string as is, JSON pretty-printed. */
export function decisionStateText(state: DecisionState): string {
  return typeof state === "string" ? state : JSON.stringify(state, null, 2) ?? "";
}

/** Validate a decide request; throws DecisionError with every problem. */
export function validateDecideInput(raw: unknown): ValidDecideInput {
  if (!isObj(raw)) throw new DecisionError("The request must be { state, questions }");
  const problems: string[] = [];
  const state = raw.state;
  if (state === undefined || state === null || (typeof state === "string" && !state.trim())) problems.push("state is required: the text or JSON the questions are about");
  else if (typeof state !== "string" && typeof state !== "object") problems.push("state must be a string, an object or an array");
  else if (decisionStateText(state as DecisionState).length > DECISION_LIMITS.maxStateChars) problems.push(`state is larger than ${DECISION_LIMITS.maxStateChars} characters`);
  const list = raw.questions;
  const questions: DecisionQuestion[] = [];
  if (!Array.isArray(list) || list.length === 0) problems.push("questions needs at least one question");
  else if (list.length > DECISION_LIMITS.maxQuestions) problems.push(`at most ${DECISION_LIMITS.maxQuestions} questions`);
  else list.forEach((q, i) => { const r = readQuestion(q, i, problems); if (r) questions.push(r); });
  const names = questions.map((q) => q.name);
  if (new Set(names).size !== names.length) problems.push("question names must be unique");
  if (questions.length && expandQuestions(questions).length > DECISION_LIMITS.maxWireQuestions) {
    problems.push(`too many questions once ranks are expanded (each item is one): at most ${DECISION_LIMITS.maxWireQuestions}`);
  }
  let thresholds: ValidDecideInput["thresholds"];
  if (raw.thresholds !== undefined && raw.thresholds !== null) {
    if (typeof raw.thresholds === "number") {
      if (raw.thresholds < 0 || raw.thresholds > 1) problems.push("thresholds must be between 0 and 1");
      else thresholds = raw.thresholds;
    } else if (isObj(raw.thresholds)) {
      const t: Record<string, number> = {};
      for (const [k, v] of Object.entries(raw.thresholds)) {
        const n = prob(v);
        if (n === undefined || n < 0 || n > 1) problems.push(`thresholds.${k} must be between 0 and 1`);
        else if (!names.includes(k)) problems.push(`thresholds.${k} names no question`);
        else t[k] = n;
      }
      thresholds = t;
    } else problems.push("thresholds must be a number or { questionName: number }");
  }
  let model: DecisionModelConfig | undefined;
  let fallback: DecisionFallbackModel | undefined;
  try { model = parseDecisionModel(raw.model, "model"); } catch (err) { problems.push((err as Error).message); }
  try { fallback = fallbackModel(raw.fallback, "request"); } catch (err) { problems.push((err as Error).message); }
  if (problems.length) throw new DecisionError(problems.length === 1 ? problems[0] : `Invalid decision request: ${problems.join("; ")}`, 400, "INVALID", problems);
  return {
    state: state as DecisionState, questions,
    ...(model ? { model } : {}), ...(thresholds !== undefined ? { thresholds } : {}), ...(fallback ? { fallback } : {}),
  };
}

// ── The questions sent to a model ────────────────────────────────────

export type WireQuestionType = "predicate" | "choice" | "score";

/** A question as a model gets it: ranks become one score question per item. */
export interface WireQuestion {
  name: string;
  type: WireQuestionType;
  instructions: string;
  choices?: DecisionChoice[];
  levels?: DecisionLevel[];
  /** A rank item's question: the rank and the item's index. */
  rank?: { question: string; item: number };
}

/** A model's answer to one wire question. */
export interface WireAnswer {
  name: string;
  /** predicate: P(yes). */
  probability?: number;
  /** choice: the chosen value. */
  choice?: string;
  /** score: 0..levels-1, fractional. */
  score?: number;
  /** choice: by value; score: by level label. */
  probabilities?: Record<string, number>;
  /** The provider's own confidence statistic, when it gives one. */
  confidence?: number;
}

export function rankItemName(question: string, item: number): string {
  return `${question}__item${item + 1}`;
}

/** The questions to send: predicate, choice and score as they are; a rank as one score per item. */
export function expandQuestions(questions: DecisionQuestion[]): WireQuestion[] {
  const out: WireQuestion[] = [];
  for (const q of questions) {
    if (q.type === "rank") {
      (q.items ?? []).forEach((item, i) => out.push({
        name: rankItemName(q.name, i), type: "score",
        instructions: `${q.instructions}\n\nRate this item: ${item.label}${item.description ? ` — ${item.description}` : ""}`,
        levels: q.levels ?? DEFAULT_RANK_LEVELS.map((l) => ({ ...l })),
        rank: { question: q.name, item: i },
      }));
    } else {
      out.push({
        name: q.name, type: q.type, instructions: q.instructions,
        ...(q.choices ? { choices: q.choices } : {}), ...(q.levels ? { levels: q.levels } : {}),
      });
    }
  }
  return out;
}

/**
 * Vercel AI Gateway's Decisions API body (POST /v1/decisions): `input` is the text, or one user
 * message with the JSON as an input_json part; choices are { value, description }, levels { label }
 * (descriptions folded into the label's instructions: the format has no level description).
 */
export function decisionsRequestBody(model: string, state: DecisionState, wire: WireQuestion[], opts: { fallback?: DecisionFallbackModel; zeroDataRetention?: boolean } = {}): Record<string, unknown> {
  const input = typeof state === "string" ? state : [{ role: "user", content: [{ type: "input_json", data: state }] }];
  const questions = wire.map((q) => {
    const levelNotes = q.levels?.some((l) => l.description) ? `\n\nLevels, lowest first:\n${q.levels.map((l, i) => `${i}. ${l.label}${l.description ? `: ${l.description}` : ""}`).join("\n")}` : "";
    return {
      type: q.type, name: q.name, instructions: `${q.instructions}${levelNotes}`,
      ...(q.choices ? { choices: q.choices.map((c) => ({ value: c.value, ...(c.description ? { description: c.description } : {}) })) } : {}),
      ...(q.levels ? { levels: q.levels.map((l) => ({ label: l.label })) } : {}),
    };
  });
  const gateway: Record<string, unknown> = {};
  if (opts.fallback) gateway.models = [opts.fallback.confidenceBelow !== undefined ? { model: opts.fallback.model, when: { confidenceBelow: opts.fallback.confidenceBelow } } : opts.fallback.model];
  if (opts.zeroDataRetention) gateway.zeroDataRetention = true;
  return { model, input, questions, ...(Object.keys(gateway).length ? { providerOptions: { gateway } } : {}) };
}

/**
 * TypeSafe's native schema (also Upstage Solar Decide and Ollama's /v1/systemone): { state,
 * questions: { name: { type: choice | score | noul, instructions, criteria } } }. A predicate is a
 * choice between "yes" and "no" there.
 */
export function typeSafeRequestBody(state: DecisionState, wire: WireQuestion[]): { state: DecisionState; questions: Record<string, { type: "choice" | "score"; instructions: string; criteria: Record<string, string> | string[] }> } {
  const questions: Record<string, { type: "choice" | "score"; instructions: string; criteria: Record<string, string> | string[] }> = {};
  for (const q of wire) {
    if (q.type === "predicate") questions[q.name] = { type: "choice", instructions: q.instructions, criteria: { yes: "Yes", no: "No" } };
    else if (q.type === "choice") questions[q.name] = { type: "choice", instructions: q.instructions, criteria: Object.fromEntries((q.choices ?? []).map((c) => [c.value, c.description ?? c.value])) };
    else questions[q.name] = { type: "score", instructions: q.instructions, criteria: (q.levels ?? []).map((l) => (l.description ? `${l.label}: ${l.description}` : l.label)) };
  }
  return { state, questions };
}

export interface DecisionUsage { inputTokens?: number; outputTokens?: number }

/** A distribution as { key: p }: from { key: p } or [{ value|label|level|index, probability }]. */
function distribution(raw: unknown): Record<string, number> | undefined {
  if (isObj(raw)) {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) { const p = prob(v); if (p !== undefined) out[k] = p; }
    return Object.keys(out).length ? out : undefined;
  }
  if (Array.isArray(raw)) {
    const out: Record<string, number> = {};
    for (const e of raw) {
      if (!isObj(e)) continue;
      const key = str(e.value) ?? str(e.label) ?? str(e.choice) ?? (e.level !== undefined ? String(e.level) : e.index !== undefined ? String(e.index) : undefined);
      const p = prob(e.probability ?? e.p);
      if (key !== undefined && p !== undefined) out[key] = p;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}

/** A score distribution keyed by level label (the provider may key by index or by label). */
function levelDistribution(raw: Record<string, number> | undefined, levels: DecisionLevel[]): Record<string, number> | undefined {
  if (!raw) return undefined;
  const out: Record<string, number> = {};
  for (const [k, p] of Object.entries(raw)) {
    const byLabel = levels.find((l) => l.label === k);
    const idx = /^\d+$/.test(k) ? Number(k) : -1;
    const label = byLabel?.label ?? levels[idx]?.label;
    if (label !== undefined) out[label] = (out[label] ?? 0) + p;
  }
  return Object.keys(out).length ? out : undefined;
}

/** One answer from a provider (or the fallback), read against its wire question. Throws when unreadable. */
function readWireAnswer(q: WireQuestion, raw: Record<string, unknown>): WireAnswer {
  const confidence = prob(raw.confidence);
  const base: WireAnswer = { name: q.name, ...(confidence !== undefined ? { confidence: clamp01(confidence) } : {}) };
  if (q.type === "predicate") {
    let p = prob(raw.probability);
    if (p === undefined && typeof raw.answer === "boolean") p = raw.answer ? 1 : 0;
    if (p === undefined) {
      const d = distribution(raw.probabilities);
      const yes = d?.yes ?? d?.true;
      if (yes !== undefined) p = yes;
    }
    if (p === undefined) throw new DecisionError(`no probability for the yes/no question "${q.name}"`, 502, "BAD_ANSWER");
    return { ...base, probability: clamp01(p) };
  }
  if (q.type === "choice") {
    const values = (q.choices ?? []).map((c) => c.value);
    const d = distribution(raw.probabilities);
    const probabilities = d ? Object.fromEntries(values.filter((v) => d[v] !== undefined).map((v) => [v, clamp01(d[v])])) : undefined;
    let choice = str(raw.choice) ?? str(raw.value) ?? str(raw.answer);
    if ((!choice || !values.includes(choice)) && probabilities && Object.keys(probabilities).length) {
      choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
    }
    if (!choice || !values.includes(choice)) throw new DecisionError(`the answer to "${q.name}" is not one of its options (${values.join(", ")})`, 502, "BAD_ANSWER");
    return { ...base, choice, ...(probabilities && Object.keys(probabilities).length ? { probabilities } : {}) };
  }
  const levels = q.levels ?? [];
  const probabilities = levelDistribution(distribution(raw.probabilities), levels);
  let score = prob(raw.score);
  if (score === undefined && probabilities) {
    const total = Object.values(probabilities).reduce((a, b) => a + b, 0) || 1;
    score = levels.reduce((a, l, i) => a + i * ((probabilities[l.label] ?? 0) / total), 0);
  }
  if (score === undefined) throw new DecisionError(`no score for "${q.name}"`, 502, "BAD_ANSWER");
  return { ...base, score: Math.max(0, Math.min(levels.length - 1, score)), ...(probabilities ? { probabilities } : {}) };
}

/** The answers of a response: an array of { name, … } or an object keyed by name. */
function answerMap(raw: unknown): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  if (Array.isArray(raw)) for (const a of raw) { if (isObj(a) && str(a.name)) map.set(str(a.name)!, a); }
  else if (isObj(raw)) for (const [k, v] of Object.entries(raw)) { if (isObj(v)) map.set(k, v); }
  return map;
}

/**
 * Read Vercel AI Gateway's Decisions response: { answers: [{ type, name, probability | choice +
 * probabilities | score + probabilities }], model, usage, provider_metadata.gateway.cost }.
 * Throws a DecisionError (502) when an answer is missing or unreadable, or a question was refused.
 */
export function parseDecisionsResponse(body: unknown, wire: WireQuestion[]): { answers: WireAnswer[]; model?: string; usage: DecisionUsage; costUsd?: number } {
  if (!isObj(body)) throw new DecisionError("The decision model answered something that is not JSON", 502, "BAD_ANSWER");
  const map = answerMap(body.answers);
  const refused: string[] = [];
  const answers = wire.map((q) => {
    const a = map.get(q.name);
    if (!a) throw new DecisionError(`The decision model gave no answer to "${q.name}"`, 502, "BAD_ANSWER");
    if (a.type === "refusal") { refused.push(q.name); return undefined; }
    return readWireAnswer(q, a);
  });
  if (refused.length) throw new DecisionError(`The decision model refused to answer: ${refused.join(", ")}`, 502, "REFUSED");
  const u = isObj(body.usage) ? body.usage : {};
  const usage: DecisionUsage = {};
  const inTok = prob(u.input_tokens ?? u.inputTokens ?? u.prompt_tokens);
  const outTok = prob(u.output_tokens ?? u.outputTokens ?? u.completion_tokens);
  if (inTok !== undefined) usage.inputTokens = inTok;
  if (outTok !== undefined) usage.outputTokens = outTok;
  const meta = isObj(body.provider_metadata) ? body.provider_metadata : isObj(body.providerMetadata) ? body.providerMetadata : undefined;
  const gw = meta && isObj(meta.gateway) ? meta.gateway : undefined;
  const cost = prob(gw?.cost ?? u.cost);
  return { answers: answers as WireAnswer[], ...(str(body.model) ? { model: str(body.model) } : {}), usage, ...(cost !== undefined ? { costUsd: cost } : {}) };
}

// ── Answers ──────────────────────────────────────────────────────────

export interface DecisionRankEntry { id: string; label: string; score: number; confidence?: number }

export interface DecisionAnswer {
  name: string;
  type: DecisionQuestionType;
  /** predicate: the answer (P(yes) ≥ 0.5). */
  value?: boolean;
  /** predicate: P(yes). */
  probability?: number;
  /** choice: the chosen option. */
  choice?: string;
  /** score: 0..levels-1, fractional (the probability-weighted level). */
  score?: number;
  /** score: the nearest level's label. */
  level?: string;
  /** choice: per option; score: per level label. */
  probabilities?: Record<string, number>;
  /** rank: the items, best first. */
  ranking?: DecisionRankEntry[];
  /** 0..1: the probability of the answer given (rank: the lowest of its items). Undefined when the model gave none. */
  confidence?: number;
  threshold?: number;
  /** Confidence below the threshold (or unknown with a threshold set). */
  uncertain: boolean;
}

function confidenceOf(q: WireQuestion, a: WireAnswer): number | undefined {
  if (a.confidence !== undefined) return a.confidence;
  if (q.type === "predicate") return a.probability === undefined ? undefined : Math.max(a.probability, 1 - a.probability);
  if (q.type === "choice") return a.choice && a.probabilities?.[a.choice] !== undefined ? a.probabilities[a.choice] : undefined;
  if (!a.probabilities) return undefined;
  const level = q.levels?.[Math.round(a.score ?? 0)]?.label;
  return level !== undefined ? a.probabilities[level] : undefined;
}

function thresholdFor(q: DecisionQuestion, thresholds: ValidDecideInput["thresholds"]): number | undefined {
  if (q.threshold !== undefined) return q.threshold;
  if (typeof thresholds === "number") return thresholds;
  return thresholds?.[q.name];
}

const uncertainOf = (confidence: number | undefined, threshold: number | undefined) => threshold !== undefined && (confidence === undefined || confidence < threshold - 1e-12);
const roundDist = (d: Record<string, number> | undefined) => (d ? Object.fromEntries(Object.entries(d).map(([k, v]) => [k, round(v)])) : undefined);

/** Put the model's answers back on the questions: ranks sorted, confidences and thresholds applied. */
export function buildAnswers(questions: DecisionQuestion[], wire: WireQuestion[], answers: WireAnswer[], thresholds?: ValidDecideInput["thresholds"]): DecisionAnswer[] {
  const byName = new Map(answers.map((a) => [a.name, a]));
  return questions.map((q) => {
    const threshold = thresholdFor(q, thresholds);
    if (q.type === "rank") {
      const ranking: DecisionRankEntry[] = (q.items ?? []).map((item, i) => {
        const w = wire.find((x) => x.rank?.question === q.name && x.rank.item === i)!;
        const a = byName.get(w.name)!;
        const c = confidenceOf(w, a);
        return { id: item.id, label: item.label, score: round(a.score ?? 0), ...(c !== undefined ? { confidence: round(c) } : {}) };
      });
      ranking.sort((a, b) => b.score - a.score);
      const confs = ranking.map((r) => r.confidence);
      const confidence = confs.every((c) => c !== undefined) ? Math.min(...(confs as number[])) : undefined;
      return { name: q.name, type: q.type, ranking, ...(confidence !== undefined ? { confidence: round(confidence) } : {}), ...(threshold !== undefined ? { threshold } : {}), uncertain: uncertainOf(confidence, threshold) };
    }
    const w = wire.find((x) => x.name === q.name)!;
    const a = byName.get(q.name)!;
    const confidence = confidenceOf(w, a);
    const common = { name: q.name, type: q.type, ...(confidence !== undefined ? { confidence: round(confidence) } : {}), ...(threshold !== undefined ? { threshold } : {}), uncertain: uncertainOf(confidence, threshold) };
    if (q.type === "predicate") return { ...common, value: (a.probability ?? 0) >= 0.5, probability: round(a.probability ?? 0) };
    if (q.type === "choice") return { ...common, choice: a.choice, ...(a.probabilities ? { probabilities: roundDist(a.probabilities) } : {}) };
    const score = a.score ?? 0;
    return { ...common, score: round(score), level: q.levels?.[Math.round(score)]?.label, ...(a.probabilities ? { probabilities: roundDist(a.probabilities) } : {}) };
  });
}

/** One answer in words: "approve: yes (P 0.93)", "team: billing (0.81)", "severity: 2.3 Blocking", "best: a > b > c". */
export function describeDecisionAnswer(a: DecisionAnswer): string {
  const conf = a.confidence !== undefined ? ` (${a.confidence.toFixed(2)})` : "";
  const flag = a.uncertain ? " — uncertain" : "";
  if (a.type === "predicate") return `${a.name}: ${a.value ? "yes" : "no"} (P(yes) ${(a.probability ?? 0).toFixed(2)})${flag}`;
  if (a.type === "choice") return `${a.name}: ${a.choice}${conf}${flag}`;
  if (a.type === "score") return `${a.name}: ${(a.score ?? 0).toFixed(2)} ${a.level ?? ""}${conf}${flag}`.replace(/ +/g, " ");
  return `${a.name}: ${(a.ranking ?? []).map((r) => r.label).join(" > ")}${conf}${flag}`;
}

// ── Uncalibrated fallback: Polpo's own chat answers ──────────────────

/** The prompt a chat model gets when no decision model is configured (no tools, JSON only). */
export function fallbackDecisionPrompt(state: DecisionState, wire: WireQuestion[]): string {
  const stateText = decisionStateText(state);
  const lines = wire.map((q, i) => {
    const head = `${i + 1}. "${q.name}" (${q.type === "predicate" ? "yes/no" : q.type}): ${q.instructions}`;
    if (q.type === "choice") return `${head}\n   Options:\n${(q.choices ?? []).map((c) => `   - "${c.value}"${c.description ? `: ${c.description}` : ""}`).join("\n")}`;
    if (q.type === "score") return `${head}\n   Levels, lowest first:\n${(q.levels ?? []).map((l, j) => `   ${j}. ${l.label}${l.description ? `: ${l.description}` : ""}`).join("\n")}`;
    return head;
  });
  return [
    "Answer typed questions about a state with probabilities: estimate them honestly from the state alone (not extreme unless the state makes the answer clear).",
    "",
    "## State",
    stateText.length > 30_000 ? `${stateText.slice(0, 30_000)}\n… (truncated)` : stateText,
    "",
    "## Questions",
    ...lines,
    "",
    "Answer with JSON only, one entry per question name:",
    '{"answers":{"<yes/no question>":{"probability":<P(yes), 0..1>},"<choice question>":{"probabilities":{"<option>":<p>,…}},"<score question>":{"probabilities":{"<level number>":<p>,…}}}}',
    "Each distribution covers every option or level and sums to 1.",
  ].join("\n");
}

/** Read the chat's answer (distributions normalized). Throws when unreadable. */
export function parseFallbackDecision(text: string, wire: WireQuestion[]): WireAnswer[] {
  const data = parseJsonLoose(text);
  const root = isObj(data) && (isObj(data.answers) || Array.isArray(data.answers)) ? data.answers : data;
  const map = answerMap(root);
  return wire.map((q) => {
    const raw = map.get(q.name);
    if (!raw) throw new DecisionError(`no answer for "${q.name}"`, 502, "BAD_ANSWER");
    const d = distribution(raw.probabilities);
    if (d && q.type !== "predicate") {
      const total = Object.values(d).reduce((a, b) => a + Math.max(0, b), 0);
      if (total > 0) for (const k of Object.keys(d)) d[k] = Math.max(0, d[k]) / total;
      return readWireAnswer(q, { ...raw, probabilities: d, score: undefined, choice: undefined, confidence: undefined });
    }
    return readWireAnswer(q, { ...raw, confidence: undefined });
  });
}

// ── Mission decision nodes ───────────────────────────────────────────

/** The question name a mission decision node asks. */
export const DECISION_NODE_QUESTION = "decision";

/** The node's question, as decide() takes it. */
export function decisionNodeQuestion(node: Pick<MissionDecision, "question" | "threshold">, items?: DecisionItem[]): DecisionQuestion {
  const q = node.question;
  return {
    name: DECISION_NODE_QUESTION, type: q.type, instructions: q.instructions,
    ...(q.choices ? { choices: q.choices } : {}),
    ...(q.levels ? { levels: q.levels.map((l) => (typeof l === "string" ? { label: l } : l)) } : {}),
    ...(items ? { items } : {}),
    ...(node.threshold !== undefined ? { threshold: node.threshold } : {}),
  };
}

/** Every task a node's branches name (blocked until the node decides). */
export function decisionNodeTasks(node: Pick<MissionDecision, "branches" | "onUncertain">): string[] {
  const all = new Set<string>();
  for (const list of Object.values(node.branches ?? {})) for (const t of list) all.add(t);
  return [...all];
}

/** Does a branch key match a score level index ("2", "0-1", or a level's label)? */
function scoreBranchMatches(key: string, index: number, labels: string[]): boolean {
  const range = /^\s*(\d+)\s*(?:-|\.\.)\s*(\d+)\s*$/.exec(key);
  if (range) return index >= Number(range[1]) && index <= Number(range[2]);
  if (/^\s*\d+\s*$/.test(key)) return Number(key) === index;
  return labels[index] !== undefined && labels[index].toLowerCase() === key.trim().toLowerCase();
}

/**
 * The branch an answer takes: predicate "yes" / "no" (or "true" / "false"), choice its value,
 * score the key whose range ("0-1", "3") or label holds the nearest level, rank the only branch
 * (or "ranked"). Undefined when no branch matches: none of the branch tasks run.
 */
export function decisionNodeBranch(node: Pick<MissionDecision, "branches" | "question">, answer: DecisionAnswer): string | undefined {
  const keys = Object.keys(node.branches ?? {});
  const find = (pred: (k: string) => boolean) => keys.find(pred);
  if (answer.type === "predicate") return find((k) => ["yes", "true"].includes(k.toLowerCase()) === !!answer.value && ["yes", "true", "no", "false"].includes(k.toLowerCase()));
  if (answer.type === "choice") return find((k) => k === answer.choice) ?? find((k) => k.toLowerCase() === (answer.choice ?? "").toLowerCase());
  if (answer.type === "score") {
    const labels = (node.question.levels ?? []).map((l) => (typeof l === "string" ? l : l.label));
    const index = Math.round(answer.score ?? 0);
    return find((k) => scoreBranchMatches(k, index, labels));
  }
  return find((k) => k.toLowerCase() === "ranked") ?? (keys.length === 1 ? keys[0] : undefined);
}

/** Does `task` depend (directly or not) on `on`? */
function dependsTransitively(task: string, on: string, deps: Map<string, Set<string>>, seen = new Set<string>()): boolean {
  if (seen.has(task)) return false;
  seen.add(task);
  for (const d of deps.get(task) ?? []) if (d === on || dependsTransitively(d, on, deps, seen)) return true;
  return false;
}

/** Problems of a mission decision node against the mission's task titles (empty: fine). */
export function missionDecisionProblems(node: MissionDecision, titles: Set<string>, deps: Map<string, Set<string>>): string[] {
  const p: string[] = [];
  const at = `decision "${node.name}"`;
  for (const t of node.afterTasks) if (!titles.has(t)) p.push(`${at}: afterTasks references unknown task "${t}"`);
  const q = node.question;
  try {
    validateDecideInput({
      state: "check",
      questions: [{ ...decisionNodeQuestion(node), ...(q.type === "rank" ? { items: typeof q.items === "string" ? [{ label: "a" }, { label: "b" }] : q.items } : {}) }],
    });
  } catch (err) {
    p.push(`${at}: ${((err as DecisionError).problems ?? [(err as Error).message]).join("; ")}`);
  }
  const keys = Object.keys(node.branches ?? {});
  if (!keys.length) p.push(`${at}: branches needs at least one branch (answer → tasks)`);
  const valid = q.type === "predicate" ? ["yes", "no", "true", "false"] : q.type === "choice" ? (q.choices ?? []).map((c) => c.value) : undefined;
  for (const k of keys) {
    if (valid && !valid.includes(k) && !valid.map((v) => v.toLowerCase()).includes(k.toLowerCase())) p.push(`${at}: branch "${k}" matches no answer (${valid.join(", ")})`);
    if (q.type === "score") {
      const labels = (q.levels ?? []).map((l) => (typeof l === "string" ? l : l.label));
      if (!labels.some((_, i) => scoreBranchMatches(k, i, labels))) p.push(`${at}: branch "${k}" matches no level (use an index, a range like 0-1, or a label)`);
    }
    for (const t of node.branches[k] ?? []) {
      if (!titles.has(t)) { p.push(`${at}: branch "${k}" references unknown task "${t}"`); continue; }
      if (node.afterTasks.includes(t)) p.push(`${at}: task "${t}" cannot be both before the decision and in one of its branches`);
      // an after task that waits on a branch task would never let the decision happen
      if (node.afterTasks.some((a) => dependsTransitively(a, t, deps))) p.push(`${at}: after task depends on the branch task "${t}": the decision could never be taken`);
    }
  }
  const u = node.onUncertain;
  if (u !== undefined && u !== "human" && !(isObj(u) && typeof u.branch === "string" && keys.includes(u.branch))) {
    p.push(`${at}: onUncertain must be "human" or { branch } naming one of its branches`);
  }
  return p;
}

/** The node's state: its template with {{tasks.<title>}} replaced, else every after task's result. */
export function renderDecisionNodeState(node: Pick<MissionDecision, "state" | "afterTasks">, tasks: Array<{ title: string; status: string; result?: { stdout?: string; stderr?: string } }>): string {
  const resultOf = (title: string) => {
    const t = tasks.find((x) => x.title === title);
    if (!t) return "";
    const out = (t.result?.stdout ?? "").trim();
    return t.status === "failed" ? `${out}\n(the task failed${t.result?.stderr ? `: ${t.result.stderr.trim().slice(0, 500)}` : ""})`.trim() : out;
  };
  if (node.state) return node.state.replace(/\{\{\s*tasks\.([^}]+?)\s*\}\}/g, (_m, title: string) => resultOf(title.trim().replace(/\.result$/, "")));
  return node.afterTasks.map((t) => `## ${t}\n${resultOf(t) || "(no result)"}`).join("\n\n");
}

/** Where a mission decision node is: deciding, decided (a branch, or none), or waiting for a person. */
export interface DecisionNodeState {
  group: string;
  missionId?: string;
  node: string;
  status: "deciding" | "decided" | "awaiting";
  /** The branch taken (null: no branch matched, none of its tasks run). */
  branch?: string | null;
  /** The branch the model's answer pointed to (a person may choose another). */
  suggested?: string | null;
  decisionId?: string;
  answer?: DecisionAnswer;
  calibrated?: boolean;
  /** Why a person must choose: uncertain, or the decision failed. */
  reason?: string;
  startedAt: string;
  decidedAt?: string;
  /** Who chose the branch: "model", "onUncertain" (its branch) or a person. */
  decidedBy?: string;
}

/** Persistence of mission decision nodes (keyed `${group}:${node}`), like checkpoints and delays. */
export interface DecisionNodeStore {
  load(): Promise<Record<string, DecisionNodeState>>;
  save(state: Record<string, DecisionNodeState>): Promise<void>;
}

/** What the mission executor asks the decision service (src/decisions/service.ts) for a node. */
export type MissionDecider = (req: {
  state: string;
  questions: DecisionQuestion[];
  /** The node's own model ("gateway:model"). */
  model?: string;
  caller: { kind: "mission"; id?: string; label: string };
}) => Promise<{ id: string; answers: DecisionAnswer[]; calibrated: boolean; model: string }>;

/** The checkpoint a node waiting for a person pauses its mission at. */
export function decisionCheckpointName(node: string): string {
  return `Decision: ${node}`;
}

/** A rank node's items: a list, or a template rendered and split by line (bullets stripped). */
export function decisionNodeItems(node: Pick<MissionDecision, "question" | "afterTasks">, tasks: Parameters<typeof renderDecisionNodeState>[1]): DecisionItem[] | undefined {
  const items = node.question.items;
  if (items === undefined) return undefined;
  if (Array.isArray(items)) return items.map((it, i) => (typeof it === "string" ? { id: String(i + 1), label: it } : { id: it.id ?? String(i + 1), label: it.label, ...(it.description ? { description: it.description } : {}) }));
  const textOut = renderDecisionNodeState({ state: items, afterTasks: node.afterTasks }, tasks);
  return textOut.split("\n").map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean).slice(0, DECISION_LIMITS.maxItems).map((label, i) => ({ id: String(i + 1), label }));
}
