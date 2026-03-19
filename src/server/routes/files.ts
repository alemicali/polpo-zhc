import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { resolve, relative, extname, basename, dirname } from "node:path";
import { POLPO_DIR_NAME } from "../../core/constants.js";
import type { FileSystem } from "@polpo-ai/core";

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

async function resolveSandboxed(requestPath: string, allowedRoots: string[], fs: FileSystem): Promise<string | null> {
  if (requestPath.includes("..")) return null;

  for (const root of allowedRoots) {
    const resolved = requestPath.startsWith("/")
      ? requestPath
      : resolve(root, requestPath);
    const rel = relative(root, resolved);
    if (!rel.startsWith("..") && !rel.startsWith("/")) {
      if (await fs.exists(resolved)) return resolved;
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
  summary: "List file roots",
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
  description: "List files and subdirectories at the given path. Path is sandboxed to the .polpo/ directory and the project working directory.",
  request: {
    query: z.object({
      path: z.string().optional().openapi({ description: "Directory path to list. Defaults to the project root.", example: ".polpo/output" }),
    }),
  },
  responses: {
    200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "Directory listing" },
    400: { content: { "application/json": { schema: errorSchema } }, description: "Invalid or disallowed path" },
    404: { content: { "application/json": { schema: errorSchema } }, description: "Path not found" },
  },
});

const previewFileRoute = createRoute({
  method: "get",
  path: "/preview",
  tags: ["Files"],
  summary: "Preview file",
  description: "Returns structured preview metadata for a file.",
  request: {
    query: z.object({
      path: z.string().openapi({ description: "Absolute or relative file path" }),
      maxLines: z.string().optional().openapi({ description: "Maximum lines to return for text files (default: 500)" }),
    }),
  },
  responses: {
    200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), data: z.any() }) } }, description: "File preview data" },
    400: { content: { "application/json": { schema: errorSchema } }, description: "Invalid or disallowed path" },
    404: { content: { "application/json": { schema: errorSchema } }, description: "File not found" },
  },
});

// ── Dependencies ─────────────────────────────────────────────────────────────

export interface FileRouteDeps {
  polpoDir: string;
  workDir: string;
  agentWorkDir: string;
  fs: FileSystem;
  emit: (event: string, data: any) => void;
}

// ── Route factory ────────────────────────────────────────────────────────────

