/**
 * Artifacts REST API — documents, dashboards, designs and diagrams that agents and people make.
 *
 *   GET    /artifacts                          list (?type, kind, createdBy, sessionId, q); former data views included as type "view"
 *   GET    /artifacts/usage                    storage used by every artifact of the instance, and the limits in force
 *   POST   /artifacts                          create { title, type, content, kind?, description?, sources?, refreshSeconds?, pinned?, tags? } (JSON, up to 32 MB)
 *   POST   /artifacts/upload                   create from a file: raw body (?title, type, kind, filename) or multipart (file + fields); type detected when not given
 *   POST   /artifacts/uploads                  start or continue an upload in parts: raw body (?append_to, more, filename) or JSON { base64, append_to?, more?, filename? } | { path }
 *   POST   /artifacts/uploads/:uploadId/finalize  { id?, expectedVersion?, title?, type?, kind?, description?, note? }: create, or replace the content of id
 *   GET    /artifacts/:id                      one artifact with its content (omitted over 10 MB: contentOmitted, read /content) and versions (?preview=1 for a compact preview)
 *   GET    /artifacts/:id/content              the content as a file, with Range support (?version, ?download=1)
 *   GET    /artifacts/:id/read                 a part: ?offset&limit (bytes), ?outline=1, or ?tab | slide | slides | sheet [&range] | board | page | scene
 *   GET    /artifacts/:id/versions/:version    one version with its content
 *   PUT    /artifacts/:id/content              replace the content from a file: raw body or multipart (?expectedVersion or x-expected-version)
 *   PATCH  /artifacts/:id                      change it: title, pinned… and the content: command update (old_str/new_str, updates[]),
 *                                              rewrite (content), append/prepend, patch (JSON Patch on the model) or ops (per kind);
 *                                              expectedVersion: 409 when it changed meanwhile
 *   POST   /artifacts/:id/duplicate            a copy of it, or of one of its versions { version? }
 *   POST   /artifacts/:id/restore/:version     make an earlier version current (as a new version)
 *   DELETE /artifacts/:id                      delete it
 *   POST   /artifacts/:id/data                 the data bridge of an html artifact: { method: sources|describe|query|sql, params }
 *
 * Former data views ("view:<id>") are read-only here: they change with the data tools or on the Data page.
 */
import { realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import {
  artifactLimits, artifactSize, artifactVersionUsage, ArtifactEditConflictError, formatArtifactBytes, isArtifactType, matchesArtifactFilter,
  ARTIFACT_VIEWER_BYTES,
  type Artifact, type ArtifactFilter, type ArtifactType,
} from "@polpo-ai/core/artifacts";
import type { DataRuntime } from "../data-runtime.js";
import { isViewArtifactId, runArtifactDataCall, viewAsArtifact, viewAsSummary, VIEW_ARTIFACT_PREFIX, type ArtifactDataMethod } from "../artifact-runtime.js";
import type { LargeArtifactStore } from "../../artifacts/store.js";
import { ArtifactQuotaError, ArtifactTooLargeToEditError } from "../../artifacts/store.js";
import { ArtifactContentError, UploadTooLargeError, type StagedUpload } from "../../artifacts/blobs.js";
import { ArtifactChangeError, type ArtifactContentChange, type ArtifactPartSelector } from "../../artifacts/ops.js";
import { detectArtifactType, UnsupportedArtifactFileError } from "../../artifacts/detect.js";
import { changeArtifact, readArtifact } from "../../artifacts/service.js";

export interface ArtifactRoutesDeps {
  store: LargeArtifactStore;
  data?: DataRuntime;
  /** Who is making the change (a person signed in to the dashboard), for versions. */
  author?: (c: any) => string;
  emit?: (payload: { artifactId: string; action: "created" | "updated" | "deleted"; type: string; title: string; timestamp: string }) => void;
  /** Folders an upload may read a file of the instance from ({ path }: chat attachments, the agents' workspace…). */
  fileRoots?: () => string[];
}

const DATA_METHODS: readonly ArtifactDataMethod[] = ["sources", "describe", "query", "sql"];
/** A JSON request (create, change): larger contents go by upload. */
export const ARTIFACT_JSON_BODY_BYTES = 32 * 1024 * 1024;
const UPLOAD_HINT = "Upload large contents instead: POST /artifacts/upload, PUT /artifacts/:id/content, or in parts with POST /artifacts/uploads (MCP: polpo_artifact_upload_prepare + polpo_artifact_upload_finalize)";

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

const previewText = (value: unknown, limit: number) => typeof value === "string" ? value.slice(0, limit) : undefined;
const previewNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Keep thumbnails independent of history and cap the excerpt sent per card. */
function artifactPreview(artifact: Artifact, content: string): { content: string } {
  const { kind, type } = artifact;
  if (type !== "html" || !content.trimStart().startsWith("{") || !["slides", "sheets", "motion"].includes(kind ?? "")) {
    return { content: content.slice(0, type === "svg" ? 48_000 : 32_000) };
  }

  let model: Record<string, unknown> | undefined;
  try {
    model = objectValue(JSON.parse(content));
  } catch {
    return { content: "" };
  }
  if (model?.version !== 1) return { content: "" };

  if (kind === "sheets" && Array.isArray(model.sheets)) {
    const first = objectValue(model.sheets[0]);
    const cells = objectValue(first?.cells);
    const excerpt: Record<string, string> = {};
    for (let row = 1; row <= 5; row += 1) {
      for (const column of "ABCD") {
        const address = column + row;
        const value = previewText(cells?.[address], 80);
        if (value !== undefined) excerpt[address] = value;
      }
    }
    return { content: JSON.stringify({ version: 1, sheets: [{ name: previewText(first?.name, 31), cells: excerpt }] }) };
  }

  if (kind === "slides" && Array.isArray(model.slides)) {
    const slide = objectValue(model.slides.find((item) => {
      const candidate = objectValue(item);
      return candidate && candidate.hidden !== true;
    })) ?? objectValue(model.slides[0]);
    if (!slide) return { content: "" };
    let imageBudget = 16_000;
    const elements = Array.isArray(slide.elements) ? slide.elements.slice(0, 20).flatMap((item, index) => {
      const element = objectValue(item);
      if (!element) return [];
      const src = typeof element.src === "string" && element.src.length <= imageBudget &&
        /^data:image\/(png|jpeg);base64,[a-z0-9+/=]+$/i.test(element.src) ? element.src : undefined;
      if (element.type === "image" && !src) return [];
      imageBudget -= src?.length ?? 0;
      return [{
        id: String(index), type: previewText(element.type, 16), color: previewText(element.color, 16),
        src, alt: previewText(element.alt, 180),
        x: previewNumber(element.x), y: previewNumber(element.y), w: previewNumber(element.w), h: previewNumber(element.h),
        fontSize: previewNumber(element.fontSize), text: previewText(element.text, 180),
      }];
    }) : undefined;
    return { content: JSON.stringify({ version: 1, slides: [{
      id: "preview", layout: previewText(slide.layout, 16), theme: previewText(slide.theme, 16), elements,
      title: previewText(slide.title, 180), body: previewText(slide.body, 440), secondary: previewText(slide.secondary, 240),
    }] }) };
  }

  if (kind === "motion" && Array.isArray(model.scenes)) {
    const first = objectValue(model.scenes[0]);
    if (!first || !Array.isArray(first.layers)) return { content: "" };
    const layers = first.layers.slice(0, 40).flatMap((item, index) => {
      const layer = objectValue(item);
      if (!layer) return [];
      return [{
        id: String(index), type: previewText(layer.type, 16), color: previewText(layer.color, 16),
        x: previewNumber(layer.x), y: previewNumber(layer.y), width: previewNumber(layer.width), height: previewNumber(layer.height),
        fontSize: previewNumber(layer.fontSize), text: previewText(layer.text, 180),
      }];
    });
    return { content: JSON.stringify({
      version: 1, width: previewNumber(model.width), height: previewNumber(model.height),
      scenes: [{
        id: "preview", name: previewText(first.name, 180), duration: previewNumber(first.duration),
        background: previewText(first.background, 16), layers,
      }],
    }) };
  }

  return { content: "" };
}


const CONTENT_TYPES: Record<ArtifactType, string> = {
  doc: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
  svg: "image/svg+xml; charset=utf-8",
  mermaid: "text/plain; charset=utf-8",
  view: "application/json; charset=utf-8",
};

const EXTENSIONS: Record<ArtifactType, string> = { doc: "md", html: "html", svg: "svg", mermaid: "mmd", view: "json" };

function fileName(artifact: Artifact): string {
  const base = artifact.title.trim().replace(/[^\w\- ]+/g, "").replace(/\s+/g, "-").toLowerCase() || "artifact";
  const json = artifact.type === "html" && ["slides", "sheets", "motion"].includes(artifact.kind ?? "") && (artifact.excerpt ?? artifact.content).trimStart().startsWith("{");
  return `${base}.${json ? "json" : EXTENSIONS[artifact.type]}`;
}

const positiveInt = (value: unknown): number | undefined => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
};

