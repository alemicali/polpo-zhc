import { useCallback, useEffect, useRef, useState } from "react";
import { useEvents } from "@polpo-ai/react";
import { apiUrl, config } from "@/lib/config";

export type BrainStatus = "candidate" | "confirmed" | "rejected" | "archived";
export type BrainEvidence = {
  id: string; sourceType: "data-source" | "file" | "chat" | "task" | "mission" | "app" | "manual";
  sourceId: string; dataset?: string; recordId?: string; excerpt?: string; observedAt: string; confidence: number;
};
export type BrainEntity = {
  id: string; type: string; name: string; aliases: string[]; summary?: string; properties: Record<string, unknown>;
  tags: string[]; confidence: number; status: BrainStatus; evidence: BrainEvidence[]; createdAt: string; updatedAt: string;
};
export type BrainRelation = {
  id: string; fromId: string; toId: string; type: string; label?: string; properties: Record<string, unknown>;
  confidence: number; status: BrainStatus; validFrom?: string; validTo?: string; evidence: BrainEvidence[]; createdAt: string; updatedAt: string;
};
export type BrainClaim = {
  id: string; entityId: string; predicate: string; value: unknown; confidence: number; status: BrainStatus;
  validFrom?: string; validTo?: string; evidence: BrainEvidence[]; createdAt: string; updatedAt: string;
};
export type BrainRun = {
  id: string; kind: "data-source" | "text" | "resolution"; label: string; status: "running" | "succeeded" | "partial" | "failed";
  sourceId?: string; dataset?: string; createdBy?: string; entitiesCreated: number; entitiesUpdated: number;
  relationsCreated: number; claimsCreated: number; warnings: string[]; error?: string; startedAt: string; finishedAt?: string;
};
export type BrainGrant = { id: string; agent: string; capabilities: Array<"read" | "write" | "admin">; entityTypes: string[] };
export type BrainStats = {
  entities: number; relations: number; claims: number; candidates: number; evidence: number; components: number;
  entityTypes: Array<{ type: string; count: number }>; relationTypes: Array<{ type: string; count: number }>; lastRun?: BrainRun;
};
export type BrainGraph = { entities: BrainEntity[]; relations: BrainRelation[]; claims: BrainClaim[]; stats: BrainStats };
export type BrainEntityDetail = { entity: BrainEntity; relations: BrainRelation[]; claims: BrainClaim[] };

async function brainRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  if (config.apiKey) headers.set("authorization", `Bearer ${config.apiKey}`);
  const response = await fetch(apiUrl(`/api/v1/brain${path}`), { ...init, headers, credentials: "include" });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(body?.error || `Company Brain ${path} request failed (${response.status})`);
  }
  return body.data as T;
}

export function useCompanyBrain() {
  const { events } = useEvents(["brain:changed"], 1);
  const [graph, setGraph] = useState<BrainGraph | null>(null);
  const [runs, setRuns] = useState<BrainRun[]>([]);
  const [grants, setGrants] = useState<BrainGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const [nextGraph, nextRuns, nextGrants] = await Promise.all([
        brainRequest<BrainGraph>("/graph?limit=1000"), brainRequest<BrainRun[]>("/runs"), brainRequest<BrainGrant[]>("/grants"),
      ]);
      setGraph(nextGraph); setRuns(nextRuns); setGrants(nextGrants); setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refetch(); }, [refetch]);
  const latestEvent = events.at(-1);
  const handledEvent = useRef(latestEvent?.id);
  useEffect(() => {
    if (!latestEvent || handledEvent.current === latestEvent.id) return;
    handledEvent.current = latestEvent.id;
    void refetch();
  }, [latestEvent, refetch]);

  const getEntity = useCallback((id: string) => brainRequest<BrainEntityDetail>(`/entities/${encodeURIComponent(id)}`), []);
  const createEntity = useCallback(async (input: Partial<BrainEntity> & Pick<BrainEntity, "type" | "name">) => {
    const result = await brainRequest<BrainEntity>("/entities", { method: "POST", body: JSON.stringify(input) }); await refetch(); return result;
  }, [refetch]);
  const updateEntity = useCallback(async (id: string, input: Partial<BrainEntity> & Pick<BrainEntity, "type" | "name">) => {
    const result = await brainRequest<BrainEntity>(`/entities/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) }); await refetch(); return result;
  }, [refetch]);
  const deleteEntity = useCallback(async (id: string) => { await brainRequest(`/entities/${encodeURIComponent(id)}`, { method: "DELETE" }); await refetch(); }, [refetch]);
  const createRelation = useCallback(async (input: Pick<BrainRelation, "fromId" | "toId" | "type"> & Partial<BrainRelation>) => {
    const result = await brainRequest<BrainRelation>("/relations", { method: "POST", body: JSON.stringify(input) }); await refetch(); return result;
  }, [refetch]);
  const updateRelation = useCallback(async (id: string, input: Pick<BrainRelation, "fromId" | "toId" | "type"> & Partial<BrainRelation>) => {
    const result = await brainRequest<BrainRelation>(`/relations/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) }); await refetch(); return result;
  }, [refetch]);
  const deleteRelation = useCallback(async (id: string) => { await brainRequest(`/relations/${encodeURIComponent(id)}`, { method: "DELETE" }); await refetch(); }, [refetch]);
  const enrichText = useCallback(async (input: { text: string; label?: string; sourceType?: string; sourceId?: string }) => {
    const result = await brainRequest<BrainRun>("/enrich/text", { method: "POST", body: JSON.stringify(input) }); await refetch(); return result;
  }, [refetch]);
  const ingestDataSource = useCallback(async (input: { sourceId: string; dataset: string; entityType?: string; idField?: string; nameField?: string; limit?: number; semantic?: boolean }) => {
    const result = await brainRequest<BrainRun>("/ingest/data-source", { method: "POST", body: JSON.stringify(input) }); await refetch(); return result;
  }, [refetch]);
  const setGrant = useCallback(async (agent: string, capability: "none" | "read" | "write" | "admin", entityTypes: string[]) => {
    await brainRequest(`/grants/${encodeURIComponent(agent)}`, { method: "PUT", body: JSON.stringify({ capability, entityTypes }) }); await refetch();
  }, [refetch]);

  return {
    graph, runs, grants, loading, error, refetch, getEntity, createEntity, updateEntity, deleteEntity,
    createRelation, updateRelation, deleteRelation, enrichText, ingestDataSource, setGrant,
  };
}

export { brainRequest };
