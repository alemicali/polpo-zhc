/**
 * Tools that run on this machine but work on the agent's files ("bridged" in TOOL_PLACEMENT:
 * pdf/excel/docx, downloads, generated images and audio, screenshots…) when the files live in a
 * remote VM: before the tool runs, the files its arguments point to are fetched from the VM;
 * after it ran, the files it created or changed here are copied into the VM. With a local
 * sandbox (same disk) nothing happens.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { toolPlacement, type Workspace } from "@polpo-ai/core/sandbox";

/** Argument names that hold paths (any casing): "path", "filePath", "outputPath", "files"… */
const PATH_ARG = /(path|file|files|dir|output|input|dest|destination|source|attachment|save|target)$/i;
const SKIP_DIRS = ["node_modules", ".polpo", ".git", ".venv", "__pycache__"];

function within(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep));
}

/** String values of path-like arguments, resolved against cwd. */
export function pathArguments(args: unknown, cwd: string): string[] {
  const out: string[] = [];
  const visit = (value: unknown, key: string) => {
    if (typeof value === "string" && PATH_ARG.test(key) && value.trim() && !/^[a-z]+:\/\//i.test(value)) {
      out.push(isAbsolute(value) ? resolve(value) : resolve(cwd, value));
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) visit(v, k);
    }
  };
  if (args && typeof args === "object") for (const [k, v] of Object.entries(args)) visit(v, k);
  return [...new Set(out)];
}

/** Files under roots changed after `stamp` (host side). */
function changedSince(stamp: string, roots: string[]): string[] {
  const existing = roots.filter((r) => existsSync(r));
  if (!existing.length) return [];
  const prune = SKIP_DIRS.flatMap((d, i) => [...(i ? ["-o"] : []), "-name", d]);
  const r = spawnSync("find", [...existing, "(", ...prune, ")", "-prune", "-o", "-type", "f", "-newer", stamp, "-print0"], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
  return r.stdout.toString("utf8").split("\0").filter(Boolean);
}

export interface BridgeOptions {
  /** The agent's working directory (relative paths resolve here). */
  cwd: string;
  /** Directories that live in the VM: the working directory and the writable paths. */
  roots: string[];
  /** The workspace, when the tool runs; undefined or a local workspace = nothing to bridge. */
  workspace: () => Promise<Workspace | undefined>;
  onWarning?: (message: string) => void;
}

type AnyTool = { name: string; execute: (...args: any[]) => Promise<any> };

/** Wrap the "bridged" tools so their files follow the remote VM. Other tools are returned as is. */
export function bridgeHostTools<T extends AnyTool>(tools: T[], opts: BridgeOptions): T[] {
  const roots = opts.roots.map((r) => resolve(r));
  return tools.map((tool) => {
    if (toolPlacement(tool.name) !== "bridged") return tool;
    const execute = tool.execute.bind(tool);
    return {
      ...tool,
      execute: async (...callArgs: any[]) => {
        const workspace = await opts.workspace().catch(() => undefined);
        if (!workspace || (workspace.provider !== "daytona" && workspace.provider !== "e2b")) return execute(...callArgs);
        const params = callArgs[1];
        // in: the files the arguments point to, from the VM (when they exist there)
        const fetched = new Set<string>();
        for (const path of pathArguments(params, opts.cwd).filter((p) => within(p, roots))) {
          const stat = await workspace.stat(path).catch(() => null);
          if (stat?.type !== "file") continue;
          await workspace.download(path, path).then(() => fetched.add(path)).catch((err) => opts.onWarning?.(`Could not fetch ${path} from the sandbox: ${(err as Error).message}`));
        }
        // file times move in coarse steps: a stamp in the past catches writes in the same tick
        const stampDir = mkdtempSync(join(tmpdir(), "polpo-bridge-"));
        const stamp = join(stampDir, "stamp");
        writeFileSync(stamp, "");
        const past = new Date(Date.now() - 2000);
        utimesSync(stamp, past, past);
        try {
          return await execute(...callArgs);
        } finally {
          // out: what the tool created or changed here, into the VM
          for (const path of changedSince(stamp, roots).filter((p) => !fetched.has(p))) {
            await workspace.upload(path, path).catch((err) => opts.onWarning?.(`Could not copy ${path} into the sandbox: ${(err as Error).message}`));
          }
          rmSync(stampDir, { recursive: true, force: true });
        }
      },
    } as T;
  });
}
