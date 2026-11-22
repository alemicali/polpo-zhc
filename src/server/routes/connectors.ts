/**
 * Connectors (MCP servers the agents and Polpo use), for the dashboard and API clients. Mounted
 * under the authenticated API (/api/v1/connectors). Secrets are write-only: no response ever
 * carries a token, header value, client secret or OAuth state.
 *
 *   GET    /connectors                       list (status, tool counts, access, which secrets are set)
 *   POST   /connectors                       create (from a catalog id or a custom URL; stdio: admin API only)
 *   GET    /connectors/catalog               well-known remote MCP servers + this instance's OAuth redirect URI
 *   GET    /connectors/oauth-apps            shared OAuth apps (client ids; whether a secret is set)
 *   PUT    /connectors/oauth-apps/:app       { clientId, clientSecret?, name? } (e.g. "google")
 *   DELETE /connectors/oauth-apps/:app
 *   GET    /connectors/:id
 *   PATCH  /connectors/:id                   name, description, access, enabled, transport, auth, toolPolicy, secrets (write-only)
 *   DELETE /connectors/:id                   revoke (best effort), delete secrets and config
 *   POST   /connectors/:id/test              connect + list tools
 *   GET    /connectors/:id/tools             the server's tools (?refresh=1), with their policy
 *   POST   /connectors/:id/oauth/start       { authorizationUrl } to open (or { authorized: true })
 *   POST   /connectors/:id/disconnect        revoke + forget the OAuth tokens
 *   POST   /connectors/discover              { url }: how to connect to an MCP server (transport, auth, scopes, name, icon)
 *   GET    /connectors/:id/icon              a custom connector's icon (?theme=dark; ETag, cached); 404: none (letter tile)
 *   POST   /connectors/:id/icon/refresh      look the icon up again (custom connectors)
 *   PUT    /connectors/:id/icon              { url } or { dataUri }: the person's own icon (pinned)
 *   DELETE /connectors/:id/icon              back to the discovered icon
 *
 * The OAuth callback (GET /api/v1/connectors/oauth/callback) is NOT here: the browser comes back
 * from the provider without the API key, so it is mounted publicly (see `connectorOAuthCallback`)
 * and authenticated by the single-use, 10-minute state.
 */
import { Hono, type Context } from "hono";
import { CONNECTOR_ID_PATTERN, type PolpoSettings } from "@polpo-ai/core";
import { CONNECTOR_CATALOG } from "../../mcp/catalog.js";
import { ConnectorError, type ConnectorManager } from "../../mcp/manager.js";
import { allowPrivateNetwork } from "../../mcp/net.js";
import { applyConnectorPatch, buildConnector, ConnectorInputError, type ConnectorInput } from "../../mcp/validate.js";
import { IconInputError } from "../../mcp/icon-store.js";
import { guardedFetcher, type SafeFetcher } from "../../mcp/icons.js";
import { probeConnector } from "../../mcp/probe.js";
import { publicConnector } from "../../mcp/view.js";

export { CONNECTOR_OAUTH_CALLBACK_PATH } from "../../mcp/runtime.js";

export interface ConnectorRouteDeps {
  manager: () => ConnectorManager;
  settings: () => PolpoSettings | undefined;
  /** This instance's OAuth redirect URI as the browser reaches it (public origin + callback path). */
  redirectUri: (c: Context) => string;
  /** Tests: the network the probe (POST /discover) uses. */
  fetcher?: SafeFetcher;
}

function fail(c: Context, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const status = err instanceof ConnectorInputError || err instanceof IconInputError ? 400 : err instanceof ConnectorError ? 409 : 500;
  return c.json({ ok: false, error: message, ...(err instanceof ConnectorError && err.oauthApp ? { oauthApp: err.oauthApp } : {}) }, status);
}

