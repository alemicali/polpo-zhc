import { useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { AgentTestCheckId, AgentTestFixAction, AgentTestRun, AgentTestRunRequest } from "@polpo-ai/sdk";

export interface UseAgentTestsReturn {
  /** The agent's test runs, newest first (undefined while loading). */
  history: AgentTestRun[] | undefined;
  /** The latest run (the one just made, else the newest in the history). */
  latest: AgentTestRun | undefined;
  isLoading: boolean;
  /** Checks running now ("all" for Run all). */
  running: AgentTestCheckId[] | "all" | null;
  error: Error | null;
  refetch: () => Promise<void>;
  /** Run every check but the smoke run; refetches the history. */
  runAll: (req?: Omit<AgentTestRunRequest, "checks">) => Promise<AgentTestRun>;
  /** Run one check (e.g. "smoke": the live run, which costs a real turn). */
  runOne: (check: AgentTestCheckId, req?: Omit<AgentTestRunRequest, "checks">) => Promise<AgentTestRun>;
  /** Apply a one-click fix, then run that check again. */
  fix: (action: AgentTestFixAction, recheck?: AgentTestCheckId) => Promise<{ message: string }>;
}

/** An agent's tests: run all or one check, the history, the one-click fixes. */
export function useAgentTests(name: string | undefined, opts: { limit?: number } = {}): UseAgentTestsReturn {
  const { client } = usePolpoContext();
  const [state, setState] = useState<{ key: string; history?: AgentTestRun[]; error: Error | null } | null>(null);
  const [latest, setLatest] = useState<{ key: string; run: AgentTestRun } | null>(null);
  const [running, setRunning] = useState<AgentTestCheckId[] | "all" | null>(null);
  const key = name ?? "";
  const limit = opts.limit;

  const fetch_ = useCallback(async () => {
    if (!name) return;
    try {
      setState({ key: name, history: await client.getAgentTests(name, { ...(limit ? { limit } : {}) }), error: null });
    } catch (err) {
      setState({ key: name, error: err as Error });
    }
  }, [client, name, limit]);

  useEffect(() => { void fetch_(); }, [fetch_]);

  const run = useCallback(async (req: AgentTestRunRequest, marker: AgentTestCheckId[] | "all") => {
    setRunning(marker);
    try {
      const r = await client.runAgentTests(name ?? "", req);
      setLatest({ key: name ?? "", run: r });
      await fetch_();
      return r;
    } finally {
      setRunning(null);
    }
  }, [client, name, fetch_]);

  const runAll = useCallback((req: Omit<AgentTestRunRequest, "checks"> = {}) => run(req, "all"), [run]);
  const runOne = useCallback((check: AgentTestCheckId, req: Omit<AgentTestRunRequest, "checks"> = {}) => run({ ...req, checks: [check] }, [check]), [run]);
  const fix = useCallback(async (action: AgentTestFixAction, recheck?: AgentTestCheckId) => {
    const r = await client.fixAgentTest(name ?? "", action);
    if (recheck) await run({ checks: [recheck] }, [recheck]);
    return r;
  }, [client, name, run]);

  const current = state?.key === key ? state : null;
  const mine = latest?.key === key ? latest.run : undefined;
  return {
    history: current?.history,
    latest: mine ?? current?.history?.[0],
    isLoading: !!name && !current,
    running,
    error: current?.error ?? null,
    refetch: fetch_,
    runAll,
    runOne,
    fix,
  };
}
