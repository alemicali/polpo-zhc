/**
 * The first browser call of a task run on a remote computer: its independent preflights run at the
 * same time, every call into the VM is bounded on this side (a provider call that never answers no
 * longer holds a tool call for minutes), and a slow call says where its time went. Plus
 * browser_eval's arguments: base64 with `-b` before the script, whatever the JavaScript holds.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Shell, ShellOptions, ShellResult } from "@polpo-ai/core/shell";
import {
  AGENT_BROWSER_CHECK_COMMAND, BROWSER_SLOW_CALL_MS, browserEvalArgs, createBrowserTools, formatBrowserTiming, sandboxBrowserCommand,
} from "../tools/browser-tools.js";
import { execWithin, withDeadline } from "../tools/browser-egress.js";
import { DESKTOP_DISPLAY_QUICK_COMMAND, desktopInstallCommand } from "../sandbox/desktop.js";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Span = { kind: string; start: number; end: number };

/** A VM's shell with realistic delays per command, recording when each ran. */
class DelayedVmShell implements Shell {
  spans: Span[] = [];
  commands: string[] = [];
  constructor(private delays: Partial<Record<string, number>> = {}, private hang = new Set<string>()) {}
  kind(command: string): string {
    if (command === AGENT_BROWSER_CHECK_COMMAND) return "browser-check";
    if (command === DESKTOP_DISPLAY_QUICK_COMMAND) return "display";
    if (command === desktopInstallCommand("display")) return "display-install";
    if (command.includes("agent-browser")) return "browser";
    return "other";
  }
  async isRemote() { return true; }
  async execute(command: string, _opts?: ShellOptions): Promise<ShellResult> {
    const kind = this.kind(command);
    this.commands.push(command);
    const start = Date.now();
    if (this.hang.has(kind)) return new Promise<ShellResult>(() => {});
    await new Promise((r) => setTimeout(r, this.delays[kind] ?? 0));
    this.spans.push({ kind, start, end: Date.now() });
    if (kind === "browser") return { stdout: JSON.stringify({ success: true, data: { ok: true } }), stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}

describe("the first browser call on a remote computer", () => {
  test("the browser check and the display run in parallel, before the browser command", async () => {
    const shell = new DelayedVmShell({ "browser-check": 150, display: 150, browser: 10 });
    const tools = createBrowserTools("/vm/work", "par", ["browser_navigate"], undefined, "/vm/out", undefined, undefined, { shell });
    const t0 = Date.now();
    await tools[0]!.execute("1", { url: "https://example.com" });
    const elapsed = Date.now() - t0;
    const check = shell.spans.find((s) => s.kind === "browser-check")!;
    const display = shell.spans.find((s) => s.kind === "display")!;
    const browser = shell.spans.find((s) => s.kind === "browser")!;
    // overlapping: each started before the other ended
    expect(display.start).toBeLessThan(check.end);
    expect(check.start).toBeLessThan(display.end);
    expect(browser.start).toBeGreaterThanOrEqual(Math.max(check.end, display.end));
    // well under the sum of the two (150 + 150)
    expect(elapsed).toBeLessThan(290);
    // installed (the runner image): never the long install
    expect(shell.commands).not.toContain(desktopInstallCommand("display"));
    // the next call: the checks are cached for this shell, only the browser command
    const before = shell.commands.length;
    await tools[0]!.execute("2", { url: "https://example.org" });
    expect(shell.spans.slice(-1)[0]!.kind).toBe("browser");
    expect(shell.commands.length - before).toBe(1);
  });

  test("a browser check the computer never answers: an error within its deadline, never a 10-minute install", async () => {
    vi.useFakeTimers();
    const shell = new DelayedVmShell({}, new Set(["browser-check"]));
    const tools = createBrowserTools("/vm/work", "hang", ["browser_navigate"], undefined, "/vm/out", undefined, undefined, { shell, headed: false });
    let done = false;
    const call = tools[0]!.execute("1", { url: "https://example.com" }).then((r) => { done = true; return r; });
    await vi.advanceTimersByTimeAsync(19_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    const r = await call;
    expect((r.content[0] as { text: string }).text).toMatch(/^Browser error: The computer did not answer the browser check within 15 s/);
    expect(shell.commands.some((c) => c.includes("npm i -g agent-browser"))).toBe(false);
  });

  test("a slow call says where its time went (details, the result's last line)", async () => {
    vi.useFakeTimers();
    const shell = new DelayedVmShell({ "browser-check": 50, browser: BROWSER_SLOW_CALL_MS + 1_000 });
    const tools = createBrowserTools("/vm/work", "slow", ["browser_navigate"], undefined, "/vm/out", undefined, undefined, { shell, headed: false });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const call = tools[0]!.execute("1", { url: "https://example.com" });
    await vi.advanceTimersByTimeAsync(BROWSER_SLOW_CALL_MS + 2_000);
    const r = await call;
    const text = (r.content.at(-1) as { text: string }).text;
    expect(text).toMatch(/\[browser_navigate took 11\.\d s: browser check 0\.1 s, command 11\.0 s\]$/);
    expect((r.details as { timing: { totalMs: number; steps: { step: string }[] } }).timing.steps.map((s) => s.step)).toEqual(["browser check", "command"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[browser] [browser_navigate took"));
    warn.mockRestore();
    vi.useRealTimers();
    // a fast call is left as it is
    const fast = new DelayedVmShell({});
    const quick = await createBrowserTools("/vm/work", "fast", ["browser_navigate"], undefined, "/vm/out", undefined, undefined, { shell: fast, headed: false })[0]!.execute("1", { url: "https://example.com" });
    expect(JSON.stringify(quick)).not.toContain("took");
  });

  test("timing breakdown and deadlines", async () => {
    expect(formatBrowserTiming([{ step: "egress", ms: 290_100 }, { step: "browser check", ms: 10 }, { step: "command", ms: 4_200 }, { step: "egress", ms: 100 }]))
      .toBe("egress 290.2 s, command 4.2 s");
    vi.useFakeTimers();
    const never = new Promise<string>(() => {});
    const late = withDeadline(never, 1_000, () => "fallback");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(late).resolves.toBe("fallback");
    const thrown = withDeadline(never, 1_000, () => { throw new Error("too late"); });
    const caught = thrown.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(caught).resolves.toBe("too late");
    const shell = new DelayedVmShell({}, new Set(["other"]));
    const r = execWithin(shell, "true", { timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(r).resolves.toMatchObject({ exitCode: 124, timedOut: true });
  });
});

// ── browser_eval ─────────────────────────────────────────────────────────

const TRICKY_JS = [
  "JSON.stringify({webdriver:navigator.webdriver, lang:navigator.language})",
  `(() => { const q = "it's \\"quoted\\""; return q + ' $HOME `+"`whoami`"+` $(id) \\\\ ' })()`,
  "const a = [1, 2, 3];\nconst b = { x: 'y' };\n// comment\na.map((n) => n * 2).join(',') + JSON.stringify(b)",
  "document.title + ' — città ✓ 日本 🎉'",
  "-b",
];

/** A fake agent-browser: prints its argv (and the decoded eval script) as agent-browser --json would. */
function fakeAgentBrowser(): string {
  const dir = mkdtempSync(join(tmpdir(), "polpo-fake-ab-"));
  dirs.push(dir);
  const bin = join(dir, "agent-browser");
  writeFileSync(bin, `#!${process.execPath}
const argv = process.argv.slice(2);
const i = argv.indexOf("eval");
let script = null;
if (i >= 0) {
  const rest = argv.slice(i + 1).filter((a) => a !== "--json");
  // agent-browser 0.26: flags before the script; whatever follows "eval" otherwise IS the script
  script = rest[0] === "-b" || rest[0] === "--base64" ? Buffer.from(rest[1], "base64").toString("utf8") : rest[0];
}
process.stdout.write(JSON.stringify({ success: true, data: { argv, script } }));
`);
  chmodSync(bin, 0o755);
  return dir;
}

describe("browser_eval arguments", () => {
  test("-b comes before the script; the base64 decodes to the exact JavaScript", () => {
    for (const js of TRICKY_JS) {
      const args = browserEvalArgs(js);
      expect(args.slice(0, 2)).toEqual(["eval", "-b"]);
      expect(args).toHaveLength(3);
      expect(args[2]).toMatch(/^[A-Za-z0-9+/=]*$/);
      expect(Buffer.from(args[2]!, "base64").toString("utf8")).toBe(js);
    }
  });

  test("remote computer: through the shell command line, agent-browser gets -b then the script", () => {
    const fake = fakeAgentBrowser();
    for (const js of TRICKY_JS) {
      const command = sandboxBrowserCommand(browserEvalArgs(js), { session: "s" });
      // the launch part runs the agent's Chrome; the tail is what reaches agent-browser
      const tail = command.slice(command.lastIndexOf("agent-browser --session"));
      expect(tail).toMatch(/^agent-browser --session 's' --cdp "\$P" 'eval' '-b' '[A-Za-z0-9+/=]*' --json$/);
      const r = spawnSync("bash", ["-c", `P=9222; ${tail}`], { encoding: "utf8", env: { ...process.env, PATH: `${fake}:${process.env.PATH}` } });
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout) as { data: { argv: string[]; script: string } };
      expect(out.data.argv.slice(0, 6)).toEqual(["--session", "s", "--cdp", "9222", "eval", "-b"]);
      expect(out.data.script).toBe(js);
    }
  });

  test("this server: the tool passes the same arguments to agent-browser (no shell)", async () => {
    const fake = fakeAgentBrowser();
    const path = process.env.PATH;
    const exe = process.env.POLPO_AGENT_BROWSER_EXECUTABLE;
    process.env.PATH = `${fake}:${path}`;
    process.env.POLPO_AGENT_BROWSER_EXECUTABLE = process.execPath;
    try {
      const tools = createBrowserTools(fake, "host-eval", ["browser_eval"], undefined, join(fake, "out"));
      for (const js of TRICKY_JS) {
        const r = await tools[0]!.execute("1", { javascript: js });
        const data = r.details as { argv: string[]; script: string };
        expect(data.argv.slice(data.argv.indexOf("eval"), data.argv.indexOf("eval") + 2)).toEqual(["eval", "-b"]);
        expect(data.script).toBe(js);
      }
    } finally {
      process.env.PATH = path;
      if (exe === undefined) delete process.env.POLPO_AGENT_BROWSER_EXECUTABLE;
      else process.env.POLPO_AGENT_BROWSER_EXECUTABLE = exe;
    }
  });
});
