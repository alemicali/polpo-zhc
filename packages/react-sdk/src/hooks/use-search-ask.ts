import { useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { SearchAskIntent, SearchAskOptions, SearchAskResult, SearchResult } from "@polpo-ai/sdk";

export interface SearchAskState {
  /** idle: nothing asked; asking: the answer is streaming; done / error: finished. */
  status: "idle" | "asking" | "done" | "error";
  /** The question asked last. */
  question: string;
  /** The answer so far (streamed text). */
  answer: string;
  /** What the assistant is doing ("Searching “invoice”…"), while asking. */
  activity: string | null;
  /** The results worth opening, best first. */
  items: SearchResult[];
  /** What to do: auto ones (navigation, view commands) are meant to run at once, the others are buttons. */
  intents: SearchAskIntent[];
  result: SearchAskResult | null;
  error: (Error & { code?: string }) | null;
}

export interface UseSearchAskReturn extends SearchAskState {
  /** Ask (cancels a previous question still streaming). Resolves with the result, or null if cancelled or failed. */
  ask: (question: string, opts?: Omit<SearchAskOptions, "onEvent" | "signal">) => Promise<SearchAskResult | null>;
  /** Stop the question streaming. */
  cancel: () => void;
  /** Back to idle. */
  reset: () => void;
}

const IDLE: SearchAskState = { status: "idle", question: "", answer: "", activity: null, items: [], intents: [], result: null, error: null };

/**
 * Ask Polpo from the search (POST /search/ask, streamed): the answer as it is written, the results
 * worth opening and the intents. Executing intents is up to the caller.
 */
export function useSearchAsk(): UseSearchAskReturn {
  const { client } = usePolpoContext();
  const [state, setState] = useState<SearchAskState>(IDLE);
  const controller = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setState((s) => (s.status === "asking" ? { ...s, status: "idle", activity: null } : s));
  }, []);

  const reset = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setState(IDLE);
  }, []);

  const ask = useCallback(async (question: string, opts: Omit<SearchAskOptions, "onEvent" | "signal"> = {}) => {
    controller.current?.abort();
    const mine = new AbortController();
    controller.current = mine;
    setState({ ...IDLE, status: "asking", question });
    try {
      const result = await client.searchAsk(question, {
        ...opts,
        signal: mine.signal,
        onEvent: (event) => {
          if (mine.signal.aborted) return;
          setState((s) => {
            switch (event.type) {
              case "status": return { ...s, activity: event.text };
              case "delta": return { ...s, answer: s.answer + event.text, activity: null };
              case "results": return { ...s, items: event.items };
              case "intent": return { ...s, intents: [...s.intents, event.intent] };
              default: return s;
            }
          });
        },
      });
      if (mine.signal.aborted) return null;
      setState((s) => ({ ...s, status: "done", activity: null, answer: result.answer || s.answer, items: result.items, intents: result.intents, result }));
      return result;
    } catch (err) {
      if (mine.signal.aborted) return null;
      setState((s) => ({ ...s, status: "error", activity: null, error: err as Error & { code?: string } }));
      return null;
    } finally {
      if (controller.current === mine) controller.current = null;
    }
  }, [client]);

  // a question still streaming stops with the component
  useEffect(() => () => controller.current?.abort(), []);

  return { ...state, ask, cancel, reset };
}
