/**
 * Building code tools for a version (or the draft, for tests): each tool's module in tools/<name>.mjs
 * (TypeScript types stripped), a package.json with the declared npm dependencies installed with
 * --ignore-scripts (no install scripts ever run), the lockfile recorded, the size capped.
 *
 * builds/<version>/ is written once and never changed; builds/draft/ is rewritten for every test run
 * (dependencies are installed again only when they changed).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { runCommand } from "../sandbox/process-tree.js";
import { limitsOf, type McpServerSpec } from "./types.js";

export class CodeBuildError extends Error {}

const require = createRequire(import.meta.url);

/** Strip TypeScript types when the runtime can (Node ≥ 22.13); plain JS is kept as is. */
export function toModuleSource(source: string): string {
  const looksTyped = /:\s*[A-Za-z{[(<]|\binterface\s|\btype\s+\w+\s*=|<\w+>\(|\bas\s+\w/.test(source);
  if (!looksTyped) return source;
  try {
    const mod = require("node:module") as { stripTypeScriptTypes?: (code: string) => string };
    if (typeof mod.stripTypeScriptTypes === "function") {
      const prev = process.emitWarning;
      process.emitWarning = (() => undefined) as typeof process.emitWarning;
      try { return mod.stripTypeScriptTypes(source); } finally { process.emitWarning = prev; }
    }
  } catch { /* plain JS, or a syntax the stripper refuses: keep it, the worker reports any error */ }
  return source;
}

/** Bytes under a folder (symlinks not followed). */
export function folderBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      const st = lstatSync(p);
      if (st.isDirectory()) stack.push(p);
      else total += st.size;
    }
  }
  return total;
}

export interface BuildOptions {
  serverId: string;
  versionKey: string;
  spec: McpServerSpec;
  buildDir: string;
  /** Tests: the install command (default: npm). */
  install?: (dir: string) => Promise<void>;
}

async function npmInstall(dir: string, timeoutMs: number): Promise<void> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? dir, npm_config_update_notifier: "false" };
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "npm_config_registry", "npm_config_cache"]) if (process.env[k]) env[k] = process.env[k]!;
  const r = await runCommand(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", "--package-lock=true", "--loglevel=error"], { cwd: dir, env, timeoutMs });
  if (r.exitCode !== 0) throw new CodeBuildError(`npm install failed: ${(r.stderr || r.stdout).trim().slice(-600)}`);
}

/** Build (or reuse) the code of a version. */
export async function buildCodeTools(opts: BuildOptions): Promise<{ lockfile?: string; depsBytes?: number }> {
  const { spec, buildDir, versionKey } = opts;
  const limits = limitsOf(spec);
  const deps = spec.dependencies ?? {};
  const depsHash = createHash("sha256").update(JSON.stringify(Object.entries(deps).sort())).digest("hex").slice(0, 16);
  const marker = join(buildDir, ".built.json");
  const published = versionKey !== "draft";
  if (published && existsSync(marker)) {
    const done = JSON.parse(readFileSync(marker, "utf-8")) as { lockfile?: string; depsBytes?: number };
    return done;
  }
  mkdirSync(join(buildDir, "tools"), { recursive: true });
  // the modules (the draft's are rewritten every time)
  rmSync(join(buildDir, "tools"), { recursive: true, force: true });
  mkdirSync(join(buildDir, "tools"), { recursive: true });
  for (const tool of spec.tools) {
    if (tool.kind !== "code" || !tool.code) continue;
    writeFileSync(join(buildDir, "tools", `${tool.name}.mjs`), toModuleSource(tool.code.source), { mode: 0o644 });
  }
  const pkg = { name: `polpo-hosted-${opts.serverId}`, private: true, type: "module", dependencies: deps };
  const pkgFile = join(buildDir, "package.json");
  const previous = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf-8")) as { depsHash?: string; lockfile?: string; depsBytes?: number } : undefined;
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
  let lockfile: string | undefined;
  let depsBytes = 0;
  if (Object.keys(deps).length) {
    if (previous?.depsHash === depsHash && existsSync(join(buildDir, "node_modules"))) {
      lockfile = previous.lockfile;
      depsBytes = previous.depsBytes ?? folderBytes(join(buildDir, "node_modules"));
    } else {
      rmSync(join(buildDir, "node_modules"), { recursive: true, force: true });
      await (opts.install ?? ((d) => npmInstall(d, 5 * 60_000)))(buildDir);
      depsBytes = folderBytes(join(buildDir, "node_modules"));
      const cap = limits.depsMaxMb * 1024 * 1024;
      if (depsBytes > cap) {
        rmSync(join(buildDir, "node_modules"), { recursive: true, force: true });
        throw new CodeBuildError(`The dependencies take ${(depsBytes / 1024 / 1024).toFixed(1)} MB, more than the ${limits.depsMaxMb} MB allowed (limits.depsMaxMb)`);
      }
      const lockPath = join(buildDir, "package-lock.json");
      lockfile = existsSync(lockPath) ? readFileSync(lockPath, "utf-8") : undefined;
    }
  } else {
    rmSync(join(buildDir, "node_modules"), { recursive: true, force: true });
  }
  const result = { ...(lockfile ? { lockfile } : {}), ...(depsBytes ? { depsBytes } : {}) };
  writeFileSync(marker, JSON.stringify({ ...result, depsHash, builtAt: new Date().toISOString(), size: statSync(buildDir).size }));
  return result;
}
