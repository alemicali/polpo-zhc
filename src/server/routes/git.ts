import { OpenAPIHono } from "@hono/zod-openapi";
import { execaCommand } from "execa";
import { resolve, isAbsolute } from "node:path";

type GitPullRequest = {
  number: number;
  title: string;
  url: string;
  state?: string;
};

type GitInfo = {
  branch: string | null;
  repo: string | null;
  ahead: number;
  behind: number;
  insertions: number;
  deletions: number;
  filesChanged: number;
  dirty: boolean;
  pr: GitPullRequest | null;
};

async function safeExec(cmd: string, cwd: string, timeout = 4_000): Promise<string | null> {
  try {
    const { stdout } = await execaCommand(cmd, { cwd, timeout });
    return stdout.trim();
  } catch {
    return null;
  }
}

function parseShortstat(line: string | null): { insertions: number; deletions: number; filesChanged: number } {
  if (!line) return { insertions: 0, deletions: 0, filesChanged: 0 };
  const files = line.match(/(\d+) files? changed/);
  const ins = line.match(/(\d+) insertions?\(\+\)/);
  const del = line.match(/(\d+) deletions?\(-\)/);
  return {
    filesChanged: files ? Number(files[1]) : 0,
    insertions: ins ? Number(ins[1]) : 0,
    deletions: del ? Number(del[1]) : 0,
  };
}

