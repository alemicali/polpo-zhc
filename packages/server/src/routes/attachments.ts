import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { join, extname } from "node:path";
import { nanoid } from "nanoid";
import type { FileSystem } from "@polpo-ai/core";
import type { AttachmentStore, Attachment } from "@polpo-ai/core/attachment-store";

const EXT_MIME: Record<string, string> = {
  ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".csv": "text/csv",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".txt": "text/plain", ".md": "text/markdown",
  ".json": "application/json", ".yaml": "text/yaml", ".yml": "text/yaml", ".xml": "application/xml",
  ".html": "text/html", ".ts": "text/typescript", ".js": "text/javascript", ".py": "text/x-python",
  ".zip": "application/zip", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4",
};

function guessMime(filename: string): string {
  return EXT_MIME[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

// ── Route definitions ──

const uploadRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Attachments"],
  summary: "Upload a file attachment for a chat session",
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Attachment uploaded",
    },
    400: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Missing file or sessionId",
    },
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Attachments"],
  summary: "List attachments for a session",
  request: {
    query: z.object({
      sessionId: z.string().openapi({ param: { name: "sessionId", in: "query" } }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.array(z.any()) }) } },
      description: "Attachment list",
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Attachments"],
  summary: "Get attachment metadata",
  request: {
    params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Attachment metadata",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Not found",
    },
  },
});

const downloadRoute = createRoute({
  method: "get",
  path: "/{id}/download",
  tags: ["Attachments"],
  summary: "Download attachment file content",
  request: {
    params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) }),
  },
  responses: {
    200: { description: "File content" },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Not found",
    },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Attachments"],
  summary: "Delete an attachment",
  request: {
    params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
      description: "Deleted",
    },
    404: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), error: z.string() }) } },
      description: "Not found",
    },
  },
});

// ── Route factory ──

interface AttachmentDeps {
  attachmentStore: AttachmentStore;
  fs: FileSystem;
  workDir: string;
}

export function attachmentRoutes(getDeps: () => AttachmentDeps) {
  const app = new OpenAPIHono();

  // POST / — upload attachment
  app.openapi(uploadRoute, async (c) => {
    const { attachmentStore, fs, workDir } = getDeps();
    const body = await c.req.parseBody({ all: true });

    const sessionId = body.sessionId as string;
    if (!sessionId) {
      return c.json({ ok: false, error: "sessionId is required" }, 400);
    }

    const files = Array.isArray(body.file) ? body.file : body.file ? [body.file] : [];
    if (files.length === 0) {
      return c.json({ ok: false, error: "No file provided" }, 400);
    }

    const results: Attachment[] = [];

    for (const file of files) {
      if (!(file instanceof File)) continue;

      const id = nanoid(12);
      const filename = file.name || `upload-${id}`;
      const relPath = `attachments/${sessionId}/${filename}`;
      const absPath = join(workDir, relPath);

      // Ensure directory exists
      const dir = join(workDir, "attachments", sessionId);
      if (!(await fs.exists(dir))) {
        await fs.mkdir(dir);
      }

      // Write file via FileSystem abstraction
      const buffer = new Uint8Array(await file.arrayBuffer());
      if ((fs as any).writeFileBuffer) {
        await (fs as any).writeFileBuffer(absPath, buffer);
      } else {
        await fs.writeFile(absPath, new TextDecoder().decode(buffer));
      }

      const attachment: Attachment = {
        id,
        sessionId,
        filename,
        mimeType: file.type || guessMime(filename),
        size: file.size,
        path: relPath,
        createdAt: new Date().toISOString(),
      };

      await attachmentStore.save(attachment);
      results.push(attachment);
    }

    return c.json({ ok: true, data: results.length === 1 ? results[0] : results }, 201);
  });

  // GET /?sessionId=xxx — list attachments
  app.openapi(listRoute, async (c) => {
    const { attachmentStore } = getDeps();
    const { sessionId } = c.req.valid("query");
    const attachments = await attachmentStore.getBySession(sessionId);
    return c.json({ ok: true, data: attachments }, 200);
  });

  // GET /:id — get metadata
  app.openapi(getRoute, async (c) => {
    const { attachmentStore } = getDeps();
    const { id } = c.req.valid("param");
    const attachment = await attachmentStore.get(id);
    if (!attachment) return c.json({ ok: false, error: "Not found" }, 404);
    return c.json({ ok: true, data: attachment }, 200);
  });

  // GET /:id/download — download file
  app.openapi(downloadRoute, async (c) => {
    const { attachmentStore, fs, workDir } = getDeps();
    const { id } = c.req.valid("param");
    const attachment = await attachmentStore.get(id);
    if (!attachment) return c.json({ ok: false, error: "Not found" }, 404);

    const absPath = join(workDir, attachment.path);
    if (!(await fs.exists(absPath))) {
      return c.json({ ok: false, error: "File not found on disk" }, 404);
    }

    let data: Uint8Array;
    if ((fs as any).readFileBuffer) {
      data = await (fs as any).readFileBuffer(absPath);
    } else {
      data = new TextEncoder().encode(await fs.readFile(absPath));
    }

    return new Response(Buffer.from(data), {
      headers: {
        "Content-Type": attachment.mimeType,
        "Content-Disposition": `inline; filename="${attachment.filename}"`,
        "Content-Length": String(data.byteLength),
      },
    });
  });

  // DELETE /:id — delete attachment
  app.openapi(deleteRoute, async (c) => {
    const { attachmentStore, fs, workDir } = getDeps();
    const { id } = c.req.valid("param");
    const attachment = await attachmentStore.get(id);
    if (!attachment) return c.json({ ok: false, error: "Not found" }, 404);

    // Delete file
    const absPath = join(workDir, attachment.path);
    try {
      if ((fs as any).unlink) await (fs as any).unlink(absPath);
    } catch { /* best effort */ }

    // Delete metadata
    await attachmentStore.delete(id);
    return c.json({ ok: true }, 200);
  });

  return app;
}
