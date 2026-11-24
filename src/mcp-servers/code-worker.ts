/**
 * Code tools in a bubblewrap-isolated worker, one per server version, started on demand and
 * stopped when idle.
 *
 * Isolation (bwrap --unshare-all --clearenv):
 * - the filesystem is a minimal read-only system (/usr), the server's build folder read-only at
 *   /srv (its code and node_modules), the worker harness, an empty /tmp. No instance files, no
 *   .polpo, no vault, no home directory;
 * - no network namespace of its own: the only way out is
 *   • ctx.fetch (and the global fetch), a request the HOST makes after checking the destination
 *     against the server's allowedDomains (https, public addresses, no redirects), and
 *   • for libraries that use HTTP(S)_PROXY, the sandbox allowlist proxy (src/sandbox/net-proxy.ts)
 *     on a Unix socket, bridged to 127.0.0.1 inside the jail, allowing only the declared hosts;
 * - secrets declared by the server arrive with each call, in memory (never on disk or in the env);
 * - limits: V8 heap (limits.memoryMb), a per-call timeout that kills the whole process tree
 *   (process-tree.ts), calls at once (limits.concurrency), result size (limits.maxResponseBytes).
 *
 * Protocol: JSON lines over stdio, each prefixed with \u0001 (anything else the code prints is
 * ignored or kept as log). host → worker: {id, type:"call", tool, input, secrets} | {id, type:"fetch-result", …}
 * worker → host: {id, type:"result", ok, result|error} | {id, type:"fetch", url, init} | {type:"log", text}.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { killTree, spawnTree } from "../sandbox/process-tree.js";
import { startNetworkProxy, type NetworkProxy, type Resolver } from "../sandbox/net-proxy.js";
import { bwrapAvailable } from "../sandbox/workspaces.js";
import { checkDestination, masker, type FetchLike } from "./http-executor.js";
import type { CodeRunner, CodeRunRequest } from "./runtime.js";
import type { McpToolCallResult } from "./types.js";

const MARK = "\u0001";
const BRIDGE_PORT = 3128;
const MAX_FETCH_BODY = 5 * 1024 * 1024;

/** The harness run inside the jail (CommonJS; loads the tool modules with import()). */
export const WORKER_SOURCE = String.raw`"use strict";
const MARK = "\u0001";
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const out = (msg) => process.stdout.write(MARK + JSON.stringify(msg) + "\n");
const log = (...args) => out({ type: "log", text: args.map((a) => typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()).join(" ").slice(0, 2000) });
console.log = console.info = console.warn = console.error = console.debug = log;
// the allowlist proxy, for libraries that honor HTTP(S)_PROXY
if (process.env.POLPO_NET_SOCKET) {
  try { spawn(process.execPath, ["/run/polpo-net/bridge.cjs", String(process.env.POLPO_BRIDGE_PORT), process.env.POLPO_NET_SOCKET], { stdio: "ignore" }); } catch {}
}
let seq = 0;
const waiting = new Map();
function hostFetch(url, init) {
  init = init || {};
  const id = "f" + (++seq);
  let headers = {};
  if (init.headers) {
    if (typeof init.headers.forEach === "function") init.headers.forEach((v, k) => { headers[k] = v; });
    else headers = Object.assign({}, init.headers);
  }
  const body = init.body === undefined || init.body === null ? undefined : typeof init.body === "string" ? init.body : String(init.body);
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    out({ type: "fetch", id, url: String(url), init: { method: init.method || "GET", headers, body } });
  }).then((r) => {
    if (r.error) throw new Error(r.error);
    const empty = [101, 204, 205, 304].includes(r.status);
    return new Response(empty ? null : r.body, { status: r.status, headers: r.headers });
  });
}
globalThis.fetch = (input, init) => hostFetch(typeof input === "string" ? input : input && input.url ? input.url : String(input), init);
const modules = new Map();
async function load(tool) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool)) throw new Error("bad tool name");
  if (!modules.has(tool)) modules.set(tool, import("/srv/tools/" + tool + ".mjs"));
  const mod = await modules.get(tool);
  const handler = mod.handler || (mod.default && mod.default.handler) || mod.default;
  if (typeof handler !== "function") throw new Error("The module does not export handler(input, ctx)");
  return handler;
}
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === "fetch-result") { const w = waiting.get(msg.id); if (w) { waiting.delete(msg.id); w.resolve(msg); } return; }
  if (msg.type !== "call") return;
  try {
    const handler = await load(msg.tool);
    const ctx = Object.freeze({ secrets: Object.freeze(Object.assign({}, msg.secrets || {})), fetch: hostFetch, log });
    const result = await handler(msg.input || {}, ctx);
    out({ type: "result", id: msg.id, ok: true, result: result === undefined ? null : result });
  } catch (err) {
    out({ type: "result", id: msg.id, ok: false, error: err && err.message ? String(err.message).slice(0, 2000) : String(err) });
  }
});
`;

interface Pending { resolve: (r: McpToolCallResult) => void; started: number; timer: NodeJS.Timeout; maxBytes: number; mask: (s: string) => string; logs: string[] }

