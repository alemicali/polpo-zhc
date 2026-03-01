import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ServerEnv } from "../app.js";
import { resolve, relative, extname, basename } from "node:path";
import { existsSync, statSync, readdirSync, createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";

// ── MIME type map ────────────────────────────────────────────────────────────
const EXT_MIME: Record<string, string> = {
  // Text / code
  ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown",
  ".html": "text/html", ".htm": "text/html", ".css": "text/css",
  ".js": "text/javascript", ".mjs": "text/javascript", ".jsx": "text/javascript",
  ".ts": "text/typescript", ".tsx": "text/typescript",
  ".json": "application/json", ".jsonl": "application/x-ndjson",
  ".yaml": "text/yaml", ".yml": "text/yaml", ".toml": "text/plain",
  ".xml": "application/xml", ".csv": "text/csv", ".tsv": "text/tab-separated-values",
  ".sh": "text/x-shellscript", ".bash": "text/x-shellscript",
  ".py": "text/x-python", ".rb": "text/x-ruby", ".go": "text/x-go",
  ".rs": "text/x-rust", ".java": "text/x-java", ".c": "text/x-c", ".cpp": "text/x-c++",
  ".h": "text/x-c", ".hpp": "text/x-c++",
  ".sql": "text/x-sql", ".graphql": "text/plain", ".env": "text/plain",
  ".log": "text/plain", ".ini": "text/plain", ".cfg": "text/plain",
  // Images
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".bmp": "image/bmp",
  // Audio
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".flac": "audio/flac", ".m4a": "audio/mp4", ".aac": "audio/aac",
  // Video
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  // Documents
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // Archives
  ".zip": "application/zip", ".tar": "application/x-tar", ".gz": "application/gzip",
  ".tgz": "application/gzip", ".bz2": "application/x-bzip2",
};

function guessMime(filePath: string): string {
  return EXT_MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function isPreviewable(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime.startsWith("image/") ||
    mime.startsWith("audio/") ||
    mime.startsWith("video/") ||
    mime === "application/json" ||
    mime === "application/pdf" ||
    mime === "application/xml" ||
    mime === "application/x-ndjson"
  );
}

// ── Security: path sandboxing ────────────────────────────────────────────────

function resolveSandboxed(requestPath: string, allowedRoots: string[]): string | null {
  // Reject obvious traversal
  if (requestPath.includes("..")) return null;

  for (const root of allowedRoots) {
    // Handle absolute paths: check if they fall within an allowed root
    const resolved = requestPath.startsWith("/")
      ? requestPath
      : resolve(root, requestPath);
    const rel = relative(root, resolved);
    if (!rel.startsWith("..") && !rel.startsWith("/")) {
      if (existsSync(resolved)) return resolved;
    }
  }
  return null;
}

// ── Route definitions ────────────────────────────────────────────────────────

const errorSchema = z.object({ ok: z.literal(false), error: z.string() });

const listFilesRoute = createRoute({
  method: "get",
  path: "/list",
  tags: ["Files"],
  summary: "List directory contents",
  description: "List files and subdirectories at the given path. Path is sandboxed to the .polpo/ directory and the project working directory. Returns entries with name, type (file/directory), size, mimeType, and modifiedAt.",
  request: {
    query: z.object({
      path: z.string().optional().openapi({ description: "Directory path to list. Defaults to the project root.", example: ".polpo/output" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Directory listing with path and entries array",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Invalid or disallowed path",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Path not found",
    },
  },
});

const previewFileRoute = createRoute({
  method: "get",
  path: "/preview",
  tags: ["Files"],
  summary: "Get file preview data",
  description: "Returns structured preview metadata for a file. For text files, includes the file content (optionally truncated). For binary files (images, audio, video, PDF), returns a URL to stream the content via the /files/read endpoint. Response includes: path, name, mimeType, size, previewable (boolean), type (text|image|pdf|audio|video|binary), url, and optionally content and truncated for text files.",
  request: {
    query: z.object({
      path: z.string().openapi({ description: "Absolute or relative file path", example: ".polpo/output/task-123/report.md" }),
      maxLines: z.string().optional().openapi({ description: "Maximum lines to return for text files (default: 500)" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "File preview data",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Invalid or disallowed path",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "File not found",
    },
  },
});

// ── Route factory ────────────────────────────────────────────────────────────

export function fileRoutes(): OpenAPIHono<ServerEnv> {
  const app = new OpenAPIHono<ServerEnv>();

  function getAllowedRoots(c: { get: (key: "orchestrator") => { getPolpoDir(): string; getWorkDir(): string } }): string[] {
    const orchestrator = c.get("orchestrator");
    return [orchestrator.getPolpoDir(), orchestrator.getWorkDir()];
  }

  // ── GET /list — directory listing (OpenAPI) ──
  app.openapi(listFilesRoute, ((c: any) => {
    const { path: reqPath = "." } = c.req.valid("query");
    const roots = getAllowedRoots(c);

    const resolved = resolveSandboxed(reqPath, roots);
    if (!resolved) {
      return c.json({ ok: false, error: "Invalid or disallowed path" }, 400);
    }

    let stat;
    try { stat = statSync(resolved); } catch { return c.json({ ok: false, error: "Path not found" }, 404); }
    if (!stat.isDirectory()) {
      return c.json({ ok: false, error: "Path is not a directory" }, 400);
    }

    const entries = readdirSync(resolved, { withFileTypes: true })
      .filter((d: any) => !d.name.startsWith(".") || d.name === ".agent")
      .map((d: any) => {
        const fullPath = resolve(resolved, d.name);
        const isDir = d.isDirectory();
        const s = isDir ? undefined : (() => { try { return statSync(fullPath); } catch { return undefined; } })();
        return {
          name: d.name,
          type: isDir ? "directory" : "file",
          ...(s ? { size: s.size, mimeType: guessMime(d.name), modifiedAt: s.mtime.toISOString() } : {}),
        };
      })
      .sort((a: any, b: any) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    // Display path relative to the first matching root
    const displayPath = roots.reduce((p: string, root: string) => {
      const rel = relative(root, resolved);
      return !rel.startsWith("..") ? rel || "." : p;
    }, reqPath);

    return c.json({ ok: true, data: { path: displayPath, entries } }, 200);
  }) as any);

  // ── GET /read — stream file content (plain handler — binary response) ──
  // NOTE: Binary streaming cannot use app.openapi() because it returns raw bytes, not JSON.
  app.get("/read", (c) => {
    const reqPath = c.req.query("path");
    const download = c.req.query("download");
    if (!reqPath) return c.json({ ok: false, error: "Missing path parameter" }, 400);

    const roots = getAllowedRoots(c);
    const resolved = resolveSandboxed(reqPath, roots);
    if (!resolved) return c.json({ ok: false, error: "Invalid or disallowed path" }, 400);

    let stat;
    try { stat = statSync(resolved); } catch { return c.json({ ok: false, error: "File not found" }, 404); }
    if (stat.isDirectory()) return c.json({ ok: false, error: "Path is a directory" }, 400);

    const mime = guessMime(resolved);
    const fileName = basename(resolved);

    const headers: Record<string, string> = {
      "Content-Type": mime,
      "Content-Length": String(stat.size),
      "Cache-Control": "private, max-age=60",
    };

    if (download) {
      headers["Content-Disposition"] = `attachment; filename="${fileName}"`;
    } else if (isPreviewable(mime)) {
      headers["Content-Disposition"] = `inline; filename="${fileName}"`;
    } else {
      headers["Content-Disposition"] = `attachment; filename="${fileName}"`;
    }

    const nodeStream = createReadStream(resolved);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;
    return new Response(webStream, { status: 200, headers });
  });

  // ── GET /preview — structured preview data for the UI (OpenAPI) ──
  app.openapi(previewFileRoute, (async (c: any) => {
    const { path: reqPath, maxLines: maxLinesStr } = c.req.valid("query");
    if (!reqPath) return c.json({ ok: false, error: "Missing path parameter" }, 400);

    const roots = getAllowedRoots(c);
    const maxLines = maxLinesStr ? parseInt(maxLinesStr, 10) : 500;

    const resolved = resolveSandboxed(reqPath, roots);
    if (!resolved) return c.json({ ok: false, error: "Invalid or disallowed path" }, 400);

    let stat;
    try { stat = statSync(resolved); } catch { return c.json({ ok: false, error: "File not found" }, 404); }
    if (stat.isDirectory()) return c.json({ ok: false, error: "Path is a directory" }, 400);

    const mime = guessMime(resolved);
    const fileName = basename(resolved);
    const fileUrl = `/api/v1/files/read?path=${encodeURIComponent(reqPath)}`;

    // Determine preview type
    let type: "text" | "image" | "pdf" | "audio" | "video" | "binary";
    if (mime.startsWith("text/") || mime === "application/json" || mime === "application/xml" || mime === "application/x-ndjson") {
      type = "text";
    } else if (mime.startsWith("image/")) {
      type = "image";
    } else if (mime === "application/pdf") {
      type = "pdf";
    } else if (mime.startsWith("audio/")) {
      type = "audio";
    } else if (mime.startsWith("video/")) {
      type = "video";
    } else {
      type = "binary";
    }

    const result: Record<string, unknown> = {
      path: reqPath,
      name: fileName,
      mimeType: mime,
      size: stat.size,
      previewable: type !== "binary",
      type,
      url: fileUrl,
    };

    // For text files, include content (truncated)
    if (type === "text") {
      const MAX_SIZE = 512 * 1024; // 512KB
      if (stat.size <= MAX_SIZE) {
        const raw = await readFile(resolved, "utf-8");
        const lines = raw.split("\n");
        const truncated = lines.length > maxLines;
        result.content = truncated ? lines.slice(0, maxLines).join("\n") : raw;
        result.truncated = truncated;
      } else {
        // Read first chunk only
        const content = await new Promise<string>((res) => {
          let data = "";
          const s = createReadStream(resolved, { start: 0, end: MAX_SIZE - 1, encoding: "utf-8" });
          s.on("data", (chunk) => { data += String(chunk); });
          s.on("end", () => res(data));
          s.on("error", () => res(""));
        });
        result.content = content;
        result.truncated = true;
      }
    }

    return c.json({ ok: true, data: result }, 200);
  }) as any);

  return app;
}
