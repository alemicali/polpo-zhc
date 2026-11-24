/**
 * Signing in a CLI account that lives on a remote computer: the dashboard's sign-in terminal runs
 * the official login command with the account's directory in a PTY on that computer (fake PTY
 * here), streamed both ways over the terminal WebSocket; only the account's owner may open it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { attachTerminalWebSocket, cliLoginInvocation, remotePtyShell } from "../server/terminal.js";
import type { RemotePty } from "../sandbox/remote-adapters.js";

const accounts = [{ id: "ada-vm", cli: "claude", computer: "box", owner: "ada@example.com" }, { id: "ada-gpt-vm", cli: "codex", computer: "box", owner: "ada@example.com" }];
const orch = (extra: Record<string, unknown> = {}) => ({
  isInitialized: true,
  getConfig: () => ({ settings: { harnesses: { enabled: [], cli: { accounts } }, computers: [{ id: "box", kind: "daytona" }] } }),
  getPolpoDir: () => "/tmp/polpo-none",
  getAgentWorkDir: () => "/tmp",
  getWorkDir: () => "/tmp",
  ...extra,
}) as any;

/** A fake provider PTY: what is written is echoed, like a terminal running the login. */
function fakePty(seen: { command?: string; writes: string[] }): RemotePty {
  let push!: (s: string) => void;
  let end!: () => void;
  const queue: Uint8Array[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  push = (s) => { queue.push(new TextEncoder().encode(s)); wake?.(); };
  end = () => { done = true; wake?.(); };
  let exit!: (r: { exitCode: number }) => void;
  const exited = new Promise<{ exitCode: number }>((r) => { exit = r; });
  setTimeout(() => push("Opening https://claude.ai/oauth/authorize?code=true\r\nPaste code here: "), 10);
  return {
    output: (async function* () {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (done) return;
        await new Promise<void>((r) => { wake = r; });
      }
    })(),
    write: async (d) => {
      seen.writes.push(d);
      if (d.includes("\r")) { push("\r\nLogin successful.\r\n"); setTimeout(() => { end(); exit({ exitCode: 0 }); }, 10); }
    },
    resize: async () => {},
    kill: async () => { end(); exit({ exitCode: 143 }); },
    wait: () => exited,
  };
}

let server: Server | undefined;
afterEach(async () => { await new Promise<void>((r) => (server ? server.close(() => r()) : r())); server = undefined; });

describe("sign-in on a remote computer", () => {
  it("the login command runs with the account's directory on that computer", () => {
    const inv = cliLoginInvocation(orch(), "ada-vm", undefined);
    expect(inv.remote?.computer).toBe("box");
    expect(inv.remote?.command).toMatch(/^export CLAUDE_CONFIG_DIR="\$HOME"\/'\.polpo-cli\/claude\/ada-vm'; .*cd "\$CLAUDE_CONFIG_DIR" && claude auth login$/);
    expect(cliLoginInvocation(orch(), "ada-gpt-vm", undefined).remote?.command).toMatch(/CODEX_HOME=.*codex login --device-auth$/);
    // only its owner, when members sign in
    process.env.POLPO_AUTH_ENABLED = "1";
    try {
      expect(() => cliLoginInvocation(orch(), "ada-vm", "bob@example.com")).toThrow(/Only ada@example.com/);
    } finally {
      delete process.env.POLPO_AUTH_ENABLED;
    }
  });

  it("the dashboard's terminal is a PTY on the computer, streamed both ways", async () => {
    const seen: { command?: string; computer?: string; writes: string[] } = { writes: [] };
    server = createServer();
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const handle = attachTerminalWebSocket(server as any, orch(), {
      openRemotePty: async (computer, command) => { seen.computer = computer; seen.command = command; return fakePty(seen); },
    });
    const port = (server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?agent=cli-login&cli_account=ada-vm&cols=100&rows=30`);
    let text = "";
    const closed = new Promise<void>((r) => ws.on("close", () => r()));
    ws.on("message", (d) => { text += d.toString(); });
    await new Promise<void>((r) => ws.on("open", () => r()));
    for (let i = 0; i < 50 && !text.includes("Paste code"); i++) await new Promise((r) => setTimeout(r, 20));
    expect(text).toContain("https://claude.ai/oauth/authorize");
    expect(seen.computer).toBe("box");
    expect(seen.command).toMatch(/claude auth login$/);
    ws.send(JSON.stringify({ type: "input", data: "the-code\r" }));
    await closed;
    expect(seen.writes).toContain("the-code\r");
    expect(text).toContain("Login successful.");
    handle.close();
  });

  it("remotePtyShell: data and exit as node-pty gives them", async () => {
    const seen = { writes: [] as string[] };
    const shell = remotePtyShell(fakePty(seen));
    let out = "";
    shell.onData((d) => { out += d; });
    const exit = new Promise<number>((r) => shell.onExit((e) => r(e.exitCode)));
    for (let i = 0; i < 50 && !out.includes("Paste"); i++) await new Promise((r) => setTimeout(r, 10));
    shell.write("x\r");
    expect(await exit).toBe(0);
    expect(out).toContain("Login successful.");
  });
});
