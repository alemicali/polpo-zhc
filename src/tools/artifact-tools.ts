/**
 * Artifact tools for Polpo and agents: make and change documents, dashboards, designs and diagrams
 * that people keep and open in the Artifacts section (and from the chat they were made in).
 *
 * Agents get them with `artifact_*` in allowedTools; they change only their own artifacts. Polpo
 * changes any. Changes are Claude-artifact style: `update` (old_str → new_str) by default, `rewrite`
 * only when most of the content changes, plus ops / JSON Patch per part and artifact_from_file to
 * publish a large file written in the workspace. An html artifact reads data through the `polpo` bridge with its author's rights.
 */
import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve as resolvePath } from "node:path";
import {
  artifactLimits, artifactSize, ArtifactEditConflictError, ARTIFACT_WORKSPACE_GUIDE, formatArtifactBytes,
  type Artifact, type ArtifactType,
} from "@polpo-ai/core/artifacts";
import { isViewArtifactId } from "../server/artifact-runtime.js";
import type { LargeArtifactStore } from "../artifacts/store.js";
import { ARTIFACT_OPS_GUIDE, type ArtifactContentChange } from "../artifacts/ops.js";
import { ARTIFACT_READ_CHARS, changeArtifact, readArtifact, versionUsageLine } from "../artifacts/service.js";
import { detectArtifactType } from "../artifacts/detect.js";
import { isPathAllowed, resolveAllowedPaths } from "./path-sandbox.js";

/** What an html artifact can call, inside its page (documented to the authors). */
export const ARTIFACT_BRIDGE_DOC = [
  "Inside an html artifact a global `polpo` reads the instance's data sources (no network: fetch/XHR are blocked):",
  "  await polpo.sources()                       → [{ id, name, kind, description }]",
  "  await polpo.describe(sourceId)              → datasets: [{ name, kind, columns: [{ name, type }] }]",
  "  await polpo.query({ sourceId, dataset, fields?, filters?: [{ field, operator: eq|neq|gt|gte|lt|lte|contains|startsWith|in|isNull, value }],",
  "                      sort?: [{ field, direction }], groupBy?, aggregates?: [{ field, operation: count|sum|avg|min|max, as? }], limit? (≤1000) })",
  "  await polpo.sql(sourceId, \"select …\")       → read-only SQL (sqlite/postgres sources)",
  "  Both return { columns: [{ name, type }], rows: [{…}], meta: { rowCount, truncated, fetchedAt } }.",
  "  polpo.onRefresh(fn)                          → fn() runs when the data may have changed and every refreshSeconds; reload there.",
  "  polpo.theme                                  → \"light\" | \"dark\" (also on <html data-theme>); polpo.onTheme(fn) for changes.",
  "Data is read with the rights of the artifact's author. Scripts and styles may come from cdnjs.cloudflare.com, cdn.jsdelivr.net,",
  "unpkg.com (e.g. Chart.js, D3) and fonts from Google Fonts; everything else must be inline.",
].join("\n");

const updateItem = Type.Object({
  old_str: Type.String({ description: "Exact text in the current content (must occur once unless replace_all)" }),
  new_str: Type.String({ description: "The replacement (\"\" deletes old_str)" }),
  replace_all: Type.Optional(Type.Boolean({ description: "Replace every occurrence" })),
});

/** How agents change artifacts: the same words in every tool description. */
export const ARTIFACT_CHANGE_GUIDE = "Prefer command \"update\" (old_str → new_str, several with updates[]) for any change smaller than most of the content: it is cheap "
  + "and keeps the rest untouched. Use \"rewrite\" (content) only when most of it changes. append/prepend add text; patch (JSON Patch on the model) "
  + "and ops (per kind) change one tab, slide, sheet range, artboard or scene. For anything over a few KB never resend the whole content: "
  + "write it to a file and use artifact_from_file.";

