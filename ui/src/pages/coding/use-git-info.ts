import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/config";
import type { GitInfo } from "./types";

/** Polls /api/v1/git/info for a given cwd. Returns null when the dir is not a git repo. */
export function useGitInfo(cwd: string, refreshKey: number = 0): GitInfo | null {
  const [info, setInfo] = useState<GitInfo | null>(null);

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    const controller = new AbortController();

    const fetchInfo = async () => {
      try {
        const res = await fetch(
          apiUrl(`/api/v1/git/info?cwd=${encodeURIComponent(cwd)}`),
          { credentials: "include", signal: controller.signal },
        );
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled) setInfo((body?.data as GitInfo | null) ?? null);
      } catch {
        /* ignore — non-git cwd is fine */
      }
    };

    fetchInfo();
    const interval = window.setInterval(fetchInfo, 8_000);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [cwd, refreshKey]);

  return info;
}
