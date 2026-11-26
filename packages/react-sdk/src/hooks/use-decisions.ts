import { useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useEvents } from "./use-events.js";
import type { DecideRequest, DecideResult, DecisionCallerKind, DecisionLogPage, DecisionNodeState, DecisionStatus } from "@polpo-ai/sdk";

export interface UseDecideReturn {
  /** Ask the decision model; resolves with the answers (or rejects: 409 when no decision model is configured). */
  decide: (req: DecideRequest) => Promise<DecideResult>;
  result: DecideResult | null;
  isDeciding: boolean;
  error: (Error & { code?: string; status?: number }) | null;
  reset: () => void;
}

/** decide(): typed judgments with probabilities (predicate, choice, score, rank) from the decision model. */
export function useDecide(): UseDecideReturn {
  const { client } = usePolpoContext();
  const [result, setResult] = useState<DecideResult | null>(null);
  const [isDeciding, setIsDeciding] = useState(false);
  const [error, setError] = useState<UseDecideReturn["error"]>(null);
  const decide = useCallback(async (req: DecideRequest) => {
    setIsDeciding(true);
    setError(null);
    try {
      const r = await client.decide(req);
      setResult(r);
      return r;
    } catch (err) {
      setError(err as UseDecideReturn["error"]);
      throw err;
    } finally {
      setIsDeciding(false);
    }
  }, [client]);
  const reset = useCallback(() => { setResult(null); setError(null); }, []);
  return { decide, result, isDeciding, error, reset };
}

/** Live: a decision was taken, a mission's decision node moved. */
const DECISION_EVENTS = ["decision:made", "decision:node"];

function useRefetchOn(refetch: () => void) {
  const { events } = useEvents(DECISION_EVENTS, 1);
  const last = events.at(-1);
  const handled = useRef(last?.id);
  useEffect(() => {
    if (!last?.id || handled.current === last.id) return;
    handled.current = last.id;
    refetch();
  }, [last, refetch]);
}

export interface UseDecisionsReturn {
  page: DecisionLogPage | undefined;
  /** The decision model and where its key comes from (never the key). */
  status: DecisionStatus | undefined;
  /** Missions' decision nodes (deciding, decided, waiting for a person). */
  nodes: DecisionNodeState[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  /** Choose a waiting node's branch (null: none of its tasks run). */
  resolveNode: (group: string, node: string, branch: string | null) => Promise<DecisionNodeState>;
}

/** The decision log (newest first, filtered), the configuration status and the mission nodes, live. */
export function useDecisions(o: { limit?: number; caller?: DecisionCallerKind; callerId?: string; uncertain?: boolean; status?: "ok" | "error" } = {}): UseDecisionsReturn {
  const { client } = usePolpoContext();
  const [page, setPage] = useState<DecisionLogPage | undefined>(undefined);
  const [status, setStatus] = useState<DecisionStatus | undefined>(undefined);
  const [nodes, setNodes] = useState<DecisionNodeState[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const refetch = useCallback(async () => {
    try {
      const [p, s, n] = await Promise.all([
        client.getDecisions({
          ...(o.limit ? { limit: o.limit } : {}), ...(o.caller ? { caller: o.caller } : {}), ...(o.callerId ? { callerId: o.callerId } : {}),
          ...(o.uncertain !== undefined ? { uncertain: o.uncertain } : {}), ...(o.status ? { status: o.status } : {}),
        }),
        client.getDecisionStatus(),
        client.getDecisionNodes(),
      ]);
      setPage(p);
      setStatus(s);
      setNodes(n);
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [client, o.limit, o.caller, o.callerId, o.uncertain, o.status]);
  useEffect(() => {
    setIsLoading(true);
    refetch().finally(() => setIsLoading(false));
  }, [refetch]);
  useRefetchOn(() => { void refetch(); });
  const resolveNode = useCallback(async (group: string, node: string, branch: string | null) => {
    const r = await client.resolveDecisionNode(group, node, branch);
    await refetch();
    return r;
  }, [client, refetch]);
  return { page, status, nodes, isLoading, error, refetch, resolveNode };
}
