/**
 * Versions of a hosted server: the same semver / unified diff helpers as agent versions
 * (packages/core/src/agent-versions.ts), applied to the server spec.
 */
import { bumpSemver, compareSemver, serializeSnapshot, snapshotToYaml, unifiedLineDiff, type AgentSnapshot } from "@polpo-ai/core";
import type { McpServerBump, McpServerFieldChange, McpServerSpec } from "./types.js";

export { compareSemver, bumpSemver };

/** The spec as a diffable document: tools keyed by name (a reordered list is not a change). */
export function specDocument(spec: McpServerSpec): Record<string, unknown> {
  const { tools, resources, ...rest } = spec;
  return {
    ...rest,
    tools: Object.fromEntries(tools.map(({ name, ...t }) => [name, t])),
    ...(resources?.length ? { resources: Object.fromEntries(resources.map(({ uri, ...r }) => [uri, r])) } : {}),
  };
}

export function specToYaml(spec: McpServerSpec): string {
  return snapshotToYaml(specDocument(spec) as AgentSnapshot);
}

export function specsEqual(a: McpServerSpec, b: McpServerSpec): boolean {
  return serializeSnapshot(specDocument(a) as AgentSnapshot) === serializeSnapshot(specDocument(b) as AgentSnapshot);
}

const same = (a: unknown, b: unknown) => serializeSnapshot({ v: a } as AgentSnapshot) === serializeSnapshot({ v: b } as AgentSnapshot);

/** What changed: top-level fields, and each tool as `tools.<name>`. */
export function specChanges(before: McpServerSpec | undefined, after: McpServerSpec): McpServerFieldChange[] {
  const b = before ? specDocument(before) : {};
  const a = specDocument(after);
  const changes: McpServerFieldChange[] = [];
  for (const field of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) {
    if (field === "tools" || field === "resources") {
      const bt = (b[field] ?? {}) as Record<string, unknown>;
      const at = (a[field] ?? {}) as Record<string, unknown>;
      for (const name of [...new Set([...Object.keys(bt), ...Object.keys(at)])].sort()) {
        if (same(bt[name], at[name])) continue;
        changes.push({ field: `${field}.${name}`, kind: bt[name] === undefined ? "added" : at[name] === undefined ? "removed" : "changed" });
      }
      continue;
    }
    if (same(b[field], a[field])) continue;
    changes.push({ field, kind: b[field] === undefined ? "added" : a[field] === undefined ? "removed" : "changed" });
  }
  return changes;
}

/**
 * The bump a change deserves: major when a tool is removed or its input schema / kind / approval
 * changes (callers may break), minor for added tools or setting changes, patch for descriptions,
 * names and icons. Undefined when nothing changed.
 */
export function suggestBump(before: McpServerSpec | undefined, after: McpServerSpec): McpServerBump | undefined {
  if (!before) return "major";
  const changes = specChanges(before, after);
  if (!changes.length) return undefined;
  let bump: McpServerBump = "patch";
  const raise = (x: McpServerBump) => { if (x === "major" || (x === "minor" && bump === "patch")) bump = x; };
  for (const c of changes) {
    if (c.field.startsWith("tools.")) {
      if (c.kind === "removed") { raise("major"); continue; }
      if (c.kind === "added") { raise("minor"); continue; }
      const name = c.field.slice("tools.".length);
      const bt = before.tools.find((t) => t.name === name)!;
      const at = after.tools.find((t) => t.name === name)!;
      if (!same(bt.inputSchema, at.inputSchema) || bt.kind !== at.kind || !!bt.requiresApproval !== !!at.requiresApproval) raise("major");
      else if (!same({ ...bt, description: 0, title: 0 }, { ...at, description: 0, title: 0 })) raise("minor");
      continue;
    }
    if (["name", "description", "icon"].includes(c.field)) continue;
    raise("minor");
  }
  return bump;
}

export function unifiedSpecDiff(serverId: string, from: { label?: string; spec?: McpServerSpec }, to: { label: string; spec: McpServerSpec }): string {
  return unifiedLineDiff(from.spec ? specToYaml(from.spec) : "", specToYaml(to.spec), `a/${serverId}@${from.label ?? "empty"}.yaml`, `b/${serverId}@${to.label}.yaml`);
}

/** The next version for a bump (first version: 1.0.0). */
export function nextVersion(versions: string[], bump: McpServerBump): string {
  const latest = [...versions].sort(compareSemver).at(-1);
  return latest ? bumpSemver(latest, bump) : "1.0.0";
}
