/**
 * The AI SDK harness sandbox session (`HarnessV1NetworkSandboxSession`: files, run, spawn, port
 * endpoints, lifecycle) over Polpo's machines:
 *
 * - a remote computer (Daytona v2): its RemoteDriver (exec, files, `spawn` on the provider's
 *   process API, `portEndpoint` on its preview proxy). The driver is the computer's: after a
 *   hibernation or a rotation it reaches the new VM, so this session object stays valid; the
 *   harness re-resolves the port endpoint when it re-attaches.
 * - this server (only when settings.harnesses.allowHost): child processes with an isolated HOME
 *   and a minimal environment — never the server's HOME (~/.claude, ~/.codex) nor its env.
 *
 * stop/destroy are no-ops: Polpo's ComputerManager owns the machine's lifecycle.
 *
 * Credential brokering is implemented here once, for every provider: the session offers the AI
 * SDK's `addRequestTransformations` / `setRequestTransformations` when the run has a broker — the
 * provider's native egress transformer (`HarnessMachine.nativeRequestTransformations`, e.g. a
 * sandbox network policy that rewrites headers), else Polpo's model relay lease (relay.ts). Both
 * get the same rules (the SDK's, presented per the gateway's auth scheme, plus Polpo's gateway
 * headers) with the same semantics. Without a broker the methods are absent and the SDK forwards
 * the credential into the VM (the fallback).
 */
import { createServer } from "node:net";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { Readable } from "node:stream";
import type { RemoteDriver, RemotePortEndpoint, RemoteProcess } from "../sandbox/remote-adapters.js";
import { killTree, spawnTree } from "../sandbox/process-tree.js";
import { PROXY_VARS, pickEnv } from "../tools/safe-env.js";
import type { HarnessSandbox, RequestTransformation } from "./types.js";
import { presentCredential, type HarnessRelayLease } from "./relay.js";

