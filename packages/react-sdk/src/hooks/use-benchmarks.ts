import { useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useEvents } from "./use-events.js";
import type {
  AgentSuite, BenchmarkCaseComparison, BenchmarkDefinition, BenchmarkEstimate, BenchmarkInput, BenchmarkReport, BenchmarkRun, BenchmarkWeights,
  PlaygroundExchange, PlaygroundPaneInput, PlaygroundSession, PlaygroundStreamEvent, SuiteCase, SuiteTraceToolCall, SuiteVariantOverrides,
} from "@polpo-ai/sdk";

/** Refetch on benchmark:progress (optionally only one benchmark run's). */
function useBenchmarkProgress(runId: string | undefined, refetch: () => void): void {
  const { events } = useEvents(["benchmark:progress"], 1);
  const latest = events.at(-1);
  const handled = useRef(latest?.id);
  useEffect(() => {
    if (!latest || handled.current === latest.id) return;
    handled.current = latest.id;
    const d = latest.data as { benchmarkRunId?: string } | undefined;
    if (!runId || d?.benchmarkRunId === runId) refetch();
  }, [latest, runId, refetch]);
}

export interface UseBenchmarksReturn {
  /** The saved benchmarks (undefined while loading). */
  benchmarks: BenchmarkDefinition[] | undefined;
  /** Benchmark runs, newest first. */
  runs: BenchmarkRun[] | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  save: (benchmark: BenchmarkInput, opts?: { id?: string; revision?: number }) => Promise<BenchmarkDefinition>;
  remove: (id: string) => Promise<void>;
  /** The cost before it runs (offline benchmarks are free). */
  estimate: (ref: { benchmarkId?: string; benchmark?: BenchmarkInput }) => Promise<BenchmarkEstimate>;
  /** Start it (confirm: the cost estimate was accepted); the runs list refreshes. */
  run: (ref: { benchmarkId?: string; benchmark?: BenchmarkInput }, opts?: { confirm?: boolean; allowRealTools?: boolean; budgetUsd?: number; source?: string }) => Promise<BenchmarkRun>;
  cancel: (runId: string) => Promise<BenchmarkRun>;
}

/** The saved benchmarks and their runs; live on benchmark:progress. */
export function useBenchmarks(opts: { benchmark?: string; runsLimit?: number } = {}): UseBenchmarksReturn {
  const { client } = usePolpoContext();
  const [state, setState] = useState<{ benchmarks?: BenchmarkDefinition[]; runs?: BenchmarkRun[]; error: Error | null; loaded: boolean }>({ error: null, loaded: false });
  const limit = opts.runsLimit ?? 30;
  const fetch_ = useCallback(async () => {
    try {
      const [benchmarks, runs] = await Promise.all([client.getBenchmarks(), client.getBenchmarkRuns({ ...(opts.benchmark ? { benchmark: opts.benchmark } : {}), limit })]);
      setState({ benchmarks, runs, error: null, loaded: true });
    } catch (err) {
      setState((s) => ({ ...s, error: err as Error, loaded: true }));
    }
  }, [client, opts.benchmark, limit]);
  useEffect(() => { void fetch_(); }, [fetch_]);
  useBenchmarkProgress(undefined, () => { void fetch_(); });

  const save = useCallback(async (b: BenchmarkInput, o: { id?: string; revision?: number } = {}) => { const d = await client.saveBenchmark(b, o); await fetch_(); return d; }, [client, fetch_]);
  const remove = useCallback(async (id: string) => { await client.deleteBenchmark(id); await fetch_(); }, [client, fetch_]);
  const estimate = useCallback((ref: { benchmarkId?: string; benchmark?: BenchmarkInput }) => client.estimateBenchmark(ref), [client]);
  const run = useCallback(async (ref: { benchmarkId?: string; benchmark?: BenchmarkInput }, o: { confirm?: boolean; allowRealTools?: boolean; budgetUsd?: number; source?: string } = {}) => {
    const r = await client.runBenchmark(ref, o);
    await fetch_();
    return r;
  }, [client, fetch_]);
  const cancel = useCallback(async (runId: string) => { const r = await client.cancelBenchmarkRun(runId); await fetch_(); return r; }, [client, fetch_]);

  return { benchmarks: state.benchmarks, runs: state.runs, isLoading: !state.loaded, error: state.error, refetch: fetch_, save, remove, estimate, run, cancel };
}

