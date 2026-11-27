/**
 * The agent's own Chrome on a remote computer: launched by Polpo like a person would (no automation
 * flags, so navigator.webdriver is false and Google sign-in works), one per profile, with its
 * DevTools port on 127.0.0.1; agent-browser attaches to it with --cdp.
 *
 *   - the launch script is run by a real /bin/sh with a fake Chrome (a node DevTools stub) and a
 *     fake agent-browser: launch, reuse, restart when dead or when its settings change, a profile
 *     held by another Chrome, --no-sandbox only as root;
 *   - the browser tools through a fake VM shell: --cdp, language/timezone, never stopped at run end;
 *   - with Google Chrome, Xvfb and agent-browser installed here: the real thing (skipped otherwise).
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Shell, ShellOptions, ShellResult } from "@polpo-ai/core/shell";
import {
  AGENT_CHROME_DEFAULT_LOCALE, AGENT_CHROME_DEFAULT_TIMEZONE, AGENT_CHROME_PORT_BASE, AGENT_CHROME_PORT_RANGE,
  agentChromeBasePort, agentChromeEnsureScript, agentChromeFlags, agentChromeLocale, type AgentChromeLaunch,
} from "../tools/agent-chrome.js";
import {
  AGENT_BROWSER_CHECK_COMMAND, agentBrowserEnv, BROWSER_SECRET_ARG, cleanupAgentBrowserSession, createBrowserTools, desktopWindowSize, sandboxBrowserCommand,
} from "../tools/browser-tools.js";

const dirs: string[] = [];
const pids: number[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "polpo-own-chrome-")); dirs.push(d); return d; };
const killPid = (pid: number | undefined) => { if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } };
afterEach(() => {
  for (const pid of pids.splice(0)) killPid(pid);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const AUTOMATION_FLAGS = ["--enable-automation", "--remote-debugging-pipe", "--disable-blink-features=AutomationControlled", "--test-type", "--disable-component-update", "--headless=old"];

describe("language, timezone and flags", () => {
  it("defaults to it-IT and Europe/Rome; the identity's locale and timezone win; junk falls back", () => {
    expect(AGENT_CHROME_DEFAULT_LOCALE).toBe("it-IT");
    expect(AGENT_CHROME_DEFAULT_TIMEZONE).toBe("Europe/Rome");
    expect(agentChromeLocale()).toEqual({ locale: "it-IT", acceptLanguage: "it-IT,it", timezone: "Europe/Rome" });
    expect(agentChromeLocale({ locale: "en-US", timezone: "America/New_York" })).toEqual({ locale: "en-US", acceptLanguage: "en-US,en", timezone: "America/New_York" });
    expect(agentChromeLocale({ locale: "de" }).acceptLanguage).toBe("de");
    expect(agentChromeLocale({ locale: "x'; rm -rf /", timezone: "$(reboot)" })).toEqual(agentChromeLocale());
  });

  it("no automation flags, DevTools on 127.0.0.1, the desktop's size, the proxy when there is one", () => {
    const base: AgentChromeLaunch = { profileName: "a", session: "a", windowSize: desktopWindowSize(), ...agentChromeLocale(), display: ":99" };
    const flags = agentChromeFlags({ ...base, proxy: "socks5://127.0.0.1:1081" });
    for (const f of AUTOMATION_FLAGS) expect(flags).not.toContain(f);
    expect(flags).toEqual(expect.arrayContaining([
      "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "--lang=it-IT", "--accept-lang=it-IT,it",
      "--window-size=1280,800", "--proxy-server=socks5://127.0.0.1:1081", "--proxy-bypass-list=<-loopback>",
    ]));
    expect(flags).not.toContain("--headless=new");
    expect(agentChromeFlags({ ...base, display: undefined })).toContain("--headless=new");
    expect(agentChromeFlags(base).some((f) => f.startsWith("--proxy"))).toBe(false);
  });

  it("each profile starts from its own port in the range", () => {
    const p = agentChromeBasePort("growth");
    expect(p).toBe(agentChromeBasePort("growth"));
    expect(p).toBeGreaterThanOrEqual(AGENT_CHROME_PORT_BASE);
    expect(p).toBeLessThan(AGENT_CHROME_PORT_BASE + AGENT_CHROME_PORT_RANGE);
  });
});

// ── The launch script, run by a real shell ──────────────────────────────

/** A VM: HOME, a fake Chrome (DevTools stub recording its argv and env) and a fake agent-browser. */
function fakeVm(uid = "0") {
  const root = tmp();
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home); mkdirSync(bin);
  const log = join(root, "calls.log");
  const script = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  writeFileSync(join(root, "fake-chrome.js"), `
    const fs = require("fs");
    const port = Number((process.argv.find((a) => a.startsWith("--remote-debugging-port=")) || "").split("=")[1]);
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ chrome: process.argv.slice(2), pid: process.pid, TZ: process.env.TZ, LANGUAGE: process.env.LANGUAGE, DISPLAY: process.env.DISPLAY || null, secret: process.env.POLPO_BROWSER_SECRET || null }) + "\\n");
    require("http").createServer((q, r) => { r.writeHead(q.url === "/json/version" ? 200 : 404); r.end("{}"); }).listen(port, "127.0.0.1");
  `);
  const chromePath = join(bin, "google-chrome");
  script("google-chrome", `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, "fake-chrome.js"))} "$@"`);
  script("agent-browser", `echo '{"agentBrowser":"'"$*"'"}' >> ${JSON.stringify(log)}`);
  script("id", `echo ${uid}`);
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, POLPO_BROWSER_SECRET: "hunter2" };
  const ensure = (o: Partial<AgentChromeLaunch> = {}) => {
    const launch: AgentChromeLaunch = { profileName: "growth", session: "growth", windowSize: [1280, 800], ...agentChromeLocale({ timezone: "Europe/Rome" }), chromePath, ...o };
    const port = execFileSync("/bin/sh", ["-c", agentChromeEnsureScript(launch)], { env, encoding: "utf8", timeout: 30_000 }).trim();
    const pid = Number(readFileSync(join(home, ".polpo/browser-chrome", `${launch.profileName}.pid`), "utf8"));
    pids.push(pid);
    return { port: Number(port), pid };
  };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const launches = () => calls().filter((c) => c.chrome);
  return { root, home, bin, chromePath, ensure, calls, launches };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitDead = async (pid: number) => { for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50)); return !alive(pid); };

