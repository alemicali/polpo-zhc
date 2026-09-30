import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { apiUrl } from "@/lib/config";
import type { GitFile } from "./types";

/** Polls /api/v1/git/status for a given cwd. Empty list when no changes / not a repo. */
export function useGitStatus(cwd: string, refreshKey: number = 0): GitFile[] {
  const [files, setFiles] = useState<GitFile[]>([]);
  const { pathname } = useLocation();
  const active = pathname === "/coding" || pathname.startsWith("/coding/");

  useEffect(() => {
    if (!cwd || !active) return;
    let cancelled = false;
    const controller = new AbortController();

    const fetchStatus = async () => {
      try {
        const res = await fetch(
          apiUrl(`/api/v1/git/status?cwd=${encodeURIComponent(cwd)}`),
          { credentials: "include", signal: controller.signal },
        );
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled) setFiles((body?.data as GitFile[]) ?? []);
      } catch {
        /* ignore */
      }
    };

    fetchStatus();
    const interval = window.setInterval(fetchStatus, 5_000);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [active, cwd, refreshKey]);

  return files;
}
