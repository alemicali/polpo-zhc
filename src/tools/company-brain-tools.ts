import { Type } from "@sinclair/typebox";
import type { Tool } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BrainChangeEmitter, BrainPrincipal } from "@polpo-ai/core/company-brain";
import { getCompanyBrainRuntime } from "../server/company-brain-runtime.js";
import { getDataRegistryRuntime } from "../server/data-runtime.js";
import type { VaultStore } from "../core/vault-store.js";

const Status = Type.Union([Type.Literal("candidate"), Type.Literal("confirmed"), Type.Literal("rejected"), Type.Literal("archived")]);
const Entity = Type.Object({
  id: Type.Optional(Type.String()), type: Type.String(), name: Type.String(), aliases: Type.Optional(Type.Array(Type.String())),
  summary: Type.Optional(Type.String()), properties: Type.Optional(Type.Record(Type.String(), Type.Any())), tags: Type.Optional(Type.Array(Type.String())),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), status: Type.Optional(Status),
});

export const BRAIN_TOOL_NAMES = [
  "brain_stats", "brain_search", "brain_get_entity", "brain_get_context", "brain_list_runs",
  "brain_upsert_entity", "brain_upsert_relation", "brain_upsert_claim", "brain_ingest_data_source",
  "brain_enrich_text", "brain_merge_entities", "brain_set_grant",
] as const;

export const BRAIN_ORCHESTRATOR_TOOLS: Tool[] = [
  { name: "brain_stats", description: "Summarize the Company Brain: entity, relation, claim, evidence, candidate, and component counts.", parameters: Type.Object({}) },
  { name: "brain_search", description: "Search canonical company entities across names, aliases, summaries, tags, and properties.", parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })) }) },
  { name: "brain_get_entity", description: "Get one canonical entity with its claims, evidence, and direct relations.", parameters: Type.Object({ id: Type.String() }) },
  { name: "brain_get_context", description: "Get an entity neighborhood for grounded reasoning. Returns connected entities, relations, claims, confidence, and provenance.", parameters: Type.Object({ entityId: Type.String(), depth: Type.Optional(Type.Number({ minimum: 0, maximum: 3 })), statuses: Type.Optional(Type.Array(Status)) }) },
  { name: "brain_list_runs", description: "List recent Company Brain ingestion and enrichment runs, including warnings and counts.", parameters: Type.Object({ limit: Type.Optional(Type.Number({ minimum: 1, maximum: 250 })) }) },
  { name: "brain_upsert_entity", description: "Create or resolve a canonical company entity. Exact type/name/alias matches enrich the existing entity instead of duplicating it.", parameters: Entity },
  { name: "brain_upsert_relation", description: "Create or update a directed semantic relation between two existing Company Brain entities.", parameters: Type.Object({
    fromId: Type.String(), toId: Type.String(), type: Type.String(), label: Type.Optional(Type.String()),
    properties: Type.Optional(Type.Record(Type.String(), Type.Any())), confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    status: Type.Optional(Status), validFrom: Type.Optional(Type.String()), validTo: Type.Optional(Type.String()),
  }) },
  { name: "brain_upsert_claim", description: "Attach an evidence-aware, temporal claim to an entity. Conflicting values remain separate claims for review.", parameters: Type.Object({
    entityId: Type.String(), predicate: Type.String(), value: Type.Any(), confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    status: Type.Optional(Status), validFrom: Type.Optional(Type.String()), validTo: Type.Optional(Type.String()),
  }) },
  { name: "brain_ingest_data_source", description: "Map a registered Data Source dataset into canonical entities, row claims, foreign-key relations, and optional LLM semantic enrichment. Repeated runs are idempotent.", parameters: Type.Object({
    sourceId: Type.String(), dataset: Type.String(), entityType: Type.Optional(Type.String()), idField: Type.Optional(Type.String()),
    nameField: Type.Optional(Type.String()), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })), semantic: Type.Optional(Type.Boolean()),
  }) },
  { name: "brain_enrich_text", description: "Extract evidence-grounded entities, relations, and claims from text into the Company Brain. LLM output is stored as reviewable candidates with provenance.", parameters: Type.Object({
    text: Type.String({ maxLength: 80_000 }), label: Type.Optional(Type.String()),
    sourceType: Type.Optional(Type.Union([Type.Literal("file"), Type.Literal("chat"), Type.Literal("task"), Type.Literal("mission"), Type.Literal("app"), Type.Literal("manual")])),
    sourceId: Type.Optional(Type.String()),
  }) },
  { name: "brain_merge_entities", description: "Resolve duplicates by merging aliases, properties, evidence, claims, and relations into one canonical entity.", parameters: Type.Object({ keepId: Type.String(), mergeIds: Type.Array(Type.String(), { minItems: 1 }) }) },
  { name: "brain_set_grant", description: "Grant or revoke an agent's scoped Company Brain access by entity type. Orchestrator/steward operation.", parameters: Type.Object({
    agent: Type.String(), capability: Type.Union([Type.Literal("none"), Type.Literal("read"), Type.Literal("write"), Type.Literal("admin")]),
    entityTypes: Type.Optional(Type.Array(Type.String())),
  }) },
];