export function connectorRoutes(deps: ConnectorRouteDeps): Hono {
  const app = new Hono();
  const ctx = (manager: ConnectorManager) => ({
    allowStdio: true, // this API is authenticated (API key / dashboard session): an admin
    existingIds: manager.store.list().map((c) => c.id),
    allowPrivateNetwork: allowPrivateNetwork(deps.settings()),
  });
  const view = async (manager: ConnectorManager, id: string) => {
    const connector = manager.store.get(id);
    return connector ? publicConnector(connector, await manager.secrets.keys(id)) : undefined;
  };

  app.get("/", async (c) => {
    const manager = deps.manager();
    const list = manager.store.list();
    const connectors = await Promise.all(list.map(async (connector) => publicConnector(connector, await manager.secrets.keys(connector.id))));
    // custom connectors without an icon yet (e.g. added before discovery existed): looked up in the background
    manager.icons.ensure(list);
    return c.json({ ok: true, data: { connectors } });
  });

  app.get("/catalog", async (c) => {
    const manager = deps.manager();
    const apps = await Promise.all(manager.store.listOAuthApps().map(async (a) => ({ ...a, hasSecret: !!(await manager.secrets.appSecret(a.id)) })));
    return c.json({ ok: true, data: { entries: CONNECTOR_CATALOG, redirectUri: deps.redirectUri(c), oauthApps: apps } });
  });

  app.get("/oauth-apps", async (c) => {
    const manager = deps.manager();
    const apps = await Promise.all(manager.store.listOAuthApps().map(async (a) => ({ ...a, hasSecret: !!(await manager.secrets.appSecret(a.id)) })));
    return c.json({ ok: true, data: { apps, redirectUri: deps.redirectUri(c) } });
  });

  app.put("/oauth-apps/:app", async (c) => {
    const manager = deps.manager();
    const id = c.req.param("app");
    const body = await c.req.json().catch(() => ({})) as { clientId?: unknown; clientSecret?: unknown; name?: unknown };
    try {
      if (!CONNECTOR_ID_PATTERN.test(id)) throw new ConnectorInputError("Invalid OAuth app id");
      if (typeof body.clientId !== "string" || !body.clientId.trim()) throw new ConnectorInputError("clientId is required");
      const saved = manager.store.upsertOAuthApp({ id, clientId: body.clientId.trim(), ...(typeof body.name === "string" ? { name: body.name } : {}) });
      if (typeof body.clientSecret === "string") await manager.secrets.setAppSecret(id, body.clientSecret.trim() || undefined);
      // connectors using this app connect with the new client next time
      for (const connector of manager.store.list().filter((x) => x.auth.oauth?.app === id)) await manager.close(connector.id);
      return c.json({ ok: true, data: { ...saved, hasSecret: !!(await manager.secrets.appSecret(id)) } });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.delete("/oauth-apps/:app", async (c) => {
    const manager = deps.manager();
    const id = c.req.param("app");
    const removed = manager.store.removeOAuthApp(id);
    await manager.secrets.setAppSecret(id, undefined);
    return c.json({ ok: true, data: { removed } });
  });

  app.post("/", async (c) => {
    const manager = deps.manager();
    const body = await c.req.json().catch(() => ({})) as ConnectorInput;
    try {
      const { connector, secrets } = await buildConnector(body, ctx(manager));
      if (Object.values(secrets).some(Boolean) && !manager.secrets.available) throw new ConnectorInputError("The vault is not available: cannot store the connector's secrets");
      manager.store.create(connector);
      if (Object.keys(secrets).length) await manager.secrets.patch(connector.id, secrets);
      manager.announce(connector.id, "created");
      manager.icons.discoverSoon(connector.id);
      return c.json({ ok: true, data: await view(manager, connector.id) }, 201);
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post("/discover", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { url?: unknown; icon?: unknown };
    if (typeof body.url !== "string" || !body.url.trim()) return c.json({ ok: false, error: "url is required" }, 400);
    const fetcher = deps.fetcher ?? guardedFetcher({ allowPrivateNetwork: allowPrivateNetwork(deps.settings()) });
    const result = await probeConnector(body.url, {
      fetch: fetcher,
      canUseCimd: deps.redirectUri(c).startsWith("https://"),
      icon: body.icon !== false,
    });
    return c.json({ ok: true, data: result });
  });

  app.get("/:id/icon", (c) => {
    const manager = deps.manager();
    const connector = manager.store.get(c.req.param("id"));
    if (!connector) return c.json({ ok: false, error: "Connector not found" }, 404);
    const image = manager.icons.read(connector, c.req.query("theme") === "dark" ? "dark" : "light");
    if (!image) return c.json({ ok: false, error: "No icon" }, 404);
    const etag = `"${image.hash}"`;
    const headers: Record<string, string> = {
      ETag: etag,
      // the URL carries the hash (?v=): a matching one never changes
      "Cache-Control": c.req.query("v") === image.hash ? "private, max-age=31536000, immutable" : "private, no-cache",
      "X-Content-Type-Options": "nosniff",
      // an SVG opened directly runs nothing and loads nothing
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      "Content-Disposition": "inline",
    };
    if (c.req.header("if-none-match")?.split(/\s*,\s*/).includes(etag)) return c.body(null, 304, headers);
    return c.body(new Uint8Array(image.bytes), 200, { ...headers, "Content-Type": image.mimeType });
  });

  app.post("/:id/icon/refresh", async (c) => {
    const manager = deps.manager();
    const connector = manager.store.get(c.req.param("id"));
    if (!connector) return c.json({ ok: false, error: "Connector not found" }, 404);
    if (connector.catalogId) return c.json({ ok: false, error: `${connector.name} is a catalog connector: it uses its official icon` }, 400);
    await manager.icons.refresh(connector.id);
    return c.json({ ok: true, data: await view(manager, connector.id) });
  });

  app.put("/:id/icon", async (c) => {
    const manager = deps.manager();
    const id = c.req.param("id");
    if (!manager.store.get(id)) return c.json({ ok: false, error: "Connector not found" }, 404);
    const body = await c.req.json().catch(() => ({})) as { url?: unknown; dataUri?: unknown };
    try {
      if (typeof body.dataUri === "string" && body.dataUri) manager.icons.setFromUpload(id, body.dataUri);
      else if (typeof body.url === "string" && body.url.trim()) await manager.icons.setFromUrl(id, body.url.trim());
      else throw new IconInputError("Give url (an https image) or dataUri (an uploaded image)");
      return c.json({ ok: true, data: await view(manager, id) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.delete("/:id/icon", async (c) => {
    const manager = deps.manager();
    const id = c.req.param("id");
    if (!manager.store.get(id)) return c.json({ ok: false, error: "Connector not found" }, 404);
    try {
      await manager.icons.reset(id);
      return c.json({ ok: true, data: await view(manager, id) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/:id", async (c) => {
    const data = await view(deps.manager(), c.req.param("id"));
    return data ? c.json({ ok: true, data }) : c.json({ ok: false, error: "Connector not found" }, 404);
  });

  app.patch("/:id", async (c) => {
    const manager = deps.manager();
    const current = manager.store.get(c.req.param("id"));
    if (!current) return c.json({ ok: false, error: "Connector not found" }, 404);
    const body = await c.req.json().catch(() => ({})) as ConnectorInput;
    try {
      const { patch, secrets, reconnect } = await applyConnectorPatch(current, body, ctx(manager));
      if (Object.values(secrets).some(Boolean) && !manager.secrets.available) throw new ConnectorInputError("The vault is not available: cannot store the connector's secrets");
      manager.store.update(current.id, patch);
      if (Object.keys(secrets).length) await manager.secrets.patch(current.id, secrets);
      if (reconnect) await manager.close(current.id);
      // another server: another icon (an icon the person set stays)
      if (patch.transport?.url && patch.transport.url !== current.transport.url) manager.icons.discoverSoon(current.id);
      if (patch.enabled === false) manager.setStatus(current.id, "disabled");
      else if (patch.enabled === true && current.status === "disabled") manager.setStatus(current.id, "disconnected");
      manager.announce(current.id, "updated");
      return c.json({ ok: true, data: await view(manager, current.id) });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.delete("/:id", async (c) => {
    const removed = await deps.manager().remove(c.req.param("id"));
    return removed ? c.json({ ok: true, data: { removed: true } }) : c.json({ ok: false, error: "Connector not found" }, 404);
  });

  app.post("/:id/test", async (c) => {
    const manager = deps.manager();
    const id = c.req.param("id");
    if (!manager.store.get(id)) return c.json({ ok: false, error: "Connector not found" }, 404);
    const result = await manager.test(id);
    return c.json({
      ok: true,
      data: { ...result, tools: result.tools?.map((t) => ({ name: t.name, title: t.title, description: t.description })), connector: await view(manager, id) },
    });
  });

  app.get("/:id/tools", async (c) => {
    const manager = deps.manager();
    const connector = manager.store.get(c.req.param("id"));
    if (!connector) return c.json({ ok: false, error: "Connector not found" }, 404);
    try {
      const tools = await manager.listTools(connector.id, { refresh: c.req.query("refresh") === "1" });
      return c.json({
        ok: true,
        data: { tools: tools.map((t) => ({ ...t, policy: connector.toolPolicy?.[t.name] ?? "allow" })) },
      });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post("/:id/oauth/start", async (c) => {
    const manager = deps.manager();
    const id = c.req.param("id");
    if (!manager.store.get(id)) return c.json({ ok: false, error: "Connector not found" }, 404);
    try {
      return c.json({ ok: true, data: { ...(await manager.startOAuth(id, deps.redirectUri(c))), redirectUri: deps.redirectUri(c) } });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post("/:id/disconnect", async (c) => {
    const manager = deps.manager();
    const id = c.req.param("id");
    if (!manager.store.get(id)) return c.json({ ok: false, error: "Connector not found" }, 404);
    await manager.disconnect(id);
    return c.json({ ok: true, data: await view(manager, id) });
  });

  return app;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]!));

function page(title: string, message: string, back: string, ok: boolean, id?: string): string {
  const payload = JSON.stringify({ type: "polpo:connector-oauth", ok, id: id ?? null }).replace(/</g, "\\u003c");
  // the opener is the dashboard, which may be on another origin than this callback (the public API URL)
  const dashboardOrigin = (() => { try { return new URL(back).origin; } catch { return undefined; } })();
  const target = dashboardOrigin ? JSON.stringify(dashboardOrigin).replace(/</g, "\\u003c") : "location.origin";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#fafafa;color:#111}
main{max-width:420px;padding:24px;text-align:center}h1{font-size:20px}a{color:#2563eb}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(back)}">Back to Polpo</a></p></main>
<script>try{if(window.opener){window.opener.postMessage(${payload},${target});setTimeout(function(){window.close()},800)}}catch(e){}</script>
</body></html>`;
}

/** GET /api/v1/connectors/oauth/callback — public; authenticated by the single-use state. */
export function connectorOAuthCallback(deps: { manager: () => ConnectorManager; uiUrl: (c: Context) => string }) {
  return async (c: Context) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code");
    const error = c.req.query("error");
    const manager = deps.manager();
    const ui = deps.uiUrl(c);
    if (error || !code) {
      const description = c.req.query("error_description");
      const reason = [error ?? "no code", description].filter(Boolean).join(": ");
      const message = `Authorization was not completed (${reason}).`;
      // the provider's error (and description) becomes the connector's lastError
      const pending = await manager.abortOAuth(state, error ?? "no code", description);
      return c.html(page("Not connected", message, `${ui}/connectors`, false, pending?.id), 400);
    }
    try {
      const { connector, error: connectError } = await manager.finishOAuth(state, code);
      const back = `${ui}/connectors?connected=${encodeURIComponent(connector.id)}`;
      return c.html(page(
        `${connector.name} connected`,
        connectError ? `Authorized, but the first connection failed: ${connectError}` : "You can close this tab and go back to Polpo.",
        back, true, connector.id,
      ));
    } catch (err) {
      return c.html(page("Not connected", err instanceof Error ? err.message : String(err), `${ui}/connectors`, false), 400);
    }
  };
}
