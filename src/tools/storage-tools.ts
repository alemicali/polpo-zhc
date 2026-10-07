/**
 * storage_* tools: S3-compatible buckets from the agent's point of view, run on the host with
 * the bucket's credentials (which never reach the agent or a sandbox).
 *
 * Agents get them with allowedTools "storage_*" (or single names) and only see the buckets they
 * have a grant on, within the grant's prefix and access. Polpo (the orchestrator) has full access
 * plus admin tools (list entries with mount status, mount, unmount).
 */

import { Type } from "@sinclair/typebox";
import type { Tool } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { VaultStore } from "../core/vault-store.js";
import { getStorageRuntime, type StorageEventEmitter } from "../storage/runtime.js";
import { isPathAllowed, resolveAllowedPaths } from "./path-sandbox.js";
import { resolveToolOutputDir } from "./tool-output.js";

const StorageParam = Type.String({ description: "Storage slug (or id) from storage_list without arguments" });

export const STORAGE_AGENT_TOOL_NAMES = ["storage_list", "storage_read", "storage_write", "storage_delete", "storage_presign"] as const;
export const STORAGE_ADMIN_TOOL_NAMES = ["storage_list_entries", "storage_mount", "storage_unmount"] as const;

export const STORAGE_AGENT_TOOLS: Tool[] = [
  {
    name: "storage_list",
    description: "List storage buckets you can use (call without `storage`), or the files and folders in one of them. Paths are relative to the bucket root you see; your grant may limit you to a prefix.",
    parameters: Type.Object({
      storage: Type.Optional(StorageParam),
      prefix: Type.Optional(Type.String({ description: 'Folder to list, e.g. "reports/2026/" (default: the root of what you can see)' })),
      recursive: Type.Optional(Type.Boolean({ description: "List every file below the prefix instead of one level (default false)" })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 1000, description: "Maximum items (default 200)" })),
    }),
  },
  {
    name: "storage_read",
    description: "Read a file from a storage bucket. Text files up to 256 KB are returned inline; larger or binary files are saved to a local file whose path is returned (read it with your file tools).",
    parameters: Type.Object({
      storage: StorageParam,
      path: Type.String({ description: "File path inside the bucket, e.g. reports/q3.csv" }),
      maxBytes: Type.Optional(Type.Number({ minimum: 1, description: "Inline text limit in bytes (max 262144)" })),
    }),
  },
  {
    name: "storage_write",
    description: "Write a file to a storage bucket, from `content` (text) or from a local file (`fromFile`, inside your allowed folders). Overwrites an existing file. Needs a write grant.",
    parameters: Type.Object({
      storage: StorageParam,
      path: Type.String({ description: "Destination path inside the bucket" }),
      content: Type.Optional(Type.String({ description: "Text content to write" })),
      fromFile: Type.Optional(Type.String({ description: "Local file to upload instead of content" })),
      contentType: Type.Optional(Type.String({ description: "MIME type (guessed from the extension when omitted)" })),
    }),
  },
  {
    name: "storage_delete",
    description: "Delete a file from a storage bucket. Needs a write grant. This cannot be undone.",
    parameters: Type.Object({ storage: StorageParam, path: Type.String() }),
  },
  {
    name: "storage_presign",
    description: "Create a temporary download link for a file in a storage bucket (anyone with the link can download it until it expires).",
    parameters: Type.Object({
      storage: StorageParam,
      path: Type.String(),
      expiresInSeconds: Type.Optional(Type.Number({ minimum: 60, maximum: 604800, description: "Validity (default 3600, max 7 days)" })),
    }),
  },
];

export const STORAGE_ADMIN_TOOLS: Tool[] = [
  {
    name: "storage_list_entries",
    description: "List registered storage buckets with their settings, agent grants, the vault entries holding their keys (owner + service) and whether each resolves (never values), and mount status on this server.",
    parameters: Type.Object({}),
  },
  {
    name: "storage_mount",
    description: "Mount (or remount) a storage bucket on this server so agents can use it as a folder.",
    parameters: Type.Object({ storage: StorageParam }),
  },
  {
    name: "storage_unmount",
    description: "Unmount a storage bucket on this server (it stays registered).",
    parameters: Type.Object({ storage: StorageParam }),
  },
];

/** Polpo's storage tools: the object tools with full access plus the admin tools. */
export const STORAGE_ORCHESTRATOR_TOOLS: Tool[] = [...STORAGE_ADMIN_TOOLS, ...STORAGE_AGENT_TOOLS];

export interface StorageToolContext {
  polpoDir: string;
  /** Agent name; undefined = Polpo itself (full access, admin tools). */
  agent?: string;
  vaultStore?: VaultStore;
  emit?: StorageEventEmitter;
  /** Emits file:changed for writes and deletes in a mounted bucket. */
  emitFileChanged?: (payload: { path: string; dir: string; action: "created" | "modified" | "deleted"; source: "agent" | "chat" }) => void;
  /** Where large reads are saved (default: the agent's tool-output folder). */
  saveDir?: string;
  /** Local files storage_write may upload (default: cwd). */
  cwd?: string;
  allowedPaths?: string[];
  outputDir?: string;
}

