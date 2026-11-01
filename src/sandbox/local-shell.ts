/**
 * The shell the local workspace runs agent commands with. On Linux and macOS it is /bin/bash. On
 * Windows that path does not exist ("uv_spawn '/bin/bash' ENOENT": the bash tool failed for every
 * command): Git for Windows' bash is used when found, else cmd.exe.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface ShellChoice {
  /** argv for a command: [...prefix, command]. */
  argv: (command: string) => string[];
  /** What the shell is, for messages. */
  name: string;
}

/**
 * Pick the shell. `POLPO_SHELL` (a bash-compatible shell) wins; on Windows, Git's bash in the usual
 * install folders or on PATH, never C:\Windows\System32\bash.exe (the WSL launcher, which may
 * have no distribution); cmd.exe as the last resort.
 */
export function chooseLocalShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): ShellChoice {
  const bash = (path: string): ShellChoice => ({ argv: (command) => [path, "-c", command], name: path });
  if (env.POLPO_SHELL) return bash(env.POLPO_SHELL);
  if (platform !== "win32") return bash("/bin/bash");

  const candidates: string[] = [];
  for (const base of [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")]) {
    if (base) candidates.push(join(base, "Git", "bin", "bash.exe"), join(base, "Git", "usr", "bin", "bash.exe"));
  }
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir || /\\windows\\system32/i.test(dir) || /\\windowsapps/i.test(dir)) continue;
    candidates.push(join(dir, "bash.exe"));
    // git.exe on PATH (…\Git\cmd): its bash is next to it
    if (/\\git\\cmd$/i.test(dir)) candidates.push(join(dir, "..", "bin", "bash.exe"));
  }
  const found = candidates.find((p) => exists(p));
  if (found) return bash(found);
  return { argv: (command) => [env.ComSpec || "cmd.exe", "/d", "/s", "/c", command], name: "cmd.exe" };
}

/**
 * Windows: end a process and everything it started. There are no process groups there: killing
 * the shell alone leaves the command running. Git's bash adds a catch: the programs it runs are
 * msys processes, linked to it through msys's own process groups, not through the Windows parent
 * chain `taskkill /T` follows (a `sleep` kept running and kept the output open). So the msys
 * groups of the Windows descendants are ended first, then the Windows tree.
 */
export function killProcessTree(pid: number): boolean {
  killMsysGroups(pid);
  const r = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  return !r.error && r.status === 0;
}

/** `kill -9` the msys process groups of `pid` and its Windows descendants (Git's bash only). */
function killMsysGroups(pid: number): void {
  const shell = localShell();
  if (shell.name === "cmd.exe") return;
  const listing = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }",
  ], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  const children = new Map<number, number[]>();
  for (const line of (listing.stdout ?? "").split(/\r?\n/)) {
    const [p, parent] = line.trim().split(" ").map(Number);
    if (!p || parent === undefined || Number.isNaN(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), p]);
  }
  const tree = [pid];
  for (let i = 0; i < tree.length; i++) tree.push(...(children.get(tree[i]!) ?? []).filter((c) => !tree.includes(c)));
  // msys exposes each process's Windows pid and process group under /proc
  const script = `for p in /proc/[0-9]*; do w=$(cat "$p/winpid" 2>/dev/null); case " ${tree.join(" ")} " in *" $w "*) kill -9 -- -"$(cat "$p/pgid")" 2>/dev/null;; esac; done; true`;
  const argv = shell.argv(script);
  spawnSync(argv[0]!, argv.slice(1), { windowsHide: true, timeout: 15_000 });
}

let cached: ShellChoice | undefined;
/** The shell of this process, chosen once. */
export function localShell(): ShellChoice {
  return (cached ??= chooseLocalShell());
}
