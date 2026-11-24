import { useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useEvents } from "./use-events.js";
import type { SkillPool, SkillRestoreResult, SkillVersionDiff, SkillVersionFiles, SkillVersionList } from "@polpo-ai/sdk";

export interface UseSkillVersionsReturn {
  /** The skill's history, newest first (undefined while loading, or when the skill has none). */
  data: SkillVersionList | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  /** The files of one version. */
  files: (version: number) => Promise<SkillVersionFiles>;
  /** What changed from version a to version b. */
  diff: (a: number, b: number) => Promise<SkillVersionDiff>;
  /** Put a version back (the current state is recorded first); refetches the history. */
  restore: (version: number) => Promise<SkillRestoreResult>;
  /** URL of one file of a version (raw), for <img>, <iframe> or a download link. */
  fileUrl: (version: number, path: string, opts?: { download?: boolean }) => string;
  /** Read one text file of a version. */
  readText: (version: number, path: string) => Promise<string>;
  /** URL of a version as a .skill (default) or .zip archive. */
  downloadUrl: (version: number, format?: "skill" | "zip") => string;
}

/**
 * A skill's versions (every change recorded as a copy of the whole folder), refetched when the skill
 * changes; diff two, browse one's files, restore one, download one.
 */
export function useSkillVersions(name: string | undefined, pool: SkillPool = "agent"): UseSkillVersionsReturn {
  const { client } = usePolpoContext();
  const { events } = useEvents(["skill:changed"], 1);
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

  const restore = useCallback(async (version: number) => {
    const r = await client.restoreSkillVersion(name ?? "", version, pool);
    await fetch_();
    return r;
  }, [client, name, pool, fetch_]);

  const current = state?.key === key ? state : null;
  return {
    data: current?.data,
    isLoading: !!name && !current,
    error: current?.error ?? null,
    refetch: fetch_,
    files: (version) => client.getSkillVersionFiles(name ?? "", version, pool),
    diff: (a, b) => client.diffSkillVersions(name ?? "", a, b, pool),
    restore,
    fileUrl: (version, path, opts) => client.skillVersionFileUrl(name ?? "", version, path, { pool, ...(opts?.download ? { download: true } : {}) }),
    readText: (version, path) => client.getSkillVersionFileText(name ?? "", version, path, pool),
    downloadUrl: (version, format) => client.skillVersionDownloadUrl(name ?? "", version, { pool, ...(format ? { format } : {}) }),
  };
}
