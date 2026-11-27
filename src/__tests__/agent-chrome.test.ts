/**
 * Agents' browsers are real Google Chrome, never Chromium: `--executable-path` on this server
 * (found once, POLPO_AGENT_BROWSER_EXECUTABLE overrides it, a clear error when Chrome is missing)
 * and in a remote computer (/usr/bin/google-chrome, installed idempotently, --no-sandbox as root);
 * headed by default on a remote computer; the agent is told never to launch a browser of its own.
 * Fakes only: no browser starts, no VM, nothing is downloaded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Shell, ShellOptions, ShellResult } from "@polpo-ai/core/shell";
import type { AgentConfig, ComputerConfig } from "@polpo-ai/core";

const spawned: Array<{ bin: string; args: string[] }> = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((bin: string, args: string[]) => {
      spawned.push({ bin, args });
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ success: true, data: { ok: true } })));
        child.emit("close", 0);
      });
      return child;
    }),
  };
});

import { execFileSync } from "node:child_process";
import {
  AGENT_BROWSER_EXECUTABLE_ENV, SANDBOX_CHROME_DEB_URL, SANDBOX_CHROME_FLAGS, SANDBOX_CHROME_INSTALL_COMMAND, SANDBOX_CHROME_PATH,
  hostChromeArgs, hostChromeCandidates, hostChromeExecutable, resetHostChromeCache,
} from "../tools/agent-chrome.js";
import {
  AGENT_BROWSER_CHECK_COMMAND, AGENT_BROWSER_INSTALL_COMMAND, agentBrowserEnv, browserPromptNote, createBrowserTools, effectiveBrowserHeaded,
  ensureSandboxBrowser, execChromeBrowserAsync, sandboxBrowserCommand,
} from "../tools/browser-tools.js";
import { desktopInstallCommand } from "../sandbox/desktop.js";
import { wantsComputerTakeoverTool } from "../tools/computer-takeover-tools.js";
import { buildHarnessInstructions } from "../adapters/harness-engine.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "polpo-chrome-")); dirs.push(d); return d; };
beforeEach(() => { resetHostChromeCache(); });
afterEach(() => {
  spawned.length = 0;
  vi.unstubAllEnvs();
  resetHostChromeCache();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** An executable file standing for Google Chrome. */
function fakeChrome(dir = tmp(), name = "google-chrome-stable"): string {
  const p = join(dir, name);
  writeFileSync(p, "#!/bin/sh\nexit 0\n");
  chmodSync(p, 0o755);
  return p;
}

