import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import {
  normalizeBrainName,
  normalizeBrainTags,
  normalizeBrainType,
  type BrainActivity,
  type BrainCapability,
  type BrainChangeEmitter,
  type BrainClaim,
  type BrainEntity,
  type BrainEvidence,
  type BrainGraph,
  type BrainGrant,
  type BrainPrincipal,
  type BrainRelation,
  type BrainRun,
  type BrainStats,
  type BrainStatus,
  type CompanyBrainSnapshot,
} from "@polpo-ai/core/company-brain";
import { queryOrchestratorText } from "../llm/query.js";
import { FileCompanyBrainStore } from "../stores/file-company-brain-store.js";
import type { DataRuntime } from "./data-runtime.js";

const MAX_GRAPH_ENTITIES = 1_000;
const MAX_INGEST_ROWS = 500;
const MAX_TEXT_CHARS = 80_000;

export interface BrainEntityInput {
  id?: string;
  type: string;
  name: string;
  aliases?: string[];
  summary?: string;
  properties?: Record<string, unknown>;
  tags?: string[];
  confidence?: number;
  status?: BrainStatus;
  evidence?: BrainEvidence[];
}

export interface BrainRelationInput {
  id?: string;
  fromId: string;
  toId: string;
  type: string;
  label?: string;
  properties?: Record<string, unknown>;
  confidence?: number;
  status?: BrainStatus;
  validFrom?: string;
  validTo?: string;
  evidence?: BrainEvidence[];
}

export interface BrainClaimInput {
  id?: string;
  entityId: string;
  predicate: string;
  value: unknown;
  confidence?: number;
  status?: BrainStatus;
  validFrom?: string;
  validTo?: string;
  evidence?: BrainEvidence[];
}

export interface BrainGraphQuery {
  query?: string;
  entityTypes?: string[];
  statuses?: BrainStatus[];
  entityId?: string;
  depth?: number;
  limit?: number;
}

export interface BrainDataIngestInput {
  sourceId: string;
  dataset: string;
  entityType?: string;
  idField?: string;
  nameField?: string;
  limit?: number;
  semantic?: boolean;
}

export interface BrainTextEnrichmentInput {
  text: string;
  label?: string;
  sourceType?: BrainEvidence["sourceType"];
  sourceId?: string;
  dataset?: string;
}

type ExtractedGraph = {
  entities?: Array<{ key?: string; type?: string; name?: string; aliases?: string[]; summary?: string; properties?: Record<string, unknown>; confidence?: number }>;
  relations?: Array<{ from?: string; to?: string; type?: string; label?: string; properties?: Record<string, unknown>; confidence?: number; validFrom?: string; validTo?: string }>;
  claims?: Array<{ entity?: string; predicate?: string; value?: unknown; confidence?: number; validFrom?: string; validTo?: string }>;
};

export class CompanyBrainRuntime {
  readonly store: FileCompanyBrainStore;

  constructor(
    readonly polpoDir: string,
    private dataRuntime?: DataRuntime,
    emitChange?: BrainChangeEmitter,
  ) {
    this.store = new FileCompanyBrainStore(polpoDir, emitChange);
  }

  setDependencies(dataRuntime?: DataRuntime, emitChange?: BrainChangeEmitter): void {
    this.dataRuntime = dataRuntime;
    this.store.setEmitter(emitChange);
  }

  async graph(query: BrainGraphQuery = {}, principal: BrainPrincipal = { admin: true }): Promise<BrainGraph> {
    const snapshot = await this.store.snapshot();
    const visible = this.visibleEntityTypes(snapshot, principal);
    const normalizedQuery = query.query?.trim().toLocaleLowerCase();
    const requestedTypes = new Set((query.entityTypes ?? []).map((type) => normalizeBrainType(type)));
    const statuses = new Set(query.statuses ?? ["candidate", "confirmed"]);
    let entities = snapshot.entities.filter((entity) => visible(entity.type)
      && statuses.has(entity.status)
      && (requestedTypes.size === 0 || requestedTypes.has(entity.type))
      && (!normalizedQuery || searchableEntity(entity).includes(normalizedQuery)));

    if (query.entityId) {
      const depth = Math.max(0, Math.min(query.depth ?? 1, 3));
      const ids = neighborhood(snapshot, query.entityId, depth);
      entities = snapshot.entities.filter((entity) => ids.has(entity.id) && visible(entity.type) && statuses.has(entity.status));
    }

    entities = entities.slice(0, Math.max(1, Math.min(query.limit ?? MAX_GRAPH_ENTITIES, MAX_GRAPH_ENTITIES)));
    const ids = new Set(entities.map((entity) => entity.id));
    const relations = snapshot.relations.filter((relation) => ids.has(relation.fromId) && ids.has(relation.toId) && statuses.has(relation.status));
    const claims = snapshot.claims.filter((claim) => ids.has(claim.entityId) && statuses.has(claim.status));
    return { entities, relations, claims, stats: calculateStats({ ...snapshot, entities, relations, claims }) };
  }