export async function executeStorageTool(name: string, args: Record<string, unknown>, ctx: StorageToolContext): Promise<string> {
  const runtime = getStorageRuntime(ctx.polpoDir, ctx.vaultStore, ctx.emit);
  const agent = ctx.agent;
  const storage = typeof args.storage === "string" ? args.storage.trim() : "";
  const requireStorage = () => { if (!storage) throw new Error("`storage` is required"); return storage; };
  const saveDir = ctx.saveDir ?? resolveToolOutputDir({ outputDir: ctx.outputDir, polpoDir: ctx.polpoDir, agentName: agent ?? "polpo" });

  switch (name) {
    case "storage_list": {
      if (!storage) return json({ storages: await runtime.accessibleEntries(agent) });
      return json(await runtime.listObjects(agent, storage, {
        prefix: optionalString(args.prefix), recursive: args.recursive === true, limit: optionalNumber(args.limit),
      }));
    }
    case "storage_read": {
      const result = await runtime.readObject(agent, requireStorage(), String(args.path ?? ""), { saveDir, maxBytes: optionalNumber(args.maxBytes) });
      if (result.kind === "text") return result.text;
      return json({ ...result, note: "The file is larger than the inline limit or binary: it was saved locally, read it from savedTo." });
    }
    case "storage_write": {
      const content = typeof args.content === "string" ? args.content : undefined;
      const fromFile = optionalString(args.fromFile);
      if ((content === undefined) === (fromFile === undefined)) throw new Error("Pass either `content` or `fromFile`");
      let source: { text: string } | { file: string };
      if (fromFile !== undefined) {
        const cwd = ctx.cwd ?? process.cwd();
        const file = isAbsolute(fromFile) ? fromFile : resolve(cwd, fromFile);
        const allowed = [...resolveAllowedPaths(cwd, ctx.allowedPaths), ...(ctx.outputDir ? [ctx.outputDir] : []), saveDir];
        if (!isPathAllowed(file, allowed)) throw new Error(`"${fromFile}" is outside your allowed folders`);
        source = { file };
      } else source = { text: content! };
      const entry = await runtime.entry(requireStorage());
      const before = entry && ctx.emitFileChanged ? runtime.hostPathOf(entry, String(args.path ?? "")) : undefined;
      const existed = before ? existsSync(before) : false;
      const written = await runtime.writeObject(agent, storage, String(args.path ?? ""), source, optionalString(args.contentType));
      if (entry) fileChanged(ctx, runtime.hostPathOf(entry, written.path), existed ? "modified" : "created");
      return json({ written: true, storage: entry?.slug ?? storage, ...written });
    }
    case "storage_delete": {
      const deleted = await runtime.deleteObject(agent, requireStorage(), String(args.path ?? ""));
      const entry = await runtime.entry(storage);
      if (entry) fileChanged(ctx, runtime.hostPathOf(entry, deleted.path), "deleted");
      return json({ deleted: true, ...deleted });
    }
    case "storage_presign":
      return json(await runtime.presign(agent, requireStorage(), String(args.path ?? ""), optionalNumber(args.expiresInSeconds)));
    case "storage_list_entries":
      if (agent !== undefined) throw new Error("storage_list_entries is reserved to Polpo");
      return json(await runtime.list());
    case "storage_mount":
      if (agent !== undefined) throw new Error("storage_mount is reserved to Polpo");
      return json(await runtime.mount(requireStorage()));
    case "storage_unmount":
      if (agent !== undefined) throw new Error("storage_unmount is reserved to Polpo");
      return json(await runtime.unmount(requireStorage()));
    default:
      throw new Error(`Unknown storage tool "${name}"`);
  }
}

function fileChanged(ctx: StorageToolContext, path: string | undefined, action: "created" | "modified" | "deleted"): void {
  if (!path || !ctx.emitFileChanged) return;
  ctx.emitFileChanged({ path, dir: dirname(path), action, source: "agent" });
}

/**
 * Agent tools for allowedTools patterns ("storage_*", "storage_read", …). Admin tools are never
 * given to agents.
 */
export function createStorageAgentTools(
  polpoDir: string,
  agent: string,
  allowedTools: string[] | undefined,
  options: Omit<StorageToolContext, "polpoDir" | "agent"> = {},
): AgentTool<any>[] {
  if (!allowedTools?.some((pattern) => pattern === "storage_*" || pattern.startsWith("storage_"))) return [];
  const definitions = STORAGE_AGENT_TOOLS.filter((tool) => allowedTools.some((pattern) =>
    pattern === tool.name || (pattern.endsWith("*") && tool.name.startsWith(pattern.slice(0, -1)))));
  return definitions.map((definition) => ({
    ...definition,
    label: `Storage ${definition.name.slice("storage_".length)}`,
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      try {
        const text = await executeStorageTool(definition.name, params, { ...options, polpoDir, agent });
        return { content: [{ type: "text" as const, text }], details: { storage: params.storage, path: params.path } };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], details: { error: true } };
      }
    },
  })) as AgentTool<any>[];
}

function optionalString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function optionalNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function json(value: unknown): string { return JSON.stringify(value, null, 2); }
