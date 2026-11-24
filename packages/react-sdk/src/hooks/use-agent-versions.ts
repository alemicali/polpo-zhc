import { useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useEvents } from "./use-events.js";
import type {
  AgentDeployEntry, AgentPublishResult, AgentVersion, AgentVersionBump, AgentVersionDiff, AgentVersionList,
} from "@polpo-ai/sdk";

/** Refetch when the agent changes (draft edits, deploys and rollbacks emit agent:updated). */
function useAgentChanged(name: string | undefined, refetch: () => void): void {
  const { events } = useEvents(["agent:updated", "agent:created", "agent:removed"], 1);
  const latest = events.at(-1);
  const handled = useRef(latest?.id);
  useEffect(() => {
    if (!latest || handled.current === latest.id) return;
    handled.current = latest.id;
    const d = latest.data as { agentName?: string } | undefined;
    if (!d?.agentName || d.agentName === name) refetch();
  }, [latest, name, refetch]);
}

export interface UseAgentVersionsReturn {
  /** Versions (newest first) and the state: production, latest, draft (undefined while loading). */
  data: AgentVersionList | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  /** One version with its config ("draft" and "production" accepted). */
  get: (version: string) => Promise<AgentVersion>;
  /** Diff two refs (a version, "production", "draft"); to defaults to the draft. */
  diff: (opts?: { from?: string; to?: string }) => Promise<AgentVersionDiff>;
  /** Publish the draft as a new version (deploy: also to production); refetches. */
  publish: (req?: { bump?: AgentVersionBump; version?: string; note?: string; deploy?: boolean }) => Promise<AgentPublishResult>;
  /** Throw away the draft; refetches. */
  discardDraft: () => Promise<void>;
}

/**
 * An agent's versions: list, read one, diff two, publish the draft, discard it. Refetched when the
 * agent changes. Deploys and rollbacks: {@link useAgentDeploys}.
 */
export function useAgentVersions(name: string | undefined): UseAgentVersionsReturn {
  const { client } = usePolpoContext();
  const [state, setState] = useState<{ key: string; data?: AgentVersionList; error: Error | null } | null>(null);
  const key = name ?? "";

  const fetch_ = useCallback(async () => {
    if (!name) return;
    try {
      setState({ key: name, data: await client.getAgentVersions(name), error: null });
    } catch (err) {
      setState({ key: name, error: err as Error });
    }
  }, [client, name]);

  useEffect(() => { void fetch_(); }, [fetch_]);
  useAgentChanged(name, () => { void fetch_(); });

  const publish = useCallback(async (req: Parameters<UseAgentVersionsReturn["publish"]>[0] = {}) => {
    const r = await client.publishAgent(name ?? "", req);
    await fetch_();
    return r;
  }, [client, name, fetch_]);

  const discardDraft = useCallback(async () => {
    await client.discardAgentDraft(name ?? "");
    await fetch_();
  }, [client, name, fetch_]);

  const current = state?.key === key ? state : null;
  return {
    data: current?.data,
    isLoading: !!name && !current,
    error: current?.error ?? null,
    refetch: fetch_,
    get: (version) => client.getAgentVersion(name ?? "", version),
    diff: (opts) => client.diffAgentVersions(name ?? "", opts),
    publish,
    discardDraft,
  };
}

export interface UseAgentDeploysReturn {
  /** The deploy history, newest first (undefined while loading). */
  data: AgentDeployEntry[] | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  /** One deploy with its diff (the version it replaced vs the one it deployed). */
  get: (id: string) => Promise<AgentDeployEntry & { diff: AgentVersionDiff }>;
  /** Deploy a published version to production; refetches. */
  deploy: (version: string, note?: string) => Promise<AgentDeployEntry>;
  /** Roll production back (to the previous deploy, or `to`); refetches. */
  rollback: (opts?: { to?: string; note?: string }) => Promise<AgentDeployEntry>;
}

/** An agent's deploy history (production pointer moves), deploy and rollback. */
export function useAgentDeploys(name: string | undefined, opts: { limit?: number } = {}): UseAgentDeploysReturn {
  const { client } = usePolpoContext();
  const [state, setState] = useState<{ key: string; data?: AgentDeployEntry[]; error: Error | null } | null>(null);
  const key = name ?? "";
  const limit = opts.limit;

  const fetch_ = useCallback(async () => {
    if (!name) return;
    try {
      setState({ key: name, data: await client.getAgentDeploys(name, { ...(limit ? { limit } : {}) }), error: null });
    } catch (err) {
      setState({ key: name, error: err as Error });
    }
  }, [client, name, limit]);

  useEffect(() => { void fetch_(); }, [fetch_]);
  useAgentChanged(name, () => { void fetch_(); });

  const deploy = useCallback(async (version: string, note?: string) => {
    const r = await client.deployAgentVersion(name ?? "", version, note);
    await fetch_();
    return r;
  }, [client, name, fetch_]);

  const rollback = useCallback(async (o: { to?: string; note?: string } = {}) => {
    const r = await client.rollbackAgent(name ?? "", o);
    await fetch_();
    return r;
  }, [client, name, fetch_]);

  const current = state?.key === key ? state : null;
  return {
    data: current?.data,
    isLoading: !!name && !current,
    error: current?.error ?? null,
    refetch: fetch_,
    get: (id) => client.getAgentDeploy(name ?? "", id),
    deploy,
    rollback,
  };
}