  async stats(principal: BrainPrincipal = { admin: true }): Promise<BrainStats> {
    const graph = await this.graph({ limit: MAX_GRAPH_ENTITIES }, principal);
    return graph.stats;
  }

  async search(query: string, principal: BrainPrincipal = { admin: true }, limit = 20): Promise<Array<BrainEntity & { score: number }>> {
    const terms = normalizeBrainName(query).toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const snapshot = await this.store.snapshot();
    const visible = this.visibleEntityTypes(snapshot, principal);
    return snapshot.entities
      .filter((entity) => visible(entity.type) && entity.status !== "rejected" && entity.status !== "archived")
      .map((entity) => ({ ...entity, score: searchScore(entity, terms) }))
      .filter((entity) => entity.score > 0)
      .sort((a, b) => b.score - a.score || b.confidence - a.confidence)
      .slice(0, Math.max(1, Math.min(limit, 100)));
  }

  async getEntity(id: string, principal: BrainPrincipal = { admin: true }): Promise<{ entity: BrainEntity; relations: BrainRelation[]; claims: BrainClaim[] }> {
    const snapshot = await this.store.snapshot();
    const entity = snapshot.entities.find((item) => item.id === id);
    if (!entity || !this.visibleEntityTypes(snapshot, principal)(entity.type)) throw new Error(`Brain entity "${id}" not found`);
    return {
      entity,
      relations: snapshot.relations.filter((relation) => relation.fromId === id || relation.toId === id),
      claims: snapshot.claims.filter((claim) => claim.entityId === id),
    };
  }

  async upsertEntity(input: BrainEntityInput, principal: BrainPrincipal = { admin: true }): Promise<BrainEntity> {
    this.require(await this.store.snapshot(), principal, "write", normalizeBrainType(input.type));
    const result = await this.store.transaction((snapshot) => {
      const { entity, created } = resolveEntity(snapshot, input);
      addActivity(snapshot, "entity", entity.id, principal.agent, `${created ? "Created" : "Updated"} ${entity.type} ${entity.name}`);
      return { entity, created };
    });
    this.store.emit({ action: result.created ? "created" : "updated", subjectType: "entity", subjectId: result.entity.id });
    return result.entity;
  }

  async upsertRelation(input: BrainRelationInput, principal: BrainPrincipal = { admin: true }): Promise<BrainRelation> {
    const snapshot = await this.store.snapshot();
    const from = snapshot.entities.find((entity) => entity.id === input.fromId);
    const to = snapshot.entities.find((entity) => entity.id === input.toId);
    if (!from || !to) throw new Error("Both relation endpoints must exist");
    this.require(snapshot, principal, "write", from.type);
    this.require(snapshot, principal, "write", to.type);
    const result = await this.store.transaction((data) => {
      const value = resolveRelation(data, input);
      addActivity(data, "relation", value.relation.id, principal.agent, `${value.created ? "Created" : "Updated"} ${value.relation.type}`);
      return value;
    });
    this.store.emit({ action: result.created ? "created" : "updated", subjectType: "relation", subjectId: result.relation.id });
    return result.relation;
  }

  async upsertClaim(input: BrainClaimInput, principal: BrainPrincipal = { admin: true }): Promise<BrainClaim> {
    const snapshot = await this.store.snapshot();
    const entity = snapshot.entities.find((item) => item.id === input.entityId);
    if (!entity) throw new Error(`Brain entity "${input.entityId}" not found`);
    this.require(snapshot, principal, "write", entity.type);
    const result = await this.store.transaction((data) => {
      const value = resolveClaim(data, input);
      addActivity(data, "claim", value.claim.id, principal.agent, `${value.created ? "Created" : "Updated"} ${value.claim.predicate}`);
      return value;
    });
    this.store.emit({ action: result.created ? "created" : "updated", subjectType: "claim", subjectId: result.claim.id });
    return result.claim;
  }

