/**
 * The catalog OAuth health check (src/mcp/catalog-check.ts): the authorization page classifier, and
 * probeCatalogEntry against local fake MCP / OAuth servers (DCR accepted or refused, login page,
 * error page, CIMD, pre-registered, none, bearer, timeout).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ConnectorCatalogEntry } from "@polpo-ai/core";
import { CHECK_REDIRECT_URI, classifyAuthorizeResponse, probeCatalogEntry } from "../mcp/catalog-check.js";
import { guardedFetcher } from "../mcp/icons.js";

const html = (body: string, title = "Page") => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

describe("classifyAuthorizeResponse", () => {
  const url = "https://auth.example.com/authorize?client_id=x";

  it("a login form is a login page", () => {
    const r = classifyAuthorizeResponse({ url, status: 200, contentType: "text/html", body: html('<form><input name="email"><input type="password"></form>', "Sign in") });
    expect(r.kind).toBe("login");
  });

  it("a redirect to another host is followed", () => {
    const r = classifyAuthorizeResponse({ url, status: 302, location: "https://login.example.com/signin?next=1" });
    expect(r).toMatchObject({ kind: "follow", next: "https://login.example.com/signin?next=1" });
  });

  it("a redirect back to the redirect URI with an error is an error", () => {
    const r = classifyAuthorizeResponse({ url, status: 302, location: `${CHECK_REDIRECT_URI}?error=invalid_scope&error_description=Unknown+scope+foo` });
    expect(r.kind).toBe("error");
    expect(r.detail).toContain("invalid_scope: Unknown scope foo");
  });

  it("a redirect to the provider's own page with ?error= is an error", () => {
    const r = classifyAuthorizeResponse({ url, status: 302, location: "https://auth.example.com/oops?error=invalid_client" });
    expect(r).toMatchObject({ kind: "error" });
  });

  it("an HTML error page (redirect_uri mismatch) is an error, even with a 200", () => {
    const r = classifyAuthorizeResponse({ url, status: 200, contentType: "text/html", body: html("<h1>Error</h1><p>The redirect_uri does not match the registered redirect URIs.</p>", "Error") });
    expect(r.kind).toBe("error");
    expect(r.detail).toMatch(/redirect_uri/);
  });

  it("a JSON OAuth error is an error", () => {
    const r = classifyAuthorizeResponse({ url, status: 400, contentType: "application/json", body: JSON.stringify({ error: "invalid_client", error_description: "Client not found" }) });
    expect(r).toMatchObject({ kind: "error", detail: "HTTP 400 invalid_client: Client not found" });
  });

  it("error codes in scripts do not count, only visible text", () => {
    const r = classifyAuthorizeResponse({ url, status: 200, contentType: "text/html", body: html('<script>const m={invalid_client:"Unknown client"}</script><button>Log in</button>') });
    expect(r.kind).toBe("login");
  });

  it("bot walls and rate limits are unverified", () => {
    expect(classifyAuthorizeResponse({ url, status: 403, contentType: "text/html", body: html("Just a moment...", "Just a moment...") }).kind).toBe("unverified");
    expect(classifyAuthorizeResponse({ url, status: 429, body: "" }).kind).toBe("unverified");
  });

  it("a consent page that shows the (example.invalid) redirect URI is not an error", () => {
    const r = classifyAuthorizeResponse({ url, status: 200, contentType: "text/html", body: html(`<h1>Polpo is requesting access</h1><p>Redirect URIs ${CHECK_REDIRECT_URI}</p><button>Authorize</button>`, "Authorize application") });
    expect(r.kind).toBe("login");
  });

  it("a login page with a captcha script is still a login page", () => {
    const r = classifyAuthorizeResponse({ url, status: 200, contentType: "text/html", body: html('<script src="https://www.google.com/recaptcha/api.js"></script><form><input type="password"></form>', "Log in") });
    expect(r.kind).toBe("login");
  });

  it("an empty client-side page is unverified", () => {
    expect(classifyAuthorizeResponse({ url, status: 200, contentType: "text/html", body: html('<div id="root"></div>', "App") }).kind).toBe("unverified");
  });
});

// ── fake servers ──

interface Scenario {
  /** MCP endpoint behaviour. */
  mcp: "none" | "bearer" | "oauth" | "hang";
  registration?: "ok" | "refused" | "absent";
  cimd?: boolean;
  /** What /authorize does. */
  authorize?: "login" | "error-page" | "redirect-error";
  /** The token endpoint takes confidential clients only (e.g. Gong). */
  confidential?: boolean;
}

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function fakeServer(scenario: Scenario) {
  const seen: Array<{ method: string; path: string; query: string; body?: string }> = [];
  let base = "";
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", base);
    seen.push({ method: req.method ?? "GET", path: url.pathname, query: url.search, ...(body ? { body } : {}) });
    const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === "/mcp") {
      if (scenario.mcp === "hang") return; // never answers
      if (scenario.mcp === "none" && req.method === "POST") {
        const id = (JSON.parse(body) as { id: number }).id;
        return json(200, { jsonrpc: "2.0", id, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "fake" } } });
      }
      if (scenario.mcp === "bearer") return json(401, { error: "unauthorized" });
      return json(401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
    }
    if (scenario.mcp === "oauth" && url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    }
    if (scenario.mcp === "oauth" && url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
        response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
        ...(scenario.registration !== "absent" ? { registration_endpoint: `${base}/register` } : {}),
        ...(scenario.cimd ? { client_id_metadata_document_supported: true } : {}),
        ...(scenario.confidential ? { token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"] } : {}),
      });
    }
    if (url.pathname === "/register" && req.method === "POST") {
      if (scenario.registration === "refused") return json(400, { error: "invalid_client_metadata", error_description: "Dynamic registration is not available for this client." });
      const meta = JSON.parse(body) as Record<string, unknown>;
      return json(201, { ...meta, client_id: "client-123", registration_client_uri: `${base}/register/client-123`, registration_access_token: "rat-1" });
    }
    if (url.pathname === "/register/client-123" && req.method === "DELETE") {
      res.writeHead(req.headers.authorization === "Bearer rat-1" ? 204 : 401);
      return res.end();
    }
    if (url.pathname === "/authorize") {
      if (scenario.authorize === "error-page") {
        res.writeHead(400, { "content-type": "text/html" });
        return res.end(html("<p>invalid_request: The redirect_uri is not registered for this client.</p>", "Error"));
      }
      if (scenario.authorize === "redirect-error") {
        res.writeHead(302, { location: `${url.searchParams.get("redirect_uri")}?error=invalid_scope&state=${url.searchParams.get("state")}` });
        return res.end();
      }
      res.writeHead(302, { location: `${base}/login?return=1` });
      return res.end();
    }
    if (url.pathname === "/login") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(html('<form><input name="email"><input type="password" name="password"><button>Sign in</button></form>', "Sign in"));
    }
    json(404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return { base, seen };
}

