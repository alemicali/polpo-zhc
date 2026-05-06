import { readdirSync, readFileSync, existsSync } from "node:fs";

/**
 * Snapshot of a single process — used by the coding "Processes" panel.
 * Always sourced from /proc on Linux; on other platforms we return what
 * we know without descendants.
 */
export type ProcessNode = {
  pid: number;
  ppid?: number;
  command: string;
  cmdline: string;
  startedAt?: string;
  cpuPercent?: number;
  memoryMb?: number;
  children: ProcessNode[];
};

/** Recursively walks /proc for the given root PIDs (e.g. terminal pty +
 * code-server child) and returns a tree per root. Capped at `maxDepth`
 * levels to avoid pathological cases. */
export function describeTrees(rootPids: number[], maxDepth = 4): ProcessNode[] {
  return rootPids
    .filter((pid) => Number.isFinite(pid) && pid > 0 && existsSync(`/proc/${pid}`))
    .map((pid) => describeNode(pid, maxDepth));
}

function describeNode(pid: number, depth: number): ProcessNode {
  const node: ProcessNode = {
    pid,
    ppid: readPpid(pid),
    command: readComm(pid),
    cmdline: readCmdline(pid),
    children: [],
  };
  if (depth <= 0) return node;
  node.children = readChildPids(pid).map((c) => describeNode(c, depth - 1));
  return node;
}

function readChildPids(pid: number): number[] {
  // /proc/<pid>/task/<tid>/children lists immediate children. A process
  // can have multiple threads (tasks); merge their child sets.
  try {
    const taskDir = `/proc/${pid}/task`;
    const tids = readdirSync(taskDir);
    const children = new Set<number>();
    for (const tid of tids) {
      let raw: string;
      try { raw = readFileSync(`${taskDir}/${tid}/children`, "utf-8"); } catch { continue; }
      for (const part of raw.trim().split(/\s+/)) {
        const n = Number.parseInt(part, 10);
        if (Number.isFinite(n) && n > 0) children.add(n);
      }
    }
    return [...children];
  } catch {
    return [];
  }
}

function readPpid(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/status`, "utf-8");
    const match = stat.match(/^PPid:\s+(\d+)/m);
    return match ? Number.parseInt(match[1]!, 10) : undefined;
  } catch { return undefined; }
}

function readComm(pid: number): string {
  try { return readFileSync(`/proc/${pid}/comm`, "utf-8").trim(); } catch { return "?"; }
}

function readCmdline(pid: number): string {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
    // /proc/<pid>/cmdline uses NUL separators.
    return raw.split("\0").filter(Boolean).join(" ");
  } catch { return ""; }
}