  async deleteSubject(kind: "entity" | "relation" | "claim", id: string, principal: BrainPrincipal = { admin: true }): Promise<boolean> {
    const snapshot = await this.store.snapshot();
    const type = kind === "entity"
      ? snapshot.entities.find((item) => item.id === id)?.type
      : kind === "claim"
        ? snapshot.entities.find((item) => item.id === snapshot.claims.find((claim) => claim.id === id)?.entityId)?.type
        : snapshot.entities.find((item) => item.id === snapshot.relations.find((relation) => relation.id === id)?.fromId)?.type;
    if (!type) return false;
    this.require(snapshot, principal, "write", type);
    const deleted = await this.store.transaction((data) => {
      if (kind === "entity") {
        const before = data.entities.length;
        data.entities = data.entities.filter((entity) => entity.id !== id);
        data.relations = data.relations.filter((relation) => relation.fromId !== id && relation.toId !== id);
        data.claims = data.claims.filter((claim) => claim.entityId !== id);
        return data.entities.length !== before;
      }
      if (kind === "relation") {
        const before = data.relations.length;
        data.relations = data.relations.filter((relation) => relation.id !== id);
        return data.relations.length !== before;
      }
      const before = data.claims.length;
      data.claims = data.claims.filter((claim) => claim.id !== id);
      return data.claims.length !== before;
    });
    if (deleted) this.store.emit({ action: "deleted", subjectType: kind, subjectId: id });
    return deleted;
  }

  async mergeEntities(keepId: string, mergeIds: string[], principal: BrainPrincipal = { admin: true }): Promise<BrainEntity> {
    const result = await this.store.transaction((snapshot) => {
      const keep = snapshot.entities.find((entity) => entity.id === keepId);
      if (!keep) throw new Error(`Brain entity "${keepId}" not found`);
      this.require(snapshot, principal, "write", keep.type);
      const merge = snapshot.entities.filter((entity) => mergeIds.includes(entity.id) && entity.id !== keep.id);
      for (const entity of merge) this.require(snapshot, principal, "write", entity.type);
      const removed = new Set(merge.map((entity) => entity.id));
      keep.aliases = uniqueStrings([...keep.aliases, ...merge.flatMap((entity) => [entity.name, ...entity.aliases])]).filter((value) => value !== keep.name);
      keep.tags = normalizeBrainTags([...keep.tags, ...merge.flatMap((entity) => entity.tags)]);
      keep.properties = Object.assign({}, ...merge.map((entity) => entity.properties), keep.properties);
      keep.evidence = mergeEvidence([...keep.evidence, ...merge.flatMap((entity) => entity.evidence)]);
      keep.confidence = Math.max(keep.confidence, ...merge.map((entity) => entity.confidence));
      keep.updatedAt = new Date().toISOString();
      snapshot.entities = snapshot.entities.filter((entity) => !removed.has(entity.id));
      for (const relation of snapshot.relations) {
        if (removed.has(relation.fromId)) relation.fromId = keep.id;
        if (removed.has(relation.toId)) relation.toId = keep.id;
      }
      snapshot.relations = dedupeRelations(snapshot.relations);
      for (const claim of snapshot.claims) if (removed.has(claim.entityId)) claim.entityId = keep.id;
      snapshot.claims = dedupeClaims(snapshot.claims);
      addActivity(snapshot, "merge", keep.id, principal.agent, `Merged ${merge.length} entities into ${keep.name}`);
      return keep;
    });
    this.store.emit({ action: "merged", subjectType: "entity", subjectId: result.id });
    return result;
  }

