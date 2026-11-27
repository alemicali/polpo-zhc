/**
 * A remote computer's desktop is a real PC desktop: XFCE on the virtual display, the agent's
 * language, timezone and keyboard, a "Chrome di <agent>" launcher that reopens the agent's CLEAN
 * Chrome, and a size per computer (settings.computers[].desktop.size).
 *
 *   - the commands as text: what XFCE is started with, what is disabled, the size everywhere;
 *   - run by a real /bin/sh in a fake VM (fake Xvfb socket, fake dbus-launch/startxfce4/openbox,
 *     apt-get, locale tools; the desktop's paths moved to a temp dir, never the host's :99):
 *     XFCE started once (idempotent), restarted when it died, openbox when XFCE is missing (and
 *     replaced by XFCE once installed), openbox installed when XFCE cannot be;
 *   - the launcher: its files, its launch script reopening the same Chrome the browser tools use.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerConfigError, computerDesktopSize, parseComputer, parseDesktopSize } from "@polpo-ai/core/sandbox";
import {
  DESKTOP_DIR, DESKTOP_DISABLED_AUTOSTART, DESKTOP_DISPLAY_COMMAND, DESKTOP_IMAGE_PACKAGES, computerDesktopOptions, desktopDisplayCommand,
  desktopInstallCommand, desktopSession, parseDesktopInspect,
} from "../sandbox/desktop.js";
import {
  agentChromeEnsureScript, agentChromeLaunchScript, agentChromeLauncherCommand, agentChromeLauncherFile, agentChromeLauncherName, agentChromeLocale,
  type AgentChromeLaunch,
} from "../tools/agent-chrome.js";
import { sandboxBrowserCommand } from "../tools/browser-tools.js";

const dirs: string[] = [];
const pids: number[] = [];
const servers: Server[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "polpo-xfce-")); dirs.push(d); return d; };
/**
 * A PATH dir with only these host tools (wrappers): the fake VM never finds the host's own X tools
 * (a real dbus-launch, startxfce4, openbox or Xvfb on this machine must never run).
 */
function hostTools(root: string, tools: string[]): string {
  const dir = join(root, "hostbin");
  mkdirSync(dir, { recursive: true });
  for (const tool of tools) {
    const real = execFileSync("/bin/sh", ["-c", `command -v ${tool} || true`], { encoding: "utf8" }).trim();
    if (real.startsWith("/")) writeFileSync(join(dir, tool), `#!/bin/sh\nexec ${real} "$@"\n`, { mode: 0o755 });
  }
  return dir;
}
const SHELL_TOOLS = ["sh", "cat", "grep", "tail", "mkdir", "chmod", "rm", "cp", "sleep", "setsid", "nohup", "tr", "sed", "id"];
afterEach(() => {
  for (const pid of pids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Wait until `ok()` (background processes write their calls a moment after the command returns). */
const waitFor = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 30)); return ok(); };
const waitDead = async (pid: number) => { for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50)); return !alive(pid); };