interface Worker {
  key: string;
  child: ChildProcess;
  proxy?: NetworkProxy;
  harnessDir: string;
  signature: string;
  allowedDomains: string[];
  inflight: Map<string, Pending>;
  queue: Array<() => void>;
  idle?: NodeJS.Timeout;
  dead: boolean;
}

export interface BwrapRunnerOptions {
  /** Tests: host-side fetch for ctx.fetch, DNS. */
  fetch?: FetchLike;
  resolve?: Resolver;
  /** Tests: the proxy's resolver. */
  log?: (line: string) => void;
}

function buildSignature(buildDir: string): string {
  try { return String(statSync(join(buildDir, ".built.json")).mtimeMs); } catch { return "none"; }
}

export class BwrapCodeRunner implements CodeRunner {
  private readonly workers = new Map<string, Worker>();
  private seq = 0;

  constructor(private readonly options: BwrapRunnerOptions = {}) {}

  static available(): boolean {
    return process.platform === "linux" && bwrapAvailable();
  }

  /** The bwrap argv for a worker (exported for tests). */
  argv(buildDir: string, harnessDir: string, memoryMb: number, proxy?: NetworkProxy): string[] {
    const node = process.execPath;
    const args = ["/usr/bin/bwrap", "--die-with-parent", "--new-session", "--unshare-all", "--clearenv",
      "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/sbin", "/sbin"];
    if (existsSync("/usr/lib64")) args.push("--symlink", "usr/lib64", "/lib64");
    args.push("--ro-bind", "/usr", "/usr");
    for (const p of ["/etc/ssl", "/etc/ca-certificates", "/etc/pki", "/etc/localtime"]) args.push("--ro-bind-try", p, p);
    if (!node.startsWith("/usr/")) args.push("--ro-bind", node, node);
    args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/run");
    args.push("--ro-bind", buildDir, "/srv", "--ro-bind", harnessDir, "/run/polpo-worker");
    const env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp", LANG: "C.UTF-8", NODE_ENV: "production" };
    if (proxy) {
      args.push("--ro-bind", proxy.dir, "/run/polpo-net");
      const url = `http://127.0.0.1:${BRIDGE_PORT}`;
      Object.assign(env, {
        POLPO_NET_SOCKET: "/run/polpo-net/proxy.sock", POLPO_BRIDGE_PORT: String(BRIDGE_PORT),
        HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, NO_PROXY: "localhost,127.0.0.1", NODE_USE_ENV_PROXY: "1",
      });
    }
    for (const [k, v] of Object.entries(env)) args.push("--setenv", k, v);
    args.push("--chdir", "/srv", node, `--max-old-space-size=${Math.max(32, memoryMb)}`, "--disable-proto=delete", "/run/polpo-worker/worker.cjs");
    return args;
  }