  async ingestDataSource(input: BrainDataIngestInput, principal: BrainPrincipal = { admin: true }): Promise<BrainRun> {
    if (!this.dataRuntime) throw new Error("Data runtime is unavailable");
    this.require(await this.store.snapshot(), principal, "write", normalizeBrainType(input.entityType ?? singularize(input.dataset)));
    const startedAt = new Date().toISOString();
    const run: BrainRun = {
      id: nanoid(), kind: "data-source", label: `Ingest ${input.dataset}`, status: "running",
      sourceId: input.sourceId, dataset: input.dataset, createdBy: principal.agent,
      entitiesCreated: 0, entitiesUpdated: 0, relationsCreated: 0, claimsCreated: 0,
      warnings: [], startedAt,
    };
    await this.store.transaction((snapshot) => { snapshot.runs.unshift(run); });

    try {
      const datasets = await this.dataRuntime.discover(input.sourceId, principal);
      const dataset = datasets.find((item) => item.name === input.dataset);
      if (!dataset) throw new Error(`Dataset "${input.dataset}" not found`);
      const limit = Math.max(1, Math.min(input.limit ?? 250, MAX_INGEST_ROWS));
      const frame = await this.dataRuntime.query({ sourceId: input.sourceId, dataset: input.dataset, limit }, principal);
      const idField = input.idField ?? dataset.columns.find((column) => column.primaryKey)?.name
        ?? dataset.columns.find((column) => column.name.toLocaleLowerCase() === "id")?.name;
      const nameField = input.nameField ?? findNameField(dataset.columns.map((column) => column.name));
      const entityType = normalizeBrainType(input.entityType ?? singularize(input.dataset));

      await this.store.transaction((snapshot) => {
        for (const [rowIndex, row] of frame.rows.entries()) {
          const recordValue = idField ? row[idField] : rowIndex;
          const recordId = String(recordValue ?? rowIndex);
          const name = normalizeBrainName(String((nameField && row[nameField]) ?? recordValue ?? `${input.dataset} ${rowIndex + 1}`));
          const evidence = makeEvidence("data-source", input.sourceId, input.dataset, recordId, undefined, 1);
          const entityId = stableId("ent", input.sourceId, input.dataset, entityType, recordId);
          const { entity, created } = resolveEntity(snapshot, {
            id: entityId, type: entityType, name, properties: row, confidence: 1, status: "confirmed", evidence: [evidence],
          });
          if (created) run.entitiesCreated += 1; else run.entitiesUpdated += 1;

          for (const [field, rawValue] of Object.entries(row)) {
            if (rawValue == null || field === idField || field === nameField || typeof rawValue === "object") continue;
            const claim = resolveClaim(snapshot, {
              entityId: entity.id, predicate: normalizeBrainType(field), value: rawValue,
              confidence: 1, status: "confirmed", evidence: [evidence],
            });
            if (claim.created) run.claimsCreated += 1;
            if (!/_id$/i.test(field)) continue;
            const targetType = normalizeBrainType(field.replace(/_id$/i, ""));
            const targetRecordId = String(rawValue);
            const target = resolveEntity(snapshot, {
              id: stableId("ent", input.sourceId, targetType, targetRecordId),
              type: targetType, name: targetRecordId, confidence: 0.7, status: "candidate", evidence: [evidence],
            });
            if (target.created) run.entitiesCreated += 1;
            const relation = resolveRelation(snapshot, {
              fromId: entity.id, toId: target.entity.id, type: `references_${targetType}`,
              confidence: 0.85, status: "candidate", evidence: [evidence],
            });
            if (relation.created) run.relationsCreated += 1;
          }
        }
        addActivity(snapshot, "ingest", run.id, principal.agent, `Mapped ${frame.rows.length} rows from ${input.dataset}`);
      });

      if (input.semantic !== false && frame.rows.length > 0) {
        try {
          const semantic = await this.extractText({
            text: JSON.stringify(frame.rows.slice(0, 50)),
            label: `${input.dataset} semantic enrichment`, sourceType: "data-source",
            sourceId: input.sourceId, dataset: input.dataset,
          }, principal, run.id);
          run.entitiesCreated += semantic.entitiesCreated;
          run.entitiesUpdated += semantic.entitiesUpdated;
          run.relationsCreated += semantic.relationsCreated;
          run.claimsCreated += semantic.claimsCreated;
        } catch (error) {
          run.warnings.push(`Semantic enrichment skipped: ${errorMessage(error)}`);
        }
      }
      run.status = run.warnings.length ? "partial" : "succeeded";
    } catch (error) {
      run.status = "failed";
      run.error = errorMessage(error);
    }
    run.finishedAt = new Date().toISOString();
    await this.store.transaction((snapshot) => {
      const index = snapshot.runs.findIndex((item) => item.id === run.id);
      if (index >= 0) snapshot.runs[index] = run;
    });
    this.store.emit({ action: "ingested", subjectType: "run", subjectId: run.id });
    if (run.status === "failed") throw new Error(run.error);
    return run;
  }

  async enrichText(input: BrainTextEnrichmentInput, principal: BrainPrincipal = { admin: true }): Promise<BrainRun> {
    this.require(await this.store.snapshot(), principal, "write");
    if (!input.text.trim()) throw new Error("Text is required");
    if (input.text.length > MAX_TEXT_CHARS) throw new Error(`Text exceeds ${MAX_TEXT_CHARS.toLocaleString()} characters`);
    const run: BrainRun = {
      id: nanoid(), kind: "text", label: input.label?.trim() || "Semantic enrichment", status: "running",
      sourceId: input.sourceId, dataset: input.dataset, createdBy: principal.agent,
      entitiesCreated: 0, entitiesUpdated: 0, relationsCreated: 0, claimsCreated: 0,
      warnings: [], startedAt: new Date().toISOString(),
    };
    await this.store.transaction((snapshot) => { snapshot.runs.unshift(run); });
    try {
      const result = await this.extractText(input, principal, run.id);
      Object.assign(run, result, { status: "succeeded" as const });
    } catch (error) {
      run.status = "failed";
      run.error = errorMessage(error);
    }
    run.finishedAt = new Date().toISOString();
    await this.store.transaction((snapshot) => {
      const index = snapshot.runs.findIndex((item) => item.id === run.id);
      if (index >= 0) snapshot.runs[index] = run;
    });
    this.store.emit({ action: "ingested", subjectType: "run", subjectId: run.id });
    if (run.status === "failed") throw new Error(run.error);
    return run;
  }