/** The change request fields of a PATCH body. */
function contentChangeOf(body: Record<string, unknown>): ArtifactContentChange {
  const change: ArtifactContentChange = {};
  if (typeof body.command === "string") change.command = body.command as ArtifactContentChange["command"];
  for (const key of ["old_str", "new_str", "content", "text", "append", "prepend"] as const) if (typeof body[key] === "string") change[key] = body[key] as string;
  if (body.replace_all === true) change.replace_all = true;
  for (const key of ["updates", "edits", "patch", "ops"] as const) if (Array.isArray(body[key])) (change as Record<string, unknown>)[key] = body[key];
  return change;
}

/** HTTP status and message for an error of the artifact layer. */
function failure(err: unknown): { status: number; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof ArtifactEditConflictError) return { status: 409, message: `${message} Read it again and redo the change.` };
  if (err instanceof UploadTooLargeError) return { status: 413, message };
  if (err instanceof ArtifactTooLargeToEditError) return { status: 413, message };
  if (err instanceof ArtifactQuotaError) return { status: 507, message };
  if (err instanceof UnsupportedArtifactFileError) return { status: 415, message };
  if (err instanceof ArtifactContentError || err instanceof ArtifactChangeError) return { status: 400, message };
  if (/ is over \d/.test(message) || /The content is over/.test(message)) return { status: 413, message: `${message}. ${UPLOAD_HINT}` };
  return { status: 400, message };
}