function entry(base: string, auth: ConnectorCatalogEntry["auth"], extra: Partial<ConnectorCatalogEntry> = {}): ConnectorCatalogEntry {
  return { id: "fake", name: "Fake", category: "Test", description: "", url: `${base}/mcp`, transport: "http", auth, verified: true, ...extra };
}

const options = () => ({ fetcher: guardedFetcher({ allowPrivateNetwork: true }), timeoutMs: 10_000, requestTimeoutMs: 5_000 });

describe("probeCatalogEntry", () => {
  it("DCR accepted: registers with Polpo's metadata, finds the login page, deletes the registration", async () => {
    const { base, seen } = await fakeServer({ mcp: "oauth", registration: "ok", authorize: "login" });
    const r = await probeCatalogEntry(entry(base, "oauth", { oauthRegistration: "dcr" }), options());
    expect(r).toMatchObject({ verdict: "ok", registrationOk: true, authorize: "login", cleanup: "deleted", serverAuth: "oauth-dcr" });
    const registration = JSON.parse(seen.find((s) => s.path === "/register" && s.method === "POST")!.body!) as Record<string, unknown>;
    expect(registration).toMatchObject({ client_name: "Polpo", redirect_uris: [CHECK_REDIRECT_URI], token_endpoint_auth_method: "none" });
    expect(seen.some((s) => s.method === "DELETE" && s.path === "/register/client-123")).toBe(true);
  });

  it("a confidential-only token endpoint gets a client_secret_basic registration", async () => {
    const { base, seen } = await fakeServer({ mcp: "oauth", registration: "ok", authorize: "login", confidential: true });
    const r = await probeCatalogEntry(entry(base, "oauth"), options());
    expect(r.verdict).toBe("ok");
    const registration = JSON.parse(seen.find((s) => s.path === "/register" && s.method === "POST")!.body!) as Record<string, unknown>;
    expect(registration.token_endpoint_auth_method).toBe("client_secret_basic");
  });

  it("resourceIndicator false: the authorization request carries no resource", async () => {
    const { base, seen } = await fakeServer({ mcp: "oauth", registration: "ok", authorize: "login" });
    await probeCatalogEntry(entry(base, "oauth"), options());
    expect(new URLSearchParams(seen.find((s) => s.path === "/authorize")!.query).get("resource")).toBe(`${base}/mcp`);
    seen.length = 0;
    const r = await probeCatalogEntry(entry(base, "oauth", { oauth: { resourceIndicator: false } }), options());
    expect(r.verdict).toBe("ok");
    expect(new URLSearchParams(seen.find((s) => s.path === "/authorize")!.query).has("resource")).toBe(false);
  });

  it("DCR refused with invalid_client_metadata (Meta's answer): fails with the exact error", async () => {
    const { base } = await fakeServer({ mcp: "oauth", registration: "refused" });
    const r = await probeCatalogEntry(entry(base, "oauth", { oauthRegistration: "dcr" }), options());
    expect(r).toMatchObject({ verdict: "fail", registrationOk: false, authorize: null });
    expect(r.registrationError).toBe("invalid_client_metadata: Dynamic registration is not available for this client.");
  });

  it("an authorization error page fails the entry", async () => {
    const { base } = await fakeServer({ mcp: "oauth", registration: "ok", authorize: "error-page" });
    const r = await probeCatalogEntry(entry(base, "oauth"), options());
    expect(r).toMatchObject({ verdict: "fail", registrationOk: true, authorize: "error", cleanup: "deleted" });
    expect(r.authorizeDetail).toMatch(/redirect_uri/);
  });

  it("an error sent back to the redirect URI fails the entry", async () => {
    const { base } = await fakeServer({ mcp: "oauth", registration: "ok", authorize: "redirect-error" });
    const r = await probeCatalogEntry(entry(base, "oauth"), options());
    expect(r).toMatchObject({ verdict: "fail", authorize: "error" });
    expect(r.authorizeDetail).toContain("invalid_scope");
  });

  it("CIMD only: builds the sign-in with a metadata document client id, but cannot verify it", async () => {
    const { base, seen } = await fakeServer({ mcp: "oauth", registration: "absent", cimd: true });
    const r = await probeCatalogEntry(entry(base, "oauth", { oauthRegistration: "cimd" }), options());
    expect(r).toMatchObject({ verdict: "unverified", authorize: "unverified", registrationOk: null, serverAuth: "oauth-cimd" });
    expect(seen.some((s) => s.path === "/register")).toBe(false);
  });

  it("neither DCR nor CIMD: an 'oauth' entry needs a pre-registered app", async () => {
    const { base } = await fakeServer({ mcp: "oauth", registration: "absent" });
    const r = await probeCatalogEntry(entry(base, "oauth"), options());
    expect(r.verdict).toBe("fail");
    expect(r.error).toMatch(/pre-registered/);
  });

  it("pre-registered: metadata with an authorization endpoint is enough", async () => {
    const { base, seen } = await fakeServer({ mcp: "oauth", registration: "absent" });
    const r = await probeCatalogEntry(entry(base, "oauth_preregistered", { oauth: { app: "fake" } }), options());
    expect(r).toMatchObject({ verdict: "ok", authorizeDetail: `authorization endpoint ${base}/authorize` });
    expect(seen.some((s) => s.path === "/register" || s.path === "/authorize")).toBe(false);
  });

  it("none: initialize succeeds", async () => {
    const { base } = await fakeServer({ mcp: "none" });
    expect(await probeCatalogEntry(entry(base, "none"), options())).toMatchObject({ verdict: "ok", serverAuth: "none" });
  });

  it("none, but the server wants a sign-in: fails", async () => {
    const { base } = await fakeServer({ mcp: "oauth", registration: "ok" });
    const r = await probeCatalogEntry(entry(base, "none"), options());
    expect(r.verdict).toBe("fail");
  });

  it("bearer: a 401 without a token", async () => {
    const { base } = await fakeServer({ mcp: "bearer" });
    expect(await probeCatalogEntry(entry(base, "bearer"), options())).toMatchObject({ verdict: "ok", serverAuth: "bearer", reachable: true });
  });

  it("times out per entry", async () => {
    const { base } = await fakeServer({ mcp: "hang" });
    const r = await probeCatalogEntry(entry(base, "oauth"), { ...options(), timeoutMs: 300 });
    expect(r.verdict).toBe("fail");
    expect(r.error).toMatch(/timed out/);
  });

  it("a per-account URL is skipped", async () => {
    const r = await probeCatalogEntry({ ...entry("https://x.example", "oauth"), url: undefined, urlTemplate: "https://{org}.example/mcp" }, options());
    expect(r).toMatchObject({ verdict: "skipped" });
  });
});