  private async extractText(input: BrainTextEnrichmentInput, principal: BrainPrincipal, runId: string): Promise<Pick<BrainRun, "entitiesCreated" | "entitiesUpdated" | "relationsCreated" | "claimsCreated">> {
    const current = await this.store.snapshot();
    const knownTypes = uniqueStrings(current.entities.map((entity) => entity.type)).slice(0, 50);
    const prompt = [
      "Extract a compact, evidence-grounded company knowledge graph from the input.",
      "Return ONLY valid JSON with keys entities, relations, claims.",
      "entities: [{key,type,name,aliases,summary,properties,confidence}]",
      "relations: [{from,to,type,label,properties,confidence,validFrom,validTo}] where from/to use entity keys.",
      "claims: [{entity,predicate,value,confidence,validFrom,validTo}] where entity uses an entity key.",
      "Do not infer facts not supported by the input. Omit weak relations. Confidence is 0..1.",
      `Prefer these existing entity types when appropriate: ${knownTypes.join(", ") || "none yet"}.`,
      `Source label: ${input.label ?? "manual text"}`,
      "INPUT:",
      input.text.slice(0, MAX_TEXT_CHARS),
    ].join("\n");
    const response = await queryOrchestratorText(prompt, undefined);
    const extracted = parseExtractedGraph(response.text);
    const evidence = makeEvidence(
      input.sourceType ?? "manual", input.sourceId ?? runId, input.dataset, undefined,
      input.text.replace(/\s+/g, " ").slice(0, 500), 0.8,
    );
    return this.store.transaction((snapshot) => {
      const counters = { entitiesCreated: 0, entitiesUpdated: 0, relationsCreated: 0, claimsCreated: 0 };
      const keys = new Map<string, string>();
      for (const raw of extracted.entities ?? []) {
        if (!raw.name?.trim()) continue;
        const result = resolveEntity(snapshot, {
          type: raw.type ?? "concept", name: raw.name, aliases: raw.aliases, summary: raw.summary,
          properties: raw.properties, confidence: clampConfidence(raw.confidence, 0.75),
          status: clampConfidence(raw.confidence, 0.75) >= 0.9 ? "confirmed" : "candidate", evidence: [evidence],
        });
        keys.set(raw.key?.trim() || raw.name, result.entity.id);
        keys.set(raw.name, result.entity.id);
        if (result.created) counters.entitiesCreated += 1; else counters.entitiesUpdated += 1;
      }
      for (const raw of extracted.relations ?? []) {
        const fromId = keys.get(raw.from ?? "");
        const toId = keys.get(raw.to ?? "");
        if (!fromId || !toId || fromId === toId) continue;
        const result = resolveRelation(snapshot, {
          fromId, toId, type: raw.type ?? "related_to", label: raw.label, properties: raw.properties,
          confidence: clampConfidence(raw.confidence, 0.7), status: "candidate",
          validFrom: raw.validFrom, validTo: raw.validTo, evidence: [evidence],
        });
        if (result.created) counters.relationsCreated += 1;
      }
      for (const raw of extracted.claims ?? []) {
        const entityId = keys.get(raw.entity ?? "");
        if (!entityId || !raw.predicate?.trim() || raw.value === undefined) continue;
        const result = resolveClaim(snapshot, {
          entityId, predicate: raw.predicate, value: raw.value,
          confidence: clampConfidence(raw.confidence, 0.7), status: "candidate",
          validFrom: raw.validFrom, validTo: raw.validTo, evidence: [evidence],
        });
        if (result.created) counters.claimsCreated += 1;
      }
      addActivity(snapshot, "ingest", runId, principal.agent, `Extracted ${counters.entitiesCreated + counters.entitiesUpdated} entities and ${counters.relationsCreated} relations`);
      return counters;
    });
  }

  async setGrant(agent: string, capability: "none" | BrainCapability, entityTypes: string[], principal: BrainPrincipal = { admin: true }): Promise<BrainGrant | null> {
    this.require(await this.store.snapshot(), principal, "admin");
    const result = await this.store.transaction((snapshot) => {
      snapshot.grants = snapshot.grants.filter((grant) => grant.agent !== agent);
      if (capability === "none") return null;
      const grant: BrainGrant = {
        id: nanoid(), agent: agent.trim(), capabilities: [capability],
        entityTypes: entityTypes.length ? uniqueStrings(entityTypes.map((type) => type === "*" ? "*" : normalizeBrainType(type))) : ["*"],
      };
      snapshot.grants.push(grant);
      addActivity(snapshot, "grant", grant.id, principal.agent, `Granted ${capability} to ${agent}`);
      return grant;
    });
    this.store.emit({ action: "grant", subjectType: "brain", subjectId: result?.id });
    return result;
  }

  async grants(principal: BrainPrincipal = { admin: true }): Promise<BrainGrant[]> {
    const snapshot = await this.store.snapshot();
    this.require(snapshot, principal, "admin");
    return snapshot.grants;
  }