export const ARTIFACT_TOOLS: Tool[] = [
  {
    name: "artifact_create",
    description: "Create an artifact that opens in the dashboard. Also supports drawings (svg) and diagrams (mermaid). Returns the id and link. Put type, kind and title before content so the workspace can open while writing. "
      + "For a large artifact (over ~20 KB) write the file with your file tools and publish it with artifact_from_file instead of sending the content here.\n"
      + ARTIFACT_WORKSPACE_GUIDE + "\n" + ARTIFACT_BRIDGE_DOC,
    parameters: Type.Object({
      title: Type.String(),
      type: Type.Union([Type.Literal("doc"), Type.Literal("html"), Type.Literal("svg"), Type.Literal("mermaid")]),
      kind: Type.Optional(Type.String({ description: "For html: slides, sheets, design, motion, dashboard, app, report, page" })),
      content: Type.String({ description: "Markdown, self-contained HTML, editable-workspace JSON, SVG or Mermaid source" }),
      description: Type.Optional(Type.String({ description: "One line: what it is for" })),
      sources: Type.Optional(Type.Array(Type.String(), { description: "Ids of the data sources it reads (html)" })),
      refreshSeconds: Type.Optional(Type.Number({ minimum: 10, description: "Reload its data every N seconds while open (html)" })),
      pinned: Type.Optional(Type.Boolean()),
    }),
  },
  {
    name: "artifact_update",
    description: "Change an artifact; every change is a new version people can step through and restore. Read it first (artifact_get), then put id and expectedVersion first. "
      + "command \"update\" (default with old_str): replace old_str with new_str — old_str must match the current content exactly once (or replace_all); "
      + "several changes: updates [{ old_str, new_str }], applied in sequence, all or nothing. command \"rewrite\": the whole new content (only when most of it changes). "
      + "command \"append\"/\"prepend\": text added at the end/beginning. patch: JSON Patch (RFC 6902) on the model (workspace JSON; { pages } of a design; { tabs } of a document). "
      + "ops: per-kind operations.\n" + ARTIFACT_OPS_GUIDE + "\n" + ARTIFACT_CHANGE_GUIDE
      + " The change is refused if someone changed it since expectedVersion: read it again and redo it.",
    parameters: Type.Object({
      id: Type.String({ description: "Artifact id (art_…)" }),
      expectedVersion: Type.Optional(Type.Integer({ minimum: 1, description: "Version read before preparing the change. A concurrent change requires reading again." })),
      command: Type.Optional(Type.Union([Type.Literal("update"), Type.Literal("rewrite"), Type.Literal("append"), Type.Literal("prepend")], { description: "update (default with old_str/updates), rewrite (default with content), append, prepend" })),
      old_str: Type.Optional(Type.String({ description: "update: the exact text to replace (unique in the content)" })),
      new_str: Type.Optional(Type.String({ description: "update: the replacement" })),
      replace_all: Type.Optional(Type.Boolean({ description: "update: replace every occurrence of old_str" })),
      updates: Type.Optional(Type.Array(updateItem, { description: "update: several replacements, applied in sequence (all or nothing)" })),
      content: Type.Optional(Type.String({ description: "rewrite: the whole new content" })),
      text: Type.Optional(Type.String({ description: "append/prepend: the text to add" })),
      patch: Type.Optional(Type.Array(Type.Object({
        op: Type.Union([Type.Literal("add"), Type.Literal("remove"), Type.Literal("replace"), Type.Literal("move"), Type.Literal("copy"), Type.Literal("test")]),
        path: Type.String({ description: "JSON pointer, e.g. /slides/2/title" }),
        from: Type.Optional(Type.String()),
        value: Type.Optional(Type.Unknown()),
      }), { description: "JSON Patch (RFC 6902) on the artifact's model" })),
      ops: Type.Optional(Type.Array(Type.Object({ op: Type.String() }, { additionalProperties: true }), { description: "Per-kind operations (see the description)" })),
      edits: Type.Optional(Type.Array(Type.Object({ find: Type.String(), replace: Type.String() }), { description: "Earlier form of updates (find → replace)" })),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      kind: Type.Optional(Type.String()),
      sources: Type.Optional(Type.Array(Type.String())),
      refreshSeconds: Type.Optional(Type.Number({ minimum: 10 })),
      note: Type.Optional(Type.String({ description: "What changed, in a few words (shown in the versions)" })),
    }),
  },
  {
    name: "artifact_from_file",
    description: "Create an artifact from a file you wrote in your workspace, or replace an artifact's content with it (id) — the way to publish a large artifact "
      + "(no size limit from your output: write the file with your file tools, then publish it). The type is detected from the extension and content "
      + "(.md doc, .html page or design, .svg, .mmd mermaid, .json slides/sheets/motion workspace) unless given. Replacing keeps the previous content as a version.",
    parameters: Type.Object({
      path: Type.String({ description: "The file, relative to your working directory or absolute inside your allowed folders" }),
      id: Type.Optional(Type.String({ description: "Replace the content of this artifact (art_…) instead of creating one" })),
      expectedVersion: Type.Optional(Type.Integer({ minimum: 1, description: "With id: the version you read" })),
      title: Type.Optional(Type.String()),
      type: Type.Optional(Type.Union([Type.Literal("doc"), Type.Literal("html"), Type.Literal("svg"), Type.Literal("mermaid")])),
      kind: Type.Optional(Type.String({ description: "For html: slides, sheets, design, motion, dashboard, app, report, page" })),
      description: Type.Optional(Type.String()),
      note: Type.Optional(Type.String({ description: "What changed (with id)" })),
    }),
  },
  {
    name: "artifact_get",
    description: "Read an artifact: details, versions and content. Small contents come whole; a large one shows its first 60,000 bytes and its outline "
      + "(tabs, slides, sheets, artboards, scenes with ids). Read more with offset/limit (bytes; continue from the end shown), the outline alone with outline: true, "
      + "or one part: tab, slide (or slides \"2-5\"), sheet (+ range \"A1:D20\"), board, page, scene — by id, name or position from 0.",
    parameters: Type.Object({
      id: Type.String(),
      version: Type.Optional(Type.Number({ description: "An earlier version number" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Byte to start from" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 240_000, description: "Bytes to read (default 60,000)" })),
      outline: Type.Optional(Type.Boolean({ description: "Only the structure (tabs, slides, sheets, boards, scenes)" })),
      tab: Type.Optional(Type.Union([Type.String(), Type.Integer()])),
      slide: Type.Optional(Type.Union([Type.String(), Type.Integer()])),
      slides: Type.Optional(Type.String({ description: "A range of slide positions, e.g. \"2-5\"" })),
      sheet: Type.Optional(Type.Union([Type.String(), Type.Integer()])),
      range: Type.Optional(Type.String({ description: "With sheet: cells like A1:D20" })),
      board: Type.Optional(Type.Union([Type.String(), Type.Integer()])),
      page: Type.Optional(Type.Union([Type.String(), Type.Integer()])),
      scene: Type.Optional(Type.Union([Type.String(), Type.Integer()])),
    }),
  },
  {
    name: "artifact_list",
    description: "List artifacts (newest first): id, type, kind, title, author, version, size. Agents see their own.",
    parameters: Type.Object({
      type: Type.Optional(Type.Union([Type.Literal("doc"), Type.Literal("html"), Type.Literal("svg"), Type.Literal("mermaid"), Type.Literal("view")])),
      q: Type.Optional(Type.String({ description: "Words in the title or description" })),
      sessionId: Type.Optional(Type.String({ description: "Only those made in this chat" })),
    }),
  },
  {
    name: "artifact_delete",
    description: "Delete an artifact and its versions.",
    parameters: Type.Object({ id: Type.String() }),
  },
];

export const ARTIFACT_TOOL_NAMES = ARTIFACT_TOOLS.map((t) => t.name);

/** A file the tool may publish: its local path (removed after use when temporary) and name. */
export interface ArtifactSourceFile {
  path: string;
  name: string;
  temporary?: boolean;
}

export interface ArtifactToolContext {
  store: LargeArtifactStore;
  /** "polpo" or the agent's name: the author of what it makes, and whose data rights it uses. */
  author: string;
  /** The chat this turn belongs to. */
  sessionId?: string;
  /** The task the agent is working on, and its mission: where what it makes came from. */
  taskId?: string;
  missionId?: string;
  emit?: (payload: { artifactId: string; action: "created" | "updated" | "deleted"; type: string; title: string; timestamp: string }) => void;
  /** A file of the agent's workspace (artifact_from_file), checked against its allowed folders. */
  readFile?: (path: string) => Promise<ArtifactSourceFile>;
}

const openPath = (id: string) => `/artifacts/${id}`;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

function line(a: Pick<Artifact, "id" | "type" | "kind" | "title" | "createdBy" | "version" | "updatedAt" | "taskId"> & { size?: number }): string {
  return `- ${a.id} [${a.type}${a.kind ? `/${a.kind}` : ""}] ${a.title} — by ${a.createdBy}, v${a.version}${typeof a.size === "number" ? `, ${formatArtifactBytes(a.size)}` : ""}, ${a.updatedAt.slice(0, 16).replace("T", " ")}${a.taskId ? `, from task ${a.taskId}` : ""}`;
}

async function ownArtifact(ctx: ArtifactToolContext, id: string): Promise<Artifact> {
  if (isViewArtifactId(id)) throw new Error("This is a data view: change it with the data tools, or make an html dashboard instead");
  const artifact = await ctx.store.get(id);
  if (!artifact) throw new Error(`No artifact ${id}`);
  if (ctx.author !== "polpo" && artifact.createdBy !== ctx.author) throw new Error(`Artifact ${id} belongs to ${artifact.createdBy}: you can change only your own`);
  return artifact;
}

/** The change request of artifact_update's arguments. */
function changeOf(args: Record<string, unknown>): ArtifactContentChange {
  const change: ArtifactContentChange = {};
  if (typeof args.command === "string") change.command = args.command as ArtifactContentChange["command"];
  for (const key of ["old_str", "new_str", "content", "text"] as const) if (typeof args[key] === "string") change[key] = args[key] as string;
  if (args.replace_all === true) change.replace_all = true;
  for (const key of ["updates", "edits", "patch", "ops"] as const) if (Array.isArray(args[key]) && (args[key] as unknown[]).length) (change as Record<string, unknown>)[key] = args[key];
  return change;
}

function friendly(err: unknown, id: string): Error {
  if (err instanceof ArtifactEditConflictError) return new Error(`Artifact ${id} changed meanwhile: read it again with artifact_get and redo the change`);
  return err instanceof Error ? err : new Error(String(err));
}

export async function executeArtifactTool(name: string, args: Record<string, unknown>, ctx: ArtifactToolContext): Promise<string> {
  const emit = (a: Artifact, action: "created" | "updated" | "deleted") =>
    ctx.emit?.({ artifactId: a.id, action, type: a.type, title: a.title, timestamp: new Date().toISOString() });
  switch (name) {
    case "artifact_create": {
      const artifact = await ctx.store.create({
        title: String(args.title ?? ""),
        type: String(args.type ?? "") as ArtifactType,
        content: String(args.content ?? ""),
        createdBy: ctx.author,
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
        ...(ctx.missionId ? { missionId: ctx.missionId } : {}),
        ...(str(args.kind) ? { kind: str(args.kind) } : {}),
        ...(str(args.description) ? { description: str(args.description) } : {}),
        ...(Array.isArray(args.sources) ? { sources: args.sources.map(String) } : {}),
        ...(typeof args.refreshSeconds === "number" ? { refreshSeconds: Math.max(10, Math.round(args.refreshSeconds)) } : {}),
        ...(args.pinned === true ? { pinned: true } : {}),
      });
      emit(artifact, "created");
      return `Created artifact ${artifact.id} (${artifact.type}${artifact.kind ? `/${artifact.kind}` : ""}, ${formatArtifactBytes(artifactSize(artifact))}): "${artifact.title}". Open: ${openPath(artifact.id)}`;
    }
    case "artifact_update": {
      const current = await ownArtifact(ctx, String(args.id ?? ""));
      const change = changeOf(args);
      const base = typeof args.expectedVersion === "number" && Number.isSafeInteger(args.expectedVersion) ? args.expectedVersion : undefined;
      if (base !== undefined && base !== current.version) {
        throw new Error(`Artifact ${current.id} changed since v${base} (now v${current.version}): read it again with artifact_get and redo the change`);
      }
      const rewrite = change.command === "rewrite" || (change.content !== undefined && !change.command);
      if (rewrite && base === undefined && artifactSize(current) > ARTIFACT_READ_CHARS) {
        throw new Error(`Artifact ${current.id} is longer than artifact_get shows (${formatArtifactBytes(artifactSize(current))}): change it with command update (old_str → new_str) or ops, or pass expectedVersion to rewrite the whole content`);
      }
      try {
        const { artifact, summary } = await changeArtifact(ctx.store, current, change, {
          expectedVersion: base ?? current.version,
          ...(typeof args.title === "string" ? { title: args.title } : {}),
          ...(typeof args.description === "string" ? { description: args.description } : {}),
          ...(typeof args.kind === "string" ? { kind: args.kind } : {}),
          ...(Array.isArray(args.sources) ? { sources: args.sources.map(String) } : {}),
          ...(typeof args.refreshSeconds === "number" ? { refreshSeconds: Math.max(10, Math.round(args.refreshSeconds)) } : {}),
          author: ctx.author,
          ...(str(args.note) ? { note: str(args.note) } : {}),
        });
        emit(artifact, "updated");
        return `Updated artifact ${artifact.id} (now v${artifact.version}${summary ? `, ${summary}` : ""}, ${formatArtifactBytes(artifactSize(artifact))}): "${artifact.title}". Open: ${openPath(artifact.id)}`;
      } catch (err) {
        throw friendly(err, current.id);
      }
    }
    case "artifact_from_file": {
      if (!ctx.readFile) throw new Error("Files cannot be published from here");
      const path = str(args.path);
      if (!path) throw new Error("path is required: the file to publish");
      const file = await ctx.readFile(path);
      try {
        const id = str(args.id);
        if (id) {
          const current = await ownArtifact(ctx, id);
          const base = typeof args.expectedVersion === "number" ? args.expectedVersion : undefined;
          if (base !== undefined && base !== current.version) throw new Error(`Artifact ${id} changed since v${base} (now v${current.version}): read it again with artifact_get`);
          const artifact = await ctx.store.update(id, {
            contentFile: { path: file.path, move: file.temporary },
            expectedVersion: base ?? current.version, author: ctx.author,
            note: str(args.note) ?? `Content from ${file.name}`,
            ...(str(args.title) ? { title: str(args.title) } : {}),
            ...(str(args.kind) ? { kind: str(args.kind) } : {}),
            ...(typeof args.description === "string" ? { description: args.description } : {}),
          }).catch((err) => { throw friendly(err, id); });
          if (!artifact) throw new Error(`No artifact ${id}`);
          emit(artifact, "updated");
          return `Updated artifact ${artifact.id} from ${file.name} (now v${artifact.version}, ${formatArtifactBytes(artifactSize(artifact))}): "${artifact.title}". Open: ${openPath(artifact.id)}`;
        }
        let type = str(args.type) as ArtifactType | undefined;
        let kind = str(args.kind);
        if (!type) {
          const handle = await open(file.path, "r");
          const head = Buffer.alloc(64 * 1024);
          const { bytesRead } = await handle.read(head, 0, head.length, 0).finally(() => handle.close());
          const detected = detectArtifactType({ filename: file.name, head: head.subarray(0, bytesRead).toString("utf-8") });
          type = detected.type;
          kind ??= detected.kind;
        }
        const artifact = await ctx.store.create({
          title: str(args.title) ?? file.name.replace(/\.[^.]+$/, ""),
          type, content: "", contentFile: { path: file.path, move: file.temporary },
          createdBy: ctx.author,
          ...(kind ? { kind } : {}),
          ...(str(args.description) ? { description: str(args.description) } : {}),
          ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
          ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
          ...(ctx.missionId ? { missionId: ctx.missionId } : {}),
        });
        emit(artifact, "created");
        return `Created artifact ${artifact.id} from ${file.name} (${artifact.type}${artifact.kind ? `/${artifact.kind}` : ""}, ${formatArtifactBytes(artifactSize(artifact))}): "${artifact.title}". Open: ${openPath(artifact.id)}`;
      } finally {
        if (file.temporary) await rm(file.path, { force: true }).catch(() => {});
      }
    }
    case "artifact_get": {
      const id = String(args.id ?? "");
      const artifact = isViewArtifactId(id) ? undefined : await ctx.store.get(id);
      if (!artifact) throw new Error(`No artifact ${id}`);
      if (ctx.author !== "polpo" && artifact.createdBy !== ctx.author) throw new Error(`Artifact ${id} belongs to ${artifact.createdBy}`);
      const version = typeof args.version === "number" && args.version !== artifact.version ? args.version : undefined;
      const sel = (v: unknown) => (typeof v === "string" || typeof v === "number" ? v : undefined);
      const read = await readArtifact(ctx.store, artifact, {
        ...(version !== undefined ? { version } : {}),
        ...(typeof args.offset === "number" ? { offset: args.offset } : {}),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        ...(args.outline === true ? { outline: true } : {}),
        part: {
          ...(sel(args.tab) !== undefined ? { tab: sel(args.tab) } : {}), ...(sel(args.slide) !== undefined ? { slide: sel(args.slide) } : {}),
          ...(str(args.slides) ? { slides: str(args.slides) } : {}), ...(sel(args.sheet) !== undefined ? { sheet: sel(args.sheet) } : {}),
          ...(str(args.range) ? { range: str(args.range) } : {}), ...(sel(args.board) !== undefined ? { board: sel(args.board) } : {}),
          ...(sel(args.page) !== undefined ? { page: sel(args.page) } : {}), ...(sel(args.scene) !== undefined ? { scene: sel(args.scene) } : {}),
        },
      });
      const range = read.start !== undefined && (read.start > 0 || read.more)
        ? ` (bytes ${read.start}–${read.end} of ${read.size}${read.more ? `; more: offset ${read.end}` : ""})` : "";
      return [
        line({ ...artifact, size: artifactSize(artifact) }),
        artifact.description ? `Description: ${artifact.description}` : "",
        artifact.sources?.length ? `Sources: ${artifact.sources.join(", ")}` : "",
        `Versions: v${artifact.version} (current)${artifact.versions.length ? `, ${artifact.versions.map((v) => `v${v.version}`).join(", ")}` : ""} — ${versionUsageLine(artifact)}`,
        read.outline ? `--- outline ---\n${read.outline}` : "",
        `--- content${version !== undefined ? ` of v${version}` : ""}${range} ---`,
        read.text,
      ].filter(Boolean).join("\n");
    }
    case "artifact_list": {
      const list = await ctx.store.list({
        ...(typeof args.type === "string" ? { type: args.type as ArtifactType } : {}),
        ...(str(args.q) ? { q: str(args.q) } : {}),
        ...(str(args.sessionId) ? { sessionId: str(args.sessionId) } : {}),
        ...(ctx.author !== "polpo" ? { createdBy: ctx.author } : {}),
      });
      return list.length ? list.slice(0, 50).map(line).join("\n") : "No artifacts.";
    }
    case "artifact_delete": {
      const artifact = await ownArtifact(ctx, String(args.id ?? ""));
      await ctx.store.delete(artifact.id);
      emit(artifact, "deleted");
      return `Deleted artifact ${artifact.id} ("${artifact.title}").`;
    }
    default:
      throw new Error(`Unknown artifact tool ${name}`);
  }
}

/**
 * A reader of the files an agent may publish (artifact_from_file): inside its allowed folders, read
 * from the local disk, or copied out of a remote workspace (sandbox) into a temporary file.
 */
export function workspaceFileReader(options: {
  cwd: string;
  allowedPaths?: string[];
  tempDir: string;
  /** A remote workspace's files (a sandbox); local files otherwise. */
  remote?: { readFileBuffer(path: string): Promise<Uint8Array> };
}): (path: string) => Promise<ArtifactSourceFile> {
  return async (requested) => {
    const path = isAbsolute(requested) ? requested : resolvePath(options.cwd, requested);
    const allowed = resolveAllowedPaths(options.cwd, options.allowedPaths);
    if (!isPathAllowed(path, allowed)) throw new Error(`"${requested}" is outside your allowed folders`);
    const name = basename(path);
    if (options.remote) {
      const bytes = await options.remote.readFileBuffer(path).catch(() => { throw new Error(`No file ${requested} in your workspace`); });
      const limit = artifactLimits().maxBytes;
      if (bytes.byteLength > limit) throw new Error(`${requested} is over the artifact limit (${formatArtifactBytes(limit)})`);
      await mkdir(options.tempDir, { recursive: true });
      const local = join(options.tempDir, `from-file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      await writeFile(local, bytes, { mode: 0o600 });
      return { path: local, name, temporary: true };
    }
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`No file ${requested} in your workspace${info?.isDirectory() ? " (it is a folder)" : ""}`);
    return { path, name };
  };
}

/** The artifact tools of an agent with `artifact_*` (or some of them) in its allowedTools. */
export function createArtifactAgentTools(allowedTools: string[] | undefined, context: () => ArtifactToolContext): AgentTool<any>[] {
  if (!allowedTools?.some((p) => p === "artifact_*" || p.startsWith("artifact_"))) return [];
  const allowed = ARTIFACT_TOOLS.filter((t) => allowedTools.some((p) => p === t.name || (p.endsWith("*") && t.name.startsWith(p.slice(0, -1)))));
  return allowed.map((definition) => ({
    ...definition,
    label: `Artifact ${definition.name.slice("artifact_".length).replace(/_/g, " ")}`,
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const text = await executeArtifactTool(definition.name, params, context());
        const artifactId = /\b(art_[\w-]+)/.exec(text)?.[1];
        return { content: [{ type: "text" as const, text }], details: artifactId ? { artifactId } : {} };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], details: { error: true } };
      }
    },
  })) as AgentTool<any>[];
}