describe("the desktop's commands", () => {
  it("XFCE with its own session bus, no screensaver, locker, power manager or compositing, the keyboard layout", () => {
    const cmd = DESKTOP_DISPLAY_COMMAND;
    expect(cmd).toContain("dbus-launch --exit-with-session startxfce4");
    expect(cmd).toContain("command -v startxfce4 >/dev/null 2>&1 && command -v dbus-launch >/dev/null 2>&1");
    expect(cmd).toContain("setxkbmap -display :99 'it'");
    expect(cmd).toContain("xset -display :99 s off -dpms s noblank");
    expect(cmd).toContain('name="use_compositing" type="bool" value="false"');
    expect(cmd).toContain('name="XkbLayout" type="string" value="it"');
    for (const a of ["xfce4-screensaver", "light-locker", "xfce4-power-manager"]) expect(DESKTOP_DISABLED_AUTOSTART).toContain(a);
    expect(cmd).toContain("Hidden=true");
    // the default panel, so XFCE never asks on the first start
    expect(cmd).toContain("cp /etc/xdg/xfce4/panel/default.xml");
    // the agent's language and timezone (defaults: it_IT.UTF-8, Europe/Rome), C.UTF-8 when it cannot be generated
    expect(cmd).toContain("LC='it_IT.UTF-8'");
    expect(cmd).toContain("TZ='Europe/Rome'");
    expect(cmd).toContain("haveloc || LC=C.UTF-8");
    expect(cmd).toContain("locale-gen");
    // openbox only as the fallback
    expect(cmd).toMatch(/elif command -v openbox .* nohup openbox/);
    expect(cmd).toContain("-screen 0 1280x800x24");
  });

  it("the session follows the agent's identity; junk falls back to the defaults", () => {
    expect(desktopSession()).toEqual({ size: [1280, 800], screen: "1280x800x24", lang: "it_IT.UTF-8", timezone: "Europe/Rome", keyboard: "it" });
    expect(desktopSession({ locale: "en-US", timezone: "America/New_York", size: "1600x900" })).toEqual({
      size: [1600, 900], screen: "1600x900x24", lang: "en_US.UTF-8", timezone: "America/New_York", keyboard: "us",
    });
    expect(desktopSession({ locale: "en-GB" }).keyboard).toBe("gb");
    expect(desktopSession({ locale: "de" })).toMatchObject({ lang: "de_DE.UTF-8", keyboard: "de" });
    expect(desktopSession({ locale: "x'; reboot", timezone: "$(reboot)", size: "99999x1" })).toEqual(desktopSession());
    const en = desktopDisplayCommand({ locale: "en-US", timezone: "America/New_York" });
    expect(en).toContain("setxkbmap -display :99 'us'");
    expect(en).toContain("LC='en_US.UTF-8'");
    expect(en).toContain("TZ='America/New_York'");
  });

  it("install: XFCE without recommends, the clipboard and keyboard tools; openbox only when XFCE cannot be installed", () => {
    const display = desktopInstallCommand("display");
    expect(display).toContain("--no-install-recommends");
    for (const pkg of ["xfce4", "xfce4-terminal", "thunar", "mousepad", "xfce4-taskmanager", "dbus-x11"]) expect(display).toContain(`desk="$desk ${pkg}"`);
    for (const pkg of ["xvfb", "xclip", "xsel", "x11-xkb-utils", "x11-xserver-utils"]) expect(display).toContain(`need="$need ${pkg}"`);
    expect(display).toContain("at-spi2-core fonts-dejavu fonts-liberation");
    expect(display).not.toContain("xfce4-goodies");
    expect(display).not.toContain("xfce4-screensaver");
    expect(display).not.toContain("x11vnc");
    expect(desktopInstallCommand("view")).toContain('need="$need x11vnc"');
  });

  it("the runner image ships every desktop package (and generates it_IT.UTF-8)", async () => {
    const { DESKTOP_PACKAGES, ROOT_STEPS } = await import("../../scripts/build-sandbox-images.mjs");
    expect([...(DESKTOP_PACKAGES as string[])].sort()).toEqual([...DESKTOP_IMAGE_PACKAGES].sort());
    const apt = (ROOT_STEPS as string[])[0]!;
    for (const pkg of DESKTOP_IMAGE_PACKAGES) expect(apt).toContain(` ${pkg} `.trimEnd());
    expect(apt).toContain("--no-install-recommends");
    expect(apt).not.toContain("openbox");
    expect((ROOT_STEPS as string[]).some((s) => s.includes("it_IT.UTF-8 UTF-8") && s.includes("locale-gen"))).toBe(true);
  });

  it("inspect: the session and the size", () => {
    expect(parseDesktopInspect("display=1\nwm=1\nsession=xfce\nvnc=0\nws=0\ninstalled=1\nsize=1600x900\n")).toMatchObject({ wm: true, session: "xfce", size: "1600x900" });
    expect(parseDesktopInspect("display=1\nwm=1\nsession=openbox\n").session).toBe("openbox");
    expect(parseDesktopInspect("display=0\nwm=0\n")).not.toHaveProperty("session");
  });
});