export interface UseBenchmarkRunReturn {
  /** The run, per-variant stats, the leaderboard (with the weights), the matrix. */
  report: BenchmarkReport | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  cancel: () => Promise<BenchmarkRun>;
  /** One case side by side for 2–4 variants. */
  compare: (caseKey: string, opts?: { variants?: string[]; repetition?: number }) => Promise<BenchmarkCaseComparison>;
}

/** One benchmark run's comparison; refetched as it progresses (benchmark:progress, and every few seconds while it runs). */
export function useBenchmarkRun(runId: string | undefined, weights?: Partial<BenchmarkWeights>): UseBenchmarkRunReturn {
  const { client } = usePolpoContext();
  const [state, setState] = useState<{ key: string; report?: BenchmarkReport; error: Error | null } | null>(null);
  const wq = weights?.quality, wc = weights?.cost, wl = weights?.latency;
  const key = `${runId ?? ""}|${wq ?? ""}|${wc ?? ""}|${wl ?? ""}`;
  const fetch_ = useCallback(async () => {
    if (!runId) return;
    const w = { ...(wq !== undefined ? { quality: wq } : {}), ...(wc !== undefined ? { cost: wc } : {}), ...(wl !== undefined ? { latency: wl } : {}) };
    try {
      const report = await client.getBenchmarkRun(runId, Object.keys(w).length ? w : undefined);
      setState({ key, report, error: null });
    } catch (err) {
      setState((s) => ({ key, ...(s?.key === key && s.report ? { report: s.report } : {}), error: err as Error }));
    }
  }, [client, runId, key, wq, wc, wl]);
  useEffect(() => { void fetch_(); }, [fetch_]);
  useBenchmarkProgress(runId, () => { void fetch_(); });
  const current = state?.key === key ? state : null;
  const live = current?.report?.run.status === "running" || current?.report?.run.status === "queued";
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => { void fetch_(); }, 3000);
    return () => clearInterval(t);
  }, [live, fetch_]);
  const cancel = useCallback(async () => { const r = await client.cancelBenchmarkRun(runId ?? ""); await fetch_(); return r; }, [client, runId, fetch_]);
  const compare = useCallback((caseKey: string, o: { variants?: string[]; repetition?: number } = {}) => client.compareBenchmarkCase(runId ?? "", caseKey, o), [client, runId]);
  return { report: current?.report, isLoading: !!runId && !current, error: current?.error ?? null, refetch: fetch_, cancel, compare };
}

/** What a pane shows while it answers (streaming). */
export interface PlaygroundLivePane {
  running: boolean;
  text: string;
  tools: SuiteTraceToolCall[];
}

export interface UsePlaygroundReturn {
  session: PlaygroundSession | undefined;
  /** Each pane's answer as it streams. */
  live: Record<string, PlaygroundLivePane>;
  sending: boolean;
  error: Error | null;
  /** Open a session with these panes (closes the previous one). */
  open: (panes: PlaygroundPaneInput[]) => Promise<PlaygroundSession>;
  /** Change the panes (a pane left as it was keeps its conversation). */
  setPanes: (panes: PlaygroundPaneInput[]) => Promise<PlaygroundSession>;
  /** Send to every pane, or to `paneIds`; streams into `live`. */
  send: (message: string, opts?: { paneIds?: string[]; allowRealTools?: boolean }) => Promise<Record<string, PlaygroundExchange>>;
  reset: (paneId?: string) => Promise<void>;
  close: () => Promise<void>;
  /** "Save as test case": returned for review, or saved into `save`'s suite. */
  saveCase: (req: { paneId: string; exchange?: number; name?: string; mockModel?: boolean; save?: { agent: string; suite: string } }) => Promise<{ case: SuiteCase; suite?: AgentSuite }>;
  /** "Promote variant": the overrides into the agent's draft (never deployed). */
  promote: (req: { agent: string; version?: string; overrides: SuiteVariantOverrides; note?: string }) => Promise<{ agent: string; fields: Record<string, unknown>; draftChanged: boolean }>;
}

