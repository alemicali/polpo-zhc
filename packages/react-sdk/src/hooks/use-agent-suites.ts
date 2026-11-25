import { useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { AgentSuite, AgentSuiteInput, SuiteDatasetImport, SuiteRun, SuiteRunRequest } from "@polpo-ai/sdk";

export interface UseAgentSuitesReturn {
  /** The agent's suites (undefined while loading). */
  suites: AgentSuite[] | undefined;
  /** Its suite runs, newest first, without traces. */
  runs: SuiteRun[] | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  /** Create (no id) or replace a suite; `revision` refuses a save over someone else's change. */
  save: (suite: AgentSuiteInput | { yaml: string }, opts?: { id?: string; revision?: number }) => Promise<AgentSuite>;
  remove: (id: string) => Promise<void>;
  importDataset: (id: string, req: SuiteDatasetImport) => Promise<AgentSuite>;
  /** Start a run (returned running); the runs list refreshes. */
  run: (id: string, req?: SuiteRunRequest) => Promise<SuiteRun>;
  cancel: (runId: string) => Promise<SuiteRun>;
  yaml: (id: string) => Promise<{ yaml: string; revision: number }>;
}

/** An agent's suites and runs: save, delete, import datasets, run, cancel. */
export function useAgentSuites(name: string | undefined, opts: { runsLimit?: number } = {}): UseAgentSuitesReturn {
  const { client } = usePolpoContext();
  const [state, setState] = useState<{ key: string; suites?: AgentSuite[]; runs?: SuiteRun[]; error: Error | null } | null>(null);
  const key = name ?? "";
  const limit = opts.runsLimit ?? 30;

  const fetch_ = useCallback(async () => {
    if (!name) return;
    try {
      const [suites, runs] = await Promise.all([client.getAgentSuites(name), client.getAgentSuiteRuns(name, { limit })]);
      setState({ key: name, suites, runs, error: null });
    } catch (err) {
      setState((s) => ({ key: name, ...(s?.key === name ? { suites: s.suites, runs: s.runs } : {}), error: err as Error }));
    }
  }, [client, name, limit]);

  useEffect(() => { void fetch_(); }, [fetch_]);

  // while a run is going, refresh the list now and then
  const current = state?.key === key ? state : null;
  const anyRunning = !!current?.runs?.some((r) => r.status === "running" || r.status === "queued");
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => { void fetch_(); }, 3000);
    return () => clearInterval(t);
  }, [anyRunning, fetch_]);

  const save = useCallback(async (suite: AgentSuiteInput | { yaml: string }, o: { id?: string; revision?: number } = {}) => {
    const saved = o.id ? await client.saveAgentSuite(name ?? "", o.id, suite, o.revision) : await client.createAgentSuite(name ?? "", suite);
    await fetch_();
    return saved;
  }, [client, name, fetch_]);
  const remove = useCallback(async (id: string) => { await client.deleteAgentSuite(name ?? "", id); await fetch_(); }, [client, name, fetch_]);
  const importDataset = useCallback(async (id: string, req: SuiteDatasetImport) => {
    const s = await client.importAgentSuiteDataset(name ?? "", id, req);
    await fetch_();
    return s;
  }, [client, name, fetch_]);
  const run = useCallback(async (id: string, req: SuiteRunRequest = {}) => {
    const r = await client.runAgentSuite(name ?? "", id, req);
    await fetch_();
    return r;
  }, [client, name, fetch_]);
  const cancel = useCallback(async (runId: string) => {
    const r = await client.cancelAgentSuiteRun(name ?? "", runId);
    await fetch_();
    return r;
  }, [client, name, fetch_]);
  const yaml = useCallback((id: string) => client.getAgentSuiteYaml(name ?? "", id), [client, name]);

  return {
    suites: current?.suites,
    runs: current?.runs,
    isLoading: !!name && !current,
    error: current?.error ?? null,
    refetch: fetch_,
    save, remove, importDataset, run, cancel, yaml,
  };
}

export interface UseAgentSuiteRunReturn {
  /** The run with its traces (refreshed while it runs). */
  run: SuiteRun | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/** One suite run, polled while it is running. */
export function useAgentSuiteRun(name: string | undefined, runId: string | null | undefined, opts: { pollMs?: number } = {}): UseAgentSuiteRunReturn {
  const { client } = usePolpoContext();
  const [state, setState] = useState<{ key: string; run?: SuiteRun; error: Error | null } | null>(null);
  const key = `${name ?? ""}/${runId ?? ""}`;
  const keyRef = useRef(key);
  keyRef.current = key;

  const fetch_ = useCallback(async () => {
    if (!name || !runId) return;
    const k = `${name}/${runId}`;
    try {
      const run = await client.getAgentSuiteRun(name, runId);
      if (keyRef.current === k) setState({ key: k, run, error: null });
    } catch (err) {
      if (keyRef.current === k) setState({ key: k, error: err as Error });
    }
  }, [client, name, runId]);

  useEffect(() => { void fetch_(); }, [fetch_]);
  const current = state?.key === key ? state : null;
  const live = current?.run?.status === "running" || current?.run?.status === "queued";
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => { void fetch_(); }, opts.pollMs ?? 2000);
    return () => clearInterval(t);
  }, [live, fetch_, opts.pollMs]);

  return { run: current?.run, isLoading: !!name && !!runId && !current, error: current?.error ?? null, refetch: fetch_ };
}
