/** What the CLI engine's protocol drivers (claude.ts, codex.ts) report, CLI-agnostic. */

export interface CliUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export const ZERO_USAGE: CliUsage = Object.freeze({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 });

export type CliEvent =
  | { type: "session"; sessionId: string; model?: string }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "tool-result"; id: string; name?: string; output: unknown; isError: boolean }
  | { type: "error"; message: string }
  /** A direction sent during the turn reached the program. */
  | { type: "steer-read" };

export interface CliTurnEnd {
  ok: boolean;
  /** The turn's final answer. */
  text: string;
  /** Why it failed (the program's own words). */
  error?: string;
  usage: CliUsage;
  /** The CLI's own estimate (Claude Code reports one even on a subscription): informational. */
  estimateUsd?: number;
  sessionId?: string;
}

/** One conversation with a running CLI program. */
export interface CliSession {
  readonly sessionId: string | undefined;
  readonly model: string | undefined;
  /** One turn: the prompt, until the program says the turn is over. */
  turn(prompt: string, onEvent: (e: CliEvent) => void): Promise<CliTurnEnd>;
  /** A direction for the running turn (true: sent to the program; false: no turn is running). */
  steer(text: string): Promise<boolean>;
  /** Stop the running turn (the conversation stays). */
  interrupt(): Promise<void>;
  /** End the conversation: the program exits (killed after a grace). */
  close(): Promise<void>;
}

export function addUsage(a: CliUsage, b: CliUsage): CliUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}
