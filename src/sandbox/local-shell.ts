/**
 * The shell the local workspace runs agent commands with. On Linux and macOS it is /bin/bash. On
 * Windows that path does not exist ("uv_spawn '/bin/bash' ENOENT": the bash tool failed for every
 * command): Git for Windows' bash is used when found, else cmd.exe.
 */

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

let cached: ShellChoice | undefined;
/** The shell of this process, chosen once. */
export function localShell(): ShellChoice {
  return (cached ??= chooseLocalShell());
}
