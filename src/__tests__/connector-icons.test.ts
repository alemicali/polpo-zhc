/**
 * Custom connectors' icons (MCP serverInfo.icons, OAuth metadata, the vendor's website), the
 * network rules (https, no private addresses, size and type limits), SVG sanitization, the icon
 * route's caching, and the connection probe behind POST /connectors/discover.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  candidateScore, checkIconUrl, discoverConnectorIcon, guardedFetcher, isBlockedAddress, mcpIconCandidates, parseHtmlIcons,
  parseManifestIcons, parseSizes, rankCandidates, registrableDomain, sanitizeSvg, sniffImage, toIconImage, unpackIco,
  type FetchOptions, type FetchedResource, type IconFetcher,
} from "../mcp/icons.js";
import { firstJsonRpc, probeConnector, resourceMetadataFromChallenge } from "../mcp/probe.js";
import { ConnectorManager } from "../mcp/manager.js";
import { connectorIconUrls } from "../mcp/view.js";
import { CATALOG_ICON_FILES } from "../mcp/catalog-icons.generated.js";
import { CONNECTOR_CATALOG } from "../mcp/catalog.js";
import { connectorRoutes } from "../server/routes/connectors.js";
import type { ConnectorConfig } from "@polpo-ai/core";

// ── fixtures ──

/** A real PNG header (IHDR) of the given size; enough for sniffing and dimensions. */
function png(width: number, height = width): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** An ICO with one embedded image. */
function ico(image: Buffer, size = 0): Buffer {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(1, 4);
  head[6] = size;
  head[7] = size;
  head.writeUInt32LE(image.length, 6 + 8);
  head.writeUInt32LE(22, 6 + 12);
  return Buffer.concat([head, image]);
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#36c"/></svg>`;
const dataUri = (mime: string, bytes: Buffer | string) => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

type Route = { status?: number; type?: string; body?: string | Buffer; headers?: Record<string, string> } | ((o: FetchOptions) => Route | Promise<Route>);

/** A fake network: exact URLs → responses; anything else 404. Records what was asked. */
function fakeNet(routes: Record<string, Route>) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetcher: IconFetcher = async (url, options): Promise<FetchedResource> => {
    calls.push({ url, method: options.method ?? "GET", ...(options.body ? { body: options.body } : {}) });
    let route = routes[url];
    if (typeof route === "function") route = await route(options);
    if (route === undefined) return { url, status: 404, contentType: "text/plain", body: Buffer.from("not found"), truncated: false, headers: {} };
    if ("throw" in (route as object)) throw new Error(String((route as { throw: string }).throw));
    const body = Buffer.from(route.body ?? "");
    if (body.length > options.maxBytes && !options.truncate) throw new Error("Too large");
    return {
      url, status: route.status ?? 200, contentType: route.type ?? "", body: body.subarray(0, options.maxBytes),
      truncated: body.length > options.maxBytes, headers: Object.fromEntries(Object.entries(route.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    };
  };
  return { fetcher, calls };
}

// ── selection ──

describe("serverInfo.icons", () => {
  it("parses sizes and ranks SVG first, then the largest ≥ 64 px", () => {
    expect(parseSizes("16x16 32x32")).toBe(32);
    expect(parseSizes(["48x48", "any"])).toBe(Infinity);
    expect(parseSizes("128x64")).toBe(64);
    expect(parseSizes(undefined)).toBeUndefined();
    const ranked = rankCandidates([
      { url: "https://x/16.png", kind: "icon", size: 16, type: "image/png" },
      { url: "https://x/256.png", kind: "icon", size: 256, type: "image/png" },
      { url: "https://x/mask.svg", kind: "mask-icon" },
      { url: "https://x/logo.svg", kind: "icon" },
      { url: "https://x/96.ico", kind: "icon", size: 96 },
    ]);
    expect(ranked.map((c) => c.url)).toEqual(["https://x/logo.svg", "https://x/256.png", "https://x/96.ico", "https://x/16.png", "https://x/mask.svg"]);
    expect(candidateScore({ url: "https://x/a", kind: "apple-touch-icon" })).toBeGreaterThan(candidateScore({ url: "https://x/favicon.ico", kind: "favicon" }));
  });

  it("splits light and dark variants and resolves relative sources", () => {
    const { light, dark } = mcpIconCandidates([
      { src: "/small.png", mimeType: "image/png", sizes: ["32x32"] },
      { src: "https://cdn.example.com/big.png", mimeType: "image/png", sizes: ["128x128"], theme: "light" },
      { src: "https://cdn.example.com/dark.svg", mimeType: "image/svg+xml", sizes: ["any"], theme: "dark" },
      { nope: true },
      "junk",
    ], "https://mcp.example.com/mcp");
    expect(light.map((c) => c.url)).toEqual(["https://cdn.example.com/big.png", "https://mcp.example.com/small.png"]);
    expect(dark).toEqual([expect.objectContaining({ url: "https://cdn.example.com/dark.svg", theme: "dark", size: Infinity })]);
    expect(mcpIconCandidates(undefined)).toEqual({ light: [], dark: [] });
  });

  it("uses the server's icons first, with a dark variant, without touching the website", async () => {
    const net = fakeNet({ "https://cdn.example.com/dark.png": { body: png(128), type: "image/png" } });
    const found = await discoverConnectorIcon({
      serverUrl: "https://mcp.example.com/mcp",
      serverInfo: { icons: [
        { src: dataUri("image/png", png(16)), mimeType: "image/png", sizes: ["16x16"] },
        { src: dataUri("image/svg+xml", SVG), mimeType: "image/svg+xml", theme: "light" },
        { src: "https://cdn.example.com/dark.png", sizes: ["128x128"], theme: "dark" },
      ] },
    }, { fetch: net.fetcher });
    expect(found?.source).toBe("mcp");
    expect(found?.light.mimeType).toBe("image/svg+xml");
    expect(found?.light.src).toBeUndefined();
    expect(found?.dark).toMatchObject({ mimeType: "image/png", width: 128, src: "https://cdn.example.com/dark.png" });
    expect(net.calls.map((c) => c.url)).toEqual(["https://cdn.example.com/dark.png"]);
  });

  it("falls back to the next icon when one is broken, and to a small one when nothing large works", async () => {
    const net = fakeNet({
      "https://cdn.example.com/big.png": { body: "<html>not an image</html>", type: "image/png" },
      "https://cdn.example.com/small.png": { body: png(32), type: "image/png" },
    });
    const found = await discoverConnectorIcon({
      serverUrl: "https://10.0.0.1/mcp",
      serverInfo: { icons: [{ src: "https://cdn.example.com/big.png", sizes: ["512x512"] }, { src: "https://cdn.example.com/small.png", sizes: ["32x32"] }] },
    }, { fetch: net.fetcher });
    expect(found).toMatchObject({ source: "mcp", light: { width: 32, src: "https://cdn.example.com/small.png" } });
  });
});

// ── the website ──

describe("website icons", () => {
  const HTML = `<!doctype html><html><head>
    <!-- <link rel="icon" href="/commented.svg"> -->
    <link rel="modulepreload" href="/assets/createLucideIcon.js"/>
    <link rel="icon" type="image/png" sizes="48x48" href="/brand/favicon-48.png"/>
    <link rel="icon" type="image/svg+xml" sizes="any" href="/brand/favicon.svg"/>
    <link rel="SHORTCUT ICON" href="https://static.example.com/favicon.ico">
    <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png"/>
    <link rel="mask-icon" href="/brand/mask.svg" color="#000">
    <link rel="manifest" href="/brand/site.webmanifest"/>
    <link href="relative.png" rel="icon" sizes="16x16 192x192">
  </head><body>…`;

  it("parses link rel tokens, sizes, types and the manifest", () => {
    const { icons, manifest } = parseHtmlIcons(HTML, "https://example.com/");
    expect(manifest).toBe("https://example.com/brand/site.webmanifest");
    expect(icons).toEqual([
      { url: "https://example.com/brand/favicon-48.png", kind: "icon", type: "image/png", size: 48 },
      { url: "https://example.com/brand/favicon.svg", kind: "icon", type: "image/svg+xml", size: Infinity },
      { url: "https://static.example.com/favicon.ico", kind: "icon" },
      { url: "https://example.com/brand/apple-touch-icon.png", kind: "apple-touch-icon" },
      { url: "https://example.com/brand/mask.svg", kind: "mask-icon" },
      { url: "https://example.com/relative.png", kind: "icon", size: 192 },
    ]);
    // <base href> changes where relative links point
    expect(parseHtmlIcons(`<base href="https://cdn.example.com/s/"><link rel=icon href=fav.png>`, "https://example.com/").icons[0]!.url).toBe("https://cdn.example.com/s/fav.png");
    // a javascript: href is never a candidate
    expect(parseHtmlIcons(`<link rel="icon" href="javascript:alert(1)">`, "https://example.com/").icons).toEqual([]);
  });

  it("reads manifest icons, skipping maskable-only ones when others exist", () => {
    const icons = parseManifestIcons(JSON.stringify({ icons: [
      { src: "/i-192.png", sizes: "192x192", type: "image/png" },
      { src: "/mask-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/i-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ] }), "https://example.com/brand/site.webmanifest");
    expect(icons.map((c) => c.url)).toEqual(["https://example.com/i-192.png", "https://example.com/i-512.png"]);
    expect(parseManifestIcons("not json", "https://example.com/m")).toEqual([]);
  });

  it("finds the registrable domain", () => {
    expect(registrableDomain("mcp.sitoinchat.it")).toBe("sitoinchat.it");
    expect(registrableDomain("api.foo.co.uk")).toBe("foo.co.uk");
    expect(registrableDomain("my-app.vercel.app")).toBe("my-app.vercel.app");
    expect(registrableDomain("x.y.my-app.vercel.app")).toBe("my-app.vercel.app");
    expect(registrableDomain("vercel.app")).toBeUndefined();
    expect(registrableDomain("127.0.0.1")).toBeUndefined();
    expect(registrableDomain("localhost")).toBeUndefined();
  });

  it("SitoInChat: the protected resource metadata names no logo, the website's SVG wins over its PNGs", async () => {
    const net = fakeNet({
      "https://mcp.sitoinchat.it/.well-known/oauth-protected-resource": {
        type: "application/json",
        body: JSON.stringify({ resource: "https://mcp.sitoinchat.it", resource_name: "SitoInChat", authorization_servers: ["https://sitoinchat.it/api/auth"] }),
      },
      "https://sitoinchat.it/.well-known/oauth-authorization-server/api/auth": { type: "application/json", body: JSON.stringify({ issuer: "https://sitoinchat.it/api/auth" }) },
      "https://sitoinchat.it/": { type: "text/html; charset=utf-8", body: HTML },
      "https://sitoinchat.it/brand/site.webmanifest": { type: "application/manifest+json", body: JSON.stringify({ icons: [{ src: "/brand/icon-512.png", sizes: "512x512", type: "image/png" }] }) },
      "https://sitoinchat.it/brand/favicon.svg": { type: "image/svg+xml", body: `<?xml version="1.0"?><svg viewBox="0 0 1 1"><metadata><c2pa:manifest>AAAA</c2pa:manifest></metadata><circle r="1"/></svg>` },
    });
    const found = await discoverConnectorIcon({ serverUrl: "https://mcp.sitoinchat.it", oauth: true }, { fetch: net.fetcher });
    expect(found?.source).toBe("website");
    expect(found?.light).toMatchObject({ mimeType: "image/svg+xml", src: "https://sitoinchat.it/brand/favicon.svg" });
    const svg = found!.light.bytes.toString();
    expect(svg).toContain(`xmlns="http://www.w3.org/2000/svg"`);
    expect(svg).not.toMatch(/metadata|c2pa:manifest|<\?xml/);
  });

  it("an OAuth logo_uri comes before the website", async () => {
    const net = fakeNet({
      "https://mcp.acme.dev/.well-known/oauth-protected-resource/mcp": {
        body: JSON.stringify({ resource: "https://mcp.acme.dev/mcp", authorization_servers: ["https://auth.acme.dev"], logo_uri: "https://auth.acme.dev/logo.png" }),
      },
      "https://auth.acme.dev/logo.png": { body: png(200), type: "image/png" },
    });
    const found = await discoverConnectorIcon({ serverUrl: "https://mcp.acme.dev/mcp", oauth: true }, { fetch: net.fetcher });
    expect(found).toMatchObject({ source: "oauth", light: { src: "https://auth.acme.dev/logo.png", width: 200 } });
  });

  it("falls back to /favicon.ico (an ICO embedding a PNG becomes that PNG), then the www host", async () => {
    const net = fakeNet({
      "https://acme.dev/": { throw: "ECONNREFUSED" } as unknown as Route,
      "https://www.acme.dev/": { type: "text/html", body: "<html><head><title>no icons</title></head></html>" },
      "https://www.acme.dev/favicon.ico": { type: "image/x-icon", body: ico(png(64)) },
    });
    const found = await discoverConnectorIcon({ serverUrl: "https://mcp.acme.dev/mcp" }, { fetch: net.fetcher });
    expect(found).toMatchObject({ source: "website", light: { mimeType: "image/png", width: 64, src: "https://www.acme.dev/favicon.ico" } });
    expect(net.calls.map((c) => c.url)).toContain("https://www.acme.dev/apple-touch-icon.png");
  });

  it("nothing usable: undefined (the letter tile)", async () => {
    const net = fakeNet({ "https://acme.dev/": { type: "text/html", body: "<html></html>" }, "https://acme.dev/favicon.ico": { type: "text/html", body: "<html>soft 404</html>" } });
    expect(await discoverConnectorIcon({ serverUrl: "https://mcp.acme.dev/mcp" }, { fetch: net.fetcher })).toBeUndefined();
  });
});

// ── images ──

describe("image validation", () => {
  it("sniffs by bytes, never by name or Content-Type", () => {
    expect(sniffImage(png(1))).toBe("image/png");
    expect(sniffImage(ico(png(16)))).toBe("image/x-icon");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.from(`﻿  <?xml version="1.0"?>\n${SVG}`))).toBe("image/svg+xml");
    expect(sniffImage(Buffer.from("<!doctype html><html><svg></svg></html>"))).toBeUndefined();
    expect(sniffImage(Buffer.from("GIF8"))).toBeUndefined(); // too short for anything but still not an image we know
    expect(() => toIconImage(Buffer.from("{\"not\":\"an image\"}"))).toThrow(/Not an image/);
    expect(() => toIconImage(Buffer.alloc(0))).toThrow(/Empty/);
  });

  it("caps the size at 512 KB", () => {
    const big = Buffer.concat([png(64), Buffer.alloc(512 * 1024)]);
    expect(() => toIconImage(big)).toThrow(/Too large/);
    expect(toIconImage(png(64))).toMatchObject({ mimeType: "image/png", width: 64, height: 64 });
  });

  it("keeps an ICO that holds a BMP as an ICO (browsers render it), with its size", () => {
    const bmp = Buffer.alloc(40, 1);
    expect(unpackIco(ico(bmp, 48))).toMatchObject({ mimeType: "image/x-icon", width: 48, height: 48 });
    expect(() => unpackIco(Buffer.from([0, 0, 1, 0, 1, 0, ...new Array(16).fill(0xff)]))).toThrow(/ICO/);
  });
});

describe("SVG sanitization", () => {
  it("removes scripts, handlers, foreignObject, external references and XML entities", () => {
    const dirty = `<?xml version="1.0"?><?xml-stylesheet href="https://evil.example/x.css"?>
<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<svg viewBox="0 0 10 10" onload="alert(1)" xmlns:xlink="http://www.w3.org/1999/xlink">
  <script>alert(1)</script><script href="https://evil.example/a.js"/>
  <foreignObject><iframe src="https://evil.example"></iframe></foreignObject>
  <style>@import url(https://evil.example/s.css); .a{fill:url(#g);background:url('https://evil.example/t.png')}</style>
  <defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs>
  <a href="javascript:alert(1)"><rect width="10" height="10" fill="url(#g)" ONCLICK='x()' style="fill:url(https://evil.example/u)"/></a>
  <use xlink:href="https://evil.example/sprite.svg#i"/><use href="#g"/>
  <image href="https://evil.example/track.png"/><image href="data:image/png;base64,iVBORw0KGgo="/>
  <animate attributeName="href" to="javascript:alert(1)"/><set attributeName="onclick" to="alert(1)"/>
  <text>&xxe;</text>
</svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 10 10"/);
    for (const bad of [/<script/i, /onload/i, /onclick/i, /foreignObject/i, /iframe/i, /evil\.example/, /javascript:/i, /@import/i, /<!DOCTYPE/i, /<!ENTITY/i, /<\?/, /<set\b/i, /attributeName="href"/]) {
      expect(clean).not.toMatch(bad);
    }
    expect(clean).toContain(`fill="url(#g)"`);
    expect(clean).toContain(`<use href="#g" />`);
    expect(clean).toContain("data:image/png;base64,iVBORw0KGgo=");
  });

  it("refuses what is not an SVG", () => {
    expect(() => sanitizeSvg("<html><body>hi</body></html>")).toThrow(/Not an SVG/);
    expect(() => sanitizeSvg("<svg><rect/>")).toThrow(/Not an SVG/);
  });
});

// ── the network ──

describe("SSRF protection", () => {
  it("blocks private, loopback, link-local, CGNAT and mapped addresses", () => {
    for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "198.18.0.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) expect(isBlockedAddress(ip), ip).toBe(false);
  });

  it("https only, no credentials, no literal private address", () => {
    expect(() => checkIconUrl("http://example.com/a.png")).toThrow(/https/);
    expect(() => checkIconUrl("ftp://example.com/a.png")).toThrow(/https/);
    expect(() => checkIconUrl("https://user:pw@example.com/a.png")).toThrow(/credentials/);
    expect(() => checkIconUrl("https://169.254.169.254/latest/meta-data")).toThrow(/private/);
    expect(() => checkIconUrl("https://[::1]/")).toThrow(/private/);
    expect(() => checkIconUrl("https://localhost/")).toThrow(/private/);
    expect(checkIconUrl("https://example.com/a.png").hostname).toBe("example.com");
  });

  it("refuses a host that resolves to a private address (the check is on the connected address)", async () => {
    const fetcher = guardedFetcher({ resolve: async () => ["10.0.0.7"], timeoutMs: 2000 });
    await expect(fetcher("https://intranet.example.com/logo.png", { maxBytes: 1000, accept: "image/*" })).rejects.toThrow(/private or local/);
    const mixed = guardedFetcher({ resolve: async () => ["93.184.216.34", "127.0.0.1"], timeoutMs: 2000 });
    await expect(mixed("https://rebind.example.com/", { maxBytes: 1000, accept: "*/*" })).rejects.toThrow(/private or local/);
  });

  describe("against a local server (private network allowed, as an admin can)", () => {
    let server: Server;
    let base: string;
    beforeAll(async () => {
      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const path = req.url ?? "/";
        if (path === "/big") { res.writeHead(200, { "content-type": "image/png" }); res.end(Buffer.alloc(4096)); return; }
        if (path === "/deflate") { res.writeHead(200, { "content-type": "text/html", "content-encoding": "deflate" }); res.end(deflateSync(Buffer.from("<html>" + "x".repeat(5000)))); return; }
        if (path.startsWith("/loop")) { res.writeHead(302, { location: `/loop${path.length}` }); res.end(); return; }
        if (path === "/to-metadata") { res.writeHead(302, { location: "https://169.254.169.254/latest" }); res.end(); return; }
        if (path === "/to-http") { res.writeHead(302, { location: "http://example.com/x.png" }); res.end(); return; }
        if (path === "/ok") { res.writeHead(301, { location: "/final.png" }); res.end(); return; }
        if (path === "/final.png") { res.writeHead(200, { "content-type": "image/png" }); res.end(png(64)); return; }
        res.writeHead(404); res.end();
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    const local = () => guardedFetcher({ allowPrivateNetwork: true, timeoutMs: 3000 });

    it("follows a redirect, re-checking it", async () => {
      const res = await local()(`${base}/ok`, { maxBytes: 1000, accept: "image/*" });
      expect(res).toMatchObject({ status: 200, url: `${base}/final.png` });
      expect(sniffImage(res.body)).toBe("image/png");
      await expect(local()(`${base}/to-http`, { maxBytes: 1000, accept: "*/*" })).rejects.toThrow(/https/);
      await expect(guardedFetcher({ timeoutMs: 3000 })(`${base}/ok`, { maxBytes: 1000, accept: "*/*" })).rejects.toThrow(/https|private/);
    });

    it("stops after a few redirects", async () => {
      await expect(local()(`${base}/loop`, { maxBytes: 1000, accept: "*/*" })).rejects.toThrow(/Too many redirects/);
    });

    it("caps the body (fails, or truncates a page), decompressed size included", async () => {
      await expect(local()(`${base}/big`, { maxBytes: 1024, accept: "image/*" })).rejects.toThrow(/Too large/);
      const page = await local()(`${base}/deflate`, { maxBytes: 1024, accept: "text/html", truncate: true });
      expect(page).toMatchObject({ truncated: true });
      expect(page.body.length).toBe(1024);
    });
  });
});

// ── storage, serving and the API ──

const allowLocal = () => ({ connectors: { allowPrivateNetwork: true } });

describe("icons through the API", () => {
  const dirs: string[] = [];
  const managers: ConnectorManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.closeAll()));
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  function setup(net: ReturnType<typeof fakeNet>, autoDiscoverIcons = true) {
    const polpoDir = mkdtempSync(join(tmpdir(), "polpo-icons-"));
    dirs.push(polpoDir);
    const events: Array<{ id: string; action?: string }> = [];
    const manager = new ConnectorManager({ polpoDir, settings: allowLocal, emit: (e) => events.push(e), log: () => undefined, autoDiscoverIcons, iconFetcher: net.fetcher });
    managers.push(manager);
    const app = new Hono();
    app.route("/api/v1/connectors", connectorRoutes({ manager: () => manager, settings: allowLocal, redirectUri: () => "https://polpo.example.com/api/v1/connectors/oauth/callback", fetcher: net.fetcher }));
    return { manager, app, events, polpoDir };
  }

  const site = () => fakeNet({
    "https://acme.dev/": { type: "text/html", body: `<link rel="icon" href="/logo.svg">` },
    "https://acme.dev/logo.svg": { type: "image/svg+xml", body: SVG },
  });

  async function until<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it("a custom connector gets its icon on create; it is served with an ETag and long caching for the hashed URL", async () => {
    const net = site();
    const { manager, app, events } = setup(net);
    const created = await app.request("/api/v1/connectors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Acme", url: "https://mcp.acme.dev/mcp" }) });
    expect(created.status).toBe(201);
    const asset = await until(() => manager.store.get("acme")?.iconAsset);
    expect(asset).toMatchObject({ source: "website", mimeType: "image/svg+xml", src: "https://acme.dev/logo.svg" });
    expect(events.some((e) => e.id === "acme" && e.action === "updated")).toBe(true);

    const list = await (await app.request("/api/v1/connectors")).json();
    expect(list.data.connectors[0].iconUrl).toBe(`/api/v1/connectors/acme/icon?v=${asset.hash}`);

    const res = await app.request(`/api/v1/connectors/acme/icon?v=${asset.hash}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("etag")).toBe(`"${asset.hash}"`);
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toMatch(/default-src 'none'.*sandbox/);
    expect(await res.text()).toContain("<svg");
    const unversioned = await app.request("/api/v1/connectors/acme/icon");
    expect(unversioned.headers.get("cache-control")).toBe("private, no-cache");
    const again = await app.request("/api/v1/connectors/acme/icon", { headers: { "if-none-match": `"${asset.hash}"` } });
    expect(again.status).toBe(304);
  });

  it("no icon: 404 (the dashboard shows the letter tile), and the next lookup waits a day", async () => {
    const net = fakeNet({});
    const { manager, app } = setup(net);
    await app.request("/api/v1/connectors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Nada", url: "https://mcp.nada.dev/mcp" }) });
    await until(() => manager.store.get("nada")?.iconCheckedAt);
    expect((await app.request("/api/v1/connectors/nada/icon")).status).toBe(404);
    const before = net.calls.length;
    await app.request("/api/v1/connectors");
    await new Promise((r) => setTimeout(r, 50));
    expect(net.calls.length).toBe(before);
  });

  it("existing custom connectors are looked up lazily on the first list; catalog connectors never are", async () => {
    const net = site();
    const { manager, app } = setup(net);
    const now = new Date().toISOString();
    const base = { kind: "mcp" as const, auth: { type: "none" as const }, access: { agents: [], polpo: true }, enabled: true, createdAt: now };
    manager.store.create({ ...base, id: "acme", name: "Acme", transport: { type: "http", url: "https://mcp.acme.dev/mcp" } });
    manager.store.create({ ...base, id: "linear", name: "Linear", catalogId: "linear", transport: { type: "http", url: "https://mcp.linear.app/mcp" } });
    const list = await (await app.request("/api/v1/connectors")).json();
    expect(list.data.connectors.find((c: ConnectorConfig) => c.id === "linear").iconUrl).toBe("/connector-icons/linear.svg");
    await until(() => manager.store.get("acme")?.iconAsset);
    expect(net.calls.every((c) => !c.url.includes("linear"))).toBe(true);
    expect(manager.store.get("linear")?.iconAsset).toBeUndefined();
    // a catalog connector cannot be overridden or refreshed
    expect((await app.request("/api/v1/connectors/linear/icon/refresh", { method: "POST" })).status).toBe(400);
    expect((await app.request("/api/v1/connectors/linear/icon", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ dataUri: dataUri("image/png", png(64)) }) })).status).toBe(400);
  });

  it("the person's upload or URL wins (pinned) until reset; bad images are refused", async () => {
    const net = fakeNet({
      ...Object.fromEntries(Object.entries({ "https://acme.dev/": { type: "text/html", body: `<link rel="icon" href="/logo.svg">` }, "https://acme.dev/logo.svg": { type: "image/svg+xml", body: SVG } })),
      "https://img.example.com/mine.png": { type: "image/png", body: png(256) },
      "https://img.example.com/page.html": { type: "text/html", body: "<html></html>" },
    });
    const { manager, app } = setup(net, false);
    manager.store.create({ id: "acme", name: "Acme", kind: "mcp", transport: { type: "http", url: "https://mcp.acme.dev/mcp" }, auth: { type: "none" }, access: { agents: [], polpo: true }, enabled: true, createdAt: new Date().toISOString() });
    const put = (body: unknown) => app.request("/api/v1/connectors/acme/icon", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const up = await (await put({ dataUri: dataUri("image/png", png(128)) })).json();
    expect(up.data.iconAsset).toMatchObject({ source: "upload", pinned: true, width: 128 });
    // discovery leaves a pinned icon alone
    await app.request("/api/v1/connectors/acme/icon/refresh", { method: "POST" });
    expect(manager.store.get("acme")?.iconAsset).toMatchObject({ source: "upload" });

    const byUrl = await (await put({ url: "https://img.example.com/mine.png" })).json();
    expect(byUrl.data.iconAsset).toMatchObject({ source: "url", pinned: true, src: "https://img.example.com/mine.png", width: 256 });

    expect((await put({ url: "https://img.example.com/page.html" })).status).toBe(400);
    expect((await put({ dataUri: "data:text/html;base64,PGh0bWw+" })).status).toBe(400);
    expect((await put({ dataUri: dataUri("image/svg+xml", "<html>nope</html>") })).status).toBe(400);
    expect((await put({})).status).toBe(400);

    const reset = await (await app.request("/api/v1/connectors/acme/icon", { method: "DELETE" })).json();
    expect(reset.data.iconAsset).toMatchObject({ source: "website" });
    expect(reset.data.iconAsset.pinned).toBeUndefined();
  });

  it("removing the connector removes its icon", async () => {
    const net = site();
    const { manager, app } = setup(net);
    await app.request("/api/v1/connectors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Acme", url: "https://mcp.acme.dev/mcp" }) });
    const asset = await until(() => manager.store.get("acme")?.iconAsset);
    await app.request("/api/v1/connectors/acme", { method: "DELETE" });
    expect(manager.icons.read({ id: "acme", iconAsset: asset } as ConnectorConfig)).toBeUndefined();
  });

  it("icon URLs: catalog → bundled file; custom → the API, with a dark variant", () => {
    expect(connectorIconUrls({ id: "gmail-2", catalogId: "gmail" })).toEqual({ iconUrl: expect.stringMatching(/^\/connector-icons\/gmail\.(svg|png|ico)$/) });
    expect(connectorIconUrls({ id: "x", catalogId: "not-in-catalog" })).toEqual({});
    // every bundled icon is a catalog entry's file on disk; recent additions have theirs
    const iconDir = join(__dirname, "..", "..", "ui", "public", "connector-icons");
    for (const [id, ext] of Object.entries(CATALOG_ICON_FILES)) {
      expect(CONNECTOR_CATALOG.some((e) => e.id === id), id).toBe(true);
      expect(existsSync(join(iconDir, `${id}.${ext}`)), `${id}.${ext}`).toBe(true);
    }
    for (const id of ["ovhcloud", "zernio", "v0", "expo", "autumn", "aws", "agentphone"]) {
      expect(connectorIconUrls({ id, catalogId: id }).iconUrl, id).toMatch(new RegExp(`^/connector-icons/${id}\\.(svg|png)$`));
    }
    expect(connectorIconUrls({ id: "x" })).toEqual({});
    expect(connectorIconUrls({ id: "x", iconAsset: { source: "mcp", mimeType: "image/png", hash: "abc", fetchedAt: "", dark: { mimeType: "image/svg+xml", hash: "def" } } }))
      .toEqual({ iconUrl: "/api/v1/connectors/x/icon?v=abc", iconDarkUrl: "/api/v1/connectors/x/icon?theme=dark&v=def" });
  });
});

