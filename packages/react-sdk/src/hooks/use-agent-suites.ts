import { useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type {
  AgentSuite, AgentSuiteInput, CaseGenerationRequest, GeneratedCaseProposal, SuiteCase, SuiteCassette, SuiteCassetteEdit, SuiteDataset, SuiteDatasetImport,
  SuiteRun, SuiteRunRequest, SuiteTargetKind, SuiteTrend,
} from "@polpo-ai/sdk";

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
  /** Mark a finished run as its suite's baseline (null clears the mark); the runs list refreshes. */
  setBaseline: (suiteId: string, runId: string | null) => Promise<void>;
  /** "Explain this run": an AI review stored on the run. */
  review: (runId: string, opts?: { language?: string }) => Promise<SuiteRun>;
  /** Record (or re-record) a case live into its cassette (admins; real model and tools). */
  record: (suiteId: string, caseId: string, opts?: { target?: string }) => Promise<SuiteRun>;
  /** A case and its cassette from a real chat (sessionId) or task run (taskId), added to the suite. */
  fromRecording: (suiteId: string, req: { sessionId?: string; taskId?: string; messageIndex?: number; name?: string }) => Promise<{ suite: AgentSuite; case: SuiteCase; cassette: SuiteCassette }>;
  /** AI-proposed cases (NOT saved): review them, then accept. */
  generate: (req?: CaseGenerationRequest) => Promise<{ proposals: GeneratedCaseProposal[]; model?: string; costUsd?: number }>;
  /** Add the accepted cases (and their datasets) to a suite. */
  accept: (suiteId: string, cases: Array<Partial<SuiteCase>>, datasets?: Array<Partial<SuiteDataset>>) => Promise<AgentSuite>;
  /** AI-proposed dataset rows for a case (not saved). */
  generateRows: (suiteId: string, req: { caseId: string; count?: number; brief?: string }) => Promise<{ datasetId?: string; columns: string[]; rows: Array<Record<string, unknown>> }>;
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
  const setBaseline = useCallback(async (suiteId: string, runId: string | null) => {
    await client.setAgentSuiteBaseline(name ?? "", suiteId, runId);
    await fetch_();
  }, [client, name, fetch_]);
  const review = useCallback(async (runId: string, o: { language?: string } = {}) => {
    const r = await client.reviewAgentSuiteRun(name ?? "", runId, o);
    await fetch_();
    return r;
  }, [client, name, fetch_]);

  const record = useCallback(async (suiteId: string, caseId: string, o: { target?: string } = {}) => {
    const r = await client.recordAgentSuiteCase(name ?? "", suiteId, caseId, { ...(o.target ? { target: o.target } : {}), allowRealTools: true });
    await fetch_();
    return r;
  }, [client, name, fetch_]);
  const fromRecording = useCallback(async (suiteId: string, req: { sessionId?: string; taskId?: string; messageIndex?: number; name?: string }) => {
    const r = await client.agentSuiteCaseFromRecording(name ?? "", suiteId, req);
    await fetch_();
    return r;
  }, [client, name, fetch_]);
  const generate = useCallback((req: CaseGenerationRequest = {}) => client.generateAgentSuiteCases(name ?? "", req), [client, name]);
  const accept = useCallback(async (suiteId: string, cases: Array<Partial<SuiteCase>>, datasets?: Array<Partial<SuiteDataset>>) => {
    const s = await client.acceptAgentSuiteCases(name ?? "", suiteId, { cases, ...(datasets?.length ? { datasets } : {}) });
    await fetch_();
    return s;
  }, [client, name, fetch_]);
  const generateRows = useCallback((suiteId: string, req: { caseId: string; count?: number; brief?: string }) => client.generateAgentSuiteDatasetRows(name ?? "", suiteId, req), [client, name]);

  return {
    suites: current?.suites,
    runs: current?.runs,
    isLoading: !!name && !current,
    error: current?.error ?? null,
    refetch: fetch_,
    save, remove, importDataset, run, cancel, yaml, setBaseline, review,
    record, fromRecording, generate, accept, generateRows,
  };
}