  async runs(principal: BrainPrincipal = { admin: true }, limit = 50): Promise<BrainRun[]> {
    const snapshot = await this.store.snapshot();
    this.require(snapshot, principal, "read");
    return snapshot.runs.slice(0, Math.max(1, Math.min(limit, 250)));
  }

  async activity(principal: BrainPrincipal = { admin: true }, limit = 100): Promise<BrainActivity[]> {
    const snapshot = await this.store.snapshot();
    this.require(snapshot, principal, "read");
    return snapshot.activity.slice(0, Math.max(1, Math.min(limit, 500)));
  }

  private visibleEntityTypes(snapshot: CompanyBrainSnapshot, principal: BrainPrincipal): (type: string) => boolean {
    if (principal.admin || !principal.agent) return () => true;
    const grant = snapshot.grants.find((item) => item.agent === principal.agent && grantsCapability(item, "read"));
    if (!grant) return () => false;
    const types = new Set(grant.entityTypes);
    return (type) => types.has("*") || types.has(normalizeBrainType(type));
  }

  private require(snapshot: CompanyBrainSnapshot, principal: BrainPrincipal, capability: BrainCapability, entityType?: string): void {
    if (principal.admin || !principal.agent) return;
    const grant = snapshot.grants.find((item) => item.agent === principal.agent && grantsCapability(item, capability));
    const allowed = grant && (!entityType || grant.entityTypes.includes("*") || grant.entityTypes.includes(normalizeBrainType(entityType)));
    if (!allowed) throw new Error(`Brain ${capability} access requires a scoped grant${entityType ? ` for ${entityType}` : ""}`);
  }
}

const runtimes = new Map<string, CompanyBrainRuntime>();
export function getCompanyBrainRuntime(polpoDir: string, dataRuntime?: DataRuntime, emitChange?: BrainChangeEmitter): CompanyBrainRuntime {
  let runtime = runtimes.get(polpoDir);
  if (!runtime) {
    runtime = new CompanyBrainRuntime(polpoDir, dataRuntime, emitChange);
    runtimes.set(polpoDir, runtime);
  } else {
    runtime.setDependencies(dataRuntime, emitChange);
  }
  return runtime;
}

function resolveEntity(snapshot: CompanyBrainSnapshot, input: BrainEntityInput): { entity: BrainEntity; created: boolean } {
  const now = new Date().toISOString();
  const type = normalizeBrainType(input.type);
  const name = normalizeBrainName(input.name);
  if (!name) throw new Error("Entity name is required");
  const needle = name.toLocaleLowerCase();
  const existing = snapshot.entities.find((entity) => entity.id === input.id || (entity.type === type
    && [entity.name, ...entity.aliases].some((value) => value.toLocaleLowerCase() === needle)));
  if (existing) {
    if (existing.name !== name && !existing.aliases.some((alias) => alias.toLocaleLowerCase() === needle)) existing.aliases.push(name);
    existing.aliases = uniqueStrings([...existing.aliases, ...(input.aliases ?? [])]).filter((alias) => alias.toLocaleLowerCase() !== existing.name.toLocaleLowerCase());
    existing.summary = input.summary ?? existing.summary;
    existing.properties = { ...existing.properties, ...(input.properties ?? {}) };
    existing.tags = normalizeBrainTags([...existing.tags, ...(input.tags ?? [])]);
    existing.confidence = Math.max(existing.confidence, clampConfidence(input.confidence, existing.confidence));
    if (input.status === "confirmed" || existing.status === "candidate") existing.status = input.status ?? existing.status;
    existing.evidence = mergeEvidence([...existing.evidence, ...(input.evidence ?? [])]);
    existing.updatedAt = now;
    return { entity: existing, created: false };
  }
  const entity: BrainEntity = {
    id: input.id ?? nanoid(), type, name,
    aliases: uniqueStrings(input.aliases ?? []).filter((alias) => alias.toLocaleLowerCase() !== needle),
    summary: input.summary, properties: input.properties ?? {}, tags: normalizeBrainTags(input.tags ?? []),
    confidence: clampConfidence(input.confidence, 0.8), status: input.status ?? "candidate",
    evidence: mergeEvidence(input.evidence ?? []), createdAt: now, updatedAt: now,
  };
  snapshot.entities.push(entity);
  return { entity, created: true };
}

