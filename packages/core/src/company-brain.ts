export type BrainCapability = "read" | "write" | "admin";
export type BrainStatus = "candidate" | "confirmed" | "rejected" | "archived";

export interface BrainEvidence {
  id: string;
  sourceType: "data-source" | "file" | "chat" | "task" | "mission" | "app" | "manual";
  sourceId: string;
  dataset?: string;
  recordId?: string;
  excerpt?: string;
  observedAt: string;
  confidence: number;
}

export interface BrainEntity {
  id: string;
  type: string;
  name: string;
  aliases: string[];
  summary?: string;
  properties: Record<string, unknown>;
  tags: string[];
  confidence: number;
  status: BrainStatus;
  evidence: BrainEvidence[];
  createdAt: string;
  updatedAt: string;
}

export interface BrainRelation {
  id: string;
  fromId: string;
  toId: string;
  type: string;
  label?: string;
  properties: Record<string, unknown>;
  confidence: number;
  status: BrainStatus;
  validFrom?: string;
  validTo?: string;
  evidence: BrainEvidence[];
  createdAt: string;
  updatedAt: string;
}

export interface BrainClaim {
  id: string;
  entityId: string;
  predicate: string;
  value: unknown;
  confidence: number;
  status: BrainStatus;
  validFrom?: string;
  validTo?: string;
  evidence: BrainEvidence[];
  createdAt: string;
  updatedAt: string;
}

export interface BrainGrant {
  id: string;
  agent: string;
  capabilities: BrainCapability[];
  /** Entity types, or `*` for the complete graph. */
  entityTypes: string[];
}

export interface BrainRun {
  id: string;
  kind: "data-source" | "text" | "resolution";
  label: string;
  status: "running" | "succeeded" | "partial" | "failed";
  sourceId?: string;
  dataset?: string;
  createdBy?: string;
  entitiesCreated: number;
  entitiesUpdated: number;
  relationsCreated: number;
  claimsCreated: number;
  warnings: string[];
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface BrainActivity {
  id: string;
  action: "entity" | "relation" | "claim" | "ingest" | "merge" | "grant";
  subjectId?: string;
  agent?: string;
  detail: string;
  createdAt: string;
}

export interface CompanyBrainSnapshot {
  version: 1;
  entities: BrainEntity[];
  relations: BrainRelation[];
  claims: BrainClaim[];
  grants: BrainGrant[];
  runs: BrainRun[];
  activity: BrainActivity[];
}

export interface BrainGraph {
  entities: BrainEntity[];
  relations: BrainRelation[];
  claims: BrainClaim[];
  stats: BrainStats;
}

export interface BrainStats {
  entities: number;
  relations: number;
  claims: number;
  candidates: number;
  evidence: number;
  entityTypes: Array<{ type: string; count: number }>;
  relationTypes: Array<{ type: string; count: number }>;
  components: number;
  lastRun?: BrainRun;
}

export interface BrainPrincipal {
  agent?: string;
  admin?: boolean;
}

export interface BrainChangeEvent {
  action: "created" | "updated" | "deleted" | "ingested" | "merged" | "grant";
  subjectType: "entity" | "relation" | "claim" | "run" | "brain";
  subjectId?: string;
  timestamp: string;
}

export type BrainChangeEmitter = (event: BrainChangeEvent) => void;

/** Most recent ingestion runs and activity entries kept in the brain. */
export const BRAIN_MAX_RUNS = 250;
export const BRAIN_MAX_ACTIVITY = 2_000;

/**
 * Storage of the company brain. Changes are whole-snapshot transactions: `change` mutates a copy,
 * the store persists what changed. Arrays keep their order (entities, relations, claims and grants
 * in insertion order; runs and activity newest first).
 */
export interface CompanyBrainStore {
  snapshot(): Promise<CompanyBrainSnapshot>;
  transaction<T>(change: (snapshot: CompanyBrainSnapshot) => T | Promise<T>): Promise<T>;
  setEmitter(emitChange?: BrainChangeEmitter): void;
  emit(event: Omit<BrainChangeEvent, "timestamp">): void;
}

export function normalizeBrainType(value: string, fallback = "concept"): string {
  const normalized = value.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return normalized || fallback;
}

export function normalizeBrainName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeBrainTags(values: string[]): string[] {
  return [...new Set(values.map((value) => normalizeBrainType(value, "")).filter(Boolean))].sort();
}