/** Extracts "owner/repo" from a git remote URL (ssh or https). */
function parseRepoFromRemote(url: string | null): string | null {
  if (!url) return null;
  // matches "git@github.com:owner/repo(.git)?", "https://github.com/owner/repo(.git)?", and ssh-style URLs
  const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

export function gitRoutes(getDeps: () => { workDir: string }) {
  const app = new OpenAPIHono();

  app.get("/info", async (c) => {
    const cwdParam = c.req.query("cwd") || ".";
    const { workDir } = getDeps();
    const root = isAbsolute(cwdParam) ? cwdParam : resolve(workDir, cwdParam);

    const branch = await safeExec("git rev-parse --abbrev-ref HEAD", root);
    if (!branch) {
      return c.json({ ok: true, data: null satisfies GitInfo | null });
    }

    const [aheadBehind, workingShortstat, stagedShortstat, dirtyRaw, remoteUrl, prJson] = await Promise.all([
      safeExec("git rev-list --left-right --count HEAD...@{u}", root),
      safeExec("git diff --shortstat HEAD", root),
      safeExec("git diff --shortstat --cached", root),
      safeExec("git status --porcelain", root),
      safeExec("git remote get-url origin", root),
      // `gh` may not be installed or authenticated — silently skip if so.
      safeExec(`gh pr view ${JSON.stringify(branch)} --json number,title,url,state`, root, 6_000),
    ]);

    const [aheadStr, behindStr] = (aheadBehind ?? "0\t0").split(/\s+/);
    const w = parseShortstat(workingShortstat);
    const s = parseShortstat(stagedShortstat);

    let pr: GitPullRequest | null = null;
    if (prJson) {
      try {
        const parsed = JSON.parse(prJson);
        if (parsed && typeof parsed.number === "number") {
          pr = {
            number: parsed.number,
            title: parsed.title ?? "",
            url: parsed.url ?? "",
            state: parsed.state,
          };
        }
      } catch {
        /* ignore */
      }
    }

    const data: GitInfo = {
      branch: branch === "HEAD" ? null : branch,
      repo: parseRepoFromRemote(remoteUrl),
      ahead: Number(aheadStr) || 0,
      behind: Number(behindStr) || 0,
      insertions: w.insertions + s.insertions,
      deletions: w.deletions + s.deletions,
      filesChanged: w.filesChanged + s.filesChanged,
      dirty: !!dirtyRaw && dirtyRaw.length > 0,
      pr,
    };

    return c.json({ ok: true, data });
  });

  // ── List local branches (current is marked) ──
  app.get("/branches", async (c) => {
    const cwdParam = c.req.query("cwd") || ".";
    const { workDir } = getDeps();
    const root = isAbsolute(cwdParam) ? cwdParam : resolve(workDir, cwdParam);

    const raw = await safeExec("git for-each-ref --format=%(HEAD)%09%(refname:short)%09%(committerdate:relative) refs/heads", root);
    if (raw == null) return c.json({ ok: true, data: { branches: [], current: null } });

    const branches = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [head, name, age] = line.split("\t");
        return { name, current: head === "*", age: age || "" };
      });
    const current = branches.find((b) => b.current)?.name ?? null;
    return c.json({ ok: true, data: { branches, current } });
  });

  // ── Modified-file list with per-file insertion/deletion counts ──
  app.get("/status", async (c) => {
    const cwdParam = c.req.query("cwd") || ".";
    const { workDir } = getDeps();
    const root = isAbsolute(cwdParam) ? cwdParam : resolve(workDir, cwdParam);

    // Status/diff are always reported for the *whole* repo containing the
    // requested cwd — running from the repo root keeps paths relative to it
    // regardless of how deep the cwd sits in the tree.
    const repoRoot = (await safeExec("git rev-parse --show-toplevel", root)) || root;
    const [unstaged, staged, porcelain] = await Promise.all([
      safeExec("git diff --numstat", repoRoot),
      safeExec("git diff --numstat --cached", repoRoot),
      safeExec("git status --porcelain", repoRoot),
    ]);

    type FileEntry = { path: string; status: string; insertions: number; deletions: number; staged: boolean };
    const map = new Map<string, FileEntry>();

    const accumulate = (raw: string | null, isStaged: boolean) => {
      if (!raw) return;
      for (const line of raw.split("\n")) {
        if (!line) continue;
        const [insStr, delStr, ...rest] = line.split("\t");
        const path = rest.join("\t");
        if (!path) continue;
        const insertions = insStr === "-" ? 0 : Number(insStr) || 0;
        const deletions = delStr === "-" ? 0 : Number(delStr) || 0;
        const existing = map.get(path);
        if (existing) {
          existing.insertions += insertions;
          existing.deletions += deletions;
          existing.staged = existing.staged || isStaged;
        } else {
          map.set(path, { path, status: "M", insertions, deletions, staged: isStaged });
        }
      }
    };
    accumulate(unstaged, false);
    accumulate(staged, true);

    if (porcelain) {
      for (const line of porcelain.split("\n")) {
        if (!line) continue;
        const xy = line.slice(0, 2);
        const path = line.slice(3).split(" -> ").pop() ?? line.slice(3);
        if (!path) continue;
        // First non-space character is the most informative status
        const code = (xy.replace(/\s/g, "")[0] ?? "M");
        const entry = map.get(path) ?? { path, status: code, insertions: 0, deletions: 0, staged: xy[0] !== " " && xy[0] !== "?" };
        entry.status = code;
        // Untracked files: count their lines as additions for nicer signal
        if (code === "?" && entry.insertions === 0 && entry.deletions === 0) {
          entry.status = "?";
        }
        map.set(path, entry);
      }
    }

    const files = Array.from(map.values()).sort((a, b) => a.path.localeCompare(b.path));
    return c.json({ ok: true, data: files });
  });

  // ── List git worktrees (path · branch · head) ──
  app.get("/worktrees", async (c) => {
    const cwdParam = c.req.query("cwd") || ".";
    const { workDir } = getDeps();
    const root = isAbsolute(cwdParam) ? cwdParam : resolve(workDir, cwdParam);

    const raw = await safeExec("git worktree list --porcelain", root);
    if (raw == null) return c.json({ ok: true, data: [] });

    type Entry = { path: string; head: string | null; branch: string | null; bare: boolean; detached: boolean };
    const entries: Entry[] = [];
    let cur: Partial<Entry> = {};
    for (const line of raw.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (cur.path) entries.push({ path: cur.path, head: cur.head ?? null, branch: cur.branch ?? null, bare: !!cur.bare, detached: !!cur.detached });
        cur = { path: line.slice("worktree ".length) };
      } else if (line.startsWith("HEAD ")) {
        cur.head = line.slice(5);
      } else if (line.startsWith("branch ")) {
        cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      } else if (line === "bare") {
        cur.bare = true;
      } else if (line === "detached") {
        cur.detached = true;
      }
    }
    if (cur.path) entries.push({ path: cur.path, head: cur.head ?? null, branch: cur.branch ?? null, bare: !!cur.bare, detached: !!cur.detached });

    return c.json({ ok: true, data: entries });
  });

  // ── Create a new git worktree (with new branch) ──
  app.post("/worktree/create", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cwdParam = (body?.cwd as string) || ".";
    const branch = String(body?.branch || "").trim();
    const customPath = typeof body?.path === "string" ? body.path.trim() : "";
    if (!branch) return c.json({ ok: false, error: "branch required" }, 400);
    // Sanity check: avoid ".."/absolute weirdness in branch names
    if (/[\s~^:?*\[\\]/.test(branch) || branch.startsWith("-")) {
      return c.json({ ok: false, error: "invalid branch name" }, 400);
    }

    const { workDir } = getDeps();
    const root = isAbsolute(cwdParam) ? cwdParam : resolve(workDir, cwdParam);

    // Default layout: <repo-root>/.worktrees/<branch> (sibling to .git)
    const repoRoot = (await safeExec("git rev-parse --show-toplevel", root)) || root;
    const target = customPath
      ? (isAbsolute(customPath) ? customPath : resolve(repoRoot, customPath))
      : resolve(repoRoot, ".worktrees", branch.replace(/[/\\]/g, "_"));

    // Does the branch already exist?
    const existing = await safeExec(`git rev-parse --verify ${JSON.stringify(branch)}`, root);
    const flag = existing ? "" : "-b";
    const cmd = `git worktree add ${flag} ${JSON.stringify(target)} ${JSON.stringify(branch)}`.trim();

    try {
      await execaCommand(cmd, { cwd: root, timeout: 30_000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: msg }, 500);
    }
    return c.json({ ok: true, data: { path: target, branch } });
  });

  // ── Open / create a PR for the current branch ──
  app.post("/pr/create", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cwdParam = (body?.cwd as string) || ".";
    const { workDir } = getDeps();
    const root = isAbsolute(cwdParam) ? cwdParam : resolve(workDir, cwdParam);

    try {
      // `--fill` reuses commit messages as title/body. `gh` must be authenticated.
      await execaCommand("gh pr create --fill", { cwd: root, timeout: 30_000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: msg }, 500);
    }

    const branch = await safeExec("git rev-parse --abbrev-ref HEAD", root);
    const prJson = branch
      ? await safeExec(`gh pr view ${JSON.stringify(branch)} --json number,title,url,state`, root, 6_000)
      : null;
    let pr: GitPullRequest | null = null;
    if (prJson) {
      try {
        const parsed = JSON.parse(prJson);
        if (typeof parsed?.number === "number") {
          pr = { number: parsed.number, title: parsed.title ?? "", url: parsed.url ?? "", state: parsed.state };
        }
      } catch {
        /* ignore */
      }
    }
    return c.json({ ok: true, data: pr });
  });

  // ── Merge an existing PR ──
  app.post("/pr/merge", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cwdParam = (body?.cwd as string) || ".";
    const number = Number(body?.number);
    const method = (body?.method as string) || "squash";
    if (!Number.isFinite(number) || number <= 0) {
      return c.json({ ok: false, error: "number required" }, 400);
    }
    const flag = method === "rebase" ? "--rebase" : method === "merge" ? "--merge" : "--squash";
    const { workDir } = getDeps();
    const root = isAbsolute(cwdParam) ? cwdParam : resolve(workDir, cwdParam);

    try {
      await execaCommand(`gh pr merge ${number} ${flag} --delete-branch`, { cwd: root, timeout: 60_000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: msg }, 500);
    }
    return c.json({ ok: true });
  });

  return app;
}
