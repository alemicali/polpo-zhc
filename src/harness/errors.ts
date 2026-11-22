/**
 * A harness run's failures, as a task result: what counts as a failed turn (an error in the
 * stream with nothing after it, an error finish reason, no model call at all) and what an error
 * means (the model is not enabled for the account, the credentials are refused: a re-run cannot
 * fix those, so they are not retried, and the message says what to change).
 *
 * Claude Code on Bedrock, model not enabled (live): the stream has one `error` part
 * ("AWS authentication failed · … · API Error: 403 anthropic.claude-sonnet-5-5 is not available
 * for this account. …"), then a finish with no usage and no text; the process exits 0.
 */

export type HarnessProvider = "anthropic" | "bedrock" | "vertex" | "openai";

export interface HarnessFailure {
  /** The task's error (stderr). */
  message: string;
  /** false: a configuration or access problem; a re-run of the same agent fails the same way. */
  retryable: boolean;
}

/** What one turn produced, as the engine saw it. */
export interface HarnessTurnOutcome {
  finishReason?: string;
  /** Error events of the turn, in order. */
  errors: string[];
  /** Text or a tool call came after the last error (the runtime recovered). */
  outputAfterError: boolean;
  /** Any text or tool call in the turn. */
  output: boolean;
  totalTokens: number;
}

const PROVIDER_LABEL: Record<HarnessProvider, string> = { anthropic: "Anthropic", bedrock: "Bedrock", vertex: "Vertex AI", openai: "OpenAI" };

/** The model is not available to the account (Bedrock model access, Vertex Model Garden, unknown model id). */
const MODEL_ACCESS = new RegExp([
  "not available for this account",
  "(?:do not|don't) have access to (?:the )?model",
  "model access",
  "not (?:been )?enabled for (?:this|your) account",
  "access(?:Denied)?Exception[^\\n]*model",
  "model[^\\n]{0,80}(?:not found|does not exist|is not supported|not supported|is unavailable)",
  "(?:invalid|unknown) model",
  "model identifier is invalid",
  "on-demand throughput isn.t supported",
  "not_found_error[^\\n]*model",
].join("|"), "i");

/** The provider refused the credentials (not a bare 403: the bridge's own connection can get one). */
const AUTH = /authentication failed|authentication_error|invalid (?:x-)?api[ -]?key|incorrect api key|API Error: 40[13]\b|security token[^\n]*(?:invalid|expired)|ExpiredToken|UnrecognizedClientException|InvalidSignatureException|credentials? (?:are |were )?(?:invalid|expired|missing)|could not load credentials/i;

const BUDGET = /budget|max_budget|spend limit/i;

/** The provider's model id in an error ("API Error: 403 anthropic.claude-sonnet-5-5 is not available …"). */
function modelInError(raw: string): string | undefined {
  return raw.match(/\b((?:[a-z]{2,4}\.)?anthropic\.[a-z0-9.:-]+|claude-[a-z0-9.:-]+|gpt-[a-z0-9.:-]+)\b/i)?.[1]?.replace(/[.:]+$/, "");
}

/**
 * An error message from a harness, labelled: model access and authentication errors say what to
 * change (and are not retryable); anything else is kept as it is.
 */
export function classifyHarnessError(raw: string, o: { harnessName: string; provider?: HarnessProvider; model?: string }): HarnessFailure {
  const text = raw.trim() || "unknown error";
  const provider = o.provider ? PROVIDER_LABEL[o.provider] : o.harnessName;
  const model = o.model ?? modelInError(text);
  const modelPart = model ? ` "${model}"` : "";
  if (MODEL_ACCESS.test(text)) {
    const fix = o.provider === "bedrock"
      ? "its quota for this AWS account is 0 (Service Quotas → Amazon Bedrock; ask AWS Support to raise it) or pick another model"
      : o.provider === "vertex"
        ? "enable it in Vertex AI Model Garden (in the configured region) or pick another model"
        : "pick another model, or enable it for the account";
    return { message: `${provider}: model${modelPart} not enabled for this account — ${fix} (agent engine or Settings → Harnesses). ${o.harnessName}: ${text}`, retryable: false };
  }
  if (AUTH.test(text)) {
    return {
      message: `${provider}: authentication failed${model ? ` (model "${model}")` : ""} — check the credentials in the vault entry of Settings → Harnesses${o.provider === "bedrock" ? " and the account's Bedrock permissions" : ""}. ${o.harnessName}: ${text}`,
      retryable: false,
    };
  }
  if (BUDGET.test(text)) return { message: `${o.harnessName} reached its spend limit (engine maxBudgetUsd): ${text}`, retryable: true };
  return { message: `${o.harnessName}: ${text}`, retryable: true };
}

/** Error finish reasons (AI SDK: "error", "length", "content-filter"; runtimes: budget, max turns). */
const ERROR_FINISH = /error|length|budget|content[-_]?filter|max[-_]?turns/i;

/** Claude Code reports some API failures as the reply itself ("API Error: 403 …"). */
const API_ERROR_REPLY = /^\s*(?:API Error:|Invalid API key|Credit balance is too low|AWS authentication failed)/i;

/**
 * Why a turn failed, or undefined: an error event with no text or tool call after it, an error
 * finish reason, or no model call at all (0 tokens, no reply, no tool call).
 */
export function harnessTurnFailure(t: HarnessTurnOutcome & { text?: string }, harnessName: string): string | undefined {
  const errors = [...new Set(t.errors.map((e) => e.trim()).filter(Boolean))];
  if (errors.length && !t.outputAfterError) return errors.join("\n");
  const reason = t.finishReason ?? "stop";
  if (reason !== "stop" && ERROR_FINISH.test(reason)) {
    return `${harnessName} ended the turn with "${reason}"${errors.length ? `: ${errors.join("\n")}` : ""}`;
  }
  if (t.totalTokens === 0 && t.text && API_ERROR_REPLY.test(t.text)) return t.text.trim();
  if (t.totalTokens === 0 && !t.output && !(t.text ?? "").trim()) {
    return `${harnessName} produced no reply and used no tokens: the model was not called (check the model and the credentials in Settings → Harnesses)`;
  }
  return undefined;
}
