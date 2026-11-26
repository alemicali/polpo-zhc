/**
 * Coding chats' approval policy: what the official program (Claude Code, Codex) may do on its own in
 * the session's worktree, and what a person approves first, inside the chat.
 *
 * On its own: read, search, edit and write files inside the worktree; run commands that stay in it
 * (tests, builds, git status / diff / commit, formatters…).
 *
 * Risky (asks first), deliberately conservative — when in doubt it asks:
 * - network-install: installing packages over the network (npm / pnpm / yarn / bun install or add,
 *   npx, pip install, cargo install / add, go get, gem, brew, apt…);
 * - network: anything else that reaches the network (curl, wget, ssh, scp, rsync, git clone / fetch /
 *   pull, gh, the program's web fetch and search tools);
 * - git-push: git push, force pushes included;
 * - outside-worktree: any file or path outside the worktree (absolute paths elsewhere, ~, $HOME, ..),
 *   reading, writing or deleting it;
 * - privileged: sudo / su / doas, docker, killing processes;
 * - unknown-tool: a tool this policy does not know.
 *
 * Codex asks only when it needs to leave its sandbox (workspace-write: network, files outside the
 * workspace), so every Codex approval request is risky by definition.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

export type CodingRiskCategory = "network-install" | "network" | "git-push" | "outside-worktree" | "privileged" | "unknown-tool";

export type CodingRisk = { risky: false } | { risky: true; category: CodingRiskCategory; reason: string };

/** The program's own tools that only read or plan (no prompt needed inside the worktree). */
const READ_TOOLS = new Set(["read", "glob", "grep", "ls", "notebookread"]);
const EDIT_TOOLS = new Set(["edit", "multiedit", "write", "notebookedit"]);
/** Tools that never touch anything outside the conversation. */
const INERT_TOOLS = new Set(["todowrite", "task", "exitplanmode", "bashoutput", "killshell", "killbash", "agent"]);
const SHELL_TOOLS = new Set(["bash", "shell", "local_shell", "exec_command"]);
const NETWORK_TOOLS = new Set(["webfetch", "websearch", "web_search", "web_fetch"]);

/** Paths a command may name without leaving the worktree. */
const HARMLESS_PATHS = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

