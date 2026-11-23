/**
 * Artifacts REST API — documents, dashboards, designs and diagrams that agents and people make.
 *
 *   GET    /artifacts                          list (?type, kind, createdBy, sessionId, q); former data views included as type "view"
 *   POST   /artifacts                          create { title, type, content, kind?, description?, sources?, refreshSeconds?, pinned?, tags? }
 *   GET    /artifacts/:id                      one artifact, with its content and versions (?preview=1 for a compact preview)
 *   PATCH  /artifacts/:id                      change it; a new content keeps the previous one as a version
 *   POST   /artifacts/:id/restore/:version     make an earlier version current (as a new version)
 *   DELETE /artifacts/:id                      delete it
 *   POST   /artifacts/:id/data                 the data bridge of an html artifact: { method: sources|describe|query|sql, params }
 *
 * Former data views ("view:<id>") are read-only here: they change with the data tools or on the Data page.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { ArtifactEditConflictError, isArtifactType, matchesArtifactFilter, type Artifact, type ArtifactFilter, type ArtifactStore } from "@polpo-ai/core/artifacts";
import type { DataRuntime } from "../data-runtime.js";
import { isViewArtifactId, runArtifactDataCall, viewAsArtifact, viewAsSummary, VIEW_ARTIFACT_PREFIX, type ArtifactDataMethod } from "../artifact-runtime.js";

export interface ArtifactRoutesDeps {
  store: ArtifactStore;
  data?: DataRuntime;
  /** Who is making the change (a person signed in to the dashboard), for versions. */
  author?: (c: any) => string;
  emit?: (payload: { artifactId: string; action: "created" | "updated" | "deleted"; type: string; title: string; timestamp: string }) => void;
}

const DATA_METHODS: readonly ArtifactDataMethod[] = ["sources", "describe", "query", "sql"];

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

const previewText = (value: unknown, limit: number) => typeof value === "string" ? value.slice(0, limit) : undefined;
const previewNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Keep thumbnails independent of history and cap the excerpt sent per card. */
function artifactPreview(artifact: Artifact): { content: string } {
  const { content, kind, type } = artifact;
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

export function artifactRoutes(getDeps: () => ArtifactRoutesDeps): OpenAPIHono {
  const app = new OpenAPIHono();
  const fail = (c: any, status: number, error: string) => c.json({ ok: false, error }, status);
  const emit = (artifactId: string, action: "created" | "updated" | "deleted", type: string, title: string) =>
    getDeps().emit?.({ artifactId, action, type, title, timestamp: new Date().toISOString() });

  const findView = async (id: string) => {
    const data = getDeps().data;
    return data ? data.store.getView(id.slice(VIEW_ARTIFACT_PREFIX.length)) : null;
  };

  app.get("/", async (c) => {
    const { store, data } = getDeps();
    const type = c.req.query("type");
    if (type && !isArtifactType(type)) return fail(c, 400, `Unknown type "${type}"`);
    const creator = c.req.query("mine") === "true" ? (getDeps().author?.(c) ?? "person:dashboard") : c.req.query("createdBy");
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
        createdBy: getDeps().author?.(c) ?? "person:dashboard",
        ...(typeof body.kind === "string" ? { kind: body.kind } : {}),
        ...(typeof body.description === "string" ? { description: body.description } : {}),
        ...(Array.isArray(body.sources) ? { sources: body.sources.map(String) } : {}),
        ...(typeof body.refreshSeconds === "number" ? { refreshSeconds: body.refreshSeconds } : {}),
        ...(body.pinned === true ? { pinned: true } : {}),
        ...(Array.isArray(body.tags) ? { tags: body.tags.map(String) } : {}),
      });
      emit(artifact.id, "created", artifact.type, artifact.title);
      return c.json({ ok: true, data: artifact }, 201);
    } catch (err) {
      return fail(c, 400, err instanceof Error ? err.message : String(err));
    }
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (isViewArtifactId(id)) {
      const view = await findView(id);
      if (!view) return fail(c, 404, "Artifact not found");
      const artifact = viewAsArtifact(view);
      return c.json({ ok: true, data: c.req.query("preview") === "1" ? artifactPreview(artifact) : artifact });
    }
    const artifact = await getDeps().store.get(id);
    if (!artifact) return fail(c, 404, "Artifact not found");
    return c.json({ ok: true, data: c.req.query("preview") === "1" ? artifactPreview(artifact) : artifact });
  });

  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    if (isViewArtifactId(id)) return fail(c, 409, "A view changes with the data tools or on the Data page");
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (body.expectedVersion !== undefined && (typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1)) {
      return fail(c, 400, "expectedVersion must be a positive integer");
    }
    try {
      const artifact = await getDeps().store.update(id, {
        ...(typeof body.expectedVersion === "number" ? { expectedVersion: body.expectedVersion } : {}),
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.kind === "string" ? { kind: body.kind } : {}),
        ...(typeof body.description === "string" ? { description: body.description } : {}),
        ...(typeof body.content === "string" ? { content: body.content } : {}),
        ...(Array.isArray(body.sources) ? { sources: body.sources.map(String) } : {}),
        ...(typeof body.refreshSeconds === "number" || body.refreshSeconds === null ? { refreshSeconds: body.refreshSeconds as number | null } : {}),
        ...(typeof body.pinned === "boolean" ? { pinned: body.pinned } : {}),
        ...(Array.isArray(body.tags) ? { tags: body.tags.map(String) } : {}),
        ...(typeof body.note === "string" ? { note: body.note } : {}),
        author: getDeps().author?.(c) ?? "person:dashboard",
      });
      if (!artifact) return fail(c, 404, "Artifact not found");
      emit(artifact.id, "updated", artifact.type, artifact.title);
      return c.json({ ok: true, data: artifact });
    } catch (err) {
      return fail(c, err instanceof ArtifactEditConflictError ? 409 : 400, err instanceof Error ? err.message : String(err));
    }
  });

  app.post("/:id/duplicate", async (c) => {
    const { store } = getDeps();
    const original = await store.get(c.req.param("id"));
    if (!original) return fail(c, 404, "Artifact not found");
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const snapshot = body.version === undefined || body.version === original.version
      ? original : original.versions.find(item => item.version === body.version);
    if (!snapshot) return fail(c, 409, "That version is no longer available");
    const { type, kind, sources, refreshSeconds, tags, description, createdBy } = original;
    try {
      // The copy runs under the same data-source grants as the original.
      const copy = await store.create({ type, kind, sources, refreshSeconds, tags, description, createdBy,
        content: snapshot.content, title: original.title + " (copy)" });
      emit(copy.id, "created", type, copy.title);
      return c.json({ ok: true, data: copy }, 201);
    } catch (err) { return fail(c, 400, (err as Error).message); }
  });

  app.post("/:id/restore/:version", async (c) => {
    const id = c.req.param("id");
    if (isViewArtifactId(id)) return fail(c, 409, "Views have no versions");
    try {
      const artifact = await getDeps().store.restore(id, Number(c.req.param("version")), getDeps().author?.(c) ?? "person:dashboard");
      if (!artifact) return fail(c, 404, "Artifact not found");
      emit(artifact.id, "updated", artifact.type, artifact.title);
      return c.json({ ok: true, data: artifact });
    } catch (err) {
      return fail(c, err instanceof ArtifactEditConflictError ? 409 : 400, err instanceof Error ? err.message : String(err));
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