describe("the agent's own Chrome (launch script, real shell, fake Chrome)", () => {
  it("launches it with its own command: DevTools on 127.0.0.1, language, TZ, proxy, no automation flags, no secret", () => {
    const vm = fakeVm();
    const { port, pid } = vm.ensure({ proxy: "socks5://127.0.0.1:1081", display: ":99" });
    expect(port).toBeGreaterThanOrEqual(AGENT_CHROME_PORT_BASE);
    const [launch] = vm.launches();
    expect(launch.pid).toBe(pid);
    expect(launch.chrome).toEqual(expect.arrayContaining([
      `--user-data-dir=${vm.home}/.polpo/browser-profiles/growth`, `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1",
      "--no-first-run", "--no-default-browser-check", "--lang=it-IT", "--accept-lang=it-IT,it",
      "--proxy-server=socks5://127.0.0.1:1081", "--window-size=1280,800", "--no-sandbox",
    ]));
    for (const f of AUTOMATION_FLAGS) expect(launch.chrome).not.toContain(f);
    expect(launch).toMatchObject({ TZ: "Europe/Rome", LANGUAGE: "it_IT", DISPLAY: ":99", secret: null });
    // the session is closed before it attaches to a new Chrome
    expect(vm.calls()[0]).toEqual({ agentBrowser: "--session growth close" });
  });

  it("reuses it while it runs; launches it again when it died", async () => {
    const vm = fakeVm();
    const first = vm.ensure();
    expect(vm.ensure()).toEqual(first);
    expect(vm.launches()).toHaveLength(1);
    process.kill(first.pid, "SIGKILL");
    expect(await waitDead(first.pid)).toBe(true);
    const second = vm.ensure();
    expect(second.pid).not.toBe(first.pid);
    expect(second.port).toBe(first.port);
    expect(vm.launches()).toHaveLength(2);
  });

  it("other settings (the egress proxy, the timezone): the old one is stopped, a new one launched", async () => {
    const vm = fakeVm();
    const first = vm.ensure();
    const second = vm.ensure({ proxy: "socks5://127.0.0.1:1081" });
    expect(await waitDead(first.pid)).toBe(true);
    expect(vm.launches().at(-1)!.chrome).toContain("--proxy-server=socks5://127.0.0.1:1081");
    const third = vm.ensure({ proxy: "socks5://127.0.0.1:1081", ...agentChromeLocale({ locale: "en-US", timezone: "America/New_York" }) });
    expect(await waitDead(second.pid)).toBe(true);
    expect(vm.launches().at(-1)).toMatchObject({ TZ: "America/New_York", LANGUAGE: "en_US" });
    expect(vm.launches().at(-1)!.chrome).toContain("--lang=en-US");
    expect(alive(third.pid)).toBe(true);
  });

  it("a profile held by another Chrome (one agent-browser launched): stopped first", async () => {
    const vm = fakeVm();
    const prof = join(vm.home, ".polpo/browser-profiles/growth");
    mkdirSync(prof, { recursive: true });
    // a Chrome agent-browser launched on the profile before: it holds the SingletonLock
    // (not a child of this process: a killed one would stay a zombie until this test reaped it)
    const holder = Number(execFileSync("/bin/sh", ["-c", `${JSON.stringify(vm.chromePath)} --remote-debugging-port=0 >/dev/null 2>&1 </dev/null & echo $!`], { encoding: "utf8" }).trim());
    pids.push(holder);
    symlinkSync(`vm-${holder}`, join(prof, "SingletonLock"));
    await new Promise((r) => setTimeout(r, 300));
    const ours = vm.ensure();
    expect(await waitDead(holder)).toBe(true);
    expect(alive(ours.pid)).toBe(true);
    expect(existsSync(join(prof, "SingletonLock"))).toBe(false);
  });

  it("--no-sandbox only as root; headless without a display", () => {
    const vm = fakeVm("1000");
    vm.ensure();
    const [launch] = vm.launches();
    expect(launch.chrome).not.toContain("--no-sandbox");
    expect(launch.chrome).toContain("--headless=new");
    expect(launch.DISPLAY).toBeNull();
  });
});

// ── The browser tools in a VM (fake shell) ──────────────────────────────

class FakeVmShell implements Shell {
  calls: Array<{ command: string; env?: Record<string, string> }> = [];
  constructor(private port = "") {}
  async isRemote() { return true; }
  async execute(command: string, opts: ShellOptions = {}): Promise<ShellResult> {
    this.calls.push({ command, ...(opts.env ? { env: opts.env } : {}) });
    if (command === AGENT_BROWSER_CHECK_COMMAND) return { stdout: "", stderr: "", exitCode: 0 };
    if (command.includes(".polpo/browser-chrome/") && !command.includes("agent-browser")) return { stdout: this.port, stderr: "", exitCode: 0 };
    return { stdout: JSON.stringify({ success: true, data: {} }), stderr: "", exitCode: 0 };
  }
}

describe("browser tools on a remote computer", () => {
  it("every launching command makes sure its Chrome runs, then attaches with --cdp; language and timezone from the identity", async () => {
    const shell = new FakeVmShell();
    const tools = createBrowserTools("/vm/work", "growth", ["browser_navigate", "browser_snapshot", "browser_close"], "/host/.polpo/browser-profiles/growth", "/vm/out", undefined, undefined,
      { shell, headed: false, identity: { locale: "en-US", timezone: "America/New_York" } });
    const t = (n: string) => tools.find((x) => x.name === n)!;
    await t("browser_navigate").execute("1", { url: "https://accounts.google.com" });
    await t("browser_snapshot").execute("2", {});
    await t("browser_close").execute("3", {});
    const cmds = shell.calls.map((c) => c.command).filter((c) => c !== AGENT_BROWSER_CHECK_COMMAND);
    expect(cmds[0]).toContain("TZ='America/New_York' LANGUAGE='en_US'");
    expect(cmds[0]).toContain("'--lang=en-US' '--accept-lang=en-US,en'");
    expect(cmds[0].endsWith(`agent-browser --session 'growth' --cdp "$P" 'open' 'https://accounts.google.com' --json`)).toBe(true);
    expect(cmds[1].endsWith(`agent-browser --session 'growth' --cdp "$P" 'snapshot' --json`)).toBe(true);
    for (const c of cmds.slice(0, 2)) {
      expect(c).not.toMatch(/--enable-automation|agent-browser [^;]*--profile|--executable-path|--headed/);
    }
    // closing the session never launches Chrome
    expect(cmds[2]).toBe("agent-browser --session 'growth' 'close' --json");
  });

  it("a vault secret travels in the environment and is unset before Chrome could inherit it", () => {
    const cmd = sandboxBrowserCommand(["fill", "@e1", BROWSER_SECRET_ARG], { session: "ada" });
    expect(cmd.startsWith("P=$(unset POLPO_BROWSER_SECRET; ")).toBe(true);
    expect(cmd.endsWith(`--cdp "$P" 'fill' '@e1' "$POLPO_BROWSER_SECRET" --json`)).toBe(true);
  });

  it("CDP_URL is its Chrome's DevTools endpoint while it runs", async () => {
    expect(await agentBrowserEnv({ session: "growth", profileName: "growth", shell: new FakeVmShell("9412\n"), headed: false, remote: true }))
      .toEqual({ POLPO_BROWSER_SESSION: "growth", CDP_URL: "http://127.0.0.1:9412" });
    expect(await agentBrowserEnv({ session: "growth", shell: new FakeVmShell(""), headed: false, remote: true }))
      .toEqual({ POLPO_BROWSER_SESSION: "growth" });
  });

  it("the end of a run only detaches agent-browser: the agent's Chrome (and a page a person left open) stays", async () => {
    const shell = new FakeVmShell();
    await cleanupAgentBrowserSession("growth", shell);
    expect(shell.calls.map((c) => c.command)).toEqual(["agent-browser --session 'growth' 'close' --json"]);
    expect(shell.calls[0]!.command).not.toMatch(/kill|browser-chrome|google-chrome/);
  });
});

// ── The real thing (Google Chrome + Xvfb + agent-browser here) ──────────

const which = (bin: string) => { try { return execFileSync("/bin/sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).trim() || undefined; } catch { return undefined; } };
const realChrome = which("google-chrome") ?? which("google-chrome-stable");
const realXvfb = which("Xvfb");
const realAgentBrowser = which("agent-browser");

describe.skipIf(!realChrome || !realXvfb || !realAgentBrowser)("Google Chrome launched by Polpo, attached with agent-browser --cdp (integration)", () => {
  it("navigator.webdriver is false, the language and timezone are the agent's", async () => {
    const root = tmp();
    const home = join(root, "home");
    mkdirSync(home);
    const display = `:${200 + Math.floor(Math.random() * 500)}`;
    const xvfb = spawn(realXvfb!, [display, "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { stdio: "ignore" });
    pids.push(xvfb.pid!);
    const session = `polpo-own-chrome-test-${process.pid}`;
    let chromePid: number | undefined;
    try {
      for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${display.slice(1)}`); i++) await new Promise((r) => setTimeout(r, 100));
      const launch: AgentChromeLaunch = {
        profileName: "itest", session, windowSize: [1280, 800], display, chromePath: realChrome!,
        ...agentChromeLocale({ locale: "it-IT", timezone: "Europe/Rome" }),
      };
      const port = execFileSync("/bin/sh", ["-c", agentChromeEnsureScript(launch)], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 60_000 }).trim();
      chromePid = Number(readFileSync(join(home, ".polpo/browser-chrome/itest.pid"), "utf8"));
      pids.push(chromePid);
      const cmdline = readFileSync(`/proc/${chromePid}/cmdline`, "utf8").split("\0");
      for (const f of AUTOMATION_FLAGS) expect(cmdline).not.toContain(f);
      const out = execFileSync(realAgentBrowser!, ["--session", session, "--cdp", port, "eval",
        "JSON.stringify([navigator.webdriver, navigator.language, Intl.DateTimeFormat().resolvedOptions().timeZone])", "--json"], { encoding: "utf8", timeout: 60_000 });
      const result = JSON.parse(JSON.parse(out).data.result);
      expect(result).toEqual([false, "it-IT", "Europe/Rome"]);
      // the end of a run detaches agent-browser: Chrome stays
      execFileSync(realAgentBrowser!, ["--session", session, "close", "--json"], { encoding: "utf8", timeout: 30_000 });
      expect(alive(chromePid)).toBe(true);
    } finally {
      try { execFileSync(realAgentBrowser!, ["--session", session, "close", "--json"], { stdio: "ignore", timeout: 20_000 }); } catch { /* closed */ }
      if (chromePid) { try { process.kill(chromePid, "SIGTERM"); } catch { /* gone */ } await waitDead(chromePid); }
      killPid(xvfb.pid);
    }
  }, 120_000);
});
