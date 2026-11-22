/**
 * Browser tools follow the sandbox: with a remote VM's shell, agent-browser runs in the VM through
 * shell.execute (open Polpo's model); otherwise it runs here as before (child process, network
 * guard). The child process is mocked: no real browser starts.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import type { Shell, ShellOptions, ShellResult } from "@polpo-ai/core/shell";
import type { FileSystem } from "@polpo-ai/core/filesystem";

const spawned: string[][] = [];
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn((_bin: string, args: string[]) => {
    spawned.push(args);
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    setImmediate(() => {
      // "screenshot <path>": the browser writes the image where it was told
      const i = args.indexOf("screenshot");
      if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("--")) writeFileSync(args[i + 1]!, Buffer.from([1, 2, 3]));
      child.stdout.emit("data", Buffer.from(JSON.stringify({ success: true, data: { path: args[i + 1] } })));
      child.emit("close", 0);
    });
    return child;
  }),
}));

import { cleanupAgentBrowserSession, createBrowserTools, sandboxBrowserCommand, AGENT_BROWSER_CHECK_COMMAND, AGENT_BROWSER_INSTALL_COMMAND } from "../tools/browser-tools.js";
import type { BrowserNetworkGuard } from "../tools/browser-network-guard.js";

/** A remote VM's shell: records commands, answers like agent-browser would. */
class FakeVmShell implements Shell {
  commands: string[] = [];
  constructor(private installed = true, private canInstall = true, private remote = true) {}
  async isRemote() { return this.remote; }
  async execute(command: string, _opts?: ShellOptions): Promise<ShellResult> {
    this.commands.push(command);
    if (command === AGENT_BROWSER_CHECK_COMMAND) return this.installed ? { stdout: "/usr/bin/agent-browser\n", stderr: "", exitCode: 0 } : { stdout: "", stderr: "", exitCode: 1 };
    if (command === AGENT_BROWSER_INSTALL_COMMAND) {
      if (!this.canInstall) return { stdout: "", stderr: "npm: not found", exitCode: 127 };
      this.installed = true;
      return { stdout: "/usr/bin/agent-browser", stderr: "", exitCode: 0 };
    }
    return { stdout: JSON.stringify({ success: true, data: { ran: command } }), stderr: "", exitCode: 0 };
  }
}

const network = (): BrowserNetworkGuard & { checked: string[] } => {
  const checked: string[] = [];
  return { checked, checkUrl: async (url: string) => { checked.push(url); return undefined; }, proxyUrl: async () => "http://127.0.0.1:9", close: async () => {} } as any;
};
const tool = (tools: any[], name: string) => tools.find((t) => t.name === name)!;
const CWD = "/vm/work";

afterEach(() => { spawned.length = 0; });