describe("Google Chrome on this server", () => {
  it("is found on PATH (google-chrome-stable, google-chrome) or the usual paths, once, and cached", () => {
    const dir = tmp();
    const chrome = fakeChrome(dir, "google-chrome");
    expect(hostChromeCandidates("linux", { PATH: dir }).slice(0, 2)).toEqual([join(dir, "google-chrome-stable"), chrome]);
    expect(hostChromeCandidates("linux", { PATH: "" })).toContain("/usr/bin/google-chrome");
    expect(hostChromeCandidates("darwin", {})[0]).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    let looked = 0;
    const candidates = () => { looked++; return [join(dir, "missing"), chrome]; };
    expect(hostChromeExecutable({}, candidates)).toEqual({ ok: true, path: chrome });
    expect(hostChromeExecutable({}, candidates)).toEqual({ ok: true, path: chrome });
    expect(looked).toBe(1);
    expect(hostChromeArgs({}, candidates)).toMatchObject({ ok: true, args: ["--executable-path", chrome] });
  });

  it("POLPO_AGENT_BROWSER_EXECUTABLE overrides it; a wrong one is an error", () => {
    const chrome = fakeChrome();
    expect(hostChromeExecutable({ [AGENT_BROWSER_EXECUTABLE_ENV]: chrome }, () => [])).toEqual({ ok: true, path: chrome });
    const bad = hostChromeExecutable({ [AGENT_BROWSER_EXECUTABLE_ENV]: "/nope/chrome" }, () => [chrome]);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/POLPO_AGENT_BROWSER_EXECUTABLE is set to "\/nope\/chrome"/);
  });

  it("missing: a clear error saying Google Chrome must be installed (no Chromium fallback)", () => {
    const r = hostChromeArgs({}, () => [join(tmp(), "google-chrome")]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Google Chrome is not installed on this server.*never Chromium.*Install Google Chrome/s);
  });

  it("agent-browser gets --executable-path; never with an external CDP Chrome", async () => {
    const chrome = fakeChrome();
    vi.stubEnv(AGENT_BROWSER_EXECUTABLE_ENV, chrome);
    await execChromeBrowserAsync(["open", "https://example.com"], { session: "a", profileDir: "/p/a" });
    expect(spawned.at(-1)).toEqual({ bin: "agent-browser", args: ["--session", "a", "--executable-path", chrome, "--profile", "/p/a", "open", "https://example.com", "--json"] });
    await execChromeBrowserAsync(["open", "https://example.com"], { session: "polpo", cdp: 9222 });
    expect(spawned.at(-1)!.args).not.toContain("--executable-path");
  });

  it("the agent's browser tools fail with the error when Chrome is missing, launching nothing; close still works", async () => {
    vi.stubEnv(AGENT_BROWSER_EXECUTABLE_ENV, "/nope/google-chrome");
    const tools = createBrowserTools("/tmp", "a", ["browser_navigate", "browser_close"], undefined, join(tmp(), "out"));
    const r = await tools.find((t) => t.name === "browser_navigate")!.execute("1", { url: "https://maps.google.com" });
    expect((r.content[0] as { text: string }).text).toMatch(/^Browser error: POLPO_AGENT_BROWSER_EXECUTABLE is set to/);
    expect(spawned).toEqual([]);
    await tools.find((t) => t.name === "browser_close")!.execute("2", {});
    expect(spawned.map((s) => s.args)).toEqual([["--session", "a", "close", "--json"]]);
  });

  it("headed only when browserHeaded is true (unchanged on this server)", async () => {
    vi.stubEnv(AGENT_BROWSER_EXECUTABLE_ENV, fakeChrome());
    vi.stubEnv("DISPLAY", ":7");
    const nav = (headed?: boolean) => createBrowserTools("/tmp", "a", ["browser_navigate"], undefined, join(tmp(), "out"), undefined, undefined, headed === undefined ? {} : { headed })[0]!;
    await nav().execute("1", { url: "https://example.com" });
    expect(spawned.at(-1)!.args).not.toContain("--headed");
    await nav(true).execute("1", { url: "https://example.com" });
    expect(spawned.at(-1)!.args).toContain("--headed");
    expect(effectiveBrowserHeaded(undefined, false)).toBe(false);
    expect(effectiveBrowserHeaded(true, false)).toBe(true);
  });
});

/** A VM's shell: agent-browser and Chrome installed; the display installable unless `noDisplay`. */
class FakeVmShell implements Shell {
  commands: string[] = [];
  constructor(private o: { noDisplay?: boolean; chrome?: boolean } = {}) {}
  async isRemote() { return true; }
  async execute(command: string, _opts?: ShellOptions): Promise<ShellResult> {
    this.commands.push(command);
    if (command === AGENT_BROWSER_CHECK_COMMAND) return { stdout: "", stderr: "", exitCode: this.o.chrome === false ? 1 : 0 };
    if (command === AGENT_BROWSER_INSTALL_COMMAND) { this.o.chrome = true; return { stdout: "", stderr: "", exitCode: 0 }; }
    if (command === desktopInstallCommand("display") && this.o.noDisplay) return { stdout: "", stderr: "could not install xvfb", exitCode: 1 };
    return { stdout: JSON.stringify({ success: true, data: {} }), stderr: "", exitCode: 0 };
  }
}
const navigate = async (shell: FakeVmShell, headed?: boolean) => {
  const tools = createBrowserTools("/vm/work", "nina-agent", ["browser_navigate"], undefined, "/vm/out", undefined, undefined, { shell, ...(headed === undefined ? {} : { headed }) });
  return tools[0]!.execute("1", { url: "https://maps.google.com" });
};