const NETWORK_INSTALL: RegExp[] = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:-\S+\s+)*(?:install|i|add|ci|update|up|upgrade|dlx|create|x)\b/,
  /\b(?:npx|bunx|pnpx)\b/,
  /\bpip[0-9.]*\s+install\b/, /\bpython[0-9.]*\s+-m\s+pip\s+install\b/, /\buv\s+(?:pip\s+install|add|sync|tool\s+install)\b/, /\bpoetry\s+(?:add|install)\b/,
  /\bcargo\s+(?:install|add|update|fetch)\b/, /\bgo\s+(?:get|install|mod\s+download)\b/,
  /\bgem\s+install\b/, /\bbundle\s+(?:install|update)\b/, /\bcomposer\s+(?:install|require|update)\b/, /\bdeno\s+install\b/,
  /\b(?:apt|apt-get|yum|dnf|apk|brew|pacman|port|snap)\s+(?:-\S+\s+)*(?:install|add|-S)\b/,
];
const NETWORK: RegExp[] = [
  /(?:^|[\s;&|(])(?:curl|wget|ssh|scp|sftp|ftp|rsync|nc|ncat|netcat|telnet|socat)\b/,
  /\bgit\s+(?:-\S+\s+)*(?:clone|fetch|pull|ls-remote|remote\s+update|submodule\s+update)\b/,
  /\bgh\s+\S/,
];
const GIT_PUSH = /\bgit\s+(?:-\S+\s+(?:\S+\s+)?)*push\b/;
const PRIVILEGED: RegExp[] = [/(?:^|[\s;&|(])(?:sudo|su|doas)\s/, /\bdocker\b|\bpodman\b/, /\b(?:kill|pkill|killall)\b/, /\b(?:shutdown|reboot|systemctl|launchctl)\b/];

function inside(target: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** A path argument outside the worktree (absolute elsewhere, ~, $HOME, or escaping with ..), or undefined. */
export function outsidePath(path: string, cwd: string): string | undefined {
  const p = path.trim();
  if (!p) return undefined;
  if (/^(?:~|\$HOME\b|\$\{HOME\})/.test(p)) return p;
  if (HARMLESS_PATHS.has(p)) return undefined;
  if (p.startsWith("/")) return inside(p, cwd) ? undefined : p;
  if (/(?:^|\/)\.\.(?:\/|$)/.test(p)) return inside(resolve(cwd, p), cwd) ? undefined : p;
  return undefined;
}

/** The path-like words of a shell command (after redirections and = too), quotes removed. */
function commandWords(command: string): string[] {
  return command
    .split(/[\s;&|()<>]+|=(?=[~/$.])/)
    .map((w) => w.replace(/^['"]+|['"]+$/g, "").replace(/^\d*>+/, ""))
    .filter(Boolean);
}

/** A shell command, judged against the policy. */
export function classifyCommand(command: string, cwd: string): CodingRisk {
  const c = command.replace(/\\\n/g, " ");
  if (GIT_PUSH.test(c)) {
    const force = /\s(?:-f|--force(?:-with-lease)?|\+\S+)\b/.test(c);
    return { risky: true, category: "git-push", reason: force ? "Force-pushes to a remote" : "Pushes to a remote" };
  }
  if (NETWORK_INSTALL.some((r) => r.test(c))) return { risky: true, category: "network-install", reason: "Installs packages over the network" };
  if (NETWORK.some((r) => r.test(c))) return { risky: true, category: "network", reason: "Reaches the network" };
  if (PRIVILEGED.some((r) => r.test(c))) return { risky: true, category: "privileged", reason: "Needs elevated rights or acts outside the session (sudo, docker, kill…)" };
  if (/\$HOME\b|\$\{HOME\}/.test(c)) return { risky: true, category: "outside-worktree", reason: "Uses a path outside the worktree ($HOME)" };
  for (const w of commandWords(c)) {
    const out = outsidePath(w, cwd);
    if (out) return { risky: true, category: "outside-worktree", reason: `Uses a path outside the worktree (${out.slice(0, 120)})` };
  }
  return { risky: false };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/**
 * A tool call of the program, judged against the policy. `tool` is the program's own tool name
 * (Claude Code: Bash, Edit, Write, Read, Grep, WebFetch…; Codex: shell, apply_patch…).
 */
export function classifyCodingAction(o: { tool: string; input: unknown; cwd: string }): CodingRisk {
  const name = o.tool.toLowerCase();
  const input = (o.input && typeof o.input === "object" ? o.input : {}) as Record<string, unknown>;
  if (INERT_TOOLS.has(name)) return { risky: false };
  if (SHELL_TOOLS.has(name)) {
    const command = Array.isArray(input.command) ? (input.command as unknown[]).map(String).join(" ") : str(input.command) ?? str(input.cmd) ?? "";
    const where = str(input.cwd) ?? str(input.workdir);
    if (where && outsidePath(where, o.cwd)) return { risky: true, category: "outside-worktree", reason: `Runs in a folder outside the worktree (${where})` };
    return classifyCommand(command, o.cwd);
  }
  if (NETWORK_TOOLS.has(name)) return { risky: true, category: "network", reason: name.includes("search") ? "Searches the web" : "Fetches a web page" };
  if (READ_TOOLS.has(name) || EDIT_TOOLS.has(name) || name === "apply_patch") {
    const paths = [input.file_path, input.path, input.notebook_path, input.filePath]
      .concat(Array.isArray(input.changes) ? (input.changes as Array<Record<string, unknown>>).map((c) => c?.path) : [])
      .map(str).filter((p): p is string => !!p);
    for (const p of paths) {
      const out = outsidePath(p, o.cwd);
      if (out) {
        const verb = READ_TOOLS.has(name) ? "Reads" : "Changes";
        return { risky: true, category: "outside-worktree", reason: `${verb} a file outside the worktree (${out.slice(0, 120)})` };
      }
    }
    return { risky: false };
  }
  return { risky: true, category: "unknown-tool", reason: `Uses ${o.tool}, a tool this policy does not know` };
}

/** One line for an approval card: what the call does. */
export function describeCodingAction(tool: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const command = Array.isArray(i.command) ? (i.command as unknown[]).map(String).join(" ") : str(i.command);
  if (command) return `$ ${command}`.slice(0, 500);
  const target = str(i.file_path) ?? str(i.path) ?? str(i.url) ?? str(i.query) ?? str(i.pattern);
  return target ? `${tool} · ${target}`.slice(0, 500) : tool;
}
