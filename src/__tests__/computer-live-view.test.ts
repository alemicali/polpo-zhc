/**
 * A computer's live view and take control: the headed browser command in the VM, CDP_URL in the
 * agent's commands (never launching a browser), the desktop's start commands (idempotent, the
 * password through the environment only, kept in the vault, re-attached after a restart), the
 * control state machine (take control, give back with a note, conflicts, timeouts), the waiting
 * tool (release note, timeout, abort), the browser waiting while a person holds the computer, the
 * server's takeover service (events, nothing restarting, the live view started for a request,
 * notifications), the task-run wire, no password in REST or MCP answers, and the authorization of
 * every new WebSocket and of Browser Live's. Fakes only: no VM, no browser, no VNC server
 * (the RFB proxy itself: computer-live-rfb.test.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { Shell, ShellOptions, ShellResult } from "@polpo-ai/core/shell";
import type { AgentConfig, ComputerConfig } from "@polpo-ai/core";
import {
  agentBrowserEnv, browserPromptNote, cdpHttpUrl, createBrowserTools, sandboxBrowserCommand, sandboxCdpUrlCommand,
  AGENT_BROWSER_CHECK_COMMAND,
} from "../tools/browser-tools.js";
import { createSystemTools } from "../tools/system-tools.js";
import {
  ComputerDesktops, DESKTOP_DISPLAY_COMMAND, DESKTOP_INSPECT_COMMAND, DESKTOP_PASSWORD_ENV, DESKTOP_STOP_COMMAND, DESKTOP_VAULT_OWNER,
  DESKTOP_VNC_OPTIONS, desktopInstallCommand, desktopUnsupported, desktopViewCommand, parseDesktopInspect, vncPassword,
} from "../sandbox/desktop.js";
import { ComputerControlError, ComputerControlStore, waitForAgentControl } from "../sandbox/computer-control.js";
import { COMPUTER_TAKEOVER_TOOL, createComputerTakeoverTools, waitForTakeover, wantsComputerTakeoverTool } from "../tools/computer-takeover-tools.js";
import { ComputerTakeoverService, handleTakeoverWire } from "../core/computer-takeover.js";
import { attachComputerDesktopWebSocket } from "../server/computer-desktop-ws.js";
import { attachBrowserDashboardWebSocket } from "../server/routes/browser-dashboard.js";
import { isTerminalRequestAuthorized } from "../server/terminal.js";
import { computerRoutes, type ComputerRouteDeps } from "../server/routes/computers.js";
import { handleMcpRequest, type McpDeps } from "../server/mcp.js";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined)))));
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "polpo-live-")); dirs.push(d); return d; };

const NINA: ComputerConfig = { id: "nina", name: "Nina", kind: "daytona" };

/** A vault in memory (get/set/remove: what the live view uses). */
function fakeVault() {
  const m = new Map<string, { type: string; credentials: Record<string, string> }>();
  return {
    get: async (owner: string, key: string) => m.get(`${owner}/${key}`) as never,
    set: async (owner: string, key: string, entry: { type: string; credentials: Record<string, string> }) => { m.set(`${owner}/${key}`, entry); },
    remove: async (owner: string, key: string) => m.delete(`${owner}/${key}`),
  } as unknown as import("@polpo-ai/core").VaultStore & { get(o: string, k: string): Promise<{ credentials: Record<string, string> } | undefined> };
}
const AGENT: AgentConfig = { name: "sitoinchat", allowedTools: ["browser_*"], defaultComputer: "nina", browserHeaded: true };

/** A VM shell: records commands and environments, answers like agent-browser. */
class FakeVmShell implements Shell {
  calls: Array<{ command: string; env?: Record<string, string> }> = [];
  constructor(private answer: (command: string) => Partial<ShellResult> = () => ({})) {}
  async isRemote() { return true; }
  async execute(command: string, opts: ShellOptions = {}): Promise<ShellResult> {
    this.calls.push({ command, ...(opts.env ? { env: opts.env } : {}) });
    if (command === AGENT_BROWSER_CHECK_COMMAND) return { stdout: "/usr/bin/agent-browser", stderr: "", exitCode: 0 };
    return { stdout: JSON.stringify({ success: true, data: {} }), stderr: "", exitCode: 0, ...this.answer(command) };
  }
}

