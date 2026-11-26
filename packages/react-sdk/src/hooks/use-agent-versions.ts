import { useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useEvents } from "./use-events.js";
import type {
  AgentDeployEntry, AgentDeployGate, AgentDeployOutcome, AgentPublishResult, AgentVersion, AgentVersionBump, AgentVersionDiff, AgentVersionList,
} from "@polpo-ai/sdk";

/** Refetch when the agent changes (draft edits, deploys and rollbacks emit agent:updated; deploy gates agent:gate). */
function useAgentChanged(name: string | undefined, refetch: () => void): void {
  const { events } = useEvents(["agent:updated", "agent:created", "agent:removed", "agent:gate"], 1);
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
  /** Move a stale draft onto production (after a rollback or deploy); refetches. */
  rebaseDraft: () => Promise<{ from?: string; to?: string; dropped: boolean }>;
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
  const onChanged = useCallback(() => { void fetch_(); }, [fetch_]);
  useAgentChanged(name, onChanged);

  const publish = useCallback(async (req: Parameters<UseAgentVersionsReturn["publish"]>[0] = {}) => {
    const r = await client.publishAgent(name ?? "", req);
    await fetch_();
    return r;
  }, [client, name, fetch_]);

  const discardDraft = useCallback(async () => {
    await client.discardAgentDraft(name ?? "");
    await fetch_();
  }, [client, name, fetch_]);

  const rebaseDraft = useCallback(async () => {
    const r = await client.rebaseAgentDraft(name ?? "");
    await fetch_();
    return r;
  }, [client, name, fetch_]);

  const get = useCallback((version: string) => client.getAgentVersion(name ?? "", version), [client, name]);
  const diff = useCallback((o?: { from?: string; to?: string }) => client.diffAgentVersions(name ?? "", o), [client, name]);

  const current = state?.key === key ? state : null;
  return {
    data: current?.data,
    isLoading: !!name && !current,
    error: current?.error ?? null,
    refetch: fetch_,
    get,
    diff,
    publish,
    discardDraft,
    rebaseDraft,
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
  /**
   * Deploy a published version to production; refetches. With required suites the outcome may be
   * pending (in verifica); a blocked deploy throws (code GATE_BLOCKED). override: admins, with a reason.
   */
  deploy: (version: string, note?: string, opts?: { override?: { reason: string } }) => Promise<AgentDeployOutcome>;
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
  const onChanged = useCallback(() => { void fetch_(); }, [fetch_]);
  useAgentChanged(name, onChanged);

  const deploy = useCallback(async (version: string, note?: string, o: { override?: { reason: string } } = {}) => {
    try {
      return await client.deployAgentVersion(name ?? "", version, note, o);
    } finally {
      // a blocked deploy is in the history too
      await fetch_();
    }
  }, [client, name, fetch_]);

  const rollback = useCallback(async (o: { to?: string; note?: string } = {}) => {
    const r = await client.rollbackAgent(name ?? "", o);
    await fetch_();
    return r;
  }, [client, name, fetch_]);

  const get = useCallback((id: string) => client.getAgentDeploy(name ?? "", id), [client, name]);

  const current = state?.key === key ? state : null;
  return {
    data: current?.data,
    isLoading: !!name && !current,
    error: current?.error ?? null,
    refetch: fetch_,
    get,
    deploy,
    rollback,
  };
}

export interface UseAgentDeployGatesReturn {
  /** The agent's deploy gates, newest first (undefined while loading). */
  data: AgentDeployGate[] | undefined;
  /** The deploy being verified now ("in verifica"), if any. */
  pending: AgentDeployGate | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  get: (id: string) => Promise<AgentDeployGate>;
  /** Stop a verification (nothing is deployed); refetches. */
  cancel: (id: string) => Promise<AgentDeployGate>;
  /** Deploy a gate's version anyway: admins only, with a reason; refetches. */
  override: (id: string, reason: string, note?: string) => Promise<AgentDeployOutcome>;
}

/**
 * An agent's deploy gates: the required suites verifying a version before production (or when it is
 * published). Live: refetched on agent:gate (progress, decisions) and agent:updated.
 */
export function useAgentDeployGates(name: string | undefined, opts: { version?: string; limit?: number } = {}): UseAgentDeployGatesReturn {
  const { client } = usePolpoContext();
  const [state, setState] = useState<{ key: string; data?: AgentDeployGate[]; error: Error | null } | null>(null);
  const { version, limit } = opts;
  const key = `${name ?? ""}:${version ?? ""}`;

  const fetch_ = useCallback(async () => {
    if (!name) return;
    const k = `${name}:${version ?? ""}`;
    try {
      setState({ key: k, data: await client.getAgentDeployGates(name, { ...(version ? { version } : {}), ...(limit ? { limit } : {}) }), error: null });
    } catch (err) {
      setState({ key: k, error: err as Error });
    }
  }, [client, name, version, limit]);

  useEffect(() => { void fetch_(); }, [fetch_]);
  const onChanged = useCallback(() => { void fetch_(); }, [fetch_]);
  useAgentChanged(name, onChanged);

  const get = useCallback((id: string) => client.getAgentDeployGate(name ?? "", id), [client, name]);
  const cancel = useCallback(async (id: string) => {
    const r = await client.cancelAgentDeployGate(name ?? "", id);
    await fetch_();
    return r;
  }, [client, name, fetch_]);
  const override = useCallback(async (id: string, reason: string, note?: string) => {
    const r = await client.overrideAgentDeployGate(name ?? "", id, reason, note);
    await fetch_();
    return r;
  }, [client, name, fetch_]);

  const current = state?.key === key ? state : null;
  const data = current?.data;
  return {
    data,
    pending: data?.find((g) => g.status === "running" && g.trigger !== "publish"),
    isLoading: !!name && !current,
    error: current?.error ?? null,
    refetch: fetch_,
    get,
    cancel,
    override,
  };
}