/** The Playground: 2–4 chat panes side by side, each bound to a variant; ephemeral sessions. */
export function usePlayground(): UsePlaygroundReturn {
  const { client } = usePolpoContext();
  const [session, setSession] = useState<PlaygroundSession | undefined>();
  const [live, setLive] = useState<Record<string, PlaygroundLivePane>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const idRef = useRef<string | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => {
    abort.current?.abort();
    if (idRef.current) void client.deletePlaygroundSession(idRef.current).catch(() => undefined);
  }, [client]);

  const open = useCallback(async (panes: PlaygroundPaneInput[]) => {
    if (idRef.current) await client.deletePlaygroundSession(idRef.current).catch(() => undefined);
    const s = await client.createPlaygroundSession(panes);
    idRef.current = s.id;
    setSession(s);
    setLive({});
    setError(null);
    return s;
  }, [client]);

  const setPanes = useCallback(async (panes: PlaygroundPaneInput[]) => {
    if (!idRef.current) return open(panes);
    const s = await client.updatePlaygroundSession(idRef.current, panes);
    setSession(s);
    return s;
  }, [client, open]);

  const send = useCallback(async (message: string, o: { paneIds?: string[]; allowRealTools?: boolean } = {}) => {
    if (!idRef.current) throw new Error("Open the Playground first");
    const id = idRef.current;
    setSending(true);
    setError(null);
    const ac = new AbortController();
    abort.current = ac;
    const onEvent = (e: PlaygroundStreamEvent) => {
      setLive((prev) => {
        const cur = prev[e.paneId] ?? { running: false, text: "", tools: [] };
        if (e.type === "start") return { ...prev, [e.paneId]: { running: true, text: "", tools: [] } };
        if (e.type === "text") return { ...prev, [e.paneId]: { ...cur, text: cur.text + e.delta } };
        if (e.type === "tool") return { ...prev, [e.paneId]: { ...cur, tools: [...cur.tools, e.call] } };
        if (e.type === "done") return { ...prev, [e.paneId]: { ...cur, running: false } };
        return prev;
      });
    };
    try {
      const out = await client.sendPlayground(id, { message, ...o }, { onEvent, signal: ac.signal });
      setSession(out.session);
      setLive({});
      return out.exchanges;
    } catch (err) {
      setError(err as Error);
      setLive((prev) => Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { ...v, running: false }])));
      throw err;
    } finally {
      setSending(false);
    }
  }, [client]);

  const reset = useCallback(async (paneId?: string) => {
    if (!idRef.current) return;
    setSession(await client.resetPlaygroundSession(idRef.current, paneId));
  }, [client]);

  const close = useCallback(async () => {
    abort.current?.abort();
    if (idRef.current) await client.deletePlaygroundSession(idRef.current).catch(() => undefined);
    idRef.current = undefined;
    setSession(undefined);
    setLive({});
  }, [client]);

  const saveCase = useCallback((req: { paneId: string; exchange?: number; name?: string; mockModel?: boolean; save?: { agent: string; suite: string } }) => {
    if (!idRef.current) return Promise.reject(new Error("Open the Playground first"));
    return client.playgroundCaseFromExchange(idRef.current, req);
  }, [client]);

  const promote = useCallback((req: { agent: string; version?: string; overrides: SuiteVariantOverrides; note?: string }) => client.promotePlaygroundVariant(req), [client]);

  return { session, live, sending, error, open, setPanes, send, reset, close, saveCase, promote };
}
