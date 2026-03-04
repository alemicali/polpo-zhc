import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ServerEnv } from "../app.js";
import { resolve, relative, extname, basename, dirname } from "node:path";
import { existsSync, statSync, readdirSync, createReadStream, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
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

const listRootsRoute = createRoute({
  method: "get",
  path: "/roots",
  tags: ["Files"],
  summary: "List browsable root directories",
  description: "Returns the filesystem roots that the file browser can navigate: the project working directory and the .polpo configuration directory.",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } },
      description: "Array of root directories with name, path, and description",
    },
  },
});

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

  function getAllowedRoots(c: { get: (key: "orchestrator") => { getPolpoDir(): string; getWorkDir(): string; getAgentWorkDir(): string } }): string[] {
    const orchestrator = c.get("orchestrator");
    // workDir must come before polpoDir so that "." resolves to the project root, not .polpo
    const roots = [orchestrator.getWorkDir(), orchestrator.getPolpoDir()];
    const agentDir = orchestrator.getAgentWorkDir();
    if (!roots.includes(agentDir)) roots.push(agentDir);
    return roots;
  }

  // ── GET /roots — available root directories ──
  app.openapi(listRootsRoute, ((c: any) => {
    const orchestrator = c.get("orchestrator");
    const workDir = orchestrator.getWorkDir();
    const polpoDir = orchestrator.getPolpoDir();
    const agentWorkDir = orchestrator.getAgentWorkDir();

    // Recursively compute total files and total size for a directory.
    // Skips node_modules, .git, and similar heavy dirs to stay fast.
    const SKIP = new Set(["node_modules", ".git", ".next", "dist", "__pycache__", ".cache"]);
    function dirStats(dir: string, depth = 0): { files: number; bytes: number } {
      if (depth > 8) return { files: 0, bytes: 0 }; // cap recursion
      let files = 0, bytes = 0;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (SKIP.has(e.name)) continue;
          const full = resolve(dir, e.name);
          if (e.isDirectory()) {
            const sub = dirStats(full, depth + 1);
            files += sub.files;
            bytes += sub.bytes;
          } else if (e.isFile()) {
            files++;
            try { bytes += statSync(full).size; } catch { /* skip */ }
          }
        }
      } catch { /* unreadable dir */ }
      return { files, bytes };
    }

    // Agent workspace relative path from project root
    const agentWorkRel = relative(workDir, agentWorkDir);
    const hasCustomWorkspace = agentWorkDir !== workDir;

    const roots: any[] = [];

    // Workspace — where agents operate.
    // When settings.workDir is a subdirectory, show it with its relative path.
    // When settings.workDir is "." (workspace = project root), show the root as workspace.
    const wsDir = hasCustomWorkspace ? agentWorkDir : workDir;
    const wsStats = dirStats(wsDir);
    roots.push({
      id: "workspace",
      name: hasCustomWorkspace ? basename(agentWorkDir) : basename(workDir),
      path: hasCustomWorkspace ? agentWorkRel : ".",
      absolutePath: wsDir,
      description: "Agent workspace",
      icon: "folder-open",
      totalFiles: wsStats.files,
      totalSize: wsStats.bytes,
    });

    // .polpo config dir
    const polpoStats = dirStats(polpoDir);
    roots.push({
      id: "polpo",
      name: ".polpo",
      path: ".polpo",
      absolutePath: polpoDir,
      description: "Polpo configuration & data",
      icon: "folder-cog",
      totalFiles: polpoStats.files,
      totalSize: polpoStats.bytes,
    });

    return c.json({ ok: true, data: { roots } }, 200);
  }) as any);

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
        const s = (() => { try { return statSync(fullPath); } catch { return undefined; } })();
        return {
          name: d.name,
          type: isDir ? "directory" : "file",
          ...(s ? {
            ...(isDir ? {} : { size: s.size, mimeType: guessMime(d.name) }),
            modifiedAt: s.mtime.toISOString(),
          } : {}),
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

  // ── POST /upload — upload file(s) to a directory (plain handler — multipart body) ──
  app.post("/upload", async (c) => {
    const body = await c.req.parseBody({ all: true });
    const destPath = (body.path as string | undefined) ?? ".";
    const roots = getAllowedRoots(c);
    const resolvedDir = resolveSandboxed(destPath, roots);
    if (!resolvedDir) return c.json({ ok: false, error: "Invalid or disallowed path" }, 400);
    if (!existsSync(resolvedDir) || !statSync(resolvedDir).isDirectory()) {
      return c.json({ ok: false, error: "Destination is not a directory" }, 400);
    }

    // body.file can be a single File or an array of Files
    const rawFiles = body.file;
    const files: globalThis.File[] = Array.isArray(rawFiles)
      ? rawFiles.filter((f): f is globalThis.File => f instanceof globalThis.File)
      : rawFiles instanceof globalThis.File ? [rawFiles] : [];

    if (files.length === 0) {
      return c.json({ ok: false, error: "No files provided" }, 400);
    }

    const uploaded: { name: string; size: number }[] = [];
    for (const file of files) {
      const filePath = resolve(resolvedDir, file.name);
      // Safety: ensure the resolved path is still within sandbox
      const rel = relative(resolvedDir, filePath);
      if (rel.startsWith("..") || rel.includes("/")) continue; // skip traversal attempts
      const buffer = Buffer.from(await file.arrayBuffer());
      writeFileSync(filePath, buffer);
      uploaded.push({ name: file.name, size: buffer.byteLength });
    }

    // Emit file:changed for each uploaded file
    const orchestrator = c.get("orchestrator");
    for (const u of uploaded) {
      orchestrator.emit("file:changed", { path: resolve(resolvedDir, u.name), dir: resolvedDir, action: "created", source: "server" });
    }

    return c.json({ ok: true, data: { uploaded, count: uploaded.length } }, 200);
  });

  // ── POST /mkdir — create a directory ──
  app.post("/mkdir", async (c) => {
    const body = await c.req.json<{ path: string }>().catch(() => null);
    if (!body?.path) return c.json({ ok: false, error: "Missing path" }, 400);

    const roots = getAllowedRoots(c);
    const parent = dirname(body.path);
    const resolvedParent = resolveSandboxed(parent === "." ? "." : parent, roots);
    if (!resolvedParent) return c.json({ ok: false, error: "Invalid or disallowed path" }, 400);

    const newDir = resolve(resolvedParent, basename(body.path));
    if (existsSync(newDir)) return c.json({ ok: false, error: "Directory already exists" }, 400);

    mkdirSync(newDir, { recursive: true });
    c.get("orchestrator").emit("file:changed", { path: newDir, dir: resolvedParent, action: "created", source: "server" });
    return c.json({ ok: true, data: { path: body.path } }, 200);
  });

  // ── POST /rename — rename a file or directory ──
  app.post("/rename", async (c) => {
    const body = await c.req.json<{ path: string; newName: string }>().catch(() => null);
    if (!body?.path || !body?.newName) return c.json({ ok: false, error: "Missing path or newName" }, 400);
    if (body.newName.includes("/") || body.newName.includes("..")) {
      return c.json({ ok: false, error: "Invalid new name" }, 400);
    }

    const roots = getAllowedRoots(c);
    const resolved = resolveSandboxed(body.path, roots);
    if (!resolved) return c.json({ ok: false, error: "Invalid or disallowed path" }, 400);
    if (!existsSync(resolved)) return c.json({ ok: false, error: "Path not found" }, 404);

    const newPath = resolve(dirname(resolved), body.newName);
    if (existsSync(newPath)) return c.json({ ok: false, error: "A file with that name already exists" }, 400);

    renameSync(resolved, newPath);
    c.get("orchestrator").emit("file:changed", { path: resolved, dir: dirname(resolved), action: "renamed", source: "server" });
    return c.json({ ok: true, data: { oldPath: body.path, newName: body.newName } }, 200);
  });

  // ── DELETE /delete — delete a file or empty directory ──
  app.post("/delete", async (c) => {
    const body = await c.req.json<{ path: string }>().catch(() => null);
    if (!body?.path) return c.json({ ok: false, error: "Missing path" }, 400);

    const roots = getAllowedRoots(c);
    const resolved = resolveSandboxed(body.path, roots);
    if (!resolved) return c.json({ ok: false, error: "Invalid or disallowed path" }, 400);
    if (!existsSync(resolved)) return c.json({ ok: false, error: "Path not found" }, 404);

    // Don't allow deleting root directories themselves
    for (const root of roots) {
      if (resolved === root) return c.json({ ok: false, error: "Cannot delete a root directory" }, 400);
    }

    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      const entries = readdirSync(resolved);
      if (entries.length > 0) return c.json({ ok: false, error: "Directory is not empty" }, 400);
    }

    rmSync(resolved, { force: true });
    c.get("orchestrator").emit("file:changed", { path: resolved, dir: dirname(resolved), action: "deleted", source: "server" });
    return c.json({ ok: true, data: { path: body.path } }, 200);
  });

  // ── GET /search — recursive flat file listing for mention autocomplete ──
  app.get("/search", (c) => {
    const query = (c.req.query("q") ?? "").toLowerCase();
    const orchestrator = c.get("orchestrator");
    // Default to agent workspace (workDir setting), not project root
    const agentDir = orchestrator.getAgentWorkDir();
    const workDir = orchestrator.getWorkDir();
    const defaultRoot = agentDir !== workDir ? relative(workDir, agentDir) : ".";
    const root = c.req.query("root") ?? defaultRoot;
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Math.min(Number(limitParam), 500) : 200;

    const roots = getAllowedRoots(c);
    const resolved = resolveSandboxed(root, roots);
    if (!resolved) return c.json({ ok: false, error: "Invalid or disallowed path" }, 400);

    const SKIP = new Set(["node_modules", ".git", ".next", "dist", "__pycache__", ".cache", ".polpo"]);
    const results: { name: string; path: string }[] = [];

    function walk(dir: string, depth: number) {
      if (depth > 10 || results.length >= limit) return;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (results.length >= limit) return;
          if (SKIP.has(e.name)) continue;
          const relPath = relative(resolved!, resolve(dir, e.name));
          if (e.isFile()) {
            if (!query || e.name.toLowerCase().includes(query) || relPath.toLowerCase().includes(query)) {
              results.push({ name: e.name, path: relPath });
            }
          } else if (e.isDirectory()) {
            walk(resolve(dir, e.name), depth + 1);
          }
        }
      } catch { /* unreadable dir */ }
    }

    walk(resolved, 0);
    return c.json({ ok: true, data: { files: results, total: results.length } }, 200);
  });

  return app;
}
