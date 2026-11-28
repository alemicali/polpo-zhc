import { useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useEvents } from "./use-events.js";
import type {
  SkillPool, SkillPublishResult, SkillRestoreResult, SkillRollbackResult, SkillVersionBump, SkillVersionDiff, SkillVersionFiles, SkillVersionList,
  SkillVersionState,
} from "@polpo-ai/sdk";

export interface UseSkillVersionsReturn {
  /** The skill's versions newest first, production, the draft's state and the lifecycle history (undefined while loading, or when the skill has none). */
  data: SkillVersionList | undefined;
  /** The lifecycle state: production, latest, the draft (changes, external, stale, suggested bump). */
  state: SkillVersionState | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  /** The files of one version (number or semver). */
  files: (version: number | string) => Promise<SkillVersionFiles>;
  /** What changed from a to b: version numbers, semvers, "draft" or "production". */
  diff: (a: number | string, b: number | string) => Promise<SkillVersionDiff>;
  /** Publish the draft as a new version in production; refetches. */
  publish: (opts?: { bump?: SkillVersionBump; version?: string; note?: string }) => Promise<SkillPublishResult>;
  /** Put an earlier version in production (default: the previous one); refetches. */
  rollback: (opts?: { to?: number | string; note?: string }) => Promise<SkillRollbackResult>;
  /** Throw the draft away (the files become production's); refetches. */
  discardDraft: () => Promise<boolean>;
  /** Move a stale draft onto production; refetches. */
  rebaseDraft: () => Promise<{ dropped: boolean }>;
  /** Put a version's files back: into the draft (publish: false, the dashboard's default) or published at once; refetches. */
  restore: (version: number | string, opts?: { publish?: boolean; note?: string }) => Promise<SkillRestoreResult>;
  /** URL of one file of a version (raw), for <img>, <iframe> or a download link. */
  fileUrl: (version: number | string, path: string, opts?: { download?: boolean }) => string;
  /** Read one text file of a version. */
  readText: (version: number | string, path: string) => Promise<string>;
  /** URL of a version as a .skill (default) or .zip archive. */
  downloadUrl: (version: number | string, format?: "skill" | "zip") => string;
}

/**
 * A skill's lifecycle, like an agent's: versions (semver) and production, the draft (unpublished
 * edits and files changed on disk), publish, rollback, discard and rebase of the draft, diffs; browse
 * a version's files, restore one, download one. Refetched when the skill changes, is published or
 * rolled back.
 */
export function useSkillVersions(name: string | undefined, pool: SkillPool = "agent"): UseSkillVersionsReturn {
  const { client } = usePolpoContext();
  const { events } = useEvents(["skill:changed", "skill:published", "skill:rolled-back"], 1);
  const [state, setState] = useState<{ key: string; data?: SkillVersionList; error: Error | null } | null>(null);
  const key = `${pool}:${name ?? ""}`;

  const fetch_ = useCallback(async () => {
    if (!name) return;
    try {
      const data = await client.getSkillVersions(name, pool);
      setState({ key, data, error: null });
    } catch (err) {
      setState({ key, error: err as Error });
    }
  }, [client, name, pool, key]);

  useEffect(() => { void fetch_(); }, [fetch_]);

  const latest = events.at(-1);
  const handled = useRef(latest?.id);
  useEffect(() => {
    if (!latest || handled.current === latest.id) return;
    handled.current = latest.id;
    const d = latest.data as { skillName?: string } | undefined;
    if (!d?.skillName || d.skillName === name) void fetch_();
  }, [fetch_, latest, name]);

  const after = useCallback(async <T,>(p: Promise<T>): Promise<T> => {
    const r = await p;
    await fetch_();
    return r;
  }, [fetch_]);

  const n = name ?? "";
  const current = state?.key === key ? state : null;
  return {
    data: current?.data,
    state: current?.data?.state,
    isLoading: !!name && !current,
    error: current?.error ?? null,
    refetch: fetch_,
    files: (version) => client.getSkillVersionFiles(n, version, pool),
    diff: (a, b) => client.diffSkill(n, { from: a, to: b }, pool),
    publish: (opts) => after(client.publishSkill(n, opts ?? {}, pool)),
    rollback: (opts) => after(client.rollbackSkill(n, opts ?? {}, pool)),
    discardDraft: async () => (await after(client.discardSkillDraft(n, pool))).discarded,
    rebaseDraft: async () => ({ dropped: (await after(client.rebaseSkillDraft(n, pool))).dropped }),
    restore: (version, opts) => after(client.restoreSkillVersion(n, version, pool, opts ?? {})),
    fileUrl: (version, path, opts) => client.skillVersionFileUrl(n, version, path, { pool, ...(opts?.download ? { download: true } : {}) }),
    readText: (version, path) => client.getSkillVersionFileText(n, version, path, pool),
    downloadUrl: (version, format) => client.skillVersionDownloadUrl(n, version, { pool, ...(format ? { format } : {}) }),
  };
}