describe("desktop size per computer", () => {
  it("settings.computers[].desktop.size: WIDTHxHEIGHT in range, remote computers only", () => {
    expect(parseComputer({ id: "nina", kind: "daytona", desktop: { size: "1600x900" } }).desktop).toEqual({ size: "1600x900" });
    expect(parseComputer({ id: "nina", kind: "daytona", desktop: {} }).desktop).toBeUndefined();
    expect(() => parseComputer({ id: "nina", kind: "daytona", desktop: { size: "big" } })).toThrow(ComputerConfigError);
    expect(() => parseComputer({ id: "nina", kind: "daytona", desktop: { size: "640x480" } })).toThrow(/800x600 to 3840x2160/);
    expect(() => parseComputer({ id: "nina", kind: "daytona", desktop: "1600x900" })).toThrow(/desktop must be an object/);
    expect(() => parseComputer({ id: "srv", kind: "host", desktop: { size: "1600x900" } })).toThrow(/no desktop of its own/);
    expect(parseDesktopSize("1920x1080")).toEqual([1920, 1080]);
    expect(computerDesktopSize({})).toBe("1280x800");
    expect(computerDesktopSize({ desktop: { size: "1600x900" } })).toBe("1600x900");
  });

  it("the size flows to Xvfb and to the agent's Chrome window; the launcher is written on a headed launch", () => {
    const cmd = sandboxBrowserCommand(["open", "https://x.test"], { session: "nina", headed: true, desktop: { size: "1600x900", label: "Nina Rossi" }, identity: { locale: "it-IT" } });
    expect(cmd).toContain("-screen 0 1600x900x24");
    expect(cmd).toContain("'--window-size=1600,900'");
    expect(cmd).toContain(agentChromeLauncherFile("nina"));
    expect(cmd).toContain("Name=Chrome di Nina Rossi");
    const headless = sandboxBrowserCommand(["open", "https://x.test"], { session: "nina", headed: false, desktop: { size: "1600x900", label: "Nina" } });
    expect(headless).not.toContain("Xvfb");
    expect(headless).not.toContain(".desktop");
    expect(headless).toContain("'--window-size=1600,900'");
  });

  it("the live view's options: the computer's size, its default agent's language and timezone", () => {
    const computer = { id: "nina", name: "Nina", kind: "daytona" as const, desktop: { size: "1440x900" } };
    const agents = [
      { name: "other", computers: ["nina"], identity: { locale: "de-DE", timezone: "Europe/Berlin" } },
      { name: "nina", defaultComputer: "nina", identity: { locale: "en-US", timezone: "America/New_York" } },
    ];
    expect(computerDesktopOptions(computer, agents)).toEqual({ size: "1440x900", locale: "en-US", timezone: "America/New_York" });
    expect(computerDesktopOptions({ ...computer, desktop: undefined }, [])).toEqual({ size: "1280x800" });
  });
});

// ── Run by a real shell in a fake VM ──────────────────────────────────────

