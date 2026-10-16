import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseLocalShell } from "../sandbox/local-shell.js";
import { LocalWorkspace } from "../sandbox/workspaces.js";
import { bashSafeEnv } from "../tools/safe-env.js";

describe("local shell", () => {
  test("Linux and macOS: /bin/bash, as before", () => {
    expect(chooseLocalShell("linux", {}, () => false).argv("echo hi")).toEqual(["/bin/bash", "-c", "echo hi"]);
    expect(chooseLocalShell("darwin", {}, () => false).name).toBe("/bin/bash");
  });

  test("POLPO_SHELL wins everywhere", () => {
    expect(chooseLocalShell("win32", { POLPO_SHELL: "D:\\tools\\bash.exe" }, () => false).argv("ls")).toEqual(["D:\\tools\\bash.exe", "-c", "ls"]);
  });

  test("Windows: Git's bash from Program Files, or next to git on PATH; never System32's WSL launcher", () => {
    const git = join("C:\\Program Files", "Git", "bin", "bash.exe");
    expect(chooseLocalShell("win32", { ProgramFiles: "C:\\Program Files", PATH: "" }, (p) => p === git).name).toBe(git);

    const nextToGit = join("D:\\Apps\\Git\\cmd", "..", "bin", "bash.exe");
    expect(chooseLocalShell("win32", { PATH: "C:\\Windows\\System32;D:\\Apps\\Git\\cmd" }, (p) => p === nextToGit).name).toBe(nextToGit);

    const wsl = join("C:\\Windows\\System32", "bash.exe");
    const choice = chooseLocalShell("win32", { PATH: "C:\\Windows\\System32", ComSpec: "C:\\Windows\\system32\\cmd.exe" }, (p) => p === wsl);
    expect(choice.name).toBe("cmd.exe");
    expect(choice.argv("dir")).toEqual(["C:\\Windows\\system32\\cmd.exe", "/d", "/s", "/c", "dir"]);
  });

  test("a command really runs in the local workspace on this machine (Windows included)", async () => {
    const root = mkdtempSync(join(tmpdir(), "polpo-shell-"));
    try {
      const ws = new LocalWorkspace({ root, sandbox: { provider: "local", network: { mode: "open" }, resources: {}, providerOptions: {}, denied: [] } } as never, bashSafeEnv);
      const r = await ws.exec("echo polpo-ok");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("polpo-ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