  private async start(req: CodeRunRequest, signature: string): Promise<Worker> {
    const harnessDir = mkdtempSync(join(tmpdir(), "polpo-mcp-worker-"));
    writeFileSync(join(harnessDir, "worker.cjs"), WORKER_SOURCE, { mode: 0o644 });
    chmodSync(harnessDir, 0o755);
    const proxy = req.allowedDomains.length
      ? await startNetworkProxy({ rule: { mode: "allowlist", allow: req.allowedDomains }, ...(this.options.resolve ? { resolve: this.options.resolve } : {}) })
      : undefined;
    const argv = this.argv(req.buildDir, harnessDir, req.limits.memoryMb, proxy);
    const child = spawnTree(argv[0]!, argv.slice(1), {
      env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"],
    });
    const worker: Worker = { key: req.workerKey, child, harnessDir, signature, allowedDomains: req.allowedDomains, inflight: new Map(), queue: [], dead: false, ...(proxy ? { proxy } : {}) };
    let buffer = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const at = line.indexOf(MARK);
        if (at < 0) continue;
        try { void this.onMessage(worker, JSON.parse(line.slice(at + 1)), req); } catch { /* not ours */ }
      }
      if (buffer.length > 64 * 1024 * 1024) this.kill(worker, "The worker printed too much output");
    });
    child.stderr!.on("data", (c: Buffer) => this.options.log?.(`[mcp-worker ${worker.key}] ${c.toString("utf-8").slice(0, 500)}`));
    child.stdin!.on("error", () => undefined);
    child.on("close", () => this.kill(worker, "The worker stopped"));
    this.workers.set(req.workerKey, worker);
    return worker;
  }

  private async onMessage(worker: Worker, msg: Record<string, any>, req: CodeRunRequest): Promise<void> {
    if (msg.type === "log") {
      for (const p of worker.inflight.values()) if (p.logs.length < 50) p.logs.push(p.mask(String(msg.text)));
      return;
    }
    if (msg.type === "fetch") {
      const reply = await this.hostFetch(msg.url, msg.init ?? {}, worker.allowedDomains, req.limits.timeoutMs).catch((err: Error) => ({ error: err.message }));
      if (!worker.dead) worker.child.stdin!.write(`${JSON.stringify({ type: "fetch-result", id: msg.id, ...reply })}\n`);
      return;
    }
    if (msg.type === "result") {
      const pending = worker.inflight.get(msg.id);
      if (!pending) return;
      worker.inflight.delete(msg.id);
      clearTimeout(pending.timer);
      const ms = Date.now() - pending.started;
      if (!msg.ok) { pending.resolve({ ok: false, text: pending.mask(String(msg.error)), error: pending.mask(String(msg.error)), ms, ...(pending.logs.length ? { response: pending.logs.join("\n") } : {}) }); }
      else {
        const text = typeof msg.result === "string" ? msg.result : JSON.stringify(msg.result, null, 2);
        if (Buffer.byteLength(text) > pending.maxBytes) {
          pending.resolve({ ok: false, text: "", error: `The result is larger than ${pending.maxBytes} bytes (limits.maxResponseBytes)`, ms });
        } else {
          const structured = msg.result && typeof msg.result === "object" && !Array.isArray(msg.result) ? msg.result : msg.result === null ? undefined : { result: msg.result };
          pending.resolve({ ok: true, text: pending.mask(text), ...(structured !== undefined ? { structured } : {}), ms, ...(pending.logs.length ? { response: pending.logs.join("\n") } : {}) });
        }
      }
      this.next(worker, req);
    }
  }

  /** A request the jailed code asked for: checked against the allowlist, made by the host. */
  private async hostFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string }, allowed: string[], timeoutMs: number) {
    const target = new URL(url);
    await checkDestination(target, allowed, this.options.resolve);
    const res = await (this.options.fetch ?? ((u: string, i: RequestInit) => fetch(u, i)))(target.toString(), {
      method: init.method ?? "GET", headers: init.headers ?? {}, ...(init.body !== undefined ? { body: init.body } : {}),
      redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { status: res.status, headers, body: text.slice(0, MAX_FETCH_BODY) };
  }

  private next(worker: Worker, req: CodeRunRequest): void {
    const go = worker.queue.shift();
    if (go) go();
    this.armIdle(worker, req.limits.idleMs);
  }

  private armIdle(worker: Worker, idleMs: number): void {
    if (worker.idle) clearTimeout(worker.idle);
    if (worker.inflight.size || worker.queue.length) return;
    worker.idle = setTimeout(() => this.kill(worker, "idle"), idleMs);
    worker.idle.unref?.();
  }

  private kill(worker: Worker, reason: string): void {
    if (worker.dead) return;
    worker.dead = true;
    if (this.workers.get(worker.key) === worker) this.workers.delete(worker.key);
    if (worker.idle) clearTimeout(worker.idle);
    killTree(worker.child, { graceMs: 500 });
    for (const [id, p] of worker.inflight) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, text: reason, error: reason, ms: Date.now() - p.started });
      worker.inflight.delete(id);
    }
    for (const go of worker.queue.splice(0)) go();
    void worker.proxy?.close().catch(() => undefined);
    rmSync(worker.harnessDir, { recursive: true, force: true });
  }

  async run(req: CodeRunRequest): Promise<McpToolCallResult> {
    const started = Date.now();
    if (!BwrapCodeRunner.available()) return { ok: false, text: "Code tools need bubblewrap (bwrap) on Linux", error: "Code tools need bubblewrap (bwrap) on Linux", ms: 0 };
    if (!existsSync(join(req.buildDir, "tools", `${req.tool.name}.mjs`))) return { ok: false, text: "The tool is not built", error: "The tool is not built", ms: 0 };
    const signature = buildSignature(req.buildDir);
    let worker = this.workers.get(req.workerKey);
    if (worker && (worker.signature !== signature || worker.dead)) { this.kill(worker, "rebuilt"); worker = undefined; }
    worker ??= await this.start(req, signature);
    const w = worker;
    // concurrency: wait for a slot
    if (w.inflight.size >= req.limits.concurrency) {
      await new Promise<void>((resolve) => w.queue.push(resolve));
      if (w.dead) return this.run(req);
    }
    if (w.idle) clearTimeout(w.idle);
    const id = `c${++this.seq}`;
    const mask = masker(Object.values(req.secrets));
    return new Promise<McpToolCallResult>((resolve) => {
      const timer = setTimeout(() => {
        // a call that runs too long: the whole worker goes (its other calls fail), the next call starts a fresh one
        this.kill(w, `Timed out after ${req.limits.timeoutMs} ms: the worker was stopped`);
      }, req.limits.timeoutMs);
      w.inflight.set(id, { resolve, started, timer, maxBytes: req.limits.maxResponseBytes, mask, logs: [] });
      req.signal?.addEventListener("abort", () => this.kill(w, "Cancelled"), { once: true });
      w.child.stdin!.write(`${JSON.stringify({ type: "call", id, tool: req.tool.name, input: req.input, secrets: req.secrets })}\n`);
    });
  }

  /** Stop a server's workers (deploy, delete, kill switch). */
  stop(serverId: string): void {
    for (const w of [...this.workers.values()]) if (w.key.startsWith(`${serverId}@`)) this.kill(w, "stopped");
  }

  stopAll(): void {
    for (const w of [...this.workers.values()]) this.kill(w, "stopped");
  }
}