/** A fake VM: the desktop's paths moved under a temp dir, fake X tools that record their calls. */
async function fakeDesktopVm(o: { xfce?: boolean; openbox?: boolean } = {}) {
  const root = tmp();
  const home = join(root, "home");
  const bin = join(root, "bin");
  const x11 = join(root, "x11");
  const dir = join(root, "desktop");
  mkdirSync(home); mkdirSync(bin); mkdirSync(x11);
  const log = join(root, "calls.log");
  const script = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  const record = (name: string, tail = "") => script(name, `echo "${name} $* LANG=$LANG TZ=$TZ DISPLAY=$DISPLAY" >> ${JSON.stringify(log)}${tail}`);
  // the display is up: a real socket and a live "Xvfb" pid (this test process)
  const sock = join(x11, "X99");
  await new Promise<void>((resolve) => { const s = createServer().listen(sock, () => resolve()); servers.push(s); });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "xvfb.pid"), String(process.pid));
  // a session that keeps running (like dbus-launch running startxfce4)
  if (o.xfce !== false) { record("dbus-launch", "; exec sleep 30"); record("startxfce4"); }
  if (o.openbox) record("openbox", "; exec sleep 30");
  record("setxkbmap"); record("xset"); record("locale-gen");
  script("locale", "echo C.utf8; echo it_IT.utf8");
  script("pgrep", "exit 1");
  // not root, no sudo: the locale step can never touch this machine's /etc
  script("id", "echo 1000");
  const env = { PATH: `${bin}:${hostTools(root, SHELL_TOOLS)}`, HOME: home };
  const run = (cmd: string) => execFileSync("/bin/sh", ["-c", cmd
    .split(DESKTOP_DIR).join(dir)
    .split("/tmp/.X11-unix/X99").join(sock)
    .split("/tmp/.X99-lock").join(join(root, "X99-lock"))], { env, encoding: "utf8", timeout: 20_000 });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  const wm = () => { const pid = Number(readFileSync(join(dir, "wm.pid"), "utf8")); pids.push(pid); return pid; };
  const kind = () => readFileSync(join(dir, "wm.kind"), "utf8").trim();
  return { root, home, bin, dir, run, calls, wm, kind, script, record };
}

describe("the desktop session (real shell, fake VM)", () => {
  it("starts XFCE once with the agent's language and timezone; idempotent; started again when it died", async () => {
    const vm = await fakeDesktopVm();
    vm.run(desktopDisplayCommand({ locale: "it-IT", timezone: "Europe/Rome" }));
    const first = vm.wm();
    expect(vm.kind()).toBe("xfce");
    await waitFor(() => vm.calls().some((c) => c.startsWith("dbus-launch")));
    expect(vm.calls().filter((c) => c.startsWith("dbus-launch"))).toEqual(["dbus-launch --exit-with-session startxfce4 LANG=it_IT.UTF-8 TZ=Europe/Rome DISPLAY=:99"]);
    expect(vm.calls()).toContain("setxkbmap -display :99 it LANG= TZ= DISPLAY=");
    expect(vm.calls().some((c) => c.startsWith("xset -display :99 s off -dpms"))).toBe(true);
    // the XFCE settings, written once
    const xc = join(vm.home, ".config/xfce4/xfconf/xfce-perchannel-xml");
    expect(readFileSync(join(xc, "xfwm4.xml"), "utf8")).toContain('"use_compositing" type="bool" value="false"');
    expect(readFileSync(join(xc, "keyboard-layout.xml"), "utf8")).toContain('value="it"');
    expect(readFileSync(join(vm.home, ".config/autostart/xfce4-screensaver.desktop"), "utf8")).toContain("Hidden=true");
    expect(readFileSync(join(vm.home, ".config/autostart/light-locker.desktop"), "utf8")).toContain("Hidden=true");

    // running: nothing started again
    vm.run(desktopDisplayCommand({ locale: "it-IT" }));
    expect(vm.calls().filter((c) => c.startsWith("dbus-launch"))).toHaveLength(1);
    expect(vm.wm()).toBe(first);

    // the session died: started again
    process.kill(first, "SIGKILL");
    expect(await waitDead(first)).toBe(true);
    vm.run(desktopDisplayCommand());
    await waitFor(() => vm.calls().filter((c) => c.startsWith("dbus-launch")).length === 2);
    expect(vm.calls().filter((c) => c.startsWith("dbus-launch"))).toHaveLength(2);
    expect(vm.wm()).not.toBe(first);
  });

  it("a language the VM does not have: generated, else C.UTF-8", async () => {
    const vm = await fakeDesktopVm();
    vm.run(desktopDisplayCommand({ locale: "fr-FR" }));
    vm.wm();
    await waitFor(() => vm.calls().some((c) => c.startsWith("dbus-launch")));
    // it cannot be generated here (not root, no sudo): C.UTF-8
    expect(vm.calls().find((c) => c.startsWith("dbus-launch"))).toContain("LANG=C.UTF-8");
  });

  it("no XFCE: openbox; XFCE installed later replaces it", async () => {
    const vm = await fakeDesktopVm({ xfce: false, openbox: true });
    vm.run(DESKTOP_DISPLAY_COMMAND);
    const openbox = vm.wm();
    expect(vm.kind()).toBe("openbox");
    await waitFor(() => vm.calls().some((c) => c.startsWith("openbox")));
    expect(vm.calls().some((c) => c.startsWith("openbox"))).toBe(true);
    vm.run(DESKTOP_DISPLAY_COMMAND);
    expect(vm.calls().filter((c) => c.startsWith("openbox"))).toHaveLength(1);
    // XFCE arrives (an install, a newer image): openbox goes, XFCE comes
    vm.record("dbus-launch", "; exec sleep 30"); vm.record("startxfce4");
    vm.run(DESKTOP_DISPLAY_COMMAND);
    expect(await waitDead(openbox)).toBe(true);
    expect(vm.kind()).toBe("xfce");
    vm.wm();
    await waitFor(() => vm.calls().some((c) => c.startsWith("dbus-launch")));
    expect(vm.calls().filter((c) => c.startsWith("dbus-launch"))).toHaveLength(1);
  });

  it("install: XFCE when it can be; openbox when apt cannot install XFCE", async () => {
    const vm = await fakeDesktopVm({ xfce: false });
    const apt = join(vm.root, "apt.log");
    // nothing installed; apt fails for XFCE (e.g. no mirror for it), works for the rest
    vm.script("dpkg-query", "exit 1");
    vm.script("id", "echo 0");
    vm.script("apt-get", `echo "$*" >> ${JSON.stringify(apt)}; case "$*" in *xfce4*) exit 100;; esac; exit 0`);
    const cmd = desktopInstallCommand("display").split(DESKTOP_DIR).join(vm.dir);
    execFileSync("/bin/sh", ["-c", cmd], { env: { PATH: `${vm.bin}:${hostTools(vm.root, SHELL_TOOLS)}`, HOME: vm.home }, encoding: "utf8", timeout: 20_000 });
    const lines = readFileSync(apt, "utf8").trim().split("\n");
    expect(lines[0]).toBe("update -qq");
    expect(lines[1]).toMatch(/^install -y -qq --no-install-recommends .*xvfb.*xfce4 .*dbus-x11.*at-spi2-core/);
    expect(lines[2]).toMatch(/^install -y -qq --no-install-recommends .*xvfb.* openbox$/);
    expect(lines[2]).not.toContain("xfce4");
    expect(readFileSync(join(vm.dir, "install.log"), "utf8")).toContain("XFCE could not be installed: openbox instead");
  });
});

