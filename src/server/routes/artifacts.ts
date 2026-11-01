/**
 * Artifacts REST API — documents, dashboards, designs and diagrams that agents and people make.
 *
 *   GET    /artifacts                          list (?type, kind, createdBy, sessionId, q); former data views included as type "view"
 *   POST   /artifacts                          create { title, type, content, kind?, description?, sources?, refreshSeconds?, pinned?, tags? }
 *   GET    /artifacts/:id                      one artifact, with its content and versions
 *   PATCH  /artifacts/:id                      change it; a new content keeps the previous one as a version
 *   POST   /artifacts/:id/restore/:version     make an earlier version current (as a new version)
 *   DELETE /artifacts/:id                      delete it
 *   POST   /artifacts/:id/data                 the data bridge of an html artifact: { method: sources|describe|query|sql, params }
 *
 * Former data views ("view:<id>") are read-only here: they change with the data tools or on the Data page.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { isArtifactType, matchesArtifactFilter, type ArtifactFilter, type ArtifactStore } from "@polpo-ai/core/artifacts";
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
    const filter: ArtifactFilter = {
      ...(type ? { type: type as ArtifactFilter["type"] } : {}),
      ...(c.req.query("kind") ? { kind: c.req.query("kind") } : {}),
      ...(c.req.query("createdBy") ? { createdBy: c.req.query("createdBy") } : {}),
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
      return view ? c.json({ ok: true, data: viewAsArtifact(view) }) : fail(c, 404, "Artifact not found");
    }
    const artifact = await getDeps().store.get(id);
    return artifact ? c.json({ ok: true, data: artifact }) : fail(c, 404, "Artifact not found");
  });

  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    if (isViewArtifactId(id)) return fail(c, 409, "A view changes with the data tools or on the Data page");
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    try {
      const artifact = await getDeps().store.update(id, {
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
      return fail(c, 400, err instanceof Error ? err.message : String(err));
    }
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
      return fail(c, 400, err instanceof Error ? err.message : String(err));
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
