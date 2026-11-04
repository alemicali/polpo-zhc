/**
 * Artifacts on the server: the store (database when the project has one, `.polpo/artifacts/` otherwise),
 * the former data views shown as artifacts of type "view", and the data bridge an html artifact uses to
 * read the instance's data sources with the rights of whoever made it.
 */
import type { Artifact, ArtifactStore, ArtifactSummary } from "@polpo-ai/core/artifacts";
import type { DataQuery, DataView } from "@polpo-ai/core/data-registry";
import { databaseStoresFor } from "../core/storage.js";
import { FileArtifactStore } from "../stores/file-artifact-store.js";
import type { DataPrincipal, DataRuntime } from "./data-runtime.js";

const fileStores = new Map<string, FileArtifactStore>();

export function getArtifactStore(polpoDir: string): ArtifactStore {
  const database = databaseStoresFor(polpoDir)?.artifactStore;
  if (database) return database;
  let store = fileStores.get(polpoDir);
  if (!store) {
    store = new FileArtifactStore(polpoDir);
    fileStores.set(polpoDir, store);
  }
  return store;
}

/** Ids of former data views shown as artifacts. */
export const VIEW_ARTIFACT_PREFIX = "view:";

export function isViewArtifactId(id: string): boolean {
  return id.startsWith(VIEW_ARTIFACT_PREFIX);
}

/** A data view as an artifact (read-only: views change with the data tools or on the Data page). */
export function viewAsArtifact(view: DataView): Artifact {
  const { id: _id, name: _name, description: _description, createdAt: _c, updatedAt: _u, ...spec } = view;
  return {
    id: `${VIEW_ARTIFACT_PREFIX}${view.id}`,
    title: view.name,
    type: "view",
    ...(view.description ? { description: view.description } : {}),
    content: JSON.stringify(spec),
    version: 1,
    versions: [],
    createdBy: view.createdBy ?? "polpo",
    ...(view.sessionId ? { sessionId: view.sessionId } : {}),
    sources: [...new Set(view.bindings.flatMap((b) => (b.query ? [b.query.sourceId] : [])))],
    ...(view.refreshSeconds ? { refreshSeconds: view.refreshSeconds } : {}),
    ...(view.persistence === "pinned" ? { pinned: true } : {}),
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

export function viewAsSummary(view: DataView): ArtifactSummary {
  const { content, versions: _versions, ...rest } = viewAsArtifact(view);
  return { ...rest, size: content.length };
}

/**
 * The data rights of an artifact: those of the agent that made it; Polpo and people have all of them.
 * An author that is no longer an agent of the instance gets none of an agent's grants either (it is
 * treated as an agent with no grants, not as an administrator).
 */
export function artifactPrincipal(createdBy: string): DataPrincipal {
  if (!createdBy || createdBy === "polpo" || createdBy.startsWith("person:")) return { admin: true };
  return { agent: createdBy };
}

export type ArtifactDataMethod = "sources" | "describe" | "query" | "sql";

/**
 * One call from an html artifact to the data bridge (read only): list the sources, describe a source's
 * datasets, run a query, or run read-only SQL — with the artifact author's rights.
 */
export async function runArtifactDataCall(
  data: DataRuntime,
  artifact: Pick<Artifact, "createdBy">,
  method: ArtifactDataMethod,
  params: Record<string, unknown>,
): Promise<unknown> {
  const principal = artifactPrincipal(artifact.createdBy);
  switch (method) {
    case "sources":
      return (await data.listSources(principal)).map((s) => ({ id: s.id, name: s.name, kind: s.kind, description: s.description }));
    case "describe":
      return data.discover(String(params.sourceId ?? ""), principal);
    case "query":
      return data.query(params as unknown as DataQuery, principal);
    case "sql":
      return data.rawSql(String(params.sourceId ?? ""), String(params.sql ?? ""), principal);
    default:
      throw new Error(`Unknown data method "${String(method)}" (sources, describe, query, sql)`);
  }
}