export function artifactRoutes(getDeps: () => ArtifactRoutesDeps): OpenAPIHono {
  const app = new OpenAPIHono();
  const fail = (c: any, status: number, error: string) => c.json({ ok: false, error }, status);
  const failWith = (c: any, err: unknown) => { const f = failure(err); return fail(c, f.status, f.message); };
  const author = (c: any) => getDeps().author?.(c) ?? "person:dashboard";
  // JSON requests are capped (JSON escaping can triple a content on the wire); uploads count their bytes as they arrive.
  const jsonLimit = bodyLimit({ maxSize: ARTIFACT_JSON_BODY_BYTES, onError: (c) => fail(c, 413, `The request is over ${formatArtifactBytes(ARTIFACT_JSON_BODY_BYTES)}. ${UPLOAD_HINT}`) });
  const isUpload = (path: string, method: string) => /\/upload$|\/uploads$/.test(path) || (method === "PUT" && /\/content$/.test(path));
  app.use("*", (c, next) => isUpload(c.req.path, c.req.method) ? next() : jsonLimit(c, next));
  const emit = (artifactId: string, action: "created" | "updated" | "deleted", type: string, title: string) =>
    getDeps().emit?.({ artifactId, action, type, title, timestamp: new Date().toISOString() });

  const findView = async (id: string) => {
    const data = getDeps().data;
    return data ? data.store.getView(id.slice(VIEW_ARTIFACT_PREFIX.length)) : null;
  };

  /** The artifact as the API returns it: content up to ARTIFACT_VIEWER_BYTES, version usage. */
  const present = async (artifact: Artifact, options: { content?: boolean } = {}) => {
    const size = artifactSize(artifact);
    const usage = artifactVersionUsage(artifact);
    if (!artifact.blob) return { ...artifact, size, usage };
    if (options.content !== false && size <= ARTIFACT_VIEWER_BYTES) {
      return { ...artifact, content: await getDeps().store.readContent(artifact), size, usage };
    }
    return { ...artifact, size, usage, contentOmitted: true };
  };

  /** A file of the instance (an attachment, a file in the agents' workspace…) inside the allowed roots. */
  const instanceFile = async (path: string): Promise<string> => {
    const roots = getDeps().fileRoots?.() ?? [];
    if (!roots.length) throw new ArtifactContentError("Files of the instance cannot be read here");
    if (path.includes("\0") || path.split(/[\\/]/).includes("..")) throw new ArtifactContentError(`"${path}" is not allowed`);
    for (const root of roots) {
      const candidate = path.startsWith("/") ? path : resolve(root, path);
      const real = await realpath(candidate).catch(() => undefined);
      const realRoot = await realpath(root).catch(() => root);
      if (!real) continue;
      const rel = relative(realRoot, real);
      if (rel.startsWith("..") || rel.startsWith("/")) continue;
      const info = await stat(real).catch(() => undefined);
      if (info?.isFile()) return real;
    }
    throw new ArtifactContentError(`No file "${path}" in the project, the agents' workspace or .polpo (find it with the files tools)`);
  };

  /** The body of an upload request, saved to a staged upload (streamed: never held whole in memory). */
  const receive = async (c: any, staged?: StagedUpload): Promise<{ upload: StagedUpload; mime?: string; fields: Record<string, string> }> => {
    const { blobs } = getDeps().store;
    const maxBytes = artifactLimits().maxBytes;
    const type = (c.req.header("content-type") ?? "").toLowerCase();
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes + (type.startsWith("multipart/") ? 1024 * 1024 : 0)) throw new UploadTooLargeError(maxBytes);
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(c.req.query() as Record<string, string>)) fields[key] = value;
    let mime: string | undefined = type || undefined;
    if (type.startsWith("multipart/form-data")) {
      const form = await c.req.formData();
      let file: File | undefined;
      for (const [key, value] of form.entries()) {
        if (typeof value === "string") fields[key] = value;
        else if (!file && (key === "file" || key === "content")) file = value as File;
      }
      if (!file) throw new ArtifactContentError("The form has no file field");
      fields.filename ??= file.name;
      mime = file.type || undefined;
      const upload = staged ?? await blobs.stage({ filename: fields.filename, by: author(c) });
      return { upload: await blobs.appendStaged(upload.id, file.stream() as unknown as AsyncIterable<Uint8Array>, { maxBytes, complete: fields.more !== "true" }), mime, fields };
    }
    const filename = fields.filename ?? c.req.header("x-filename") ?? /filename="?([^";]+)"?/.exec(c.req.header("content-disposition") ?? "")?.[1];
    if (filename) fields.filename = decodeURIComponent(filename);
    const upload = staged ?? await blobs.stage({ filename: fields.filename, by: author(c) });
    const body = c.req.raw.body as ReadableStream<Uint8Array> | null;
    const complete = fields.more !== "true";
    return { upload: await blobs.appendStaged(upload.id, body ? (body as unknown as AsyncIterable<Uint8Array>) : new Uint8Array(), { maxBytes, complete }), mime, fields };
  };

  /** The beginning of a staged upload, as text (to detect its type). */
  const stagedHead = async (upload: StagedUpload): Promise<string> => {
    const { createReadStream } = await import("node:fs");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of createReadStream(getDeps().store.blobs.stagedPath(upload.id), { start: 0, end: 64 * 1024 - 1 }) as AsyncIterable<Buffer>) {
      chunks.push(chunk);
      size += chunk.length;
    }
    return Buffer.concat(chunks, size).toString("utf-8");
  };

  /** Create an artifact from a complete upload, or replace the content of `id` with it. */
  const finalize = async (c: any, upload: StagedUpload, input: Record<string, unknown>, mime?: string) => {
    const { store } = getDeps();
    if (!upload.complete) throw new ArtifactContentError(`Upload ${upload.id} is not complete: send the last part without more`);
    if (upload.by && upload.by !== author(c)) throw new ArtifactContentError(`Upload ${upload.id} was started by someone else`);
    const contentFile = { path: store.blobs.stagedPath(upload.id), move: true };
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const note = str(input.note);
    try {
      if (str(input.id)) {
        const id = str(input.id)!;
        if (isViewArtifactId(id)) throw new ArtifactContentError("A view changes with the data tools or on the Data page");
        const current = await store.get(id);
        if (!current) return { status: 404 as const, error: "Artifact not found" };
        const expectedVersion = positiveInt(input.expectedVersion);
        const updated = await store.update(id, {
          contentFile, author: author(c), ...(expectedVersion ? { expectedVersion } : {}),
          note: note ?? `Content replaced by upload${upload.filename ? ` (${upload.filename})` : ""}`,
          ...(str(input.title) ? { title: str(input.title) } : {}), ...(str(input.kind) ? { kind: str(input.kind) } : {}),
          ...(typeof input.description === "string" ? { description: input.description } : {}),
        });
        if (!updated) return { status: 404 as const, error: "Artifact not found" };
        emit(updated.id, "updated", updated.type, updated.title);
        return { status: 200 as const, artifact: updated };
      }
      let type = str(input.type) as ArtifactType | undefined;
      let kind = str(input.kind);
      if (type && !isArtifactType(type)) throw new ArtifactContentError(`Unknown type "${type}" (doc, html, svg, mermaid)`);
      if (type === "view") throw new ArtifactContentError("Views are created with the data tools; make an html dashboard instead");
      if (!type) {
        const detected = detectArtifactType({ filename: upload.filename, mime, head: await stagedHead(upload) });
        type = detected.type;
        kind ??= detected.kind;
      }
      const title = str(input.title) ?? (upload.filename ? upload.filename.replace(/\.[^.]+$/, "") : "Uploaded artifact");
      const artifact = await store.create({
        title, type, content: "", contentFile, createdBy: author(c),
        ...(kind ? { kind } : {}), ...(str(input.description) ? { description: str(input.description) } : {}),
        ...(str(input.sessionId) ? { sessionId: str(input.sessionId) } : {}),
        ...(note ? { note } : {}), ...(input.pinned === true || input.pinned === "true" ? { pinned: true } : {}),
      });
      emit(artifact.id, "created", artifact.type, artifact.title);
      return { status: 201 as const, artifact };
    } finally {
      await store.blobs.dropStaged(upload.id);
    }
  };

  app.get("/", async (c) => {
    const { store, data } = getDeps();
    const type = c.req.query("type");
    if (type && !isArtifactType(type)) return fail(c, 400, `Unknown type "${type}"`);
    const creator = c.req.query("mine") === "true" ? author(c) : c.req.query("createdBy");
    const filter: ArtifactFilter = {
      ...(type ? { type: type as ArtifactFilter["type"] } : {}),
      ...(c.req.query("kind") ? { kind: c.req.query("kind") } : {}),
      ...(creator ? { createdBy: creator } : {}),
      ...(c.req.query("sessionId") ? { sessionId: c.req.query("sessionId") } : {}),
      ...(c.req.query("q") ? { q: c.req.query("q") } : {}),
    };
    const artifacts = await store.list(filter);
    const views = data && (!type || type === "view")
      ? (await data.store.listViews()).map(viewAsSummary).filter((v) => matchesArtifactFilter(v, filter))
      : [];
    const all = [...artifacts, ...views].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return c.json({ ok: true, data: all });
  });

  app.get("/usage", async (c) => {
    const usage = await getDeps().store.usage();
    const limits = artifactLimits();
    return c.json({ ok: true, data: { ...usage, warning: usage.bytes >= 0.8 * usage.maxBytes, limits, viewerBytes: ARTIFACT_VIEWER_BYTES } });
  });

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof body.title !== "string" || typeof body.content !== "string" || !isArtifactType(body.type)) {
      return fail(c, 400, "title, type (doc, html, svg, mermaid) and content are required");
    }
    if (body.type === "view") return fail(c, 400, "Views are created with the data tools; make an html dashboard instead");
    try {
      const artifact = await getDeps().store.create({
        title: body.title,
        type: body.type,
        content: body.content,
        createdBy: author(c),
        ...(typeof body.kind === "string" ? { kind: body.kind } : {}),
        ...(typeof body.description === "string" ? { description: body.description } : {}),
        ...(Array.isArray(body.sources) ? { sources: body.sources.map(String) } : {}),
        ...(typeof body.refreshSeconds === "number" ? { refreshSeconds: body.refreshSeconds } : {}),
        ...(body.pinned === true ? { pinned: true } : {}),
        ...(Array.isArray(body.tags) ? { tags: body.tags.map(String) } : {}),
      });
      emit(artifact.id, "created", artifact.type, artifact.title);
      return c.json({ ok: true, data: await present(artifact) }, 201);
    } catch (err) {
      return failWith(c, err);
    }
  });

  app.post("/upload", async (c) => {
    let upload: StagedUpload | undefined;
    try {
      const received = await receive(c);
      upload = received.upload;
      const result = await finalize(c, received.upload, received.fields, received.mime);
      if (!("artifact" in result)) return fail(c, result.status, result.error!);
      return c.json({ ok: true, data: await present(result.artifact!) }, result.status);
    } catch (err) {
      if (upload) await getDeps().store.blobs.dropStaged(upload.id);
      return failWith(c, err);
    }
  });

  app.post("/uploads", async (c) => {
    const { blobs } = getDeps().store;
    const maxBytes = artifactLimits().maxBytes;
    try {
      const type = (c.req.header("content-type") ?? "").toLowerCase();
      if (type.startsWith("application/json")) {
        const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
        const appendTo = typeof body.append_to === "string" && body.append_to ? body.append_to : undefined;
        if (typeof body.path === "string" && body.path) {
          if (appendTo) throw new ArtifactContentError("A file of the instance is read whole: send it without append_to");
          const path = await instanceFile(body.path);
          const { createReadStream } = await import("node:fs");
          const upload = await blobs.stage({ filename: body.path.split("/").pop(), by: author(c) });
          const done = await blobs.appendStaged(upload.id, createReadStream(path) as AsyncIterable<Uint8Array>, { maxBytes, complete: true });
          return c.json({ ok: true, data: { uploadId: done.id, size: done.size, complete: true, filename: done.filename } }, 201);
        }
        if (typeof body.base64 !== "string" || !body.base64) throw new ArtifactContentError("Send { base64 } (a part of the content, base64), { path } (a file of the instance) or the bytes as the body");
        const bytes = Buffer.from(body.base64.replace(/^data:[^,]*,/, ""), "base64");
        if (!bytes.byteLength) throw new ArtifactContentError("The base64 data is empty or invalid");
        const staged = appendTo ? await blobs.staged(appendTo) : await blobs.stage({ ...(typeof body.filename === "string" ? { filename: body.filename } : {}), by: author(c) });
        if (!staged) throw new ArtifactContentError(`There is no upload ${appendTo} in progress (uploads are kept 30 minutes): start again without append_to`);
        if (staged.by && staged.by !== author(c)) throw new ArtifactContentError(`Upload ${staged.id} was started by someone else`);
        const done = await blobs.appendStaged(staged.id, bytes, { maxBytes, complete: body.more !== true });
        return c.json({ ok: true, data: { uploadId: done.id, size: done.size, complete: done.complete, filename: done.filename } }, appendTo ? 200 : 201);
      }
      const appendTo = c.req.query("append_to");
      const staged = appendTo ? await blobs.staged(appendTo) : undefined;
      if (appendTo && !staged) throw new ArtifactContentError(`There is no upload ${appendTo} in progress (uploads are kept 30 minutes): start again without append_to`);
      if (staged?.by && staged.by !== author(c)) throw new ArtifactContentError(`Upload ${staged.id} was started by someone else`);
      const { upload } = await receive(c, staged);
      return c.json({ ok: true, data: { uploadId: upload.id, size: upload.size, complete: upload.complete, filename: upload.filename } }, appendTo ? 200 : 201);
    } catch (err) {
      return failWith(c, err);
    }
  });

  app.post("/uploads/:uploadId/finalize", async (c) => {
    const upload = await getDeps().store.blobs.staged(c.req.param("uploadId"));
    if (!upload) return fail(c, 404, `Upload ${c.req.param("uploadId")} expired or does not exist (uploads are kept 30 minutes): upload again`);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    try {
      const result = await finalize(c, upload, body);
      if (!("artifact" in result)) return fail(c, result.status, result.error!);
      return c.json({ ok: true, data: await present(result.artifact!) }, result.status);
    } catch (err) {
      return failWith(c, err);
    }
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (isViewArtifactId(id)) {
      const view = await findView(id);
      if (!view) return fail(c, 404, "Artifact not found");
      const artifact = viewAsArtifact(view);
      return c.json({ ok: true, data: c.req.query("preview") === "1" ? artifactPreview(artifact, artifact.content) : artifact });
    }
    const { store } = getDeps();
    const artifact = await store.get(id);
    if (!artifact) return fail(c, 404, "Artifact not found");
    try {
      if (c.req.query("preview") === "1") {
        // a blob workspace is previewed when it is small enough to read; a blob page from its excerpt
        const size = artifactSize(artifact);
        const content = !artifact.blob ? artifact.content
          : ["slides", "sheets", "motion"].includes(artifact.kind ?? "") ? (size <= 5 * 1024 * 1024 ? await store.readContent(artifact) : "")
          : artifact.excerpt ?? "";
        return c.json({ ok: true, data: artifactPreview(artifact, content) });
      }
      return c.json({ ok: true, data: await present(artifact, { content: c.req.query("content") !== "none" }) });
    } catch (err) {
      return failWith(c, err);
    }
  });

  app.get("/:id/content", async (c) => {
    const { store } = getDeps();
    const artifact = await store.get(c.req.param("id"));
    if (!artifact) return fail(c, 404, "Artifact not found");
    const version = positiveInt(c.req.query("version"));
    const item = version === undefined || version === artifact.version ? artifact : artifact.versions.find((v) => v.version === version);
    if (!item) return fail(c, 404, `No version ${version} of this artifact`);
    const size = artifactSize(item);
    let start = 0;
    let end = size - 1;
    let partial = false;
    const range = c.req.header("range");
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!m || (!m[1] && !m[2])) return c.body(null, 416, { "content-range": `bytes */${size}` });
      if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
      else { start = Math.max(0, size - Number(m[2])); end = size - 1; }
      if (start >= size || end < start) return c.body(null, 416, { "content-range": `bytes */${size}` });
      partial = true;
    }
    const opened = store.openContent(artifact, { version, start, end });
    if (c.req.header("if-none-match") === opened.etag && !partial) return c.body(null, 304);
    const headers: Record<string, string> = {
      "content-type": CONTENT_TYPES[artifact.type],
      "content-length": String(Math.max(0, opened.end - opened.start + 1)),
      "accept-ranges": "bytes",
      etag: opened.etag,
      "cache-control": "private, no-cache",
      "x-content-type-options": "nosniff",
      // the content is never run on the API's origin (html runs in the dashboard's sandboxed frame)
      "content-security-policy": "sandbox",
      "content-disposition": `${c.req.query("download") ? "attachment" : "inline"}; filename="${fileName(artifact)}"`,
    };
    if (partial) headers["content-range"] = `bytes ${opened.start}-${opened.end}/${size}`;
    const { Readable } = await import("node:stream");
    return c.body(Readable.toWeb(opened.stream) as unknown as ReadableStream, partial ? 206 : 200, headers);
  });

  app.get("/:id/read", async (c) => {
    const { store } = getDeps();
    const artifact = await store.get(c.req.param("id"));
    if (!artifact) return fail(c, 404, "Artifact not found");
    const q = (k: string) => c.req.query(k) || undefined;
    const num = (k: string) => { const v = q(k); return v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined; };
    const sel = (k: string) => { const v = q(k); return v !== undefined && /^\d+$/.test(v) ? Number(v) : v; };
    const part: ArtifactPartSelector = {
      ...(q("tab") ? { tab: sel("tab") } : {}), ...(q("slide") ? { slide: sel("slide") } : {}), ...(q("slides") ? { slides: q("slides") } : {}),
      ...(q("sheet") ? { sheet: sel("sheet") } : {}), ...(q("range") ? { range: q("range") } : {}),
      ...(q("board") ? { board: sel("board") } : {}), ...(q("page") ? { page: sel("page") } : {}), ...(q("scene") ? { scene: sel("scene") } : {}),
    };
    try {
      const read = await readArtifact(store, artifact, {
        ...(num("version") ? { version: num("version") } : {}), ...(num("offset") !== undefined ? { offset: num("offset") } : {}),
        ...(num("limit") ? { limit: num("limit") } : {}), ...(q("outline") === "1" || q("outline") === "true" ? { outline: true } : {}), part,
      });
      return c.json({ ok: true, data: { id: artifact.id, version: num("version") ?? artifact.version, ...read } });
    } catch (err) {
      return failWith(c, err);
    }
  });

  app.get("/:id/versions/:version", async (c) => {
    const { store } = getDeps();
    const artifact = await store.get(c.req.param("id"));
    if (!artifact) return fail(c, 404, "Artifact not found");
    const version = positiveInt(c.req.param("version"));
    const item = version === artifact.version ? artifact : artifact.versions.find((v) => v.version === version);
    if (!item || version === undefined) return fail(c, 404, `No version ${c.req.param("version")} of this artifact`);
    const size = artifactSize(item);
    const content = size <= ARTIFACT_VIEWER_BYTES ? await store.readContent(artifact, version) : undefined;
    const { blob: _blob, ...rest } = item as Artifact;
    return c.json({ ok: true, data: { version, author: rest.author, note: rest.note, at: (item as { at?: string }).at ?? artifact.updatedAt, size, ...(content !== undefined ? { content } : { content: "", contentOmitted: true }) } });
  });

  app.put("/:id/content", async (c) => {
    const id = c.req.param("id");
    if (isViewArtifactId(id)) return fail(c, 409, "A view changes with the data tools or on the Data page");
    const { store } = getDeps();
    const current = await store.get(id);
    if (!current) return fail(c, 404, "Artifact not found");
    const expected = positiveInt(c.req.query("expectedVersion") ?? c.req.header("x-expected-version"));
    if (expected !== undefined && expected !== current.version) return fail(c, 409, `This artifact changed while you were editing it (now v${current.version}). Read it again and redo the change.`);
    let upload: StagedUpload | undefined;
    try {
      const received = await receive(c);
      upload = received.upload;
      const result = await finalize(c, received.upload, { ...received.fields, id, ...(expected ? { expectedVersion: expected } : {}) });
      if (!("artifact" in result)) return fail(c, result.status, result.error!);
      return c.json({ ok: true, data: await present(result.artifact!) });
    } catch (err) {
      if (upload) await store.blobs.dropStaged(upload.id);
      return failWith(c, err);
    }
  });

  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    if (isViewArtifactId(id)) return fail(c, 409, "A view changes with the data tools or on the Data page");
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (body.expectedVersion !== undefined && (typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1)) {
      return fail(c, 400, "expectedVersion must be a positive integer");
    }
    const { store } = getDeps();
    try {
      const artifact = await store.get(id);
      if (!artifact) return fail(c, 404, "Artifact not found");
      const { artifact: updated, summary } = await changeArtifact(store, artifact, contentChangeOf(body), {
        ...(typeof body.expectedVersion === "number" ? { expectedVersion: body.expectedVersion } : {}),
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.kind === "string" ? { kind: body.kind } : {}),
        ...(typeof body.description === "string" ? { description: body.description } : {}),
        ...(Array.isArray(body.sources) ? { sources: body.sources.map(String) } : {}),
        ...(typeof body.refreshSeconds === "number" || body.refreshSeconds === null ? { refreshSeconds: body.refreshSeconds as number | null } : {}),
        ...(typeof body.pinned === "boolean" ? { pinned: body.pinned } : {}),
        ...(Array.isArray(body.tags) ? { tags: body.tags.map(String) } : {}),
        ...(typeof body.note === "string" ? { note: body.note } : {}),
        author: author(c),
      });
      emit(updated.id, "updated", updated.type, updated.title);
      // a partial change answers without the whole content (read it with GET when needed)
      const data = await present(updated, { content: summary === undefined || summary === "rewritten" });
      return c.json({ ok: true, data: summary ? { ...data, change: summary } : data });
    } catch (err) {
      return failWith(c, err);
    }
  });

  app.post("/:id/duplicate", async (c) => {
    const { store } = getDeps();
    const original = await store.get(c.req.param("id"));
    if (!original) return fail(c, 404, "Artifact not found");
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (body.version !== undefined && (typeof body.version !== "number" || !Number.isSafeInteger(body.version) || body.version < 1)) {
      return fail(c, 400, "version must be a positive integer");
    }
    const snapshot = body.version === undefined || body.version === original.version
      ? original : original.versions.find(item => item.version === body.version);
    if (!snapshot) return fail(c, 409, "That version is no longer available");
    const { type, kind, sources, refreshSeconds, tags, description, createdBy } = original;
    try {
      // The copy keeps the original's author (createdBy): an html artifact reads data with its
      // author's rights, so it keeps the same grants — never the duplicator's, which could be wider.
      // Who duplicated it, and from which version, is recorded on the copy's first version.
      const by = author(c);
      const copy = await store.create({ type, kind, sources, refreshSeconds, tags, description, createdBy,
        content: snapshot.blob ? "" : snapshot.content,
        ...(snapshot.blob ? { contentFile: { path: store.blobPath(original.id, snapshot.blob) } } : {}),
        title: original.title + " (copy)",
        author: by, note: `Duplicated from ${original.id} v${snapshot.version} by ${by}` });
      emit(copy.id, "created", type, copy.title);
      return c.json({ ok: true, data: await present(copy) }, 201);
    } catch (err) { return failWith(c, err); }
  });

  app.post("/:id/restore/:version", async (c) => {
    const id = c.req.param("id");
    if (isViewArtifactId(id)) return fail(c, 409, "Views have no versions");
    try {
      const artifact = await getDeps().store.restore(id, Number(c.req.param("version")), author(c));
      if (!artifact) return fail(c, 404, "Artifact not found");
      emit(artifact.id, "updated", artifact.type, artifact.title);
      return c.json({ ok: true, data: await present(artifact) });
    } catch (err) {
      return failWith(c, err);
    }
  });

  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    if (isViewArtifactId(id)) return fail(c, 409, "Delete a view on the Data page or with the data tools");
    const artifact = await getDeps().store.get(id);
    if (!artifact || !(await getDeps().store.delete(id))) return fail(c, 404, "Artifact not found");
    emit(id, "deleted", artifact.type, artifact.title);
    return c.json({ ok: true, data: { deleted: true } });
  });

  app.post("/:id/data", async (c) => {
    const { data, store } = getDeps();
    if (!data) return fail(c, 503, "Data sources are not available on this instance");
    const id = c.req.param("id");
    const artifact = isViewArtifactId(id) ? (await findView(id).then((v) => (v ? viewAsArtifact(v) : undefined))) : await store.get(id);
    if (!artifact) return fail(c, 404, "Artifact not found");
    const body = await c.req.json().catch(() => ({})) as { method?: unknown; params?: unknown };
    const method = String(body.method ?? "") as ArtifactDataMethod;
    if (!DATA_METHODS.includes(method)) return fail(c, 400, `method must be one of ${DATA_METHODS.join(", ")}`);
    try {
      const result = await runArtifactDataCall(data, artifact, method, (body.params ?? {}) as Record<string, unknown>);
      return c.json({ ok: true, data: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(c, /denied|not granted|not allowed/i.test(message) ? 403 : 400, message);
    }
  });

  return app;
}