describe("Google Chrome in a remote computer", () => {
  it("every launching command uses /usr/bin/google-chrome, --no-sandbox when root; close does not", () => {
    expect(SANDBOX_CHROME_PATH).toBe("/usr/bin/google-chrome");
    expect(sandboxBrowserCommand(["open", "https://x.test"], { session: "a" }))
      .toBe(`agent-browser --executable-path /usr/bin/google-chrome $([ "$(id -u)" = 0 ] && echo '--args --no-sandbox') --session 'a' 'open' 'https://x.test' --json`);
    expect(sandboxBrowserCommand(["open", "https://x.test"], { session: "a", headed: true })).toContain(`DISPLAY=:99 agent-browser --headed ${SANDBOX_CHROME_FLAGS} --session 'a'`);
    expect(sandboxBrowserCommand(["close"], { session: "a", headed: true })).toBe("agent-browser --session 'a' 'close' --json");
  });

  it("--no-sandbox only as root (the flags as a shell expands them)", () => {
    const words = (uid: string) => execFileSync("/bin/sh", ["-c", `id() { echo ${uid}; }; set -- ${SANDBOX_CHROME_FLAGS}; printf '%s\\n' "$@"`], { encoding: "utf8" }).trim().split("\n");
    expect(words("0")).toEqual(["--executable-path", "/usr/bin/google-chrome", "--args", "--no-sandbox"]);
    expect(words("1000")).toEqual(["--executable-path", "/usr/bin/google-chrome"]);
  });

  it("the check wants Chrome (never Chromium); the install adds it, once per shell", async () => {
    expect(AGENT_BROWSER_CHECK_COMMAND).toContain("command -v google-chrome");
    expect(AGENT_BROWSER_CHECK_COMMAND).not.toMatch(/chromium|\.agent-browser\/browsers/);
    expect(AGENT_BROWSER_INSTALL_COMMAND).toContain(SANDBOX_CHROME_INSTALL_COMMAND);
    expect(AGENT_BROWSER_INSTALL_COMMAND).not.toContain("agent-browser install");
    const shell = new FakeVmShell({ chrome: false });
    expect(await ensureSandboxBrowser(shell)).toBeUndefined();
    expect(await ensureSandboxBrowser(shell)).toBeUndefined();
    expect(shell.commands).toEqual([AGENT_BROWSER_CHECK_COMMAND, AGENT_BROWSER_INSTALL_COMMAND]);
  });

  describe("the install step (run by a real shell, with fake curl/apt-get)", () => {
    /** A bin folder with only what the step needs: fake curl, apt-get, dpkg, sudo; real sh, rm, tail, id, uname. */
    function fakeVm(arch = "amd64", uid = "0") {
      const bin = tmp();
      const log = join(bin, "calls.log");
      const script = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
      for (const real of ["sh", "rm", "tail", "uname", "cat", "chmod"]) {
        const found = ["/bin", "/usr/bin"].map((d) => join(d, real)).find((p) => existsSync(p));
        if (found) symlinkSync(found, join(bin, real));
      }
      script("id", `echo ${uid}`);
      script("dpkg", `echo ${arch}`);
      script("curl", `echo "curl $*" >> ${log}`);
      script("sudo", `echo "sudo $*" >> ${log}; shift; exec "$@"`);
      // apt-get "installs" Chrome: google-chrome appears on PATH
      script("apt-get", `echo "apt-get $*" >> ${log}; case "$*" in *install*) printf '#!/bin/sh\\n' > ${bin}/google-chrome; chmod 755 ${bin}/google-chrome;; esac`);
      const run = () => {
        try {
          execFileSync(join(bin, "sh"), ["-c", SANDBOX_CHROME_INSTALL_COMMAND], { env: { PATH: bin }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
          return { exitCode: 0, stderr: "" };
        } catch (err: any) {
          return { exitCode: err.status as number, stderr: String(err.stderr) };
        }
      };
      const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
      return { run, calls };
    }

    it("installs Google's .deb with apt-get when google-chrome is missing, then is a no-op", () => {
      const vm = fakeVm();
      expect(vm.run()).toEqual({ exitCode: 0, stderr: "" });
      const first = vm.calls();
      expect(first[0]).toBe(`curl -fsSL -o /tmp/polpo-google-chrome.deb ${SANDBOX_CHROME_DEB_URL}`);
      expect(first).toContain("apt-get install -y -qq /tmp/polpo-google-chrome.deb");
      expect(first.some((c) => c.startsWith("sudo"))).toBe(false);
      // idempotent: Chrome is there, nothing is downloaded or installed again
      expect(vm.run()).toEqual({ exitCode: 0, stderr: "" });
      expect(vm.calls()).toEqual(first);
    });

    it("not root: through sudo -n", () => {
      const vm = fakeVm("amd64", "1000");
      expect(vm.run().exitCode).toBe(0);
      expect(vm.calls().some((c) => c.startsWith("sudo -n sh -c"))).toBe(true);
    });

    it("no amd64: a clear error, nothing downloaded", () => {
      const vm = fakeVm("arm64");
      const r = vm.run();
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/Google Chrome has no Linux build/);
      expect(vm.calls()).toEqual([]);
    });
  });

  it("the runner image (polpo-runner-vm-4) ships Google Chrome from the same .deb", async () => {
    const { ROOT_STEPS, CHROME_DEB_URL, DAYTONA_V2_IMAGE } = await import("../../scripts/build-sandbox-images.mjs");
    expect(DAYTONA_V2_IMAGE).toBe("polpo-runner-vm-4");
    expect(CHROME_DEB_URL).toBe(SANDBOX_CHROME_DEB_URL);
    const step = (ROOT_STEPS as string[]).find((s) => s.includes(CHROME_DEB_URL));
    expect(step).toMatch(/^command -v google-chrome .*apt-get install -y \/tmp\/google-chrome\.deb/);
    expect((ROOT_STEPS as string[]).indexOf(step!)).toBeGreaterThan((ROOT_STEPS as string[]).findIndex((s) => s.includes("npm install -g agent-browser")));
  });
});

describe("headed by default on a remote computer", () => {
  it("unset: headed on the computer's desktop", async () => {
    const shell = new FakeVmShell();
    await navigate(shell);
    expect(shell.commands).toContain(desktopInstallCommand("display"));
    expect(shell.commands.at(-1)).toContain(`DISPLAY=:99 agent-browser --headed ${SANDBOX_CHROME_FLAGS}`);
  });

  it("browserHeaded: false keeps it headless (no display)", async () => {
    const shell = new FakeVmShell();
    await navigate(shell, false);
    expect(shell.commands).not.toContain(desktopInstallCommand("display"));
    expect(shell.commands.at(-1)).toMatch(/^agent-browser --executable-path \/usr\/bin\/google-chrome /);
  });

  it("no display to be had: headless by default (tried once), an error when headed was asked for", async () => {
    const shell = new FakeVmShell({ noDisplay: true });
    const r = await navigate(shell);
    expect((r.content[0] as { text: string }).text).not.toMatch(/error/i);
    expect(shell.commands.at(-1)).not.toContain("--headed");
    await navigate(shell);
    expect(shell.commands.filter((c) => c === desktopInstallCommand("display"))).toHaveLength(1);
    const asked = await navigate(new FakeVmShell({ noDisplay: true }), true);
    expect((asked.content[0] as { text: string }).text).toMatch(/^Browser error: The virtual display ca/);
  });

  it("DISPLAY in its commands, the prompt and request_computer_takeover follow the default", async () => {
    const shell = new FakeVmShell();
    expect((await agentBrowserEnv({ session: "a", shell, remote: true })).DISPLAY).toBe(":99");
    expect((await agentBrowserEnv({ session: "a", shell, headed: false, remote: true })).DISPLAY).toBeUndefined();
    expect(effectiveBrowserHeaded(undefined, true)).toBe(true);
    expect(effectiveBrowserHeaded(false, true)).toBe(false);
    const nina: ComputerConfig = { id: "nina", name: "Nina", kind: "daytona" };
    const agent = (o: Partial<AgentConfig>): AgentConfig => ({ name: "a", ...o });
    expect(wantsComputerTakeoverTool(agent({ allowedTools: ["browser_*"] }), nina)).toBe(true);
    expect(wantsComputerTakeoverTool(agent({ allowedTools: ["browser_*"], browserHeaded: false }), nina)).toBe(false);
    expect(wantsComputerTakeoverTool(agent({ allowedTools: ["read"] }), nina)).toBe(false);
    expect(wantsComputerTakeoverTool(agent({ allowedTools: ["browser_*"] }), { id: "host", name: "This server", kind: "host" })).toBe(false);
  });
});

describe("the agent uses Polpo's browser, never one of its own", () => {
  it("the prompt note, the tool description and the harness instructions say so", () => {
    const note = browserPromptNote({ session: "a" });
    expect(note).toMatch(/Use Polpo's browser only.*real Google Chrome/);
    expect(note).toMatch(/Never launch a browser of your own.*Playwright\/Puppeteer.*flagged as bots/s);
    expect(note).toMatch(/connectOverCDP/);
    const nav = createBrowserTools("/tmp", "a", ["browser_navigate"], undefined, join(tmp(), "out"))[0]!;
    expect(nav.description).toMatch(/real Google Chrome.*never launch a Chromium\/Chrome\/Playwright browser of your own/s);
    const harness = buildHarnessInstructions({ agent: { name: "a" }, cwd: "/w", hostTools: ["browser_navigate", "read"], harness: "claude-code" });
    expect(harness).toMatch(/use Polpo's browser.*\$CDP_URL.*Never launch a Chromium, Chrome or Playwright\/Puppeteer browser of your own/s);
    expect(buildHarnessInstructions({ agent: { name: "a" }, cwd: "/w", hostTools: ["read"], harness: "claude-code" })).not.toMatch(/Polpo's browser/);
  });
});