describe("serverInfo icons on connect (a real MCP server)", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const s = new McpServer({
        name: "iconic", version: "1.0.0", websiteUrl: "https://iconic.example",
        icons: [
          { src: dataUri("image/svg+xml", SVG), mimeType: "image/svg+xml", sizes: ["any"], theme: "light" },
          { src: dataUri("image/png", png(96)), mimeType: "image/png", sizes: ["96x96"], theme: "dark" },
        ],
      });
      s.registerTool("ping", { description: "ping" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
      res.on("close", () => { void transport.close(); void s.close(); });
      await s.connect(transport);
      await transport.handleRequest(req as never, res, raw ? JSON.parse(raw) : undefined);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("stores the light icon and its dark variant from serverInfo.icons, without blocking the connection", async () => {
    const polpoDir = mkdtempSync(join(tmpdir(), "polpo-icons-mcp-"));
    const net = fakeNet({});
    const manager = new ConnectorManager({ polpoDir, settings: allowLocal, log: () => undefined, autoDiscoverIcons: true, iconFetcher: net.fetcher });
    try {
      manager.store.create({ id: "iconic", name: "Iconic", kind: "mcp", transport: { type: "http", url: `${base}/mcp` }, auth: { type: "none" }, access: { agents: [], polpo: true }, enabled: true, createdAt: new Date().toISOString() });
      const test = await manager.test("iconic");
      expect(test.ok).toBe(true);
      const end = Date.now() + 3000;
      while (!manager.store.get("iconic")?.iconAsset && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      const connector = manager.store.get("iconic")!;
      expect(connector.iconAsset).toMatchObject({ source: "mcp", mimeType: "image/svg+xml", dark: { mimeType: "image/png", width: 96 } });
      expect(manager.icons.read(connector, "dark")?.mimeType).toBe("image/png");
      expect(manager.icons.read(connector, "light")?.bytes.toString()).toContain("<svg");
      expect(net.calls).toEqual([]);
    } finally {
      await manager.closeAll();
      rmSync(polpoDir, { recursive: true, force: true });
    }
  });
});

// ── the connection probe ──

describe("probe: how to connect", () => {
  const URL_ = "https://mcp.acme.dev/mcp";
  const initOk = (serverInfo: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    status: 200, type: "application/json",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo, ...extra } }),
    headers: { "mcp-session-id": "s1" },
  });
  const unauthorized = (challenge?: string) => ({ status: 401, type: "application/json", body: "{\"error\":\"invalid_token\"}", headers: challenge ? { "WWW-Authenticate": challenge } : {} });
  const prm = (extra: Record<string, unknown> = {}) => ({
    type: "application/json",
    body: JSON.stringify({ resource: URL_, resource_name: "Acme", authorization_servers: ["https://auth.acme.dev"], scopes_supported: ["read", "write"], ...extra }),
  });
  const asMeta = (extra: Record<string, unknown> = {}) => ({
    type: "application/json",
    body: JSON.stringify({ issuer: "https://auth.acme.dev", authorization_endpoint: "https://auth.acme.dev/authorize", token_endpoint: "https://auth.acme.dev/token", code_challenge_methods_supported: ["S256"], ...extra }),
  });

  it("parses challenges and JSON-RPC in JSON or SSE", () => {
    expect(resourceMetadataFromChallenge(`Bearer error="invalid_token", resource_metadata="https://x/.well-known/oauth-protected-resource"`)).toBe("https://x/.well-known/oauth-protected-resource");
    expect(resourceMetadataFromChallenge("Bearer realm=x")).toBeUndefined();
    expect(firstJsonRpc(`event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n`, "text/event-stream")).toMatchObject({ id: 1 });
    expect(firstJsonRpc("<html>", "text/html")).toBeUndefined();
  });

  it("no auth: initialize succeeds; name, version, instructions and the server's icon", async () => {
    const net = fakeNet({ [URL_]: (o) => (o.method === "POST" ? initOk({ name: "acme-mcp", title: "Acme Tools", version: "2.1.0", icons: [{ src: dataUri("image/svg+xml", SVG) }] }, { instructions: "Use search first." }) : { status: 405 }) });
    const r = await probeConnector(URL_, { fetch: net.fetcher });
    expect(r).toMatchObject({ reachable: true, transport: "http", authRequired: false, server: { name: "acme-mcp", title: "Acme Tools", version: "2.1.0", instructions: "Use search first." } });
    expect(r.recommendation).toMatchObject({ transport: "http", auth: "none", recommended: true, scopes: [], name: "Acme Tools", icon: { source: "mcp", dataUri: expect.stringMatching(/^data:image\/svg\+xml;base64,/) } });
    expect(r.options[0]).toMatchObject({ auth: "none", recommended: true });
    const init = JSON.parse(net.calls[0]!.body!);
    expect(init).toMatchObject({ method: "initialize", params: { protocolVersion: "2025-11-25", clientInfo: { name: "polpo" } } });
    // the session it opened is closed
    expect(net.calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("OAuth with dynamic client registration (the SitoInChat shape): scopes preselected, name from resource_name", async () => {
    const net = fakeNet({
      [URL_]: unauthorized(`Bearer resource_metadata="https://mcp.acme.dev/.well-known/oauth-protected-resource/mcp"`),
      "https://mcp.acme.dev/.well-known/oauth-protected-resource/mcp": prm(),
      "https://auth.acme.dev/.well-known/oauth-authorization-server": asMeta({ registration_endpoint: "https://auth.acme.dev/register", token_endpoint_auth_methods_supported: ["none"] }),
    });
    const r = await probeConnector(URL_, { fetch: net.fetcher, icon: false });
    expect(r).toMatchObject({
      transport: "http", authRequired: true,
      resource: { resourceName: "Acme", scopes: ["read", "write"], authorizationServers: ["https://auth.acme.dev"] },
      authorizationServer: { registration: true, cimd: false, pkceMethods: ["S256"], tokenAuthMethods: ["none"] },
    });
    expect(r.recommendation).toMatchObject({ auth: "oauth-dcr", scopes: ["read", "write"], name: "Acme" });
    expect(r.options.map((o) => [o.auth, o.recommended])).toEqual([["oauth-dcr", true], ["oauth-preregistered", false], ["bearer", false]]);
  });

  it("OAuth with a Client ID Metadata Document when the instance has a public https URL", async () => {
    const net = fakeNet({
      [URL_]: unauthorized(),
      "https://mcp.acme.dev/.well-known/oauth-protected-resource/mcp": prm(),
      "https://auth.acme.dev/.well-known/oauth-authorization-server": asMeta({ client_id_metadata_document_supported: true, registration_endpoint: "https://auth.acme.dev/register" }),
    });
    expect((await probeConnector(URL_, { fetch: net.fetcher, icon: false, canUseCimd: true })).recommendation?.auth).toBe("oauth-cimd");
    const local = await probeConnector(URL_, { fetch: net.fetcher, icon: false, canUseCimd: false });
    expect(local.recommendation?.auth).toBe("oauth-dcr");
    expect(local.options.map((o) => o.auth)).toContain("oauth-cimd");
  });

  it("OAuth without registration: a pre-registered client id (OpenID discovery found under the issuer)", async () => {
    const net = fakeNet({
      [URL_]: unauthorized(),
      "https://mcp.acme.dev/.well-known/oauth-protected-resource": prm({ authorization_servers: ["https://login.acme.dev/tenant"] }),
      "https://login.acme.dev/tenant/.well-known/openid-configuration": asMeta({ issuer: "https://login.acme.dev/tenant" }),
    });
    const r = await probeConnector(URL_, { fetch: net.fetcher, icon: false });
    expect(r.recommendation).toMatchObject({ auth: "oauth-preregistered", notes: expect.arrayContaining([expect.stringMatching(/client id/)]) });
  });

  it("401 with no OAuth metadata: a bearer token", async () => {
    const net = fakeNet({ [URL_]: unauthorized("Bearer realm=\"api\"") });
    const r = await probeConnector(URL_, { fetch: net.fetcher, icon: false });
    expect(r).toMatchObject({ authRequired: true, transport: "http" });
    expect(r.recommendation).toMatchObject({ auth: "bearer", scopes: [], name: "mcp.acme.dev" });
    expect(r.options.map((o) => o.auth)).toEqual(["bearer", "oauth-preregistered"]);
  });

  it("legacy SSE: POST is refused, GET opens an event stream", async () => {
    const net = fakeNet({
      "https://mcp.acme.dev/sse": (o) => (o.method === "POST" ? { status: 405 } : { status: 200, type: "text/event-stream", body: "event: endpoint\ndata: /messages?session=1\n\n" }),
    });
    const r = await probeConnector("https://mcp.acme.dev/sse", { fetch: net.fetcher, icon: false });
    expect(r).toMatchObject({ transport: "sse", authRequired: false });
    expect(r.recommendation).toMatchObject({ transport: "sse", auth: "none", notes: expect.arrayContaining([expect.stringMatching(/SSE/)]) });
  });

  it("unreachable, or not an MCP server", async () => {
    const down = fakeNet({ [URL_]: { throw: "getaddrinfo ENOTFOUND mcp.acme.dev" } as unknown as Route });
    const r = await probeConnector(URL_, { fetch: down.fetcher });
    expect(r).toMatchObject({ reachable: false, error: expect.stringMatching(/Could not reach/), options: [] });
    expect(r.recommendation).toBeUndefined();
    const web = fakeNet({ [URL_]: { status: 200, type: "text/html", body: "<html>marketing</html>" } });
    expect((await probeConnector(URL_, { fetch: web.fetcher })).error).toMatch(/does not look like an MCP server/);
    expect((await probeConnector("not a url", { fetch: web.fetcher })).error).toMatch(/valid/);
    // a blocked address is reported as such
    const blocked = await probeConnector("https://10.0.0.1/mcp", { fetch: guardedFetcher({ timeoutMs: 1000 }) });
    expect(blocked).toMatchObject({ reachable: false, error: expect.stringMatching(/private or local/) });
  });

  it("POST /connectors/discover runs the probe with the instance's CIMD capability", async () => {
    const net = fakeNet({
      [URL_]: unauthorized(),
      "https://mcp.acme.dev/.well-known/oauth-protected-resource/mcp": prm(),
      "https://auth.acme.dev/.well-known/oauth-authorization-server": asMeta({ client_id_metadata_document_supported: true }),
    });
    const polpoDir = mkdtempSync(join(tmpdir(), "polpo-probe-"));
    const manager = new ConnectorManager({ polpoDir, settings: allowLocal, log: () => undefined });
    try {
      const app = new Hono();
      app.route("/c", connectorRoutes({ manager: () => manager, settings: allowLocal, redirectUri: () => "https://polpo.example.com/cb", fetcher: net.fetcher }));
      const res = await app.request("/c/discover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: URL_, icon: false }) });
      const body = await res.json();
      expect(body.data.recommendation).toMatchObject({ auth: "oauth-cimd", scopes: ["read", "write"], name: "Acme" });
      expect((await app.request("/c/discover", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(400);
    } finally {
      rmSync(polpoDir, { recursive: true, force: true });
    }
  });
});
