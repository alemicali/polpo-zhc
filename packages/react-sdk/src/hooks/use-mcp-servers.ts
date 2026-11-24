import { useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useEvents } from "./use-events.js";
import type {
  McpHostedServer, McpServerCallLog, McpServerDeploy, McpServerDiff, McpServerSpec, McpServerSummary, McpServerTemplateInfo,
  McpServerVersionInfo, McpToolTestResult, McpPendingCall, McpServerGenerateRequest, McpServerGenerateResult,
} from "@polpo-ai/sdk";

/** Refetch on `mcp-server:changed` (for `id`, or any server when undefined). */
function useServerChanged(id: string | undefined, refetch: () => void): void {
  const { events } = useEvents(["mcp-server:changed"], 1);
  const latest = events.at(-1);
  const handled = useRef(latest?.id);
  useEffect(() => {
    if (!latest || handled.current === latest.id) return;
    handled.current = latest.id;
    const d = latest.data as { id?: string } | undefined;
    if (!id || !d?.id || d.id === id) refetch();
  }, [latest, id, refetch]);
}

export interface UseMcpServersReturn {
  servers: McpServerSummary[];
  templates: McpServerTemplateInfo[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  /** Create a draft from a spec or a template; refetches. */
  create: (req: { id?: string; spec?: McpServerSpec; template?: string }) => Promise<{ id: string; problems: string[]; setup?: string }>;
  /** Draft a spec with Polpo's model (from an API or a description). */
  generate: (req: McpServerGenerateRequest) => Promise<McpServerGenerateResult>;
}

/** The custom MCP servers Polpo hosts, and the templates (Printful…). Live through `mcp-server:changed`. */
export function useMcpServers(): UseMcpServersReturn {
  const { client } = usePolpoContext();
  const [servers, setServers] = useState<McpServerSummary[]>([]);
  const [templates, setTemplates] = useState<McpServerTemplateInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([client.getMcpServers(), client.getMcpServerTemplates()]);
      setServers(s);
      setTemplates(t);
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [client]);

  useEffect(() => {
    setIsLoading(true);
    void fetch_().finally(() => setIsLoading(false));
  }, [fetch_]);
  useServerChanged(undefined, useCallback(() => { void fetch_(); }, [fetch_]));

  const create = useCallback(async (req: Parameters<UseMcpServersReturn["create"]>[0]) => {
    const r = await client.createMcpServer(req);
    await fetch_();
    return r;
  }, [client, fetch_]);
  const generate = useCallback((req: McpServerGenerateRequest) => client.generateMcpServer(req), [client]);

  return { servers, templates, isLoading, error, refetch: fetch_, create, generate };
}

export interface UseMcpServerReturn {
  server: McpHostedServer | undefined;
  versions: McpServerVersionInfo[];
  deploys: McpServerDeploy[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  saveDraft: (spec: McpServerSpec) => Promise<{ problems: string[] }>;
  discardDraft: () => Promise<void>;
  updateSettings: (req: Parameters<ReturnType<typeof usePolpoContext>["client"]["updateMcpServerSettings"]>[1]) => Promise<void>;
  test: (req: { tool: string; input?: Record<string, unknown>; ref?: string; confirm?: boolean; dryRun?: boolean }) => Promise<McpToolTestResult>;
  runTests: (ref?: string) => Promise<{ results: McpToolTestResult[]; passed: number; failed: number; skipped: number }>;
  saveTests: (tests: Parameters<ReturnType<typeof usePolpoContext>["client"]["saveMcpServerTests"]>[1]) => Promise<void>;
  publish: (req?: { bump?: "major" | "minor" | "patch"; version?: string; note?: string; deploy?: boolean; force?: boolean }) => Promise<{ version: string }>;
  deploy: (version: string, note?: string) => Promise<McpServerDeploy>;
  rollback: (opts?: { to?: string; note?: string }) => Promise<McpServerDeploy>;
  diff: (opts?: { from?: string; to?: string }) => Promise<McpServerDiff>;
  logs: (limit?: number) => Promise<McpServerCallLog[]>;
  pending: () => Promise<McpPendingCall[]>;
  remove: () => Promise<void>;
}

/** One hosted server: its draft, versions and deploys, and every action on it. Live through `mcp-server:changed`. */
export function useMcpServer(id: string | undefined): UseMcpServerReturn {
  const { client } = usePolpoContext();
  const [state, setState] = useState<{ server?: McpHostedServer; versions: McpServerVersionInfo[]; deploys: McpServerDeploy[]; error: Error | null; loading: boolean }>({ versions: [], deploys: [], error: null, loading: true });

  const fetch_ = useCallback(async () => {
    if (!id) return;
    try {
      const [server, versions, deploys] = await Promise.all([client.getMcpServer(id), client.getMcpServerVersions(id), client.getMcpServerDeploys(id)]);
      setState({ server, versions, deploys, error: null, loading: false });
    } catch (err) {
      setState((s) => ({ ...s, error: err as Error, loading: false }));
    }
  }, [client, id]);

  useEffect(() => { void fetch_(); }, [fetch_]);
  useServerChanged(id, useCallback(() => { void fetch_(); }, [fetch_]));

  const key = id ?? "";
  const after = <T,>(p: Promise<T>) => p.then(async (r) => { await fetch_(); return r; });
  return {
    server: state.server, versions: state.versions, deploys: state.deploys, isLoading: state.loading, error: state.error, refetch: fetch_,
    saveDraft: (spec) => after(client.saveMcpServerDraft(key, spec)),
    discardDraft: () => after(client.discardMcpServerDraft(key)).then(() => undefined),
    updateSettings: (req) => after(client.updateMcpServerSettings(key, req)).then(() => undefined),
    test: (req) => client.testMcpServerTool(key, req),
    runTests: (ref) => client.runMcpServerTests(key, ref),
    saveTests: (tests) => after(client.saveMcpServerTests(key, tests)).then(() => undefined),
    publish: (req) => after(client.publishMcpServer(key, req ?? {})),
    deploy: (version, note) => after(client.deployMcpServer(key, version, note)),
    rollback: (opts) => after(client.rollbackMcpServer(key, opts ?? {})),
    diff: (opts) => client.diffMcpServer(key, opts ?? {}),
    logs: (limit) => client.getMcpServerLogs(key, limit),
    pending: () => client.getMcpServerPending(key),
    remove: () => client.deleteMcpServer(key).then(() => undefined),
  };
}
