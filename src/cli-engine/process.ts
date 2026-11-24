/**
 * The CLI engine's processes: the official `claude` / `codex` program, unmodified, run with an
 * account's config directory (CLAUDE_CONFIG_DIR / CODEX_HOME) and a minimal environment.
 *
 * - This server: a child in its own process group (process-tree.ts: kill stops everything it
 *   started), stdin/stdout pipes for the stream-json / JSON-RPC protocol.
 * - A remote computer (a HarnessMachine with long-running processes): its process API has no
 *   stdin, so the program reads an inbox file through `tail -f`; sending a line appends to it.
 *
 * The environment carries nothing of the server's credentials (no ANTHROPIC_*, OPENAI_*, AWS_*,
 * tokens): the CLI uses the account's own sign-in, and only that.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { CLI_CONFIG_ENV, type CliAccount, type CliId } from "@polpo-ai/core";
import { killTree, spawnTree } from "../sandbox/process-tree.js";
import { PROXY_VARS, pickEnv } from "../tools/safe-env.js";
import type { HarnessMachine } from "../harness/sandbox-session.js";

export interface CliProcess {
  /** stdout, line by line (ends when the program closes it). */
  lines(): AsyncIterable<string>;
  /** The last lines of stderr (error reports). */
  stderrTail(): string;
  /** One line to the program's input. */
  send(line: string): Promise<void>;
  /** Close the program's input (it finishes its work and exits). */
  endInput(): Promise<void>;
  /** Stop it with everything it started. */
  kill(): Promise<void>;
  wait(): Promise<{ exitCode: number }>;
}

/** What starts a CLI program (tests inject fakes; default: this server or the computer). */
export type CliLauncher = (o: { cli: CliId; args: string[]; cwd: string; env: Record<string, string> }) => Promise<CliProcess>;

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** "~/x" with that machine's home ("~" alone too). */
export function expandHome(path: string, home: string): string {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/**
 * The environment of a CLI process on this server: PATH (with ~/.local/bin, where Anthropic's
 * installer puts claude), HOME, the locale, the timezone, proxy settings, and the account's config
 * directory. Nothing else of the server's environment.
 */
export function cliHostEnv(cli: CliId, account: Pick<CliAccount, "configDir">, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const home = base.HOME || homedir();
  const env: Record<string, string> = {
    ...pickEnv(base, ["LANG", "LANGUAGE", "TZ", "USER", "LOGNAME", "SHELL", "NODE_EXTRA_CA_CERTS", "XDG_RUNTIME_DIR", ...PROXY_VARS], ["LC_"]),
    HOME: home,
    PATH: [join(home, ".local", "bin"), base.PATH ?? "/usr/local/bin:/usr/bin:/bin"].join(":"),
    LANG: base.LANG ?? "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
  };
  env[CLI_CONFIG_ENV[cli]] = expandHome(account.configDir, home);
  if (cli === "claude") {
    // no telemetry prompts or auto-updates in the middle of a run
    env.DISABLE_AUTOUPDATER = "1";
    env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = "1";
  }
  return env;
}

/** A CLI program on this server, with stdin/stdout pipes. */
export function hostCliProcess(file: string, args: string[], o: { cwd: string; env: Record<string, string> }): CliProcess {
  const child = spawnTree(file, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (d: string) => { stderr = (stderr + d).slice(-8000); });
  child.stdin!.on("error", () => { /* the program exited: nothing to write to */ });
  const exited = new Promise<{ exitCode: number }>((resolve) => {
    child.on("error", (err) => { stderr += `\n${(err as Error).message}`; resolve({ exitCode: 127 }); });
    child.on("close", (code, signal) => resolve({ exitCode: code ?? (signal === "SIGKILL" ? 137 : signal === "SIGTERM" ? 143 : 1) }));
  });
  return {
    lines: () => createInterface({ input: child.stdout!, crlfDelay: Infinity }),
    stderrTail: () => stderr,
    send: (line) => new Promise((resolve, reject) => {
      if (!child.stdin!.writable) { reject(new Error("The CLI's input is closed")); return; }
      child.stdin!.write(`${line}\n`, (err) => (err ? reject(err) : resolve()));
    }),
    endInput: async () => { if (child.stdin!.writable) child.stdin!.end(); },
    kill: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      killTree(child);
      await exited;
    },
    wait: () => exited,
  };
}

/** The end-of-input marker of a remote inbox (the reader stops at it, closing the program's input). */
export const INBOX_EOF = "__POLPO_CLI_EOF__";

/**
 * A CLI program on a remote computer: it reads `inbox` (a file in the VM) through `tail -f`, up to
 * the end marker; sending appends a line. `machine.spawn` gives its output.
 */
export async function remoteCliProcess(machine: HarnessMachine, command: string, o: { cwd: string; env: Record<string, string>; inbox: string }): Promise<CliProcess> {
  await machine.exec(`mkdir -p "$(dirname ${q(o.inbox)})" && : > ${q(o.inbox)}`, {});
  const p = await machine.spawn(
    `tail -n +1 -f ${q(o.inbox)} | sed -u '/^${INBOX_EOF}$/q' | grep -v --line-buffered '^${INBOX_EOF}$' | ${command}`,
    { cwd: o.cwd, env: o.env },
  );
  let stderr = "";
  void (async () => {
    try {
      for await (const c of p.stderr as unknown as AsyncIterable<Uint8Array>) stderr = (stderr + Buffer.from(c).toString("utf8")).slice(-8000);
    } catch { /* stopped following */ }
  })();
  const append = async (line: string) => {
    const r = await machine.exec(`printf '%s\\n' ${q(line)} >> ${q(o.inbox)}`, {});
    if (r.exitCode !== 0) throw new Error(`Could not send to the CLI: ${r.stderr.slice(0, 200)}`);
  };
  return {
    lines: () => linesOf(p.stdout),
    stderrTail: () => stderr,
    send: append,
    endInput: () => append(INBOX_EOF),
    kill: async () => {
      await p.kill();
      // tail -f outlives the pipeline's other end until its next write
      await machine.exec(`pkill -f -- ${q(`tail -n +1 -f ${o.inbox}`)} || true`, {}).catch(() => undefined);
    },
    wait: () => p.wait(),
  };
}

async function* linesOf(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
    }
  }
  if (buf) yield buf;
}