export interface UseSuiteCassetteReturn {
  /** The case's cassette (null: never recorded; undefined while loading). */
  cassette: SuiteCassette | null | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  /** Edit recorded calls (response, delete, turn into a case mock). */
  edit: (edits: SuiteCassetteEdit[]) => Promise<SuiteCassette>;
  /** Delete the cassette (the case blocks its tool calls until recorded again). */
  remove: () => Promise<void>;
}

/** The cassette a case replays: read, edit (per call), delete. */
export function useSuiteCassette(name: string | undefined, suiteId: string | null | undefined, caseId: string | null | undefined): UseSuiteCassetteReturn {
  const { client } = usePolpoContext();
  const [state, setState] = useState<{ key: string; cassette?: SuiteCassette | null; error: Error | null } | null>(null);
  const key = `${name ?? ""}/${suiteId ?? ""}/${caseId ?? ""}`;
  const keyRef = useRef(key);
  keyRef.current = key;
  const fetch_ = useCallback(async () => {
    if (!name || !suiteId || !caseId) return;
    const k = `${name}/${suiteId}/${caseId}`;
    try {
      const cassette = await client.getAgentSuiteCaseCassette(name, suiteId, caseId);
      if (keyRef.current === k) setState({ key: k, cassette, error: null });
    } catch (err) {
      if (keyRef.current === k) setState({ key: k, error: err as Error });
    }
  }, [client, name, suiteId, caseId]);
  useEffect(() => { void fetch_(); }, [fetch_]);
  const current = state?.key === key ? state : null;
  const edit = useCallback(async (edits: SuiteCassetteEdit[]) => {
    const c = current?.cassette;
    if (!name || !c) throw new Error("There is no cassette to edit");
    const next = await client.editAgentCassette(name, c.id, edits, c.revision);
    setState({ key, cassette: next, error: null });
    return next;
  }, [client, name, current?.cassette, key]);
  const remove = useCallback(async () => {
    const c = current?.cassette;
    if (!name || !c) return;
    await client.deleteAgentCassette(name, c.id);
    setState({ key, cassette: null, error: null });
  }, [client, name, current?.cassette, key]);
  return { cassette: current?.cassette, isLoading: !!name && !!suiteId && !!caseId && !current, error: current?.error ?? null, refetch: fetch_, edit, remove };
}

export interface UseTargetSuitesReturn {
  suites: AgentSuite[] | undefined;
  runs: SuiteRun[] | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  /** Save a suite (a hosted server: its saved tests, id "saved-tests"). */
  save: (suite: AgentSuiteInput, revision?: number) => Promise<AgentSuite>;
  remove: (suiteId: string) => Promise<void>;
  /** Start a run (returned running); the runs refresh while it runs. */
  run: (suiteId: string, req?: SuiteRunRequest) => Promise<SuiteRun>;
}

/** The suites of a hosted MCP server (its saved tests) or a mission, and their runs. */
export function useTargetSuites(kind: SuiteTargetKind, id: string | undefined, opts: { runsLimit?: number } = {}): UseTargetSuitesReturn {
  const { client } = usePolpoContext();
  const [state, setState] = useState<{ key: string; suites?: AgentSuite[]; runs?: SuiteRun[]; error: Error | null } | null>(null);
  const key = `${kind}/${id ?? ""}`;
  const limit = opts.runsLimit ?? 20;
  const fetch_ = useCallback(async () => {
    if (!id) return;
    const k = `${kind}/${id}`;
    try {
      const [suites, runs] = await Promise.all([client.getTargetSuites(kind, id), client.getTargetSuiteRuns(kind, id, { limit })]);
      setState({ key: k, suites, runs, error: null });
    } catch (err) {
      setState((s) => ({ key: k, ...(s?.key === k ? { suites: s.suites, runs: s.runs } : {}), error: err as Error }));
    }
  }, [client, kind, id, limit]);
  useEffect(() => { void fetch_(); }, [fetch_]);
  const current = state?.key === key ? state : null;
  const anyRunning = !!current?.runs?.some((r) => r.status === "running" || r.status === "queued");
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => { void fetch_(); }, 3000);
    return () => clearInterval(t);
  }, [anyRunning, fetch_]);
  const save = useCallback(async (suite: AgentSuiteInput, revision?: number) => {
    const s = await client.saveTargetSuite(kind, id ?? "", suite, revision);
    await fetch_();
    return s;
  }, [client, kind, id, fetch_]);
  const remove = useCallback(async (suiteId: string) => { await client.deleteTargetSuite(kind, id ?? "", suiteId); await fetch_(); }, [client, kind, id, fetch_]);
  const run = useCallback(async (suiteId: string, req: SuiteRunRequest = {}) => {
    const r = await client.runTargetSuite(kind, id ?? "", suiteId, req);
    await fetch_();
    return r;
  }, [client, kind, id, fetch_]);
  return { suites: current?.suites, runs: current?.runs, isLoading: !!id && !current, error: current?.error ?? null, refetch: fetch_, save, remove, run };
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

