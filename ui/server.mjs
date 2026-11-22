import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const root = resolve(option("root", fileURLToPath(new URL("./dist", import.meta.url))));
const host = option("host", process.env.HOST ?? "127.0.0.1");
const port = Number(option("port", process.env.PORT ?? "4173"));
const apiUrl = process.env.POLPO_API_URL ?? process.env.VITE_POLPO_API_URL ?? "";
const apiKey = process.env.POLPO_API_KEY ?? process.env.VITE_POLPO_API_KEY;
// The Ink Hub the sidebar links to (a self-hosted hub; default polpo.sh)
const inkHubUrl = process.env.POLPO_INK_HUB_URL || undefined;

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

// The instance's default look (settings.appearance) and branding (settings.branding: name, tagline,
// logos, logo frame), inlined into runtime-config.js so index.html's inline script paints them on the
// first frame (colours, title, logo preload). Read from the API's public routes, cached briefly.
// POLPO_APPEARANCE_URL / POLPO_BRANDING_URL override where they are read (e.g. an internal address
// when POLPO_API_URL is empty because the API is on the same origin behind a proxy); without
// POLPO_BRANDING_URL, the branding is read next to POLPO_APPEARANCE_URL.
const apiConfigBase = apiUrl ? `${apiUrl.replace(/\/+$/, "")}/api/v1/config` : "";
const appearanceUrl = process.env.POLPO_APPEARANCE_URL
  ?? (apiConfigBase ? `${apiConfigBase}/appearance` : "");
const brandingUrl = process.env.POLPO_BRANDING_URL
  || (process.env.POLPO_APPEARANCE_URL ? process.env.POLPO_APPEARANCE_URL.replace(/\/appearance\/*$/, "/branding") : "")
  || (apiConfigBase ? `${apiConfigBase}/branding` : "");
// The orchestrator's display name (settings.orchestratorName), read next to the branding.
const orchestratorUrl = brandingUrl ? brandingUrl.replace(/\/branding\/*$/, "/orchestrator") : "";
const APPEARANCE_TTL_MS = Number(process.env.POLPO_APPEARANCE_TTL_MS ?? 30_000);
const APPEARANCE_TIMEOUT_MS = 1_500;

/** The branding fields the page may show (public display data only; anything else is left out). */
const BRANDING_FIELDS = ["productName", "tagline", "logoUrl", "logoDarkUrl", "logoFrame"];

function publicBranding(data) {
  const out = {};
  for (const key of BRANDING_FIELDS) {
    const value = data[key];
    if (typeof value === "string" && value && value.length <= 2048) out[key] = value;
  }
  if (out.logoFrame !== undefined && out.logoFrame !== "box" && out.logoFrame !== "none") delete out.logoFrame;
  return out;
}

/**
 * A public JSON object from the API, asked at most every 30 s: on an error the last one known, else
 * undefined (not inlined: the page uses its cached copy). A slow API never delays the page more than 1.5 s.
 */
function cachedPublic(url, pick = (data) => data) {
  const cache = { checkedAt: 0, value: undefined, pending: null };
  return async () => {
    if (!url) return undefined;
    if (Date.now() - cache.checkedAt < APPEARANCE_TTL_MS) return cache.value;
    cache.pending ??= (async () => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(APPEARANCE_TIMEOUT_MS), headers: { accept: "application/json" } });
        if (!res.ok) {
          // an API without the route (older): nothing to inline, ask again later
          if (res.status === 404) cache.value = null;
          return;
        }
        const body = await res.json();
        if (body && body.ok && body.data && typeof body.data === "object" && !Array.isArray(body.data)) {
          cache.value = pick(body.data);
        }
      } catch {
        // unreachable or slow: keep the last value (the page falls back to its cached copy)
      } finally {
        cache.checkedAt = Date.now();
        cache.pending = null;
      }
    })();
    await cache.pending;
    return cache.value;
  };
}

const instanceAppearance = cachedPublic(appearanceUrl);
const instanceBranding = cachedPublic(brandingUrl, publicBranding);
const instanceOrchestratorName = cachedPublic(orchestratorUrl, (data) => {
  const name = typeof data.name === "string" ? data.name.trim() : "";
  return name && name.length <= 40 ? name : null;
});