export async function executeCompanyBrainTool(
  name: string,
  args: Record<string, unknown>,
  polpoDir: string,
  principal: BrainPrincipal,
  vaultStore?: VaultStore,
  emitChange?: BrainChangeEmitter,
): Promise<string> {
  const dataRuntime = getDataRegistryRuntime(polpoDir, vaultStore);
  const runtime = getCompanyBrainRuntime(polpoDir, dataRuntime, emitChange);
  if (name === "brain_stats") return json(await runtime.stats(principal));
  if (name === "brain_search") return json(await runtime.search(String(args.query), principal, optionalNumber(args.limit) ?? 20));
  if (name === "brain_get_entity") return json(await runtime.getEntity(String(args.id), principal));
  if (name === "brain_get_context") return json(await runtime.graph({
    entityId: String(args.entityId), depth: optionalNumber(args.depth) ?? 1,
    statuses: args.statuses as any,
  }, principal));
  if (name === "brain_list_runs") return json(await runtime.runs(principal, optionalNumber(args.limit) ?? 50));
  if (name === "brain_upsert_entity") return json(await runtime.upsertEntity(args as any, principal));
  if (name === "brain_upsert_relation") return json(await runtime.upsertRelation(args as any, principal));
  if (name === "brain_upsert_claim") return json(await runtime.upsertClaim(args as any, principal));
  if (name === "brain_ingest_data_source") return json(await runtime.ingestDataSource(args as any, principal));
  if (name === "brain_enrich_text") return json(await runtime.enrichText(args as any, principal));
  if (name === "brain_merge_entities") return json(await runtime.mergeEntities(String(args.keepId), args.mergeIds as string[], principal));
  if (name === "brain_set_grant") return json(await runtime.setGrant(String(args.agent), args.capability as any, (args.entityTypes as string[] | undefined) ?? ["*"], principal));
  throw new Error(`Unknown Company Brain tool "${name}"`);
}

export function createCompanyBrainAgentTools(
  polpoDir: string,
  agent: string,
  allowedTools: string[] | undefined,
  vaultStore?: VaultStore,
  emitChange?: BrainChangeEmitter,
): AgentTool<any>[] {
  if (!allowedTools?.some((pattern) => pattern === "brain_*" || pattern.startsWith("brain_"))) return [];
  const definitions = BRAIN_ORCHESTRATOR_TOOLS.filter((tool) => allowedTools.some((pattern) => pattern === tool.name || (pattern.endsWith("*") && tool.name.startsWith(pattern.slice(0, -1)))));
  return definitions.map((definition) => ({
    ...definition,
    label: definition.name.split("_").slice(1).map((value) => value[0]?.toUpperCase() + value.slice(1)).join(" "),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      try {
        const text = await executeCompanyBrainTool(definition.name, params, polpoDir, { agent }, vaultStore, emitChange);
        return { content: [{ type: "text" as const, text }], details: { entityId: params.id ?? params.entityId, run: definition.name.includes("ingest") || definition.name.includes("enrich") } };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], details: { error: true } };
      }
    },
  })) as AgentTool<any>[];
}

function json(value: unknown): string { return JSON.stringify(value, null, 2); }
function optionalNumber(value: unknown): number | undefined { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; }
