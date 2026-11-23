import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
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

// When each What's new entry went online on this instance. The build lists its entry ids in
// whats-new-ids.json (vite.config.ts); the first time this server serves a build containing an id,
// it records the time in <POLPO_UI_STATE_DIR>/whats-new.json (default: .polpo-ui-state next to the
// static root, so it survives rebuilds) and never changes it afterwards. The very first time (no
// state file yet) the ids already there are recorded without a time: they went online before
// times were kept, and the page shows their day only. Only ids and times are stored, no secrets.
const whatsNewIdsPath = join(root, "whats-new-ids.json");
const uiStateDir = resolve(process.env.POLPO_UI_STATE_DIR || join(root, "..", ".polpo-ui-state"));
const whatsNewStatePath = join(uiStateDir, "whats-new.json");
const WHATS_NEW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const whatsNew = { key: "", value: undefined, pending: null };

async function readWhatsNewIds() {
  const parsed = JSON.parse(await readFile(whatsNewIdsPath, "utf8"));
  const list = Array.isArray(parsed) ? parsed : parsed?.ids;
  if (!Array.isArray(list)) throw new Error("no ids");
  return [...new Set(list.filter((id) => typeof id === "string" && WHATS_NEW_ID.test(id)))].slice(0, 5000);
}

/** The recorded map (id → ISO time or null), or null when there is no state file yet. */
async function readWhatsNewState() {
  let text;
  try {
    text = await readFile(whatsNewStatePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(text);
  const map = parsed && typeof parsed === "object" ? parsed.firstSeen : undefined;
  if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("unexpected content");
  const out = {};
  for (const [id, value] of Object.entries(map)) {
    if (!WHATS_NEW_ID.test(id)) continue;
    out[id] = typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
  }
  return out;
}

async function writeWhatsNewState(map) {
  await mkdir(uiStateDir, { recursive: true });
  const tmp = `${whatsNewStatePath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ version: 1, firstSeen: map }, null, 2)}\n`, { mode: 0o644 });
  await rename(tmp, whatsNewStatePath);
}

/** Record the build's new ids and return { id: ISO time } for the ids of this build that have one. */
async function recordWhatsNew() {
  let ids;
  try {
    ids = await readWhatsNewIds();
  } catch {
    return undefined; // a build without the list (older, dev): nothing to record or show
  }
  let stored;
  try {
    stored = await readWhatsNewState();
  } catch (error) {
    // never overwrite a file we cannot read: show no times rather than wrong ones
    console.warn(`What's new: cannot read ${whatsNewStatePath} (${error instanceof Error ? error.message : error}); times not shown`);
    return undefined;
  }
  const firstRun = stored === null;
  let known = stored ?? {};
  const now = new Date().toISOString();
  const added = ids.filter((id) => !Object.hasOwn(known, id));
  if (added.length > 0 || firstRun) {
    const next = { ...known };
    for (const id of added) next[id] = firstRun ? null : now;
    try {
      await writeWhatsNewState(next);
      known = next;
      if (!firstRun) console.log(`What's new: ${added.length} new entr${added.length === 1 ? "y" : "ies"} online at ${now}`);
    } catch (error) {
      // not persisted: a time kept only in memory would change at the next restart, so show none
      console.warn(`What's new: cannot write ${whatsNewStatePath} (${error instanceof Error ? error.message : error}); new entries shown without a time`);
    }
  }
  const out = {};
  for (const id of ids) if (typeof known[id] === "string") out[id] = known[id];
  return out;
}

/** The recorded times, checked again whenever the build's id list changes (a rebuild without a restart). */
async function whatsNewPublishedAt() {
  const metadata = await stat(whatsNewIdsPath).catch(() => null);
  const key = metadata?.isFile() ? `${metadata.mtimeMs}:${metadata.size}` : "none";
  if (key === whatsNew.key) return whatsNew.value;
  whatsNew.pending ??= (async () => {
    try {
      whatsNew.value = key === "none" ? undefined : await recordWhatsNew();
      whatsNew.key = key;
    } finally {
      whatsNew.pending = null;
    }
  })();
  await whatsNew.pending;
  return whatsNew.value;
}

async function runtimeConfig() {
  const [appearance, branding, orchestratorName, whatsNewTimes] = await Promise.all([
    instanceAppearance(), instanceBranding(), instanceOrchestratorName(), whatsNewPublishedAt().catch(() => undefined),
  ]);
  const payload = {
    baseUrl: apiUrl, apiKey, inkHubUrl,
    ...(appearance !== undefined ? { appearance } : {}),
    ...(branding !== undefined ? { branding } : {}),
    ...(typeof orchestratorName === "string" ? { orchestratorName } : {}),
    ...(whatsNewTimes && Object.keys(whatsNewTimes).length > 0 ? { whatsNewPublishedAt: whatsNewTimes } : {}),
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

// The PWA manifest with the instance's look and name: theme_color and background_color are its page
// background (the custom one, else its palette's, from dist/theme-colors.json; light theme: light,
// else dark), name and short_name its product name. Without them: the build's manifest as is.
const MANIFEST_COLOR = /^(#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(?:oklch|oklab|lab|lch|hsla?|rgba?)\(\s*[0-9a-zA-Z.%\s,/+-]{1,80}\))$/;
let themeColorsCache = null;

async function themeColors() {
  if (themeColorsCache === null) {
    try {
      const parsed = JSON.parse(await readFile(join(root, "theme-colors.json"), "utf8"));
      themeColorsCache = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      themeColorsCache = {};
    }
  }
  return themeColorsCache;
}

function manifestLook(appearance, colors) {
  const a = appearance && typeof appearance === "object" ? appearance : {};
  const dark = a.theme !== "light";
  const custom = a.custom && a.custom.enabled ? a.custom[dark ? "dark" : "light"] : undefined;
  const background = custom && typeof custom.background === "string" ? custom.background.trim() : "";
  if (MANIFEST_COLOR.test(background)) return background;
  const palette = Array.isArray(colors[a.palette]) ? colors[a.palette] : colors.tide;
  const color = Array.isArray(palette) ? palette[dark ? 1 : 0] : undefined;
  return typeof color === "string" && MANIFEST_COLOR.test(color) ? color : undefined;
}

async function serveManifest(req, res, path) {
  const [appearance, branding, colors, raw] = await Promise.all([instanceAppearance(), instanceBranding(), themeColors(), readFile(path, "utf8")]);
  let manifest;
  try { manifest = JSON.parse(raw); } catch { manifest = null; }
  if (!manifest || typeof manifest !== "object") {
    await serveStatic(req, res, path, "/manifest.webmanifest", await stat(path));
    return;
  }
  const color = manifestLook(appearance, colors);
  if (color) {
    manifest.theme_color = color;
    manifest.background_color = color;
  }
  const name = branding && typeof branding.productName === "string" ? branding.productName.trim() : "";
  if (name) {
    manifest.name = name;
    manifest.short_name = name.slice(0, 30);
  }
  const body = Buffer.from(JSON.stringify(manifest));
  res.writeHead(200, {
    "Cache-Control": "no-cache",
    "Content-Type": "application/manifest+json; charset=utf-8",
    "Content-Length": body.length,
    "X-Content-Type-Options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : body);
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
      if (metadata?.isFile() && url.pathname === "/manifest.webmanifest") {
        await serveManifest(req, res, requestedPath);
        return;
      }
      if (metadata?.isFile()) {
        await serveFile(req, res, requestedPath, url.pathname === "/" ? "/index.html" : url.pathname);
        return;
      }
    }
    // A missing build file (an old tab or service worker asking for chunks of a previous deploy) is a
    // real 404: answering with index.html makes the browser fail with a MIME error instead of retrying.
    if (url.pathname.startsWith("/assets/") || /\.(?:js|mjs|css|map|woff2?|png|jpe?g|svg|webp|ico|json|wasm)$/i.test(url.pathname)) {
      res.writeHead(404, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    await serveFile(req, res, join(root, "index.html"), "/index.html");
  } catch (error) {
    res.writeHead(500, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
    res.end(error instanceof Error ? error.message : "Internal Server Error");
  }
});

// record the build's entries when it goes online (the deploy restarts this server), not at the first visit
await whatsNewPublishedAt().catch(() => undefined);

server.listen(port, host, () => {
  console.log(`Polpo UI production server listening on http://${host}:${port}`);
  console.log(`Static root: ${root}`);
  console.log(`API target: ${apiUrl || "same origin"}`);
});
