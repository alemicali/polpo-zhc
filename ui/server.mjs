import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const root = resolve(option("root", new URL("./dist", import.meta.url).pathname));
const host = option("host", process.env.HOST ?? "127.0.0.1");
const port = Number(option("port", process.env.PORT ?? "4173"));
const apiUrl = process.env.POLPO_API_URL ?? process.env.VITE_POLPO_API_URL ?? "";
const apiKey = process.env.POLPO_API_KEY ?? process.env.VITE_POLPO_API_KEY;

const MIME = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const compressed = new Map();
const compressible = /^(text\/|application\/(javascript|json|manifest\+json))/;

function runtimeConfig() {
  return `globalThis.__POLPO_RUNTIME_CONFIG__=${JSON.stringify({ baseUrl: apiUrl, apiKey })};`;
}

function safePath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const relative = normalize(decoded).replace(/^([/\\])+/, "");
  const path = resolve(root, relative);
  return path === root || path.startsWith(`${root}/`) ? path : null;
}

function cacheControl(pathname) {
  if (pathname === "/index.html" || pathname === "/sw.js" || pathname === "/registerSW.js") {
    return "no-cache";
  }
  if (pathname.startsWith("/assets/") && /-[A-Za-z0-9_-]{8,}\./.test(pathname)) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}

async function compressedBody(path, metadata, encoding) {
  const key = `${path}:${metadata.mtimeMs}:${metadata.size}:${encoding}`;
  let pending = compressed.get(key);
  if (!pending) {
    pending = readFile(path).then((body) => encoding === "br"
      ? brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })
      : gzipAsync(body, { level: 6 }));
    compressed.set(key, pending);
  }
  return pending;
}

async function serveFile(req, res, path, pathname) {
  const metadata = await stat(path);
  const contentType = MIME.get(extname(path).toLowerCase()) ?? "application/octet-stream";
  const etag = `W/\"${metadata.size.toString(16)}-${Math.trunc(metadata.mtimeMs).toString(16)}\"`;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag, "Cache-Control": cacheControl(pathname) });
    res.end();
    return;
  }

  const accepts = req.headers["accept-encoding"] ?? "";
  const encoding = accepts.includes("br") ? "br" : accepts.includes("gzip") ? "gzip" : null;
  const headers = {
    "Cache-Control": cacheControl(pathname),
    "Content-Type": contentType,
    ETag: etag,
    Vary: "Accept-Encoding",
    "X-Content-Type-Options": "nosniff",
  };

  if (req.method === "HEAD") {
    res.writeHead(200, { ...headers, "Content-Length": metadata.size });
    res.end();
    return;
  }
  if (encoding && compressible.test(contentType) && metadata.size >= 1024) {
    const body = await compressedBody(path, metadata, encoding);
    res.writeHead(200, { ...headers, "Content-Encoding": encoding, "Content-Length": body.length });
    res.end(body);
    return;
  }
  res.writeHead(200, { ...headers, "Content-Length": metadata.size });
  createReadStream(path).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      res.end("Method Not Allowed");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/runtime-config.js") {
      const body = runtimeConfig();
      res.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "text/javascript; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    const requestedPath = safePath(url.pathname === "/" ? "/index.html" : url.pathname);
    if (requestedPath) {
      const metadata = await stat(requestedPath).catch(() => null);
      if (metadata?.isFile()) {
        await serveFile(req, res, requestedPath, url.pathname === "/" ? "/index.html" : url.pathname);
        return;
      }
    }
    await serveFile(req, res, join(root, "index.html"), "/index.html");
  } catch (error) {
    res.writeHead(500, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
    res.end(error instanceof Error ? error.message : "Internal Server Error");
  }
});

server.listen(port, host, () => {
  console.log(`Polpo UI production server listening on http://${host}:${port}`);
  console.log(`Static root: ${root}`);
  console.log(`API target: ${apiUrl || "same origin"}`);
});
