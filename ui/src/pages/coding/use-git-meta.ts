import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/config";

export type GitBranch = { name: string; current: boolean; age: string };
export type GitWorktree = { path: string; head: string | null; branch: string | null; bare: boolean; detached: boolean };

export function useBranches(cwd: string, refreshKey: number = 0) {
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    fetch(apiUrl(`/api/v1/git/branches?cwd=${encodeURIComponent(cwd)}`), { credentials: "include" })
      .then((r) => r.ok ? r.json() : null)
      .then((body) => {
        if (cancelled || !body?.data) return;
        setBranches(body.data.branches ?? []);
        setCurrent(body.data.current ?? null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [cwd, refreshKey]);

  return { branches, current };
}

export function useWorktrees(cwd: string, refreshKey: number = 0) {
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    fetch(apiUrl(`/api/v1/git/worktrees?cwd=${encodeURIComponent(cwd)}`), { credentials: "include" })
      .then((r) => r.ok ? r.json() : null)
      .then((body) => {
        if (cancelled) return;
        setWorktrees((body?.data as GitWorktree[]) ?? []);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [cwd, refreshKey]);

  return worktrees;
}

export type DirEntry = { name: string; path: string; hasPolpoConfig: boolean };
export type BrowseResult = { current: string; parent: string | null; dirs: DirEntry[] };

export async function browseDir(path: string): Promise<BrowseResult | null> {
  try {
    const res = await fetch(
      apiUrl(`/api/v1/filesystem/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`),
      { credentials: "include" },
    );
    if (!res.ok) return null;
    const body = await res.json();
    return body?.data ?? null;
  } catch {
    return null;
  }
}