async function runtimeConfig() {
  const [appearance, branding, orchestratorName] = await Promise.all([instanceAppearance(), instanceBranding(), instanceOrchestratorName()]);
  const payload = {
    baseUrl: apiUrl, apiKey, inkHubUrl,
    ...(appearance !== undefined ? { appearance } : {}),
    ...(branding !== undefined ? { branding } : {}),
    ...(typeof orchestratorName === "string" ? { orchestratorName } : {}),
  };
  // JSON in a script: never let a value close it
  return `globalThis.__POLPO_RUNTIME_CONFIG__=${JSON.stringify(payload).replace(/</g, "\\u003c")};`;
}

function safePath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const path = resolve(root, normalize(decoded).replace(/^([/\\])+/, ""));
  // relative() uses the platform separator, so this also holds on Windows
  const inside = relative(root, path);
  return inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside) ? path : null;
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

const escapeHtml = (value) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * index.html with the instance's product name in <title> (and the home-screen name), so even the
 * tab and a link preview never show the default for a branded instance. Unbranded: the file as is.
 */
function brandIndexHtml(html, branding) {
  const name = branding && typeof branding.productName === "string" ? branding.productName.trim() : "";
  if (!name) return html;
  const safe = escapeHtml(name);
  return html
    .replace(/<title>[^<]*<\/title>/i, () => `<title>${safe}</title>`)
    .replace(/(<meta\s+name="apple-mobile-web-app-title"\s+content=")[^"]*(")/i, (_, a, b) => `${a}${safe}${b}`);
}

const indexCache = new Map();

async function serveIndex(req, res, path) {
  const metadata = await stat(path);
  const branding = await instanceBranding();
  const name = branding && typeof branding.productName === "string" ? branding.productName.trim() : "";
  if (!name) {
    await serveStatic(req, res, path, "/index.html", metadata);
    return;
  }
  const key = `${path}:${metadata.mtimeMs}:${metadata.size}:${name}`;
  let entry = indexCache.get(key);
  if (!entry) {
    const body = Buffer.from(brandIndexHtml(await readFile(path, "utf8"), branding));
    const tag = createHash("sha1").update(body).digest("base64url").slice(0, 16);
    entry = { body, etag: `W/"${tag}"`, br: null, gzip: null };
    indexCache.clear(); // one at a time: the name changes rarely
    indexCache.set(key, entry);
  }
  const headers = {
    "Cache-Control": cacheControl("/index.html"),
    "Content-Type": "text/html; charset=utf-8",
    ETag: entry.etag,
    Vary: "Accept-Encoding",
    "X-Content-Type-Options": "nosniff",
  };
  if (req.headers["if-none-match"] === entry.etag) {
    res.writeHead(304, { ETag: entry.etag, "Cache-Control": headers["Cache-Control"] });
    res.end();
    return;
  }
  if (req.method === "HEAD") {
    res.writeHead(200, { ...headers, "Content-Length": entry.body.length });
    res.end();
    return;
  }
  const accepts = req.headers["accept-encoding"] ?? "";
  const encoding = accepts.includes("br") ? "br" : accepts.includes("gzip") ? "gzip" : null;
  if (encoding && entry.body.length >= 1024) {
    entry[encoding] ??= encoding === "br"
      ? brotli(entry.body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })
      : gzipAsync(entry.body, { level: 6 });
    const body = await entry[encoding];
    res.writeHead(200, { ...headers, "Content-Encoding": encoding, "Content-Length": body.length });
    res.end(body);
    return;
  }
  res.writeHead(200, { ...headers, "Content-Length": entry.body.length });
  res.end(entry.body);
}

async function serveFile(req, res, path, pathname) {
  if (pathname === "/index.html") {
    await serveIndex(req, res, path);
    return;
  }
  await serveStatic(req, res, path, pathname, await stat(path));
}

async function serveStatic(req, res, path, pathname, metadata) {
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
      const body = await runtimeConfig();
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
