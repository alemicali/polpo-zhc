/**
 * Artifact tools for Polpo and agents: make and change documents, dashboards, designs and diagrams
 * that people keep and open in the Artifacts section (and from the chat they were made in).
 *
 * Agents get them with `artifact_*` in allowedTools; they change only their own artifacts. Polpo
 * changes any. An html artifact reads data through the `polpo` bridge with its author's rights.
 */
import { Type } from "@sinclair/typebox";
import type { Tool } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { applyArtifactEdits, type Artifact, type ArtifactStore, type ArtifactType } from "@polpo-ai/core/artifacts";
import { isViewArtifactId } from "../server/artifact-runtime.js";

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

const editsParam = Type.Optional(Type.Array(Type.Object({
  find: Type.String({ description: "Exact text in the current content (must occur once)" }),
  replace: Type.String(),
}), { description: "Change parts of the content instead of rewriting it" }));

export const ARTIFACT_TOOLS: Tool[] = [
  {
    name: "artifact_create",
    description: "Make an artifact people keep and open in the Artifacts section: a document (doc, Markdown), a dashboard, design, "
      + "report or small app (html: one self-contained page), a drawing (svg) or a diagram (mermaid). Returns its id and where to open it.\n"
      + ARTIFACT_BRIDGE_DOC,
    parameters: Type.Object({
      title: Type.String(),
      type: Type.Union([Type.Literal("doc"), Type.Literal("html"), Type.Literal("svg"), Type.Literal("mermaid")]),
      content: Type.String({ description: "Markdown, a complete HTML page, an <svg>, or Mermaid source" }),
      kind: Type.Optional(Type.String({ description: "For html: dashboard, design, app, report, page" })),
      description: Type.Optional(Type.String({ description: "One line: what it is for" })),
      sources: Type.Optional(Type.Array(Type.String(), { description: "Ids of the data sources it reads (html)" })),
      refreshSeconds: Type.Optional(Type.Number({ minimum: 10, description: "Reload its data every N seconds while open (html)" })),
      pinned: Type.Optional(Type.Boolean()),
    }),
  },
  {
    name: "artifact_update",
    description: "Change an artifact: new content (whole, or edits that find and replace parts), title, description, sources, refresh. "
      + "The previous content is kept as a version (people can go back to it).",
    parameters: Type.Object({
      id: Type.String({ description: "Artifact id (art_…)" }),
      content: Type.Optional(Type.String({ description: "The whole new content" })),
      edits: editsParam,
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      kind: Type.Optional(Type.String()),
      sources: Type.Optional(Type.Array(Type.String())),
      refreshSeconds: Type.Optional(Type.Number({ minimum: 10 })),
      note: Type.Optional(Type.String({ description: "What changed, in a few words (shown in the versions)" })),
    }),
  },
  {
    name: "artifact_get",
    description: "Read an artifact: its content (or an earlier version's) and details.",
    parameters: Type.Object({
      id: Type.String(),
      version: Type.Optional(Type.Number({ description: "An earlier version number" })),
    }),
  },
  {
    name: "artifact_list",
    description: "List artifacts (newest first): id, type, kind, title, author, version. Agents see their own.",
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

export interface ArtifactToolContext {
  store: ArtifactStore;
  /** "polpo" or the agent's name: the author of what it makes, and whose data rights it uses. */
  author: string;
  /** The chat this turn belongs to. */
  sessionId?: string;
  emit?: (payload: { artifactId: string; action: "created" | "updated" | "deleted"; type: string; title: string; timestamp: string }) => void;
}

const MAX_CONTENT_IN_RESULT = 60_000;
const openPath = (id: string) => `/artifacts/${id}`;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

function line(a: Pick<Artifact, "id" | "type" | "kind" | "title" | "createdBy" | "version" | "updatedAt">): string {
  return `- ${a.id} [${a.type}${a.kind ? `/${a.kind}` : ""}] ${a.title} — by ${a.createdBy}, v${a.version}, ${a.updatedAt.slice(0, 16).replace("T", " ")}`;
}

async function ownArtifact(ctx: ArtifactToolContext, id: string): Promise<Artifact> {
  if (isViewArtifactId(id)) throw new Error("This is a data view: change it with the data tools, or make an html dashboard instead");
  const artifact = await ctx.store.get(id);
  if (!artifact) throw new Error(`No artifact ${id}`);
  if (ctx.author !== "polpo" && artifact.createdBy !== ctx.author) throw new Error(`Artifact ${id} belongs to ${artifact.createdBy}: you can change only your own`);
  return artifact;
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
        ...(str(args.kind) ? { kind: str(args.kind) } : {}),
        ...(str(args.description) ? { description: str(args.description) } : {}),
        ...(Array.isArray(args.sources) ? { sources: args.sources.map(String) } : {}),
        ...(typeof args.refreshSeconds === "number" ? { refreshSeconds: Math.max(10, Math.round(args.refreshSeconds)) } : {}),
        ...(args.pinned === true ? { pinned: true } : {}),
      });
      emit(artifact, "created");
      return `Created artifact ${artifact.id} (${artifact.type}${artifact.kind ? `/${artifact.kind}` : ""}): "${artifact.title}". Open: ${openPath(artifact.id)}`;
    }
    case "artifact_update": {
      const current = await ownArtifact(ctx, String(args.id ?? ""));
      const edits = Array.isArray(args.edits) ? (args.edits as Array<{ find: string; replace: string }>) : undefined;
      if (typeof args.content === "string" && edits?.length) throw new Error("Give either content or edits, not both");
      const content = typeof args.content === "string" ? args.content : edits?.length ? applyArtifactEdits(current.content, edits) : undefined;
      const artifact = await ctx.store.update(current.id, {
        ...(content !== undefined ? { content } : {}),
        ...(typeof args.title === "string" ? { title: args.title } : {}),
        ...(typeof args.description === "string" ? { description: args.description } : {}),
        ...(typeof args.kind === "string" ? { kind: args.kind } : {}),
        ...(Array.isArray(args.sources) ? { sources: args.sources.map(String) } : {}),
        ...(typeof args.refreshSeconds === "number" ? { refreshSeconds: Math.max(10, Math.round(args.refreshSeconds)) } : {}),
        author: ctx.author,
        ...(str(args.note) ? { note: str(args.note) } : {}),
      });
      if (!artifact) throw new Error(`No artifact ${current.id}`);
      emit(artifact, "updated");
      return `Updated artifact ${artifact.id} (now v${artifact.version}): "${artifact.title}". Open: ${openPath(artifact.id)}`;
    }
    case "artifact_get": {
      const id = String(args.id ?? "");
      const artifact = isViewArtifactId(id) ? undefined : await ctx.store.get(id);
      if (!artifact) throw new Error(`No artifact ${id}`);
      if (ctx.author !== "polpo" && artifact.createdBy !== ctx.author) throw new Error(`Artifact ${id} belongs to ${artifact.createdBy}`);
      const wanted = typeof args.version === "number" && args.version !== artifact.version
        ? artifact.versions.find((v) => v.version === args.version)
        : undefined;
      if (typeof args.version === "number" && args.version !== artifact.version && !wanted) throw new Error(`No version ${args.version} (current v${artifact.version}; kept: ${artifact.versions.map((v) => v.version).join(", ") || "none"})`);
      const content = wanted?.content ?? artifact.content;
      const clipped = content.length > MAX_CONTENT_IN_RESULT ? `${content.slice(0, MAX_CONTENT_IN_RESULT)}\n… (${content.length - MAX_CONTENT_IN_RESULT} more characters)` : content;
      return [
        line(artifact),
        artifact.description ? `Description: ${artifact.description}` : "",
        artifact.sources?.length ? `Sources: ${artifact.sources.join(", ")}` : "",
        `Versions: v${artifact.version} (current)${artifact.versions.length ? `, ${artifact.versions.map((v) => `v${v.version}`).join(", ")}` : ""}`,
        `--- content${wanted ? ` of v${wanted.version}` : ""} ---`,
        clipped,
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

/** The artifact tools of an agent with `artifact_*` (or some of them) in its allowedTools. */
export function createArtifactAgentTools(allowedTools: string[] | undefined, context: () => ArtifactToolContext): AgentTool<any>[] {
  if (!allowedTools?.some((p) => p === "artifact_*" || p.startsWith("artifact_"))) return [];
  const allowed = ARTIFACT_TOOLS.filter((t) => allowedTools.some((p) => p === t.name || (p.endsWith("*") && t.name.startsWith(p.slice(0, -1)))));
  return allowed.map((definition) => ({
    ...definition,
    label: `Artifact ${definition.name.slice("artifact_".length)}`,
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