function resolveRelation(snapshot: CompanyBrainSnapshot, input: BrainRelationInput): { relation: BrainRelation; created: boolean } {
  const now = new Date().toISOString();
  const type = normalizeBrainType(input.type, "related_to");
  const existing = snapshot.relations.find((relation) => relation.id === input.id
    || (relation.fromId === input.fromId && relation.toId === input.toId && relation.type === type));
  if (existing) {
    existing.label = input.label ?? existing.label;
    existing.properties = { ...existing.properties, ...(input.properties ?? {}) };
    existing.confidence = Math.max(existing.confidence, clampConfidence(input.confidence, existing.confidence));
    if (input.status === "confirmed" || existing.status === "candidate") existing.status = input.status ?? existing.status;
    existing.validFrom = input.validFrom ?? existing.validFrom;
    existing.validTo = input.validTo ?? existing.validTo;
    existing.evidence = mergeEvidence([...existing.evidence, ...(input.evidence ?? [])]);
    existing.updatedAt = now;
    return { relation: existing, created: false };
  }
  const relation: BrainRelation = {
    id: input.id ?? nanoid(), fromId: input.fromId, toId: input.toId, type,
    label: input.label, properties: input.properties ?? {}, confidence: clampConfidence(input.confidence, 0.75),
    status: input.status ?? "candidate", validFrom: input.validFrom, validTo: input.validTo,
    evidence: mergeEvidence(input.evidence ?? []), createdAt: now, updatedAt: now,
  };
  snapshot.relations.push(relation);
  return { relation, created: true };
}

function resolveClaim(snapshot: CompanyBrainSnapshot, input: BrainClaimInput): { claim: BrainClaim; created: boolean } {
  const now = new Date().toISOString();
  const predicate = normalizeBrainType(input.predicate, "value");
  const valueKey = stableValue(input.value);
  const existing = snapshot.claims.find((claim) => claim.id === input.id
    || (claim.entityId === input.entityId && claim.predicate === predicate && stableValue(claim.value) === valueKey));
  if (existing) {
    existing.confidence = Math.max(existing.confidence, clampConfidence(input.confidence, existing.confidence));
    if (input.status === "confirmed" || existing.status === "candidate") existing.status = input.status ?? existing.status;
    existing.validFrom = input.validFrom ?? existing.validFrom;
    existing.validTo = input.validTo ?? existing.validTo;
    existing.evidence = mergeEvidence([...existing.evidence, ...(input.evidence ?? [])]);
    existing.updatedAt = now;
    return { claim: existing, created: false };
  }
  const claim: BrainClaim = {
    id: input.id ?? nanoid(), entityId: input.entityId, predicate, value: input.value,
    confidence: clampConfidence(input.confidence, 0.75), status: input.status ?? "candidate",
    validFrom: input.validFrom, validTo: input.validTo, evidence: mergeEvidence(input.evidence ?? []),
    createdAt: now, updatedAt: now,
  };
  snapshot.claims.push(claim);
  return { claim, created: true };
}

function calculateStats(snapshot: CompanyBrainSnapshot): BrainStats {
  const entityTypes = counts(snapshot.entities.map((entity) => entity.type));
  const relationTypes = counts(snapshot.relations.map((relation) => relation.type));
  return {
    entities: snapshot.entities.length,
    relations: snapshot.relations.length,
    claims: snapshot.claims.length,
    candidates: snapshot.entities.filter((item) => item.status === "candidate").length
      + snapshot.relations.filter((item) => item.status === "candidate").length
      + snapshot.claims.filter((item) => item.status === "candidate").length,
    evidence: snapshot.entities.reduce((total, item) => total + item.evidence.length, 0)
      + snapshot.relations.reduce((total, item) => total + item.evidence.length, 0)
      + snapshot.claims.reduce((total, item) => total + item.evidence.length, 0),
    entityTypes, relationTypes, components: componentCount(snapshot.entities, snapshot.relations), lastRun: snapshot.runs[0],
  };
}

function neighborhood(snapshot: CompanyBrainSnapshot, rootId: string, depth: number): Set<string> {
  const seen = new Set([rootId]);
  let frontier = new Set([rootId]);
  for (let level = 0; level < depth; level++) {
    const next = new Set<string>();
    for (const relation of snapshot.relations) {
      if (frontier.has(relation.fromId) && !seen.has(relation.toId)) next.add(relation.toId);
      if (frontier.has(relation.toId) && !seen.has(relation.fromId)) next.add(relation.fromId);
    }
    for (const id of next) seen.add(id);
    frontier = next;
  }
  return seen;
}

function componentCount(entities: BrainEntity[], relations: BrainRelation[]): number {
  if (entities.length === 0) return 0;
  const remaining = new Set(entities.map((entity) => entity.id));
  let components = 0;
  while (remaining.size) {
    components += 1;
    const first = remaining.values().next().value as string;
    const queue = [first];
    remaining.delete(first);
    while (queue.length) {
      const id = queue.pop()!;
      for (const relation of relations) {
        const next = relation.fromId === id ? relation.toId : relation.toId === id ? relation.fromId : undefined;
        if (next && remaining.delete(next)) queue.push(next);
      }
    }
  }
  return components;
}