describe("headed browser in the VM", () => {
  it("headed: the display first, the agent's Chrome on it; headless: --headless=new; same profile and egress proxy", () => {
    const headless = sandboxBrowserCommand(["open", "https://x.test"], { session: "a", profileName: "a", proxy: "socks5://127.0.0.1:1081" });
    expect(headless).toContain("'--headless=new'");
    expect(headless).not.toContain("DISPLAY");
    const headed = sandboxBrowserCommand(["open", "https://x.test"], { session: "a", profileName: "a", proxy: "socks5://127.0.0.1:1081", headed: true });
    expect(headed.startsWith(`(${DESKTOP_DISPLAY_COMMAND}) >/dev/null 2>&1; P=$(`)).toBe(true);
    expect(headed).toContain("DISPLAY=':99' $S nohup");
    expect(headed).not.toContain("--headless");
    for (const c of [headed, headless]) {
      expect(c).toContain(`N='a'; PROF="$HOME"/.polpo/browser-profiles/"$N"`);
      expect(c).toContain("'--proxy-server=socks5://127.0.0.1:1081' '--proxy-bypass-list=<-loopback>'");
      expect(c).toContain("'--window-size=1280,800'");
      expect(c.endsWith(`agent-browser --session 'a' --cdp "$P" 'open' 'https://x.test' --json`)).toBe(true);
      expect(c).not.toMatch(/--headed|--profile |--executable-path/);
    }
  });

  it("a headed agent's browser tools install the display once and run headed", async () => {
    const shell = new FakeVmShell();
    const tools = createBrowserTools("/vm/work", "sitoinchat", ["browser_navigate"], "/h/.polpo/browser-profiles/sitoinchat", "/vm/out", undefined, undefined, { shell, headed: true });
    const nav = tools.find((t) => t.name === "browser_navigate")!;
    await nav.execute("1", { url: "https://example.com" });
    await nav.execute("2", { url: "https://example.com/2" });
    const cmds = shell.calls.map((c) => c.command);
    expect(cmds.filter((c) => c === desktopInstallCommand("display"))).toHaveLength(1);
    expect(cmds.filter((c) => c.includes("DISPLAY=':99' $S nohup") && c.includes(`--cdp "$P"`))).toHaveLength(2);
  });
});

