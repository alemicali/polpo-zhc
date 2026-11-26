import { useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useEvents } from "./use-events.js";
import type { SkillFileList, SkillPool } from "@polpo-ai/sdk";

export interface UseSkillFilesReturn {
  /** The files of the skill (undefined while loading or when it does not exist). */
  data: SkillFileList | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  /** URL of one file (raw, with its content type), for <img>, <iframe> or a download link. */
  fileUrl: (path: string, opts?: { download?: boolean }) => string;
  /** URL of the whole skill as a .skill (default) or .zip archive. */
  downloadUrl: (format?: "skill" | "zip") => string;
}

/**
 * The files of an installed skill (SKILL.md, scripts/, references/, assets/…), refetched when the
 * skill changes (installed again, updated).
 */
export function useSkillFiles(name: string | undefined, pool: SkillPool = "agent"): UseSkillFilesReturn {
  const { client } = usePolpoContext();
  const { events } = useEvents(["skill:changed"], 1);
  const [state, setState] = useState<{ key: string; data?: SkillFileList; error: Error | null } | null>(null);
  const key = `${pool}:${name ?? ""}`;

  const fetch_ = useCallback(async () => {
    if (!name) return;
    try {
      const data = await client.getSkillFiles(name, pool);
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

  const current = state?.key === key ? state : null;
  return {
    data: current?.data,
    isLoading: !!name && !current,
    error: current?.error ?? null,
    refetch: fetch_,
    fileUrl: (path, opts) => client.skillFileUrl(name ?? "", path, { pool, ...(opts?.download ? { download: true } : {}) }),
    downloadUrl: (format) => client.skillDownloadUrl(name ?? "", { pool, ...(format ? { format } : {}) }),
  };
}
