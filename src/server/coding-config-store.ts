import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Persisted, server-side coding configuration.
 *
 * - `agentCommands`: shell command launched per agent kind. Empty/missing
 *   keys fall back to the server's baked-in defaults (claude/codex/shell).
 * - `allowedExtraRoots`: absolute paths that may host workspaces in addition
 *   to the agent work dir. Mirrors the UI "Allow paths outside workspace"
 *   flag — the source of truth lives on the server so the cwd check is
 *   trustworthy regardless of what any browser says.
 */
export type CodingConfig = {
  agentCommands: Partial<Record<"claude" | "codex" | "terminal", string>>;
  allowedExtraRoots: string[];
  /** Shell command launched by the workspace "PR" button when no PR yet
   * exists for the current branch. The default delegates to Claude Code
   * non-interactively so the user can click once and walk away. */
  prCommand: string;
};

export const DEFAULT_PR_COMMAND =
  'claude -p --dangerously-skip-permissions "Operator mode: act, do not ask. Procedure: (1) if HEAD is on main or master, create and switch to a new branch named feat/wt-<short-utc-timestamp>; (2) run `git add -A`; if there are pending changes, commit them with a one-line message inferred from the diff; (3) `git push -u origin HEAD`; (4) `gh pr create --fill`. If --fill fails (no template, ambiguous, base==head), retry with explicit `gh pr create --title <inferred from diff> --body <short summary + test plan inferred from diff>`. Decide every title/message/branch-name yourself. Print only essential progress lines. Never present options to the user, never ask clarifying questions, never wait for confirmation."';

export const DEFAULT_CODING_CONFIG: CodingConfig = {
  agentCommands: {},
  allowedExtraRoots: [],
  prCommand: DEFAULT_PR_COMMAND,
};

const FILE_NAME = "coding-config.json";

function configPath(polpoDir: string): string {
  return join(polpoDir, FILE_NAME);
}

export function readCodingConfig(polpoDir: string): CodingConfig {
  const file = configPath(polpoDir);
  if (!existsSync(file)) return DEFAULT_CODING_CONFIG;
  try {
    return normalize(JSON.parse(readFileSync(file, "utf-8")));
  } catch {
    return DEFAULT_CODING_CONFIG;
  }
}

export function writeCodingConfig(polpoDir: string, patch: Partial<CodingConfig>): CodingConfig {
  if (!existsSync(polpoDir)) mkdirSync(polpoDir, { recursive: true });
  const current = readCodingConfig(polpoDir);
  const next = normalize({ ...current, ...patch });
  const file = configPath(polpoDir);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), "utf-8");
  renameSync(tmp, file);
  return next;
}

/** Combined whitelist: polpoDir itself (always allowed — that's where we
 * manage worktrees, code-server user data, etc.) + persisted config +
 * env var (env wins as a hard override for hosted setups). */
export function getEffectiveAllowedRoots(polpoDir: string): string[] {
  const fromConfig = readCodingConfig(polpoDir).allowedExtraRoots;
  const raw = process.env.POLPO_ALLOWED_WORKSPACE_ROOTS;
  const fromEnv = raw
    ? raw.split(/[,:]/).map((s) => s.trim()).filter(Boolean)
    : [];
  const all = [polpoDir, ...fromConfig, ...fromEnv]
    .filter((p) => isAbsolute(p))
    .map((p) => resolve(p));
  return Array.from(new Set(all));
}

function normalize(value: unknown): CodingConfig {
  if (!value || typeof value !== "object") return DEFAULT_CODING_CONFIG;
  const record = value as Record<string, unknown>;
  const agentCommands: CodingConfig["agentCommands"] = {};
  if (record.agentCommands && typeof record.agentCommands === "object") {
    for (const kind of ["claude", "codex", "terminal"] as const) {
      const v = (record.agentCommands as Record<string, unknown>)[kind];
      if (typeof v === "string" && v.trim()) agentCommands[kind] = v.trim();
    }
  }
  const allowedExtraRoots = Array.isArray(record.allowedExtraRoots)
    ? Array.from(new Set(
        (record.allowedExtraRoots as unknown[])
          .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
          .map((p) => p.trim())
          .filter((p) => isAbsolute(p))
          .map((p) => resolve(p)),
      ))
    : [];
  const prCommand = typeof record.prCommand === "string" && record.prCommand.trim()
    ? record.prCommand.trim()
    : DEFAULT_PR_COMMAND;
  return { agentCommands, allowedExtraRoots, prCommand };
}