describe("CDP_URL", () => {
  it("converts agent-browser's websocket into the HTTP endpoint", () => {
    expect(cdpHttpUrl("ws://127.0.0.1:41911/devtools/browser/648058a4")).toBe("http://127.0.0.1:41911");
    expect(cdpHttpUrl("wss://h.test:9222/devtools/browser/x")).toBe("https://h.test:9222");
    expect(cdpHttpUrl("not a url")).toBeUndefined();
    expect(cdpHttpUrl(undefined)).toBeUndefined();
  });

  it("only asks for the CDP URL of a session that exists (never launches a browser)", () => {
    const cmd = sandboxCdpUrlCommand("sito'inchat");
    expect(cmd).toMatch(/^if agent-browser session list --json .*grep -qF .*; then agent-browser --session 'sito'\\''inchat' get cdp-url --json/);
  });

  it("remote: CDP_URL, DISPLAY and the session in the environment; no session, no CDP_URL", async () => {
    // the agent's own Chrome: its DevTools port while it runs (recorded by Polpo when it launched it)
    const live = new FakeVmShell((c) => (c.includes(".polpo/browser-chrome/'sitoinchat'") ? { stdout: "45555\n" } : {}));
    expect(await agentBrowserEnv({ session: "sitoinchat", shell: live, headed: true, remote: true }))
      .toEqual({ POLPO_BROWSER_SESSION: "sitoinchat", CDP_URL: "http://127.0.0.1:45555", DISPLAY: ":99" });
    const none = new FakeVmShell(() => ({ stdout: "" }));
    // headed by default on a remote computer: DISPLAY even before the browser runs; false: none
    expect(await agentBrowserEnv({ session: "sitoinchat", shell: none, remote: true })).toEqual({ POLPO_BROWSER_SESSION: "sitoinchat", DISPLAY: ":99" });
    expect(await agentBrowserEnv({ session: "sitoinchat", shell: none, headed: false, remote: true })).toEqual({ POLPO_BROWSER_SESSION: "sitoinchat" });
  });

  it("bash gets the browser's environment per command; env_from_vault wins; a failure never stops the command", async () => {
    const shell = new FakeVmShell();
    let calls = 0;
    const commandEnv = async () => { calls++; if (calls === 2) throw new Error("boom"); return { CDP_URL: "http://127.0.0.1:1", POLPO_BROWSER_SESSION: "a" }; };
    const bash = createSystemTools("/vm/work", ["bash"], undefined, undefined, undefined, undefined, shell, { commandEnv }).find((t) => t.name === "bash")!;
    await bash.execute("1", { command: "python3 cdp.py" });
    expect(shell.calls.at(-1)!.env).toEqual({ CDP_URL: "http://127.0.0.1:1", POLPO_BROWSER_SESSION: "a" });
    const r = await bash.execute("2", { command: "echo hi" });
    expect((r.details as { exitCode: number }).exitCode).toBe(0);
    expect(shell.calls.at(-1)!.env).toBeUndefined();
  });

  it("the prompt tells the agent CDP_URL is its own browser, and about take control", () => {
    const note = browserPromptNote({ headed: true, computer: { id: "nina", name: "Nina" }, takeover: true });
    expect(note).toContain("CDP_URL");
    expect(note).toContain("YOUR browser");
    expect(note).toContain("request_computer_takeover");
    expect(browserPromptNote({})).not.toContain("request_computer_takeover");
  });
});

describe("the desktop in the VM", () => {
  it("commands are idempotent (alive checks) and the one password travels in the environment only", () => {
    expect(DESKTOP_DISPLAY_COMMAND).toContain("alive \"$D/xvfb.pid\"");
    expect(DESKTOP_DISPLAY_COMMAND).toContain("-nolisten tcp");
    const keep = desktopViewCommand({ restart: false });
    expect(keep).toContain(`if [ "0" = 1 ] || ! alive "$D/vnc.pid"`);
    expect(keep).toContain("-localhost");
    expect(keep).toContain(`-passwdfile "rm:$D/vnc.pass"`);
    // one full-access password: no view-only one (the server filters viewers' input)
    expect(keep).toContain(`printf '%s\\n' "$${DESKTOP_PASSWORD_ENV}" >"$D/vnc.pass"`);
    expect(keep).not.toContain("VIEWONLY");
    expect(keep).toContain(DESKTOP_VNC_OPTIONS);
    expect(DESKTOP_VNC_OPTIONS).toContain("-cursor arrow");
    expect(DESKTOP_VNC_OPTIONS).toContain("-noncache");
    expect(keep).toContain("websockify 0.0.0.0:6080 127.0.0.1:5900");
    expect(desktopViewCommand({ restart: true })).toContain(`if [ "1" = 1 ]`);
    expect(keep).toContain(`"$${DESKTOP_PASSWORD_ENV}"`);
    expect(desktopInstallCommand("view")).toContain("command -v x11vnc >/dev/null 2>&1 || need=\"$need x11vnc\"");
    expect(desktopInstallCommand("view")).toContain("[ -z \"$need\" ] && exit 0");
    expect(desktopInstallCommand("display")).not.toContain("x11vnc");
    expect(DESKTOP_STOP_COMMAND).not.toContain("xvfb");
    expect(parseDesktopInspect("display=1\nwm=0\nvnc=1\nws=1\ninstalled=1\n")).toEqual({ display: true, wm: false, vnc: true, ws: true, installed: true });
    expect(vncPassword()).toMatch(/^[A-Za-z2-9]{8}$/);
  });

  /** A computer manager whose machine runs (VM `remoteId`) and records what it is asked. */
  const fakeManager = (o: { running?: boolean; remoteId?: string; vnc?: boolean } = {}) => {
    const execs: Array<{ command: string; env?: Record<string, string> }> = [];
    const vm = { remoteId: o.remoteId ?? "vm-1", vnc: o.vnc ?? true, running: o.running ?? true };
    const driver = {
      get remoteId() { return vm.remoteId; },
      exec: async (command: string, x: { env?: Record<string, string> } = {}) => {
        execs.push({ command, ...(x.env ? { env: x.env } : {}) });
        const up = vm.vnc ? 1 : 0;
        return { exitCode: 0, stdout: command === DESKTOP_INSPECT_COMMAND ? `display=1\nwm=1\nvnc=${up}\nws=${up}\ninstalled=1\n` : "", stderr: "", timedOut: false };
      },
      portEndpoint: async (port: number) => ({ url: `wss://${port}-vm-1.preview.test/signed`, headers: { "X-Daytona-Skip-Preview-Warning": "true" } }),
    };
    const manager = {
      attach: async () => driver,
      whenRunning: async <T>(_c: ComputerConfig, fn: (d: typeof driver) => Promise<T>) => (vm.running ? fn(driver) : undefined),
      hold: () => () => {},
    };
    return { execs, vm, manager: manager as never };
  };

  it("start installs what is missing, starts the display and VNC with one password kept in the vault; nothing restarts after", async () => {
    const { execs, manager } = fakeManager();
    const vault = fakeVault();
    const d = new ComputerDesktops({ manager: () => manager, sandboxFor: () => ({ provider: "daytona" } as never), vault: () => vault });
    await d.start(NINA);
    expect(execs.map((e) => e.command)).toEqual([desktopInstallCommand("view"), DESKTOP_DISPLAY_COMMAND, desktopViewCommand({ restart: true })]);
    const first = execs[2]!.env!;
    expect(Object.keys(first)).toEqual([DESKTOP_PASSWORD_ENV]);
    expect(first[DESKTOP_PASSWORD_ENV]).toMatch(/^.{8}$/);
    // the password is never on a command line; it is in the vault, under the reserved owner
    expect(execs.some((e) => e.command.includes(first[DESKTOP_PASSWORD_ENV]!))).toBe(false);
    expect((await vault.get(DESKTOP_VAULT_OWNER, "nina"))?.credentials).toMatchObject({ password: first[DESKTOP_PASSWORD_ENV], remoteId: "vm-1" });
    await d.start(NINA);
    expect(execs[5]!.command).toBe(desktopViewCommand({ restart: false }));
    expect(execs[5]!.env).toEqual(first);
    expect(d.password("nina")).toBe(first[DESKTOP_PASSWORD_ENV]);
    expect((await d.status(NINA)).state).toBe("running");
    await d.stop(NINA);
    expect(execs.at(-2)!.command).toBe(DESKTOP_STOP_COMMAND);
    expect(d.password("nina")).toBeUndefined();
    await new Promise((r) => setTimeout(r, 5));
    expect(await vault.get(DESKTOP_VAULT_OWNER, "nina")).toBeUndefined();
  });

  it("after a restart it re-attaches to a live view still running on the same VM, without starting anything", async () => {
    const vault = fakeVault();
    const before = fakeManager();
    await new ComputerDesktops({ manager: () => before.manager, sandboxFor: () => ({ provider: "daytona" } as never), vault: () => vault }).start(NINA);
    const password = before.execs[2]!.env![DESKTOP_PASSWORD_ENV];
    // a new server process: nothing in memory
    const after = fakeManager();
    const d = new ComputerDesktops({ manager: () => after.manager, sandboxFor: () => ({ provider: "daytona" } as never), vault: () => vault });
    expect(d.password("nina")).toBeUndefined();
    expect(await d.attached(NINA)).toBe(true);
    expect(d.password("nina")).toBe(password);
    expect((await d.status(NINA)).state).toBe("running");
    expect(after.execs.map((e) => e.command)).toEqual([DESKTOP_INSPECT_COMMAND, DESKTOP_INSPECT_COMMAND]);
    // a start keeps x11vnc and its password
    await d.start(NINA);
    expect(after.execs.at(-1)).toEqual({ command: desktopViewCommand({ restart: false }), env: { [DESKTOP_PASSWORD_ENV]: password } });
  });

  it("a machine that is off is never started to re-attach; another VM or a refused password gets a new one", async () => {
    const vault = fakeVault();
    const first = fakeManager();
    await new ComputerDesktops({ manager: () => first.manager, sandboxFor: () => ({ provider: "daytona" } as never), vault: () => vault }).start(NINA);
    const off = fakeManager({ running: false });
    const d = new ComputerDesktops({ manager: () => off.manager, sandboxFor: () => ({ provider: "daytona" } as never), vault: () => vault });
    expect(await d.attached(NINA)).toBe(false);
    expect(off.execs).toEqual([]);
    // a new VM: its VNC server (if any) never had this password
    const other = fakeManager({ remoteId: "vm-2" });
    const d2 = new ComputerDesktops({ manager: () => other.manager, sandboxFor: () => ({ provider: "daytona" } as never), vault: () => vault });
    const s = await d2.status(NINA);
    expect(s).toMatchObject({ state: "stopped", note: expect.stringMatching(/does not know/) });
    await d2.start(NINA);
    expect(other.execs.at(-1)!.command).toBe(desktopViewCommand({ restart: true }));
    expect((await vault.get(DESKTOP_VAULT_OWNER, "nina"))?.credentials.remoteId).toBe("vm-2");
    // the VNC server refused it (rfb-proxy): forgotten, the next start restarts it with a new one
    const old = d2.password("nina");
    d2.invalidate("nina");
    await d2.start(NINA);
    expect(other.execs.at(-1)!.command).toBe(desktopViewCommand({ restart: true }));
    expect(d2.password("nina")).not.toBe(old);
  });

  it("status never starts a machine that is off; host and E2B computers have no live view", async () => {
    const { execs, manager } = fakeManager({ running: false });
    const d = new ComputerDesktops({ manager: () => manager, sandboxFor: () => ({ provider: "daytona" } as never) });
    expect((await d.status(NINA)).state).toBe("machine-off");
    expect(execs).toEqual([]);
    expect(desktopUnsupported({ id: "h", name: "H", kind: "host" })).toMatch(/Browser Live/);
    expect(desktopUnsupported({ id: "e", name: "E", kind: "e2b" })).toMatch(/Daytona v2/);
    await expect(d.start({ id: "e", name: "E", kind: "e2b" })).rejects.toThrow(/Daytona v2/);
  });
});

describe("control state", () => {
  it("request → take control → give back with a note", async () => {
    let now = Date.parse("2026-11-26T10:00:00Z");
    const store = new ComputerControlStore(tmp(), () => now);
    const r = await store.open({ computerId: "nina", agent: "sitoinchat", reason: "LinkedIn asks for 2FA", url: "https://linkedin.com/login", whatToDo: "Sign in", taskId: "t1" });
    expect(r).toMatchObject({ status: "pending", expiresAt: "2026-11-26T10:30:00.000Z" });
    expect(store.get("nina")).toMatchObject({ holder: "agent", open: [{ id: r.id }] });
    const t = await store.takeover("nina", "ale@x.it");
    expect(t.requests.map((x) => x.id)).toEqual([r.id]);
    expect(store.heldByPerson("nina")?.person).toBe("ale@x.it");
    expect(store.request(r.id)).toMatchObject({ status: "in_control", takenBy: "ale@x.it" });
    // another person cannot give it back or take it without force
    await expect(store.release("nina", "bob@x.it")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(store.takeover("nina", "bob@x.it")).rejects.toBeInstanceOf(ComputerControlError);
    now += 60_000;
    const rel = await store.release("nina", "ale@x.it", "Signed in, you are on the feed");
    expect(rel.requests[0]).toMatchObject({ id: r.id, status: "released", note: "Signed in, you are on the feed", takenBy: "ale@x.it" });
    expect(store.get("nina")).toMatchObject({ holder: "agent", lastNote: "Signed in, you are on the feed", open: [] });
    await expect(store.release("nina", "ale@x.it")).rejects.toMatchObject({ code: "NOT_HELD" });
    // force: taking it from someone who walked away
    await store.takeover("nina", "bob@x.it");
    await store.takeover("nina", "ale@x.it", { force: true });
    expect(store.heldByPerson("nina")?.person).toBe("ale@x.it");
  });

  it("a request made while a person holds it is theirs at once; requests expire; closing is idempotent", async () => {
    let now = Date.parse("2026-11-26T10:00:00Z");
    const store = new ComputerControlStore(tmp(), () => now);
    await store.takeover("nina", "ale@x.it");
    const r = await store.open({ computerId: "nina", agent: "a", reason: "CAPTCHA", timeoutMinutes: 5 });
    expect(r).toMatchObject({ status: "in_control", takenBy: "ale@x.it" });
    const r2 = await store.open({ computerId: "other", agent: "a", reason: "x", timeoutMinutes: 1 });
    now += 2 * 60_000;
    expect(store.request(r2.id)?.status).toBe("timeout");
    expect((await store.close(r2.id, "cancelled"))?.status).toBe("timeout");
    await expect(store.open({ computerId: "nina", agent: "a", reason: "  " })).rejects.toMatchObject({ code: "INVALID" });
  });
});

describe("request_computer_takeover", () => {
  const agentOn = (o: Partial<AgentConfig> = {}): AgentConfig => ({ ...AGENT, ...o });

  it("is offered on a remote computer with a headed browser, or when allowed", () => {
    expect(wantsComputerTakeoverTool(agentOn(), NINA)).toBe(true);
    expect(wantsComputerTakeoverTool(agentOn({ browserHeaded: false }), NINA)).toBe(false);
    expect(wantsComputerTakeoverTool(agentOn({ browserHeaded: false, allowedTools: ["request_computer_takeover"] }), NINA)).toBe(true);
    expect(wantsComputerTakeoverTool(agentOn(), { id: "host", name: "This server", kind: "host" })).toBe(false);
    expect(wantsComputerTakeoverTool(agentOn(), undefined)).toBe(false);
  });

  it("waits for the person to give control back and returns their note (never what they typed)", async () => {
    const store = new ComputerControlStore(tmp());
    const access = {
      request: (ask: { reason: string; url?: string; whatToDo?: string }) => store.open({ computerId: "nina", agent: AGENT.name, ...ask }),
      get: (id: string) => store.request(id),
      close: (id: string, s: "timeout" | "cancelled") => store.close(id, s),
    };
    const [tool] = createComputerTakeoverTools(AGENT, NINA, access, { pollMs: 5 });
    expect(tool!.name).toBe(COMPUTER_TAKEOVER_TOOL);
    const run = tool!.execute("1", { reason: "Sign in to LinkedIn (2FA)", url: "https://linkedin.com" });
    await new Promise((r) => setTimeout(r, 20));
    await store.takeover("nina", "ale@x.it");
    await new Promise((r) => setTimeout(r, 20));
    await store.release("nina", "ale@x.it", "Done, you are signed in");
    const res = await run;
    expect(res.content[0].text).toContain("Done, you are signed in");
    expect(res.details).toMatchObject({ outcome: "released", by: "ale@x.it", note: "Done, you are signed in", computerId: "nina" });
  });

  it("times out (the request is closed) and stops with the run", async () => {
    let now = 0;
    const closed: string[] = [];
    const base = { id: "tko_1", computerId: "nina", agent: "a", reason: "x", createdAt: new Date(0).toISOString(), expiresAt: new Date(60_000).toISOString(), status: "pending" as const };
    const access = { get: () => base, close: async (_id: string, s: string) => { closed.push(s); } };
    const t = await waitForTakeover(access, base, { pollMs: 1, now: () => (now += 30_000) });
    expect(t.outcome).toBe("timeout");
    const ac = new AbortController();
    const p = waitForTakeover(access, base, { pollMs: 5, signal: ac.signal, now: () => 0 });
    ac.abort();
    expect((await p).outcome).toBe("aborted");
    expect(closed).toEqual(["timeout", "cancelled"]);
  });
});

describe("the agent's browser waits while a person holds the computer", () => {
  it("polls until given back; gives up after the wait; stops with the run", async () => {
    let held: { computerId: string; holder: "person"; person: string } | undefined = { computerId: "nina", holder: "person", person: "ale" };
    const store = { heldByPerson: () => held };
    const waited = waitForAgentControl(store, "nina", { pollMs: 5 });
    setTimeout(() => { held = undefined; }, 20);
    expect(await waited).toBeUndefined();
    held = { computerId: "nina", holder: "person", person: "ale" };
    expect(await waitForAgentControl(store, "nina", { pollMs: 1, maxWaitMs: 5 })).toMatch(/ale has control of computer "nina"/);
    const ac = new AbortController();
    ac.abort();
    expect(await waitForAgentControl(store, "nina", { signal: ac.signal })).toMatch(/Stopped/);
  });

  it("browser tools do not act while a person holds it", async () => {
    const shell = new FakeVmShell();
    const store = { heldByPerson: () => ({ computerId: "nina", holder: "person" as const, person: "ale", since: "x" }) };
    const tools = createBrowserTools("/vm/work", "a", ["browser_navigate"], undefined, "/vm/out", undefined, undefined, { shell, control: { computerId: "nina", store, pollMs: 1, maxWaitMs: 5 } });
    const r = await tools.find((t) => t.name === "browser_navigate")!.execute("1", { url: "https://example.com" });
    expect(String(r.content[0].text)).toMatch(/ale has control/);
    expect(shell.calls).toEqual([]);
  });
});

describe("the server's takeover service", () => {
  it("announces, starts the live view for a request, notifies the person; take control and give back restart nothing", async () => {
    const events: Array<Record<string, unknown>> = [];
    const started: string[] = [];
    const sent: Array<{ channel: string; title: string }> = [];
    const service = new ComputerTakeoverService({
      polpoDir: tmp(), computers: () => [NINA, { id: "h", name: "H", kind: "host" }],
      emit: (e) => events.push(e as never), startDesktop: async (c) => { started.push(c.id); },
      router: () => ({ getChannelIds: () => ["slack", "tg"], getRules: () => [], sendDirect: async (o) => { sent.push(o); } }),
    });
    const r = await service.request(AGENT, "nina", { reason: "2FA" }, { sessionId: "s1" });
    await service.desktopStarting;
    await new Promise((x) => setTimeout(x, 5));
    expect(started).toEqual(["nina"]);
    expect(sent.map((s) => s.channel)).toEqual(["slack", "tg"]);
    expect(sent[0]!.title).toBe("sitoinchat needs you on computer Nina");
    await service.takeover("nina", "ale@x.it");
    await service.release("nina", "ale@x.it", "ok");
    expect(events.map((e) => e.action)).toEqual(["requested", "desktop-started", "taken", "released"]);
    expect(events[3]).toMatchObject({ holder: "agent", requestId: r.id, note: "ok", person: "ale@x.it" });
    expect(started).toEqual(["nina"]);
    // only a remote computer, only an agent that uses it
    await expect(service.takeover("h", "x")).rejects.toMatchObject({ code: "INVALID" });
    await expect(service.request({ name: "other" }, "nina", { reason: "x" })).rejects.toMatchObject({ code: "INVALID" });
  });

  it("a live view that cannot start never fails the agent's request (the agent still waits for the person)", async () => {
    const logs: string[] = [];
    const events: string[] = [];
    const service = new ComputerTakeoverService({
      polpoDir: tmp(), computers: () => [NINA], emit: (e) => events.push((e as { action: string }).action),
      startDesktop: async () => { throw new Error("no ports"); }, log: (_l, m) => logs.push(m),
    });
    const r = await service.request(AGENT, "nina", { reason: "CAPTCHA" });
    await service.desktopStarting;
    expect(r.status).toBe("pending");
    expect(events).toEqual(["requested"]);
    expect(logs.join("\n")).toMatch(/could not be started.*no ports/);
  });

  it("the instance's rules on computer:takeover notify instead of the fallback", async () => {
    const sent: string[] = [];
    const service = new ComputerTakeoverService({
      polpoDir: tmp(), computers: () => [NINA], emit: () => {},
      router: () => ({ getChannelIds: () => ["slack"], getRules: () => [{ events: ["computer:*"] }], sendDirect: async (o) => { sent.push(o.channel); } }),
    });
    await service.request(AGENT, "nina", { reason: "x" });
    await new Promise((x) => setTimeout(x, 5));
    expect(sent).toEqual([]);
  });

  it("task runs: as the run's agent, only while it runs, closing only its own requests", async () => {
    const service = new ComputerTakeoverService({ polpoDir: tmp(), computers: () => [NINA], emit: () => {} });
    const deps = {
      service,
      run: async (id: string) => (id === "run-1" ? { agentName: AGENT.name, taskId: "t1", status: "running" as const } : id === "run-2" ? { agentName: AGENT.name, taskId: "t1", status: "done" as const } : undefined) as never,
      task: async () => undefined,
      agentFor: async () => AGENT,
    };
    expect(await handleTakeoverWire({ type: "computer_takeover", op: "request", runId: "run-2", computerId: "nina", reason: "x" }, deps)).toEqual({ ok: false, error: "this run is not running" });
    const ok = await handleTakeoverWire({ type: "computer_takeover", op: "request", runId: "run-1", computerId: "nina", reason: "2FA" }, deps);
    expect(ok).toMatchObject({ ok: true, request: { agent: AGENT.name, taskId: "t1", runId: "run-1", status: "pending" } });
    const id = (ok as { request: { id: string } }).request.id;
    expect(await handleTakeoverWire({ type: "computer_takeover", op: "close", runId: "run-3", requestId: id, status: "timeout" }, deps)).toMatchObject({ ok: false });
    expect(await handleTakeoverWire({ type: "computer_takeover", op: "close", runId: "run-1", requestId: id, status: "timeout" }, deps)).toMatchObject({ ok: true, request: { status: "timeout" } });
  });
});

describe("WebSocket authorization", () => {
  const listen = async (attach: (s: Server) => void) => {
    const server = createServer();
    servers.push(server);
    attach(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return (server.address() as { port: number }).port;
  };
  /** The HTTP status an upgrade gets (101 when it is accepted). */
  const upgrade = (port: number, path: string) => new Promise<number>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.on("unexpected-response", (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
    ws.on("open", () => { resolve(101); ws.terminate(); });
    ws.on("error", () => resolve(-1));
  });

  it("the terminal's rule: an API key or a session; open only without either", () => {
    const req = (headers: Record<string, string>) => ({ headers } as never);
    expect(isTerminalRequestAuthorized(req({}), tmp(), ["k-123"], undefined)).toBe(false);
    expect(isTerminalRequestAuthorized(req({ authorization: "Bearer k-123" }), tmp(), ["k-123"], undefined)).toBe(true);
    expect(isTerminalRequestAuthorized(req({}), tmp(), ["k-123"], "k-123")).toBe(true);
    expect(isTerminalRequestAuthorized(req({}), tmp(), [], undefined)).toBe(true);
  });

  it("the live view: 401 without login, 409 before the live view is started, proxied (the server speaks RFB first) when it is", async () => {
    // the VM side: an echo server standing for websockify
    const upstream = createServer();
    servers.push(upstream);
    const { WebSocketServer } = await import("ws");
    const echo = new WebSocketServer({ server: upstream });
    echo.on("connection", (s) => s.on("message", (m) => s.send(m)));
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const upstreamPort = (upstream.address() as { port: number }).port;
    let started = false;
    const holds: string[] = [];
    const desktops = {
      attached: async () => started,
      password: () => (started ? "pw" : undefined),
      endpoint: async () => ({ url: `ws://127.0.0.1:${upstreamPort}/`, headers: {} }),
      hold: () => { holds.push("hold"); return () => holds.push("release"); },
    } as unknown as ComputerDesktops;
    const port = await listen((s) => attachComputerDesktopWebSocket(s, {
      authorize: (req, q) => q.api_key === "secret" || req.headers.authorization === "Bearer secret",
      ready: () => true, computer: (id) => (id === "nina" ? NINA : undefined), desktops: () => desktops,
    }));
    expect(await upgrade(port, "/api/v1/computers/nina/desktop/vnc")).toBe(401);
    expect(await upgrade(port, "/api/v1/computers/ghost/desktop/vnc?api_key=secret")).toBe(404);
    expect(await upgrade(port, "/api/v1/computers/nina/desktop/vnc?api_key=secret")).toBe(409);
    started = true;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/computers/nina/desktop/vnc?api_key=secret`);
    const got = await new Promise<string>((resolve, reject) => {
      ws.on("message", (m) => resolve(m.toString()));
      ws.on("error", reject);
    });
    expect(got).toBe("RFB 003.008\n");
    ws.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(holds).toEqual(["hold", "release"]);
    echo.close();
  });

  it("Browser Live's WebSockets (VNC, dashboard, CDP) need a login too", async () => {
    const port = await listen((s) => attachBrowserDashboardWebSocket(s, { authorize: () => false }));
    expect(await upgrade(port, "/api/v1/browser-dashboard/vnc")).toBe(401);
    expect(await upgrade(port, "/api/v1/browser-dashboard/cdp/9222/devtools/browser/x")).toBe(401);
    expect(await upgrade(port, "/api/v1/browser-dashboard/view/")).toBe(401);
  });
});

it("no secret in a takeover event or a desktop status", async () => {
  const events: unknown[] = [];
  const service = new ComputerTakeoverService({ polpoDir: tmp(), computers: () => [NINA], emit: (e) => events.push(e) });
  await service.request(AGENT, "nina", { reason: "x" });
  await service.takeover("nina", undefined);
  expect(JSON.stringify(events)).not.toMatch(/password/i);
});

it("no VNC password in any REST or MCP answer about the live view", async () => {
  const PASSWORD = "Zq7pW3xK";
  const desktops = {
    status: async () => ({ computerId: "nina", state: "running", display: ":99", startedAt: "2026-11-27T10:00:00Z" }),
    start: async () => ({ computerId: "nina", state: "running", display: ":99", startedAt: "2026-11-27T10:00:00Z" }),
    stop: async () => ({ computerId: "nina", state: "stopped", display: ":99" }),
    password: () => PASSWORD,
  } as unknown as ComputerDesktops;
  const service = new ComputerTakeoverService({ polpoDir: tmp(), computers: () => [NINA], emit: () => {} });
  const app = computerRoutes({
    computers: () => [NINA], settings: () => undefined, agents: async () => [AGENT], manager: () => ({}) as never,
    save: async () => {}, sandboxFor: () => ({ error: "x" }), emit: () => {}, emitTakeover: () => {},
    desktops: () => desktops, takeover: () => service, member: () => "ale@x.it",
  } as ComputerRouteDeps);
  const answers: string[] = [];
  const rest = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    answers.push(text);
    return { status: res.status, text };
  };
  for (const [m, p] of [["GET", "/nina/desktop?viewer=1"], ["POST", "/nina/desktop/start"], ["POST", "/nina/takeover"], ["GET", "/nina/desktop?viewer=1"], ["POST", "/nina/release"], ["POST", "/nina/desktop/stop"]] as const) {
    expect((await rest(m, p, m === "POST" ? {} : undefined)).status).toBe(200);
  }
  // the viewer's role and path, never a password
  expect(JSON.parse(answers[0]!).data.viewer).toEqual({ mode: "view", path: "/api/v1/computers/nina/desktop/vnc" });
  expect(JSON.parse(answers[2]!).data.viewer).toEqual({ mode: "control", path: "/api/v1/computers/nina/desktop/vnc" });
  // MCP reads the same routes
  const api: McpDeps["api"] = async (method, path, body) => {
    const r = await rest(method, path.replace(/^\/api\/v1\/computers/, ""), body);
    return { status: r.status, body: JSON.parse(r.text), headers: new Headers() };
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const res = await handleMcpRequest(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }), { api, version: "x", toolsets: ["computers"] });
    const out = await res.text();
    answers.push(out);
    return out;
  };
  expect(await rpc("polpo_computer_desktop", { id: "nina", action: "start" })).toMatch(/Live view of nina: running/);
  await rpc("polpo_computer_desktop", { id: "nina" });
  await rpc("polpo_computer_takeover", { id: "nina" });
  await rpc("polpo_computer_release", { id: "nina", note: "done" });
  for (const a of answers) {
    expect(a).not.toContain(PASSWORD);
    expect(a).not.toMatch(/"password"/i);
  }
});