// ── "Chrome di <agent>" ───────────────────────────────────────────────────

describe("the agent's Chrome launcher", () => {
  function fakeChromeVm() {
    const root = tmp();
    const home = join(root, "home");
    const bin = join(root, "bin");
    mkdirSync(home); mkdirSync(bin);
    const log = join(root, "calls.log");
    const script = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
    writeFileSync(join(root, "fake-chrome.js"), `
      const fs = require("fs");
      const port = Number((process.argv.find((a) => a.startsWith("--remote-debugging-port=")) || "").split("=")[1]);
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ chrome: process.argv.slice(2), pid: process.pid, TZ: process.env.TZ, DISPLAY: process.env.DISPLAY || null }) + "\\n");
      require("http").createServer((q, r) => { r.writeHead(q.url === "/json/version" ? 200 : 404); r.end("{}"); }).listen(port, "127.0.0.1");
    `);
    script("google-chrome", `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, "fake-chrome.js"))} "$@"`);
    script("agent-browser", `echo '{"agentBrowser":"'"$*"'"}' >> ${JSON.stringify(log)}`);
    script("xdotool", `echo '{"xdotool":"'"$*"'"}' >> ${JSON.stringify(log)}`);
    script("gio", "exit 0");
    script("pgrep", "exit 1");
    script("id", "echo 0");
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home };
    const launch: AgentChromeLaunch & { label: string } = {
      profileName: "nina", session: "nina", windowSize: [1600, 900], ...agentChromeLocale(), display: ":99", proxy: "socks5://127.0.0.1:1081",
      chromePath: join(bin, "google-chrome"), label: "Nina Rossi",
    };
    const sh = (cmd: string) => execFileSync("/bin/sh", ["-c", cmd], { env, encoding: "utf8", timeout: 30_000 });
    const launches = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []).filter((c) => c.chrome);
    const chromePid = () => { const pid = Number(readFileSync(join(home, ".polpo/browser-chrome/nina.pid"), "utf8")); pids.push(pid); return pid; };
    return { home, launch, sh, launches, chromePid };
  }

  it("on the desktop and in the menu: its name, the launch script, executable; written only when it changed", () => {
    const vm = fakeChromeVm();
    vm.sh(agentChromeLauncherCommand(vm.launch));
    const file = agentChromeLauncherFile("nina");
    const desktop = join(vm.home, "Desktop", file);
    const menu = join(vm.home, ".local/share/applications", file);
    const entry = readFileSync(desktop, "utf8");
    expect(entry).toBe(readFileSync(menu, "utf8"));
    expect(entry).toContain("[Desktop Entry]\nVersion=1.0\nType=Application\nName=Chrome di Nina Rossi\n");
    expect(entry).toContain(`Exec=/bin/sh "${vm.home}/.polpo/browser-chrome/nina.launch.sh"`);
    expect(entry).toContain("Icon=google-chrome");
    expect(statSync(desktop).mode & 0o111).not.toBe(0);
    const launchSh = join(vm.home, ".polpo/browser-chrome/nina.launch.sh");
    expect(readFileSync(launchSh, "utf8").trim()).toBe(agentChromeLaunchScript(vm.launch));
    // never a plain google-chrome: the ensure script with the agent's profile, proxy, language, port
    expect(readFileSync(launchSh, "utf8")).toContain(agentChromeEnsureScript(vm.launch));
    const mtime = statSync(desktop).mtimeMs;
    vm.sh(agentChromeLauncherCommand(vm.launch));
    expect(statSync(desktop).mtimeMs).toBe(mtime);
    expect(agentChromeLauncherName("Ni\nna\\")).toBe("Chrome di Ni na");
    expect(agentChromeLauncherName("")).toBe("Chrome di agente");
  });

  it("a person reopens the same clean Chrome; the browser tools then reuse it; closed, it comes back", async () => {
    const vm = fakeChromeVm();
    vm.sh(agentChromeLauncherCommand(vm.launch));
    // the person clicks the launcher
    vm.sh(`/bin/sh "$HOME/.polpo/browser-chrome/nina.launch.sh"`);
    const pid = vm.chromePid();
    const [first] = vm.launches();
    expect(first.chrome).toEqual(expect.arrayContaining([
      `--user-data-dir=${vm.home}/.polpo/browser-profiles/nina`, "--remote-debugging-address=127.0.0.1", "--proxy-server=socks5://127.0.0.1:1081",
      "--lang=it-IT", "--window-size=1600,900",
    ]));
    expect(first).toMatchObject({ TZ: "Europe/Rome", DISPLAY: ":99" });
    // the browser tools' ensure: the same Chrome (same settings), not a second one
    vm.sh(agentChromeEnsureScript(vm.launch));
    expect(vm.launches()).toHaveLength(1);
    // clicked again while it runs: brought to the front, not launched again
    vm.sh(`/bin/sh "$HOME/.polpo/browser-chrome/nina.launch.sh"`);
    expect(vm.launches()).toHaveLength(1);
    // the person closed it: the next browser call (or click) launches it again
    process.kill(pid, "SIGKILL");
    expect(await waitDead(pid)).toBe(true);
    vm.sh(agentChromeEnsureScript(vm.launch));
    expect(vm.launches()).toHaveLength(2);
    vm.chromePid();
  });
});
