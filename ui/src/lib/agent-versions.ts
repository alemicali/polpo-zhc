/** Agent versions: small helpers shared by the dashboard's Versions tab and settings. */
import { apiUrl, config } from "@/lib/config";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isSemver(v: string): boolean { return SEMVER.test(v); }

/** "person:ada@x.io" → "ada@x.io"; "system:migration" → "migration"; "mcp:Claude" → "MCP Claude". */
export function actorLabel(actor: string): string {
  return actor.replace(/^(person|system|mcp):/, (_m, kind: string) => (kind === "mcp" ? "MCP " : ""));
}

/** The version a bump gives after `version`. */
export function bumpVersion(version: string, bump: "major" | "minor" | "patch"): string {
  const m = SEMVER.exec(version);
  const [ma, mi, pa] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  return bump === "major" ? `${ma + 1}.0.0` : bump === "minor" ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`;
}

/** settings.agents.versioning.autoDeployApiUpdates (PATCH /config/settings). */
export async function saveAutoDeployApiUpdates(value: boolean): Promise<void> {
  const headers = new Headers({ "content-type": "application/json" });
  if (config.apiKey) headers.set("authorization", `Bearer ${config.apiKey}`);
  const res = await fetch(apiUrl("/api/v1/config/settings"), {
    method: "PATCH", headers, credentials: "include",
    body: JSON.stringify({ agents: { versioning: { autoDeployApiUpdates: value } } }),
  });
  const body = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
  if (!res.ok || !body?.ok) throw new Error(body?.error || `Could not save (${res.status})`);
}