describe("browser in a remote sandbox", () => {
  test("commands go through the VM's shell with the session and a VM-side profile", async () => {
    const shell = new FakeVmShell();
    const guard = network();
    const tools = createBrowserTools(CWD, "agent-a", ["browser_navigate", "browser_snapshot", "browser_close"], "/host/.polpo/browser-profiles/agent-a", "/vm/out", undefined, guard, { shell });
    const r = await tool(tools, "browser_navigate").execute("1", { url: "https://example.com" });
    expect(r.details).toEqual({ ran: expect.stringContaining("'open' 'https://example.com'") });
    expect(shell.commands[0]).toBe(AGENT_BROWSER_CHECK_COMMAND);
    expect(shell.commands[1]).toBe(`agent-browser --session 'agent-a' --profile "$HOME"/'.polpo/browser-profiles/agent-a' 'open' 'https://example.com' --json`);
    await tool(tools, "browser_snapshot").execute("2", { interactive_only: true });
    expect(shell.commands.at(-1)).toContain("'snapshot' '-i' --json");
    await tool(tools, "browser_close").execute("3", {});
    expect(shell.commands.at(-1)).toBe("agent-browser --session 'agent-a' 'close' --json");
    // checked once per shell; nothing ran here; the host network guard is the VM's business
    expect(shell.commands.filter((c) => c === AGENT_BROWSER_CHECK_COMMAND)).toHaveLength(1);
    expect(spawned).toEqual([]);
    expect(guard.checked).toEqual([]);
  });

  test("the URL scheme check still applies", async () => {
    const shell = new FakeVmShell();
    const tools = createBrowserTools(CWD, "a", ["browser_navigate"], undefined, "/vm/out", undefined, undefined, { shell });
    await expect(tool(tools, "browser_navigate").execute("1", { url: "file:///etc/passwd" })).rejects.toThrow();
    expect(shell.commands).toEqual([]);
  });

  test("screenshots are saved in the VM, at the checked path", async () => {
    const shell = new FakeVmShell();
    const tools = createBrowserTools(CWD, "a", ["browser_screenshot"], undefined, "/vm/out", undefined, undefined, { shell });
    await tool(tools, "browser_screenshot").execute("1", { path: "shots/home.png", full_page: true });
    expect(shell.commands.at(-1)).toBe("mkdir -p '/vm/work/shots' && agent-browser --session 'a' 'screenshot' '/vm/work/shots/home.png' '--full' --json");
    await expect(tool(tools, "browser_screenshot").execute("2", { path: "/etc/evil.png" })).rejects.toThrow();
  });

  test("arguments are quoted for the shell", () => {
    expect(sandboxBrowserCommand(["fill", "@e1", "it's $(rm -rf /)"], { session: "s" }))
      .toBe(`agent-browser --session 's' 'fill' '@e1' 'it'\\''s $(rm -rf /)' --json`);
  });

  test("agent-browser missing in the VM: installed on first use", async () => {
    const shell = new FakeVmShell(false, true);
    const tools = createBrowserTools(CWD, "a", ["browser_get"], undefined, "/vm/out", undefined, undefined, { shell });
    const r = await tool(tools, "browser_get").execute("1", { what: "title" });
    expect(shell.commands.slice(0, 2)).toEqual([AGENT_BROWSER_CHECK_COMMAND, AGENT_BROWSER_INSTALL_COMMAND]);
    expect(r.details).toEqual({ ran: expect.stringContaining("'get' 'title'") });
  });

  test("agent-browser missing and not installable: a clear error", async () => {
    const shell = new FakeVmShell(false, false);
    const tools = createBrowserTools(CWD, "a", ["browser_get"], undefined, "/vm/out", undefined, undefined, { shell });
    const r = await tool(tools, "browser_get").execute("1", { what: "title" });
    expect(r.content[0].text).toMatch(/agent-browser is not installed in the sandbox.*runner image/s);
  });

  test("cleanup closes the session in the VM", async () => {
    const shell = new FakeVmShell();
    await cleanupAgentBrowserSession("agent-a", shell);
    expect(shell.commands).toEqual(["agent-browser --session 'agent-a' 'close' --json"]);
    expect(spawned).toEqual([]);
  });
});

describe("browser on this machine", () => {
  test("a local sandbox's shell keeps the browser here, behind the network guard", async () => {
    const shell = new FakeVmShell(true, true, false);
    const guard = network();
    const tools = createBrowserTools("/tmp", "a", ["browser_navigate"], "/host/profiles/a", "/tmp/out", undefined, guard, { shell });
    await tool(tools, "browser_navigate").execute("1", { url: "https://example.com" });
    expect(shell.commands).toEqual([]);
    expect(guard.checked).toEqual(["https://example.com"]);
    expect(spawned[0]).toEqual(["--session", "a", "--profile", "/host/profiles/a", "--proxy", "http://127.0.0.1:9", "--proxy-bypass", "<-loopback>", "open", "https://example.com", "--json"]);
  });

  test("a screenshot taken here is saved through the given FileSystem", async () => {
    const saved = new Map<string, Uint8Array>();
    const fs = {
      mkdir: async () => {},
      writeFileBuffer: async (path: string, data: Uint8Array) => { saved.set(path, new Uint8Array(data)); },
    } as unknown as FileSystem;
    const tools = createBrowserTools("/vm/work", "a", ["browser_screenshot"], undefined, "/tmp/out", undefined, undefined, { fs });
    const r = await tool(tools, "browser_screenshot").execute("1", { path: "s.png" });
    expect([...saved.get("/vm/work/s.png")!]).toEqual([1, 2, 3]);
    expect(r.details).toEqual({ path: "/vm/work/s.png" });
    expect(spawned[0]![1]).not.toBe("/vm/work/s.png");
  });
});