/** What a harness needs from a machine. Paths are absolute (relative ones resolve against workDir). */
export interface HarnessMachine {
  readonly id: string;
  readonly description: string;
  readonly workDir: string;
  exec(command: string, opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** null when it does not exist. */
  readFile(path: string): Promise<Uint8Array | null>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  stat(path: string): Promise<{ type: "file" | "directory" | "other"; size: number } | null>;
  list(path: string): Promise<Array<{ name: string; type: "file" | "directory" | "symlink" | "other" }> | null>;
  /** false when it did not exist. */
  remove(path: string): Promise<boolean>;
  spawn(command: string, opts: { cwd?: string; env?: Record<string, string> }): Promise<RemoteProcess>;
  portEndpoint(port: number, protocol: "http" | "https" | "ws"): Promise<RemotePortEndpoint>;
  /** Stop following process output (processes keep running). */
  close(): void;
  /**
   * Optional provider capability: the provider rewrites the VM's outbound HTTPS requests itself
   * (outside the VM), with the semantics of the AI SDK's request transformations: rules match on
   * host / path / method / query / headers, credential headers the VM sent are dropped, matching
   * rules' headers are set ("" removes a header). `replace`: the rules replace the previous set.
   * Providers without it are brokered by Polpo's model relay.
   */
  nativeRequestTransformations?(rules: ReadonlyArray<RequestTransformation>, opts: { replace: boolean }): Promise<void>;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const enc = new TextEncoder();

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

/** All of `stream`; with `partial`, what arrived before it broke off (a stopped command's output). */
async function bytesOf(stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, partial = false): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    for await (const c of stream as AsyncIterable<Uint8Array>) { chunks.push(c); n += c.length; }
  } catch (err) {
    if (!partial) throw err;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// ── Remote computer ────────────────────────────────────────────────────

/**
 * A remote computer as a harness machine. `driver` resolves the computer's driver (the same object
 * for the whole run; it follows the computer to a new VM). Processes and ports need the driver's
 * optional `spawn`/`portEndpoint` (Daytona v2): others are refused with a clear message.
 */
export function remoteHarnessMachine(o: {
  driver: () => Promise<RemoteDriver>; workDir: string; label: string; portTtlSeconds?: number;
  /** The driver rewrites outbound requests natively (RemoteDriver.requestTransformations). */
  nativeTransformations?: boolean;
}): HarnessMachine {
  const followed = new Set<RemoteProcess>();
  const abs = (p: string) => (p.startsWith("/") ? p : posix.join(o.workDir, p));
  const machine: HarnessMachine = {
    get id() { return o.label; },
    description: `Polpo computer ${o.label} (Linux VM); working directory ${o.workDir}.`,
    workDir: o.workDir,
    exec: async (command, x) => {
      x.signal?.throwIfAborted();
      const d = await o.driver();
      const r = await d.exec(command, { cwd: x.cwd ? abs(x.cwd) : o.workDir, env: x.env, timeoutMs: x.timeoutMs });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    },
    readFile: async (path) => {
      if (!(await machine.stat(path))) return null;
      return (await o.driver()).readFile(abs(path));
    },
    writeFile: async (path, data) => {
      const d = await o.driver();
      const p = abs(path);
      try {
        await d.writeFile(p, data);
      } catch {
        // a missing parent directory: create it and try once more
        await d.exec(`mkdir -p ${q(posix.dirname(p))}`, {});
        await d.writeFile(p, data);
      }
    },
    stat: async (path) => {
      const r = await (await o.driver()).exec(`stat -c '%F|%s' -- ${q(abs(path))} 2>/dev/null`, {});
      if (r.exitCode !== 0 || !r.stdout.trim()) return null;
      const [kind, size] = r.stdout.trim().split("|");
      return { type: kind === "directory" ? "directory" : kind?.includes("regular") ? "file" : "other", size: Number(size) || 0 };
    },
    list: async (path) => {
      const s = await machine.stat(path);
      if (!s) return null;
      if (s.type !== "directory") throw new Error(`Not a directory: ${path}`);
      const r = await (await o.driver()).exec(`find ${q(abs(path))} -mindepth 1 -maxdepth 1 -printf '%y|%f\\n' 2>/dev/null`, {});
      return r.stdout.split("\n").filter(Boolean).map((line) => {
        const [y, ...rest] = line.split("|");
        return { name: rest.join("|"), type: y === "d" ? "directory" : y === "l" ? "symlink" : y === "f" ? "file" : "other" } as const;
      });
    },
    remove: async (path) => {
      const s = await machine.stat(path);
      if (!s) return false;
      if (s.type === "directory") throw new Error(`Is a directory: ${path}`);
      await (await o.driver()).exec(`rm -f -- ${q(abs(path))}`, {});
      return true;
    },
    spawn: async (command, x) => {
      const d = await o.driver();
      if (!d.spawn) throw new Error(`Computer ${o.label} cannot start long-running processes (agent harnesses need a Daytona v2 computer)`);
      const p = await d.spawn(command, { cwd: x.cwd ? abs(x.cwd) : o.workDir, env: x.env });
      followed.add(p);
      void p.wait().finally(() => followed.delete(p));
      return p;
    },
    portEndpoint: async (port, protocol) => {
      const d = await o.driver();
      if (!d.portEndpoint) throw new Error(`Computer ${o.label} exposes no ports to this server (agent harnesses need a Daytona v2 computer)`);
      return d.portEndpoint(port, { protocol, ttlSeconds: o.portTtlSeconds });
    },
    close: () => {
      for (const p of followed) p.detach();
      followed.clear();
    },
  };
  if (o.nativeTransformations) {
    machine.nativeRequestTransformations = async (rules, x) => {
      const d = await o.driver();
      if (!d.requestTransformations) throw new Error(`Computer ${o.label} cannot rewrite outbound requests`);
      await d.requestTransformations(rules, x);
    };
  }
  return machine;
}

// ── This server (isolated HOME) ────────────────────────────────────────

/**
 * The environment a harness process gets on this server: a minimal one, HOME (and every config,
 * cache and data directory the runtimes read) inside `home`. Nothing else of the server's env
 * (no ANTHROPIC_*, AWS_*, CLAUDE_*, OPENAI_*, CODEX_*, no tokens) — the runtime's credentials come
 * from the harness auth, explicitly. From the server's env it takes only what safe-env.ts passes to
 * every command and is not about the user's home: PATH, the locale, the timezone, the proxy
 * settings (with this machine always reached directly: the bridge listens on 127.0.0.1).
 */
export function isolatedHostEnv(home: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {
    ...pickEnv(base, ["LANG", "LANGUAGE", "TZ", ...PROXY_VARS], ["LC_"]),
    HOME: home,
    USER: "polpo-harness",
    PATH: base.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: base.LANG ?? "C.UTF-8",
    TERM: "dumb",
    TMPDIR: join(home, "tmp"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    npm_config_cache: join(home, ".npm"),
    COREPACK_HOME: join(home, ".cache", "node", "corepack"),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  };
  if (base.NODE_EXTRA_CA_CERTS) env.NODE_EXTRA_CA_CERTS = base.NODE_EXTRA_CA_CERTS;
  if (PROXY_VARS.some((k) => k in env && !/no_proxy/i.test(k))) {
    for (const k of ["NO_PROXY", "no_proxy"]) env[k] = [env[k], "localhost,127.0.0.1,::1"].filter(Boolean).join(",");
  }
  return env;
}

/**
 * A command on this server, in its own process group: kill() stops it with everything it started
 * (SIGTERM, SIGKILL after a grace) and returns once the shell is gone; `release()` then lets go of
 * output a program that escaped the group may still hold open.
 */
function hostProcess(command: string, cwd: string, env: Record<string, string>): RemoteProcess & { release(): void } {
  const child = spawnTree("bash", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let killed = false;
  const exited = new Promise<{ exitCode: number }>((resolve) => {
    const end = (code: number | null, signal: NodeJS.Signals | null) =>
      resolve({ exitCode: code ?? (signal === "SIGKILL" ? 137 : signal === "SIGTERM" ? 143 : 1) });
    child.on("error", () => resolve({ exitCode: 127 }));
    child.on("close", end);
    // stopped: done when the shell exits, not when the last holder of its output does
    child.on("exit", (code, signal) => { if (killed) end(code, signal); });
  });
  return {
    id: String(child.pid ?? "0"),
    stdout: Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr!) as unknown as ReadableStream<Uint8Array>,
    wait: () => exited,
    kill: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      killed = true;
      killTree(child);
      await exited;
    },
    detach: () => { /* the child is ours: nothing to stop following */ },
    release: () => { child.stdout!.destroy(); child.stderr!.destroy(); },
  };
}

/** This server as a harness machine: processes with an isolated HOME under `home`. */
export function hostHarnessMachine(o: { workDir: string; home: string; label?: string; baseEnv?: NodeJS.ProcessEnv }): HarnessMachine {
  const children = new Set<RemoteProcess>();
  const env = isolatedHostEnv(o.home, o.baseEnv);
  const abs = (p: string) => (p.startsWith("/") ? p : join(o.workDir, p));
  const ready = (async () => {
    for (const dir of [o.home, env.TMPDIR!, env.XDG_CONFIG_HOME!, env.XDG_CACHE_HOME!]) await mkdir(dir, { recursive: true });
  })();
  const missing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === "ENOENT";
  return {
    id: o.label ?? "host",
    description: `This Polpo server (isolated HOME ${o.home}); working directory ${o.workDir}.`,
    workDir: o.workDir,
    exec: async (command, x) => {
      await ready;
      const p = hostProcess(command, x.cwd ? abs(x.cwd) : o.workDir, { ...env, ...(x.env ?? {}) });
      let stopped = false;
      const onAbort = () => { stopped = true; void p.kill(); };
      if (x.signal?.aborted) onAbort();
      else x.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = x.timeoutMs ? setTimeout(onAbort, x.timeoutMs) : undefined;
      try {
        const out = bytesOf(p.stdout, true);
        const err = bytesOf(p.stderr, true);
        const r = await p.wait();
        if (stopped) p.release();
        const [stdout, stderr] = await Promise.all([out, err]);
        return { exitCode: r.exitCode, stdout: Buffer.from(stdout).toString("utf8"), stderr: Buffer.from(stderr).toString("utf8") };
      } finally {
        if (timer) clearTimeout(timer);
        x.signal?.removeEventListener("abort", onAbort);
      }
    },
    readFile: async (path) => {
      try { return new Uint8Array(await readFile(abs(path))); } catch (err) { if (missing(err)) return null; throw err; }
    },
    writeFile: async (path, data) => {
      await mkdir(dirname(abs(path)), { recursive: true });
      await writeFile(abs(path), data);
    },
    stat: async (path) => {
      try {
        const s = await stat(abs(path));
        return { type: s.isDirectory() ? "directory" : s.isFile() ? "file" : "other", size: s.size };
      } catch (err) { if (missing(err)) return null; throw err; }
    },
    list: async (path) => {
      try {
        const entries = await readdir(abs(path), { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : e.isSymbolicLink() ? "symlink" : e.isFile() ? "file" : "other" } as const));
      } catch (err) { if (missing(err)) return null; throw err; }
    },
    remove: async (path) => {
      const s = await stat(abs(path)).catch(() => null);
      if (!s) return false;
      if (s.isDirectory()) throw new Error(`Is a directory: ${path}`);
      await rm(abs(path), { force: true });
      return true;
    },
    spawn: async (command, x) => {
      await ready;
      const p = hostProcess(command, x.cwd ? abs(x.cwd) : o.workDir, { ...env, ...(x.env ?? {}) });
      children.add(p);
      void p.wait().finally(() => children.delete(p));
      return p;
    },
    portEndpoint: async (port, protocol) => ({ url: `${protocol === "ws" ? "ws" : protocol}://127.0.0.1:${port}` }),
    close: () => {
      for (const p of children) void p.kill();
      children.clear();
    },
  };
}

/** A free TCP port on this server (host harness bridges, one per session). */
export function freeHostPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** A port in the VM no process listens on (from 4000), for this session's bridge. */
export async function freeMachinePort(machine: Pick<HarnessMachine, "exec">, from = 4000, to = 4099): Promise<number> {
  const r = await machine.exec(
    `for p in $(seq ${from} ${to}); do (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null || { echo $p; exit 0; }; done; exit 1`, {},
  );
  const port = Number(r.stdout.trim());
  if (r.exitCode !== 0 || !Number.isInteger(port)) throw new Error(`No free port between ${from} and ${to} on the computer`);
  return port;
}

/**
 * Who brokers a run's model credential: the machine's provider natively, or Polpo's relay lease.
 * `scheme` presents the brokered key the way a custom gateway wants it; `rules` are Polpo's own
 * (gateway headers, for the upstream host).
 */
export interface HarnessCredentialBroker {
  lease?: Pick<HarnessRelayLease, "addRules" | "setRules">;
  scheme?: "x-api-key" | "bearer" | "none";
  rules?: RequestTransformation[];
  /**
   * Polpo's own credential rules (OpenCode: Polpo writes the runtime's config, so the placeholder
   * and its rule are Polpo's, not the SDK's). Installed with the session, before any process
   * starts, and kept when the runtime replaces its own rules.
   */
  credentialRules?: RequestTransformation[];
}

/** "native" (the provider rewrites requests), "relay" (Polpo's lease) or "none" (no brokering). */
export function brokeringOf(machine: Pick<HarnessMachine, "nativeRequestTransformations">, broker: HarnessCredentialBroker | undefined): "native" | "relay" | "none" {
  if (!broker) return "none";
  if (machine.nativeRequestTransformations) return "native";
  return broker.lease ? "relay" : "none";
}

/**
 * The harness sandbox session over a machine (structurally `HarnessV1NetworkSandboxSession`).
 * `port`: the bridge port this session's runtime listens on. `broker`: credential brokering
 * (addRequestTransformations / setRequestTransformations), for any provider.
 */
export function createHarnessSandboxSession(machine: HarnessMachine, opts: {
  port: number; broker?: HarnessCredentialBroker;
  /** Environment every process the runtime spawns starts from (the runtime's own variables win). */
  spawnEnv?: Record<string, string>;
}): HarnessSandbox {
  const abs = (p: string) => (p.startsWith("/") ? p : posix.join(machine.workDir, p));
  const brokering = brokeringOf(machine, opts.broker);
  const credentialRules = opts.broker?.credentialRules ?? [];
  const polpoRules = [...(opts.broker?.rules ?? []), ...credentialRules];
  let nativeRules: RequestTransformation[] | undefined;
  if (brokering === "relay" && credentialRules.length) opts.broker!.lease!.addRules(credentialRules);
  /** Native brokering with Polpo's own credential rules: installed before the first process at the latest. */
  const ensureNative = async () => {
    if (brokering !== "native" || nativeRules || !credentialRules.length) return;
    nativeRules = [...polpoRules];
    await machine.nativeRequestTransformations!(nativeRules, { replace: true });
  };
  const transformations: Record<string, (rules: ReadonlyArray<RequestTransformation>) => Promise<void>> = brokering === "native"
    ? {
        // Polpo's rules go with the first set; later additions only add the runtime's
        addRequestTransformations: async (rules) => {
          const add = presentCredential(rules, opts.broker!.scheme);
          if (!nativeRules) { nativeRules = [...polpoRules, ...add]; await machine.nativeRequestTransformations!(nativeRules, { replace: true }); return; }
          nativeRules.push(...add);
          await machine.nativeRequestTransformations!(add, { replace: false });
        },
        setRequestTransformations: async (rules) => {
          nativeRules = [...polpoRules, ...presentCredential(rules, opts.broker!.scheme)];
          await machine.nativeRequestTransformations!(nativeRules, { replace: true });
        },
      }
    : brokering === "relay"
      ? {
          addRequestTransformations: async (rules) => { opts.broker!.lease!.addRules(rules); },
          setRequestTransformations: async (rules) => { opts.broker!.lease!.setRules([...credentialRules, ...rules]); },
        }
      : {};
  const session: Record<string, any> = {
    id: machine.id,
    description: machine.description,
    defaultWorkingDirectory: machine.workDir,
    ports: [opts.port],

    readBinaryFile: async ({ path }: { path: string }) => machine.readFile(abs(path)),
    readFile: async ({ path }: { path: string }) => {
      const b = await machine.readFile(abs(path));
      return b == null ? null : streamOf(b);
    },
    readTextFile: async ({ path, encoding = "utf-8", startLine, endLine }: { path: string; encoding?: string; startLine?: number; endLine?: number }) => {
      const b = await machine.readFile(abs(path));
      if (b == null) return null;
      const text = new TextDecoder(encoding).decode(b);
      if (startLine == null && endLine == null) return text;
      const lines = text.split("\n");
      return lines.slice((startLine ?? 1) - 1, endLine ?? lines.length).join("\n");
    },
    writeBinaryFile: async ({ path, content }: { path: string; content: Uint8Array }) => machine.writeFile(abs(path), content),
    writeTextFile: async ({ path, content }: { path: string; content: string }) => machine.writeFile(abs(path), enc.encode(content)),
    writeFile: async ({ path, content }: { path: string; content: ReadableStream<Uint8Array> }) => machine.writeFile(abs(path), await bytesOf(content)),
    stat: async ({ path }: { path: string }) => machine.stat(abs(path)),
    listDirectory: async ({ path }: { path: string }) => machine.list(abs(path)),
    deleteFile: async ({ path }: { path: string }) => machine.remove(abs(path)),

    run: async ({ command, workingDirectory, env, abortSignal, maxOutputLength }: { command: string; workingDirectory?: string; env?: Record<string, string>; abortSignal?: AbortSignal; maxOutputLength?: number }) => {
      const r = await machine.exec(command, { cwd: workingDirectory ? abs(workingDirectory) : undefined, env, signal: abortSignal });
      if (maxOutputLength == null) return r;
      return {
        exitCode: r.exitCode,
        stdout: r.stdout.slice(0, maxOutputLength), stderr: r.stderr.slice(0, maxOutputLength),
        stdoutLength: r.stdout.length, stderrLength: r.stderr.length,
      };
    },
    spawn: async ({ command, workingDirectory, env, abortSignal, stdin }: { command: string; workingDirectory?: string; env?: Record<string, string>; abortSignal?: AbortSignal; stdin?: boolean }) => {
      if (stdin === true) throw new Error("Polpo harness sandbox: interactive stdin is not supported");
      await ensureNative();
      const spawnEnv = opts.spawnEnv || env ? { ...(opts.spawnEnv ?? {}), ...(env ?? {}) } : undefined;
      const p = await machine.spawn(command, { cwd: workingDirectory ? abs(workingDirectory) : undefined, env: spawnEnv });
      abortSignal?.addEventListener("abort", () => void p.kill(), { once: true });
      return { pid: undefined, processId: p.id, stdout: p.stdout, stderr: p.stderr, wait: () => p.wait(), kill: () => p.kill() };
    },

    getPortEndpoint: async ({ port, protocol = "ws" }: { port: number; protocol?: "http" | "https" | "ws" }) => {
      const e = await machine.portEndpoint(port, protocol);
      return { url: e.url, ...(e.headers ? { headers: e.headers } : {}) };
    },
    getPortUrl: async (o: { port: number; protocol?: "http" | "https" | "ws" }) => (await session.getPortEndpoint(o)).url,
    // the machine outlives every session: Polpo's ComputerManager stops and deletes it
    stop: async () => {},
    destroy: async () => {},
    ...transformations,
    restricted: () => {
      const {
        getPortEndpoint, getPortUrl, stop, destroy, restricted, ports, id, defaultWorkingDirectory,
        addRequestTransformations, setRequestTransformations, ...basic
      } = session;
      return basic;
    },
  };
  return session as HarnessSandbox;
}
