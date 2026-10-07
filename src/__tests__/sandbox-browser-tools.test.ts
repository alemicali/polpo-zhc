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

import { cleanupAgentBrowserSession, createBrowserTools, sandboxBrowserCommand, AGENT_BROWSER_INSTALL_COMMAND } from "../tools/browser-tools.js";
import type { BrowserNetworkGuard } from "../tools/browser-network-guard.js";

/** A remote VM's shell: records commands, answers like agent-browser would. */
class FakeVmShell implements Shell {
  commands: string[] = [];
  constructor(private installed = true, private canInstall = true, private remote = true) {}
  async isRemote() { return this.remote; }
  async execute(command: string, _opts?: ShellOptions): Promise<ShellResult> {
    this.commands.push(command);
    if (command === "command -v agent-browser") return this.installed ? { stdout: "/usr/bin/agent-browser\n", stderr: "", exitCode: 0 } : { stdout: "", stderr: "", exitCode: 1 };
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
    expect(shell.commands[0]).toBe("command -v agent-browser");
    expect(shell.commands[1]).toBe(`agent-browser --session 'agent-a' --profile "$HOME"/'.polpo/browser-profiles/agent-a' 'open' 'https://example.com' --json`);
    await tool(tools, "browser_snapshot").execute("2", { interactive_only: true });
    expect(shell.commands.at(-1)).toContain("'snapshot' '-i' --json");
    await tool(tools, "browser_close").execute("3", {});
    expect(shell.commands.at(-1)).toBe("agent-browser --session 'agent-a' 'close' --json");
    // checked once per shell; nothing ran here; the host network guard is the VM's business
    expect(shell.commands.filter((c) => c === "command -v agent-browser")).toHaveLength(1);
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
    expect(shell.commands.slice(0, 2)).toEqual(["command -v agent-browser", AGENT_BROWSER_INSTALL_COMMAND]);
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