export interface UseAgentSuiteTrendReturn {
  /** The suite's finished runs over time and by version (undefined while loading). */
  trend: SuiteTrend | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/** A suite's trend: pass rate, score, cost and latency per run and per version. */
export function useAgentSuiteTrend(name: string | undefined, suiteId: string | null | undefined, opts: { limit?: number } = {}): UseAgentSuiteTrendReturn {
  const { client } = usePolpoContext();
  const [state, setState] = useState<{ key: string; trend?: SuiteTrend; error: Error | null } | null>(null);
  const key = `${name ?? ""}/${suiteId ?? ""}/${opts.limit ?? ""}`;
  const keyRef = useRef(key);
  keyRef.current = key;
  const fetch_ = useCallback(async () => {
    if (!name || !suiteId) return;
    const k = `${name}/${suiteId}/${opts.limit ?? ""}`;
    try {
      const trend = await client.getAgentSuiteTrend(name, suiteId, opts.limit ? { limit: opts.limit } : {});
      if (keyRef.current === k) setState({ key: k, trend, error: null });
    } catch (err) {
      if (keyRef.current === k) setState({ key: k, error: err as Error });
    }
  }, [client, name, suiteId, opts.limit]);
  useEffect(() => { void fetch_(); }, [fetch_]);
  const current = state?.key === key ? state : null;
  return { trend: current?.trend, isLoading: !!name && !!suiteId && !current, error: current?.error ?? null, refetch: fetch_ };
}

/** One run of a hosted server's or a mission's suite, polled while it is running. */
export function useTargetSuiteRun(kind: SuiteTargetKind, id: string | undefined, runId: string | null | undefined, opts: { pollMs?: number } = {}): UseAgentSuiteRunReturn {
  const { client } = usePolpoContext();
  const [state, setState] = useState<{ key: string; run?: SuiteRun; error: Error | null } | null>(null);
  const key = `${kind}/${id ?? ""}/${runId ?? ""}`;
  const keyRef = useRef(key);
  keyRef.current = key;
  const fetch_ = useCallback(async () => {
    if (!id || !runId) return;
    const k = `${kind}/${id}/${runId}`;
    try {
      const run = await client.getTargetSuiteRun(kind, id, runId);
      if (keyRef.current === k) setState({ key: k, run, error: null });
    } catch (err) {
      if (keyRef.current === k) setState({ key: k, error: err as Error });
    }
  }, [client, kind, id, runId]);
  useEffect(() => { void fetch_(); }, [fetch_]);
  const current = state?.key === key ? state : null;
  const live = current?.run?.status === "running" || current?.run?.status === "queued";
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => { void fetch_(); }, opts.pollMs ?? 2000);
    return () => clearInterval(t);
  }, [live, fetch_, opts.pollMs]);
  return { run: current?.run, isLoading: !!id && !!runId && !current, error: current?.error ?? null, refetch: fetch_ };
}