describe("browser_fill from the vault", () => {
  const SECRET = "s3cret-Passw0rd!";
  const vault = { get: (s: string) => (s === "github" ? { user: "ada", password: SECRET } : undefined), has: (s: string) => s === "github", list: () => [{ service: "github", type: "login", keys: ["user", "password"] }] } as any;

  test("on the host the value goes to the process, never back to the model", async () => {
    const tools = createBrowserTools(CWD, "ada", ["browser_fill"], "/polpo/browser-profiles/ada", "/tmp/out", undefined, undefined, { vault });
    const result = await tool(tools, "browser_fill").execute("1", { selector: "@e3", from_vault: "github.password" });
    const args = spawned.at(-1)!;
    expect(args.slice(args.indexOf("fill"), args.indexOf("fill") + 3)).toEqual(["fill", "@e3", SECRET]);
    const text = JSON.stringify(result);
    expect(text).not.toContain(SECRET);
    expect(result.content[0].text).toBe("Filled @e3 with github.password from the vault.");
  });

  test("in a sandbox the command line holds a variable, the value travels in the environment", async () => {
    const envs: Array<Record<string, string> | undefined> = [];
    const shell = new FakeVmShell();
    const execute = shell.execute.bind(shell);
    shell.execute = async (command: string, opts?: ShellOptions) => { envs.push(opts?.env); return execute(command, opts); };
    const tools = createBrowserTools(CWD, "ada", ["browser_fill"], "/polpo/browser-profiles/ada", "/tmp/out", undefined, undefined, { shell, vault });
    const result = await tool(tools, "browser_fill").execute("1", { selector: "@e3", from_vault: "github.password" });
    const fill = shell.commands.find((c) => c.includes(" 'fill' "))!;
    expect(fill).toContain(`'fill' '@e3' "$POLPO_BROWSER_SECRET"`);
    expect(shell.commands.join("\n")).not.toContain(SECRET);
    expect(envs.at(-1)).toEqual({ POLPO_BROWSER_SECRET: SECRET });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test("errors name the reference, never a value; text and from_vault are exclusive", async () => {
    const tools = createBrowserTools(CWD, "ada", ["browser_fill"], undefined, "/tmp/out", undefined, undefined, { vault });
    const fill = tool(tools, "browser_fill");
    expect((await fill.execute("1", { selector: "@e3", from_vault: "github.token" })).content[0].text).toMatch(/vault entry "github" has no key "token" \(keys: user, password\)/);
    expect((await fill.execute("1", { selector: "@e3", from_vault: "gitlab.password" })).content[0].text).toMatch(/no vault entry/);
    expect((await fill.execute("1", { selector: "@e3", text: "x", from_vault: "github.password" })).content[0].text).toMatch(/either text or from_vault/);
    expect((await fill.execute("1", { selector: "@e3" })).content[0].text).toMatch(/either text or from_vault/);
    const noVault = tool(createBrowserTools(CWD, "ada", ["browser_fill"], undefined, "/tmp/out"), "browser_fill");
    expect((await noVault.execute("1", { selector: "@e3", from_vault: "github.password" })).content[0].text).toMatch(/no vault entries are available/);
    // plain text still works
    await fill.execute("1", { selector: "@e4", text: "ada@example.com" });
    expect(spawned.at(-1)).toContain("ada@example.com");
  });
});

describe("browser egress through a residential proxy", () => {
  const net = require("node:net") as typeof import("node:net");
  const fsMod = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");

  async function listening(): Promise<{ url: string; close: () => void }> {
    const server = net.createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as import("node:net").AddressInfo).port;
    return { url: `socks5://127.0.0.1:${port}`, close: () => server.close() };
  }
  const closedPort = async () => { const p = await listening(); p.close(); await new Promise((r) => setTimeout(r, 20)); return p.url; };

  test("reachable: the browser starts behind the proxy (a running one restarts) and the profile is marked", async () => {
    const { resetEgressReachability } = await import("../tools/browser-egress.js");
    resetEgressReachability();
    const proxy = await listening();
    const profile = fsMod.mkdtempSync(path.join(os.tmpdir(), "polpo-egress-"));
    try {
      const tools = createBrowserTools(CWD, "growth-egress-1", ["browser_navigate"], profile, "/tmp/out", undefined, undefined, { egress: { name: "home", url: proxy.url } });
      await tool(tools, "browser_navigate").execute("1", { url: "https://example.com" });
      expect(spawned.some((a) => a.includes("close"))).toBe(true);
      const open = spawned.find((a) => a.includes("open"))!;
      expect(open).toEqual(expect.arrayContaining(["--proxy", proxy.url]));
      expect(fsMod.readFileSync(path.join(profile, ".polpo-egress"), "utf-8")).toBe("home");
    } finally {
      proxy.close();
      fsMod.rmSync(profile, { recursive: true, force: true });
    }
  });

  test("unreachable: direct from the server, but a profile signed in through it pauses", async () => {
    const { resetEgressReachability } = await import("../tools/browser-egress.js");
    resetEgressReachability();
    const url = await closedPort();
    const fresh = fsMod.mkdtempSync(path.join(os.tmpdir(), "polpo-egress-"));
    const signedIn = fsMod.mkdtempSync(path.join(os.tmpdir(), "polpo-egress-"));
    fsMod.writeFileSync(path.join(signedIn, ".polpo-egress"), "home");
    try {
      const direct = createBrowserTools(CWD, "growth-egress-2", ["browser_navigate"], fresh, "/tmp/out", undefined, undefined, { egress: { name: "home", url } });
      await tool(direct, "browser_navigate").execute("1", { url: "https://example.com" });
      expect(spawned.find((a) => a.includes("open"))).not.toContain("--proxy");
      spawned.length = 0;
      const paused = createBrowserTools(CWD, "growth-egress-3", ["browser_navigate"], signedIn, "/tmp/out", undefined, undefined, { egress: { name: "home", url } });
      const result = await tool(paused, "browser_navigate").execute("1", { url: "https://example.com" });
      expect(result.content[0].text).toMatch(/"home" connection is unreachable.*stays paused/s);
      expect(spawned).toHaveLength(0);
    } finally {
      fsMod.rmSync(fresh, { recursive: true, force: true });
      fsMod.rmSync(signedIn, { recursive: true, force: true });
    }
  });

  test("a sandbox network rule keeps its own proxy; a remote sandbox ignores the egress", async () => {
    const guard = network();
    const tools = createBrowserTools(CWD, "growth-egress-4", ["browser_navigate"], undefined, "/tmp/out", undefined, guard, { egress: { name: "home", url: "socks5://127.0.0.1:1" } });
    await tool(tools, "browser_navigate").execute("1", { url: "https://example.com" });
    expect(spawned.find((a) => a.includes("open"))).toEqual(expect.arrayContaining(["--proxy", "http://127.0.0.1:9"]));
    const shell = new FakeVmShell();
    const remote = createBrowserTools(CWD, "growth-egress-5", ["browser_navigate"], undefined, "/tmp/out", undefined, undefined, { shell, egress: { name: "home", url: "socks5://127.0.0.1:1" } });
    const r = await tool(remote, "browser_navigate").execute("1", { url: "https://example.com" });
    expect(JSON.stringify(r)).not.toMatch(/paused|unreachable/);
  });
});