export function fileRoutes(getDeps: () => FileRouteDeps): OpenAPIHono {
  const app = new OpenAPIHono();

  function getAllowedRoots(): string[] {
    const deps = getDeps();
    const roots = [deps.workDir, deps.polpoDir];
    if (!roots.includes(deps.agentWorkDir)) roots.push(deps.agentWorkDir);
    return roots;
  }

  // ── GET /roots — available root directories ──
  app.openapi(listRootsRoute, (async (c: any) => {
    const deps = getDeps();
    const { workDir, polpoDir, agentWorkDir, fs } = deps;

    const SKIP = new Set(["node_modules", ".git", ".next", "dist", "__pycache__", ".cache"]);
    async function dirStats(dir: string, depth = 0): Promise<{ files: number; bytes: number }> {
      if (depth > 8) return { files: 0, bytes: 0 };
      let files = 0, bytes = 0;
      try {
        const entries = fs.readdirWithTypes
          ? await fs.readdirWithTypes(dir)
          : (await fs.readdir(dir)).map((n) => ({ name: n, isDirectory: false, isFile: true }));
        for (const e of entries) {
          if (SKIP.has(e.name)) continue;
          const full = resolve(dir, e.name);
          if (e.isDirectory) {
            const sub = await dirStats(full, depth + 1);
            files += sub.files;
            bytes += sub.bytes;
          } else if (e.isFile) {
            files++;
            try { bytes += (await fs.stat(full)).size; } catch { /* skip */ }
          }
        }
      } catch { /* unreadable dir */ }
      return { files, bytes };
    }

    const agentWorkRel = relative(workDir, agentWorkDir);
    const hasCustomWorkspace = agentWorkDir !== workDir;
    const wsDir = hasCustomWorkspace ? agentWorkDir : workDir;
    const wsStats = await dirStats(wsDir);

    const roots: any[] = [
      {
        id: "workspace",
        name: hasCustomWorkspace ? basename(agentWorkDir) : basename(workDir),
        path: hasCustomWorkspace ? agentWorkRel : ".",
        absolutePath: wsDir,
        description: "Agent workspace",
        icon: "folder-open",
        totalFiles: wsStats.files,
        totalSize: wsStats.bytes,
      },
    ];

    const polpoStats = await dirStats(polpoDir);
    roots.push({
      id: "polpo",
      name: POLPO_DIR_NAME,
      path: POLPO_DIR_NAME,
      absolutePath: polpoDir,
      description: "Polpo configuration & data",
      icon: "folder-cog",
      totalFiles: polpoStats.files,
      totalSize: polpoStats.bytes,
    });

    return c.json({ ok: true, data: { roots } }, 200);
  }) as any);

  // ── GET /list — directory listing ──
  app.openapi(listFilesRoute, (async (c: any) => {
    const deps = getDeps();
    const { fs } = deps;
    const { path: reqPath = "." } = c.req.valid("query");
    const roots = getAllowedRoots();

    const resolved = await resolveSandboxed(reqPath, roots, fs);
    if (!resolved) return c.json({ ok: false, error: "Invalid or disallowed path" }, 400);

    let s;
    try { s = await fs.stat(resolved); } catch { return c.json({ ok: false, error: "Path not found" }, 404); }
    if (!s.isDirectory) return c.json({ ok: false, error: "Path is not a directory" }, 400);

    const rawEntries = fs.readdirWithTypes
      ? await fs.readdirWithTypes(resolved)
      : (await fs.readdir(resolved)).map((n) => ({ name: n, isDirectory: false, isFile: true }));

    const entries = [];
    for (const d of rawEntries) {
      if (d.name.startsWith(".") && d.name !== ".agent") continue;
      const fullPath = resolve(resolved, d.name);
      const isDir = d.isDirectory;
      let fileStat;
      try { fileStat = await fs.stat(fullPath); } catch { /* skip */ }
      entries.push({
        name: d.name,
        type: isDir ? "directory" : "file",
        ...(fileStat ? {
          ...(isDir ? {} : { size: fileStat.size, mimeType: guessMime(d.name) }),
          modifiedAt: fileStat.modifiedAt?.toISOString(),
        } : {}),
      });
    }

    entries.sort((a: any, b: any) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const displayPath = roots.reduce((p: string, root: string) => {
      const rel = relative(root, resolved);
      return !rel.startsWith("..") ? rel || "." : p;
    }, reqPath);

    return c.json({ ok: true, data: { path: displayPath, entries } }, 200);
  }) as any);

  // ── GET /read — stream file content (binary response) ──
  app.get("/read", async (c) => {
    const deps = getDeps();
    const { fs } = deps;
    const reqPath = c.req.query("path");
    const download = c.req.query("download");
    if (!reqPath) return c.json({ ok: false, error: "Missing path parameter" }, 400);

    const roots = getAllowedRoots();
    const resolved = await resolveSandboxed(reqPath, roots, fs);
    if (!resolved) return c.json({ ok: false, error: "Invalid or disallowed path" }, 400);

    let s;
    try { s = await fs.stat(resolved); } catch { return c.json({ ok: false, error: "File not found" }, 404); }
    if (s.isDirectory) return c.json({ ok: false, error: "Path is a directory" }, 400);

    const mime = guessMime(resolved);
    const fileName = basename(resolved);

    // Read via buffer abstraction (works with Node, Sandbox, etc.)
    const buffer = fs.readFileBuffer
      ? await fs.readFileBuffer(resolved)
      : new TextEncoder().encode(await fs.readFile(resolved));

    const headers: Record<string, string> = {
      "Content-Type": mime,
      "Content-Length": String(buffer.byteLength),
      "Cache-Control": "private, max-age=60",
    };

    if (download) {
      headers["Content-Disposition"] = `attachment; filename="${fileName}"`;
    } else if (isPreviewable(mime)) {
      headers["Content-Disposition"] = `inline; filename="${fileName}"`;
    } else {
      headers["Content-Disposition"] = `attachment; filename="${fileName}"`;
    }

    return new Response(new Uint8Array(buffer) as any, { status: 200, headers });
  });

  // ── GET /preview — structured preview data ──
  app.openapi(previewFileRoute, (async (c: any) => {
    const deps = getDeps();
    const { fs } = deps;
    const { path: reqPath, maxLines: maxLinesStr } = c.req.valid("query");
    if (!reqPath) return c.json({ ok: false, error: "Missing path parameter" }, 400);

    const roots = getAllowedRoots();
    const maxLines = maxLinesStr ? parseInt(maxLinesStr, 10) : 500;

    const resolved = await resolveSandboxed(reqPath, roots, fs);
    if (!resolved) return c.json({ ok: false, error: "Invalid or disallowed path" }, 400);

    let s;
    try { s = await fs.stat(resolved); } catch { return c.json({ ok: false, error: "File not found" }, 404); }
    if (s.isDirectory) return c.json({ ok: false, error: "Path is a directory" }, 400);

    const mime = guessMime(resolved);
    const fileName = basename(resolved);
    const fileUrl = `/api/v1/files/read?path=${encodeURIComponent(reqPath)}`;

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
      size: s.size,
      previewable: type !== "binary",
      type,
      url: fileUrl,
    };

    if (type === "text") {
      const MAX_SIZE = 512 * 1024;
      if (s.size <= MAX_SIZE) {
        const raw = await fs.readFile(resolved);
        const lines = raw.split("\n");
        const truncated = lines.length > maxLines;
        result.content = truncated ? lines.slice(0, maxLines).join("\n") : raw;
        result.truncated = truncated;
      } else {
        // For large files, read via buffer and decode partial
        const buffer = fs.readFileBuffer
          ? await fs.readFileBuffer(resolved)
          : new TextEncoder().encode(await fs.readFile(resolved));
        const partial = new TextDecoder().decode(buffer.slice(0, MAX_SIZE));
        result.content = partial;
        result.truncated = true;
      }
    }

    return c.json({ ok: true, data: result }, 200);
  }) as any);

  // ── POST /upload — upload file(s) ──
  app.post("/upload", async (c) => {
    const deps = getDeps();
    const { fs } = deps;
    const body = await c.req.parseBody({ all: true });
    const destPath = (body.path as string | undefined) ?? ".";
    const roots = getAllowedRoots();
    const resolvedDir = await resolveSandboxed(destPath, roots, fs);
    if (!resolvedDir) return c.json({ ok: false, error: "Invalid or disallowed path" }, 400);

    const dirStat = await fs.stat(resolvedDir).catch(() => null);
    if (!dirStat?.isDirectory) return c.json({ ok: false, error: "Destination is not a directory" }, 400);

    const rawFiles = body.file;
    const files: globalThis.File[] = Array.isArray(rawFiles)
      ? rawFiles.filter((f): f is globalThis.File => f instanceof globalThis.File)
      : rawFiles instanceof globalThis.File ? [rawFiles] : [];

    if (files.length === 0) return c.json({ ok: false, error: "No files provided" }, 400);

    const uploaded: { name: string; size: number }[] = [];
    for (const file of files) {
      const filePath = resolve(resolvedDir, file.name);
      const rel = relative(resolvedDir, filePath);
      if (rel.startsWith("..") || rel.includes("/")) continue;
      const data = new Uint8Array(await file.arrayBuffer());
      if (fs.writeFileBuffer) {
        await fs.writeFileBuffer(filePath, data);
      } else {
        await fs.writeFile(filePath, new TextDecoder().decode(data));
      }
      uploaded.push({ name: file.name, size: data.byteLength });
    }

    for (const u of uploaded) {
      deps.emit("file:changed", { path: resolve(resolvedDir, u.name), dir: resolvedDir, action: "created", source: "server" });
    }

    return c.json({ ok: true, data: { uploaded, count: uploaded.length } }, 200);
  });

  // ── POST /mkdir — create a directory ──
  app.post("/mkdir", async (c) => {
    const deps = getDeps();
    const { fs } = deps;
    const body = await c.req.json<{ path: string }>().catch(() => null);
    if (!body?.path) return c.json({ ok: false, error: "Missing path" }, 400);

    const roots = getAllowedRoots();
    const parent = dirname(body.path);
    const resolvedParent = await resolveSandboxed(parent === "." ? "." : parent, roots, fs);
    if (!resolvedParent) return c.json({ ok: false, error: "Invalid or disallowed path" }, 400);

    const newDir = resolve(resolvedParent, basename(body.path));
    if (await fs.exists(newDir)) return c.json({ ok: false, error: "Directory already exists" }, 400);

    await fs.mkdir(newDir);
    deps.emit("file:changed", { path: newDir, dir: resolvedParent, action: "created", source: "server" });
    return c.json({ ok: true, data: { path: body.path } }, 200);
  });

  // ── POST /rename — rename a file or directory ──
  app.post("/rename", async (c) => {
    const deps = getDeps();
    const { fs } = deps;
    const body = await c.req.json<{ path: string; newName: string }>().catch(() => null);
    if (!body?.path || !body?.newName) return c.json({ ok: false, error: "Missing path or newName" }, 400);
    if (body.newName.includes("/") || body.newName.includes("..")) {
      return c.json({ ok: false, error: "Invalid new name" }, 400);
    }

    const roots = getAllowedRoots();
    const resolved = await resolveSandboxed(body.path, roots, fs);
    if (!resolved) return c.json({ ok: false, error: "Invalid or disallowed path" }, 400);
    if (!(await fs.exists(resolved))) return c.json({ ok: false, error: "Path not found" }, 404);

    const newPath = resolve(dirname(resolved), body.newName);
    if (await fs.exists(newPath)) return c.json({ ok: false, error: "A file with that name already exists" }, 400);

    await fs.rename(resolved, newPath);
    deps.emit("file:changed", { path: resolved, dir: dirname(resolved), action: "renamed", source: "server" });
    return c.json({ ok: true, data: { oldPath: body.path, newName: body.newName } }, 200);
  });

  // ── POST /delete — delete a file or empty directory ──
  app.post("/delete", async (c) => {
    const deps = getDeps();
    const { fs } = deps;
    const body = await c.req.json<{ path: string }>().catch(() => null);
    if (!body?.path) return c.json({ ok: false, error: "Missing path" }, 400);

    const roots = getAllowedRoots();
    const resolved = await resolveSandboxed(body.path, roots, fs);
    if (!resolved) return c.json({ ok: false, error: "Invalid or disallowed path" }, 400);
    if (!(await fs.exists(resolved))) return c.json({ ok: false, error: "Path not found" }, 404);

    for (const root of roots) {
      if (resolved === root) return c.json({ ok: false, error: "Cannot delete a root directory" }, 400);
    }

    const s = await fs.stat(resolved);
    if (s.isDirectory) {
      const entries = await fs.readdir(resolved);
      if (entries.length > 0) return c.json({ ok: false, error: "Directory is not empty" }, 400);
    }

    await fs.remove(resolved);
    deps.emit("file:changed", { path: resolved, dir: dirname(resolved), action: "deleted", source: "server" });
    return c.json({ ok: true, data: { path: body.path } }, 200);
  });

  // ── GET /search — recursive flat file listing ──
  app.get("/search", async (c) => {
    const deps = getDeps();
    const { fs } = deps;
    const query = (c.req.query("q") ?? "").toLowerCase();
    const agentDir = deps.agentWorkDir;
    const defaultRoot = agentDir !== deps.workDir ? relative(deps.workDir, agentDir) : ".";
    const root = c.req.query("root") ?? defaultRoot;
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Math.min(Number(limitParam), 500) : 200;

    const roots = getAllowedRoots();
    const resolved = await resolveSandboxed(root, roots, fs);
    if (!resolved) return c.json({ ok: false, error: "Invalid or disallowed path" }, 400);

    const SKIP = new Set(["node_modules", ".git", ".next", "dist", "__pycache__", ".cache", POLPO_DIR_NAME]);
    const results: { name: string; path: string }[] = [];

    async function walk(dir: string, depth: number) {
      if (depth > 10 || results.length >= limit) return;
      try {
        const entries = fs.readdirWithTypes
          ? await fs.readdirWithTypes(dir)
          : (await fs.readdir(dir)).map((n) => ({ name: n, isDirectory: false, isFile: true }));
        for (const e of entries) {
          if (results.length >= limit) return;
          if (SKIP.has(e.name)) continue;
          const relPath = relative(resolved!, resolve(dir, e.name));
          if (e.isFile) {
            if (!query || e.name.toLowerCase().includes(query) || relPath.toLowerCase().includes(query)) {
              results.push({ name: e.name, path: relPath });
            }
          } else if (e.isDirectory) {
            await walk(resolve(dir, e.name), depth + 1);
          }
        }
      } catch { /* unreadable dir */ }
    }

    await walk(resolved, 0);
    return c.json({ ok: true, data: { files: results, total: results.length } }, 200);
  });

  return app;
}
