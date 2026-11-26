/**
 * A stand-in for useSearchAsk (@polpo-ai/react) in the palette's tests: the answer comes from
 * `askScript`, which streams events (text, results, intents) and resolves with the result, or throws.
 */
import { useState } from "react";

export interface MockAskEvent { type: string; text?: string; items?: unknown[]; intent?: unknown }
export interface MockAskResult { answer: string; items: unknown[]; intents: Array<Record<string, unknown>>; fastPath: boolean; rounds: number }
type Script = (q: string, emit: (e: MockAskEvent) => void) => Promise<MockAskResult>;

export const askCalls: Array<{ q: string; opts: Record<string, unknown> }> = [];
let script: Script = async () => { throw Object.assign(new Error("no script"), { code: "LLM_ERROR" }); };
export function setAskScript(s: Script): void { script = s; }
export function resetAskMock(): void {
  askCalls.length = 0;
  script = async () => { throw Object.assign(new Error("no script"), { code: "LLM_ERROR" }); };
}

interface State {
  status: "idle" | "asking" | "done" | "error";
  question: string;
  answer: string;
  activity: string | null;
  items: unknown[];
  intents: Array<Record<string, unknown>>;
  result: MockAskResult | null;
  error: (Error & { code?: string }) | null;
}
const IDLE: State = { status: "idle", question: "", answer: "", activity: null, items: [], intents: [], result: null, error: null };

export function useSearchAskMock() {
  const [state, setState] = useState<State>(IDLE);
  return {
    ...state,
    ask: async (q: string, opts: Record<string, unknown> = {}) => {
      askCalls.push({ q, opts });
      setState({ ...IDLE, status: "asking", question: q });
      try {
        const result = await script(q, (e) => setState((s) => (
          e.type === "delta" ? { ...s, answer: s.answer + (e.text ?? "") }
            : e.type === "results" ? { ...s, items: e.items ?? [] }
            : e.type === "intent" ? { ...s, intents: [...s.intents, e.intent as Record<string, unknown>] }
            : s
        )));
        setState((s) => ({ ...s, status: "done", answer: result.answer || s.answer, items: result.items, intents: result.intents, result }));
        return result;
      } catch (err) {
        setState((s) => ({ ...s, status: "error", error: err as Error & { code?: string } }));
        return null;
      }
    },
    cancel: () => setState((s) => (s.status === "asking" ? { ...s, status: "idle" } : s)),
    reset: () => setState(IDLE),
  };
}