function dedupeRelations(relations: BrainRelation[]): BrainRelation[] {
  const map = new Map<string, BrainRelation>();
  for (const relation of relations) {
    const key = `${relation.fromId}:${relation.toId}:${relation.type}`;
    const existing = map.get(key);
    if (!existing) map.set(key, relation);
    else existing.evidence = mergeEvidence([...existing.evidence, ...relation.evidence]);
  }
  return [...map.values()];
}

function dedupeClaims(claims: BrainClaim[]): BrainClaim[] {
  const map = new Map<string, BrainClaim>();
  for (const claim of claims) {
    const key = `${claim.entityId}:${claim.predicate}:${stableValue(claim.value)}`;
    const existing = map.get(key);
    if (!existing) map.set(key, claim);
    else existing.evidence = mergeEvidence([...existing.evidence, ...claim.evidence]);
  }
  return [...map.values()];
}

function parseExtractedGraph(text: string): ExtractedGraph {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The enrichment model did not return a JSON graph");
  const parsed = JSON.parse(stripped.slice(start, end + 1)) as ExtractedGraph;
  if (!parsed || typeof parsed !== "object") throw new Error("The enrichment model returned an invalid graph");
  return parsed;
}

function makeEvidence(sourceType: BrainEvidence["sourceType"], sourceId: string, dataset?: string, recordId?: string, excerpt?: string, confidence = 1): BrainEvidence {
  return { id: nanoid(), sourceType, sourceId, dataset, recordId, excerpt, observedAt: new Date().toISOString(), confidence: clampConfidence(confidence, 1) };
}

function mergeEvidence(evidence: BrainEvidence[]): BrainEvidence[] {
  const map = new Map<string, BrainEvidence>();
  for (const item of evidence) {
    const key = `${item.sourceType}:${item.sourceId}:${item.dataset ?? ""}:${item.recordId ?? ""}:${item.excerpt ?? ""}`;
    const existing = map.get(key);
    if (!existing || item.confidence > existing.confidence) map.set(key, item);
  }
  return [...map.values()].slice(-100);
}

function addActivity(snapshot: CompanyBrainSnapshot, action: BrainActivity["action"], subjectId: string, agent: string | undefined, detail: string): void {
  snapshot.activity.unshift({ id: nanoid(), action, subjectId, agent, detail, createdAt: new Date().toISOString() });
}

function stableId(prefix: string, ...values: unknown[]): string {
  return `${prefix}_${createHash("sha256").update(values.map(String).join("\u001f")).digest("hex").slice(0, 16)}`;
}

function stableValue(value: unknown): string {
  try { return JSON.stringify(value, Object.keys((value && typeof value === "object" && !Array.isArray(value)) ? value as object : {}).sort()); }
  catch { return String(value); }
}

function searchableEntity(entity: BrainEntity): string {
  return `${entity.name} ${entity.type} ${entity.aliases.join(" ")} ${entity.summary ?? ""} ${entity.tags.join(" ")} ${stableValue(entity.properties)}`.toLocaleLowerCase();
}

function searchScore(entity: BrainEntity, terms: string[]): number {
  const name = entity.name.toLocaleLowerCase();
  const aliases = entity.aliases.map((alias) => alias.toLocaleLowerCase());
  const haystack = searchableEntity(entity);
  return terms.reduce((score, term) => score
    + (name === term ? 12 : name.startsWith(term) ? 8 : name.includes(term) ? 5 : 0)
    + (aliases.some((alias) => alias === term) ? 7 : 0)
    + (haystack.includes(term) ? 1 : 0), 0);
}

function counts(values: string[]): Array<{ type: string; count: number }> {
  const map = new Map<string, number>();
  for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
  return [...map].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

function findNameField(fields: string[]): string | undefined {
  const priorities = ["name", "title", "label", "display_name", "full_name", "email", "slug"];
  return priorities.find((candidate) => fields.some((field) => field.toLocaleLowerCase() === candidate))
    ? fields.find((field) => priorities.includes(field.toLocaleLowerCase()))
    : fields.find((field) => !/_id$/i.test(field));
}

function singularize(value: string): string {
  const normalized = normalizeBrainType(value);
  if (normalized.endsWith("ies")) return `${normalized.slice(0, -3)}y`;
  if (normalized.endsWith("ses")) return normalized.slice(0, -2);
  return normalized.endsWith("s") && !normalized.endsWith("ss") ? normalized.slice(0, -1) : normalized;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.map(normalizeBrainName).filter((value) => value && !seen.has(value.toLocaleLowerCase()) && Boolean(seen.add(value.toLocaleLowerCase())));
}

function clampConfidence(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value!)) : fallback;
}

function grantsCapability(grant: BrainGrant, capability: BrainCapability): boolean {
  if (grant.capabilities.includes("admin")) return true;
  if (capability === "read") return grant.capabilities.includes("read") || grant.capabilities.includes("write");
  return grant.capabilities.includes(capability);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
