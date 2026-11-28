import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// ── SDK mock: SSE buffer + agents ───────────────────────────────────────────
type FakeEvent = { id: string; event: string; data: unknown; timestamp: string };
const sse = vi.hoisted(() => ({
  events: [] as FakeEvent[],
  listeners: new Set<() => void>(),
  push(event: string, data: unknown) {
    sse.events = [...sse.events, { id: String(sse.events.length + 1), event, data, timestamp: new Date().toISOString() }];
    sse.listeners.forEach((l) => l());
  },
}));
vi.mock("@polpo-ai/react", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useEvents: (filter?: string[]) => {
      const all = useSyncExternalStore(
        (cb) => { sse.listeners.add(cb); return () => sse.listeners.delete(cb); },
        () => sse.events,
      );
      return { events: filter?.length ? all.filter((e) => filter.includes(e.event)) : all };
    },
    useAgents: () => ({ agents: [{ name: "pm", identity: { displayName: "Marco" } }, { name: "dev" }], teams: [], isLoading: false }),
    // hosted MCP servers (their own tests: hosted-servers.test.tsx)
    useMcpServers: () => ({ servers: [], templates: [], isLoading: false, error: null, refetch: async () => {}, create: async () => ({ id: "x", problems: [] }), generate: async () => ({}) }),
    useMcpServer: () => ({ server: undefined, versions: [], deploys: [], isLoading: false, error: null }),
  };
});

import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { ConnectorsPage } from "../src/pages/connectors";
import { AgentConnectorsSection } from "../src/components/connectors/agent-connectors-section";
import { ConnectorDetailSheet } from "../src/components/connectors/connector-detail-sheet";
import { CustomConnectorDialog } from "../src/components/connectors/custom-connector-dialog";
import { DEFAULT_PRODUCT_NAME } from "../src/lib/branding";
import {
  EMPTY_CUSTOM_FORM, OAUTH_MESSAGE_TYPE, allowedToolsCoverConnector, catalogCardState, catalogCategories, customConnectorInput,
  filterCatalog, splitArgs, toggleAgentAccess, validateCustomConnector,
  accountLabel, groupConnectors, nextAccountName, suggestedAccountName,
  accountLabelFrom, identityTargetFor, importCandidates, importIdentity,
  type CatalogEntry, type Connector, type ConnectorAccount,
} from "../src/lib/connectors-api";

// ── Fixtures ────────────────────────────────────────────────────────────────
const entry = (id: string, name: string, category: string, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id, name, category, description: `${name} tools`, url: `https://mcp.${id}.com/mcp`, transport: "http", auth: "oauth", verified: true, ...extra,
});
const CATALOG: CatalogEntry[] = [
  entry("linear", "Linear", "Project management", { description: "Manage Linear issues", inClaudeDirectory: true }),
  entry("notion", "Notion", "Knowledge & docs", { description: "Search Notion pages" }),
  entry("gmail", "Gmail", "Google Workspace", { auth: "oauth_preregistered", oauth: { app: "google" }, setup: "Google needs an OAuth client:\n1. Create a Web application client.\n2. Add this instance's redirect URI to it: <public URL>/api/v1/connectors/oauth/callback (shown on the Connectors page)." }),
  entry("stripe", "Stripe", "Payments", { auth: "bearer" }),
  entry("azure-devops", "Azure DevOps", "Developer tools", { url: undefined, urlTemplate: "https://mcp.dev.azure.com/{organization}" }),
];
const REDIRECT = "https://polpo.example.com/api/v1/connectors/oauth/callback";

function connector(id: string, extra: Partial<Connector> = {}): Connector {
  return {
    id, name: id[0]!.toUpperCase() + id.slice(1), kind: "mcp", transport: { type: "http", url: `https://mcp.${id}.com/mcp` },
    auth: { type: "oauth" }, access: { agents: [], polpo: true }, enabled: true, catalogId: id, createdAt: "2026-11-19T00:00:00Z",
    status: "needs_auth",
    secrets: { bearerToken: false, headers: [], clientSecret: false, values: [], oauth: { authorized: false, clientRegistered: false, pending: false } },
    ...extra,
  };
}

// ── Fake server ─────────────────────────────────────────────────────────────
interface Server {
  connectors: Connector[];
  catalog?: CatalogEntry[];
  oauthApps: Array<{ id: string; clientId: string; hasSecret: boolean; createdAt: string }>;
  calls: Array<{ method: string; path: string; body?: unknown }>;
  registrationFailure?: string;
}
let server: Server;

function ok(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify({ ok: true, data }), { status }));
}

function installFetch() {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    if (url.pathname.startsWith("/api/v1/agents/")) {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      server.calls.push({ method: init?.method ?? "GET", path: url.pathname, body });
      return ok({ name: decodeURIComponent(url.pathname.split("/").pop()!), ...(body?.connectorTools ? { connectorTools: body.connectorTools } : {}) });
    }
    const path = url.pathname.replace("/api/v1/connectors", "") || "/";
    const catalog = server.catalog ?? CATALOG;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    server.calls.push({ method, path, body });
    expect(url.search).not.toMatch(/key|token/i); // credentials never go in the URL
    if (path === "/" && method === "GET") return ok({ connectors: server.connectors });
    if (path === "/catalog") return ok({ entries: catalog, redirectUri: REDIRECT, oauthApps: server.oauthApps });
    if (path.startsWith("/oauth-apps/") && method === "PUT") {
      const app = { id: path.split("/")[2]!, clientId: body.clientId, hasSecret: !!body.clientSecret, createdAt: "x" };
      server.oauthApps = [...server.oauthApps.filter((a) => a.id !== app.id), app];
      return ok(app);
    }
    if (path === "/" && method === "POST") {
      const fromCatalog = catalog.find((e) => e.id === body.catalogId);
      // like the server: another account of an app gets the next free id (linear-2…)
      const baseId = body.catalogId ?? "custom";
      let newId = baseId;
      for (let n = 2; server.connectors.some((c) => c.id === newId); n++) newId = `${baseId}-${n}`;
      const created = connector(newId, fromCatalog ? {
        catalogId: fromCatalog.id, name: body.name ?? fromCatalog.name,
        ...(fromCatalog.auth === "bearer" ? { auth: { type: "bearer" as const }, status: "disconnected" as const } : {}),
        ...(fromCatalog.oauth ? { auth: { type: "oauth" as const, oauth: fromCatalog.oauth } } : {}),
        ...(body.url ? { transport: { type: "http" as const, url: body.url } } : {}),
      } : { name: body.name, catalogId: undefined, auth: body.auth, transport: body.transport, status: body.auth?.type === "oauth" ? "needs_auth" : "disconnected" });
      // like the server: a per-identity connector has no sign-in of its own, starts with no accounts
      if (body.scope) Object.assign(created, { scope: body.scope }, body.scope.kind === "identity" ? { status: "disconnected", accounts: [] } : {});
      server.connectors = [...server.connectors, created];
      return ok(created, 201);
    }
    const [, id, action] = path.split("/");
    const current = server.connectors.find((c) => c.id === id);
    if (!current) return Promise.resolve(new Response(JSON.stringify({ ok: false, error: "Connector not found" }), { status: 404 }));
    const save = (next: Connector) => { server.connectors = server.connectors.map((c) => (c.id === id ? next : c)); return next; };
    if (action === "accounts") return accountsRoute(current, path.split("/").slice(3), method, body, save);
    if (!action && method === "GET") return ok(current);
    if (!action && method === "DELETE") {
      server.connectors = server.connectors.filter((c) => c.id !== id);
      return ok({ removed: true });
    }
    if (!action && method === "PATCH") return ok(save({ ...current, ...body, access: body.access ? { ...current.access, ...body.access } : current.access }));
    if (action === "oauth" && method === "POST") {
      if (server.registrationFailure && !current.auth.oauth?.app) {
        const error = server.registrationFailure;
        save({ ...current, status: "error", lastError: error });
        return Promise.resolve(new Response(JSON.stringify({ ok: false, error, oauthApp: id }), { status: 409 }));
      }
      save({ ...current, secrets: { ...current.secrets, oauth: { ...current.secrets.oauth, pending: true } } });
      return ok({ authorizationUrl: `https://auth.${id}.com/authorize?state=abc`, redirectUri: REDIRECT });
    }
    if (action === "test") {
      const next = save({ ...current, status: "connected", toolCount: 2 });
      return ok({ ok: true, status: "connected", tools: [{ name: "a" }, { name: "b" }], connector: next });
    }
    if (action === "tools") {
      return ok({ tools: [
        { name: "create_issue", title: "Create issue", description: "Create a Linear issue", policy: current.toolPolicy?.create_issue ?? "allow" },
        { name: "list_issues", description: "List issues", policy: "allow" },
      ] });
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// ── Per-identity connectors: the accounts routes ────────────────────────────
function account(id: string, identity: string, label: string, extra: Partial<ConnectorAccount> = {}): ConnectorAccount {
  return {
    id, identity, label, createdAt: "2026-11-28T00:00:00Z", status: "needs_auth",
    secrets: { bearerToken: false, headers: [], oauth: { authorized: false, pending: false } },
    ...extra,
  };
}
const authorized = { bearerToken: false, headers: [], oauth: { authorized: true, pending: false } };

function accountsRoute(current: Connector, rest: string[], method: string, body: Record<string, unknown> | undefined, save: (c: Connector) => Connector) {
  const [accId, sub] = rest;
  const accounts = current.accounts ?? [];
  const withAccounts = (list: ConnectorAccount[]) => save({ ...current, accounts: list });
  if (!accId && method === "POST") {
    const identity = body!.identity === "me" ? "person:ada@acme.com" : String(body!.identity);
    const secrets = body!.secrets as { bearerToken?: string } | undefined;
    const created = account(`acc-new${accounts.length + 1}`, identity, String(body!.label), {
      ...(accounts.some((a) => a.identity === identity) ? {} : { default: true }),
      status: current.auth.type === "oauth" ? "needs_auth" : "disconnected",
      secrets: { bearerToken: !!secrets?.bearerToken, headers: [], oauth: { authorized: false, pending: false } },
    });
    return ok({ account: created, connector: withAccounts([...accounts, created]) }, 201);
  }
  if (accId === "import" && method === "POST") {
    const source = server.connectors.find((c) => c.id === body!.from)!;
    const identity = String(body!.identity);
    const imported = account("acc-imported", identity, String(body!.label), {
      importedFrom: source.id, status: "connected", secrets: authorized, ...(source.account ? { account: source.account } : {}),
      ...(accounts.some((a) => a.identity === identity) ? {} : { default: true }),
    });
    const next = withAccounts([...accounts, imported]);
    if (body!.removeSource !== false) server.connectors = server.connectors.filter((c) => c.id !== source.id);
    return ok({ account: imported, source: { id: source.id, removed: body!.removeSource !== false, disabled: false }, renamed: { from: `mcp__${source.id}__*`, to: `mcp__${current.id}__*` }, connector: next }, 201);
  }
  const found = accounts.find((a) => a.id === accId);
  if (!found) return Promise.resolve(new Response(JSON.stringify({ ok: false, error: "No such account" }), { status: 404 }));
  const put = (a: ConnectorAccount, makeDefault = false) => withAccounts(accounts.map((x) => {
    if (x.id === a.id) return a;
    if (makeDefault && x.identity === a.identity) { const { default: _d, ...restOf } = x; return restOf; }
    return x;
  }));
  if (!sub && method === "PATCH") {
    const next = { ...found, ...(body!.label ? { label: String(body!.label) } : {}), ...(body!.default ? { default: true } : {}),
      ...((body!.secrets as { bearerToken?: string } | undefined)?.bearerToken ? { secrets: { ...found.secrets, bearerToken: true } } : {}) };
    return ok({ account: next, connector: put(next, !!body!.default) });
  }
  if (!sub && method === "DELETE") return ok({ removed: true, connector: withAccounts(accounts.filter((a) => a.id !== accId)) });
  if (sub === "oauth") {
    put({ ...found, secrets: { ...found.secrets, oauth: { ...found.secrets.oauth, pending: true } } });
    return ok({ authorizationUrl: `https://auth.${current.id}.com/authorize?account=${accId}`, redirectUri: REDIRECT });
  }
  if (sub === "test") {
    const next = { ...found, status: "connected" as const, toolCount: 2 };
    return ok({ ok: true, status: "connected", account: accId, tools: [{ name: "a" }, { name: "b" }], connector: put(next) });
  }
  if (sub === "disconnect") return ok(put({ ...found, status: "needs_auth", secrets: { ...found.secrets, oauth: { authorized: false, pending: false } } }));
  throw new Error(`unexpected ${method} accounts/${rest.join("/")}`);
}

/** The person finishes signing in an account at the provider. */
function completeAccountSignIn(id: string, accId: string, signedInAs?: string) {
  server.connectors = server.connectors.map((c) => (c.id === id
    ? { ...c, accounts: (c.accounts ?? []).map((a) => (a.id === accId ? { ...a, status: "connected" as const, secrets: authorized, ...(signedInAs ? { account: signedInAs } : {}) } : a)) }
    : c));
}

/** The person finishes signing in at the provider: the callback stores tokens and connects. */
function completeSignIn(id: string, toolCount = 3) {
  server.connectors = server.connectors.map((c) => (c.id === id
    ? { ...c, status: "connected", toolCount, secrets: { ...c.secrets, oauth: { authorized: true, clientRegistered: true, pending: false } } }
    : c));
}

// ── DOM helpers ─────────────────────────────────────────────────────────────
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  sse.events = [];
  server = { connectors: [], oauthApps: [], calls: [] };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const byText = (text: string | RegExp, selector = "button") =>
  [...document.querySelectorAll<HTMLElement>(selector)].find((el) => (typeof text === "string" ? el.textContent?.trim() === text : text.test(el.textContent ?? "")));
const inDialog = (text: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')].find((el) => el.textContent?.trim() === text);
const click = (el: Element | null | undefined) => act(async () => { (el as HTMLElement).click(); });
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const inputByLabel = (label: string) => {
  const span = [...document.querySelectorAll("label > span")].find((s) => s.textContent === label);
  return span?.parentElement?.querySelector("input") as HTMLInputElement;
};

async function renderPage(initial = "/connectors") {
  await act(async () => root.render(
    <MemoryRouter initialEntries={[initial]}><TooltipProvider><ConnectorsPage /></TooltipProvider></MemoryRouter>,
  ));
  await flush();
}
const cards = () => [...container.querySelectorAll('[data-testid^="catalog-card-"]')].map((c) => c.getAttribute("data-testid")!.replace("catalog-card-", ""));

// ── Pure helpers ────────────────────────────────────────────────────────────

test("catalog search matches every word, puts name hits first, and filters by category", () => {
  expect(catalogCategories(CATALOG).map((c) => c.name)).toEqual(["Project management", "Knowledge & docs", "Google Workspace", "Payments", "Developer tools"]);
  expect(filterCatalog(CATALOG, { query: "issues" }).map((e) => e.id)).toEqual(["linear"]);
  expect(filterCatalog(CATALOG, { query: "NOTION pages" }).map((e) => e.id)).toEqual(["notion"]);
  expect(filterCatalog(CATALOG, { category: "Payments" }).map((e) => e.id)).toEqual(["stripe"]);
  expect(filterCatalog(CATALOG, { query: "linear", category: "Payments" })).toEqual([]);
  // name matches come before description matches
  const extra = [entry("tracker", "Tracker", "X", { description: "Sync with Linear" }), ...CATALOG];
  expect(filterCatalog(extra, { query: "linear" }).map((e) => e.id)).toEqual(["linear", "tracker"]);
});

test("card state: connect, needs setup until the shared OAuth app has a secret, then the connector's status", () => {
  const gmail = CATALOG[2]!;
  expect(catalogCardState(CATALOG[0]!, [], []).state).toBe("connect");
  expect(catalogCardState(gmail, [], []).state).toBe("needs_setup");
  expect(catalogCardState(gmail, [], [{ id: "google", clientId: "x", hasSecret: false, createdAt: "" }]).state).toBe("needs_setup");
  expect(catalogCardState(gmail, [], [{ id: "google", clientId: "x", hasSecret: true, createdAt: "" }]).state).toBe("connect");
  expect(catalogCardState(CATALOG[0]!, [connector("linear", { status: "connected" })], []).state).toBe("connected");
  expect(catalogCardState(CATALOG[0]!, [connector("linear", { status: "needs_reauth" })], []).state).toBe("needs_reauth");
  expect(catalogCardState(CATALOG[0]!, [connector("linear", { status: "connected", enabled: false })], []).state).toBe("disabled");
});

test("agent access toggles, including revoking from 'every agent'", () => {
  expect(toggleAgentAccess({ agents: [], polpo: true }, "pm", true, ["pm", "dev"])).toEqual({ agents: ["pm"], polpo: true });
  expect(toggleAgentAccess({ agents: ["pm", "dev"], polpo: false }, "pm", false, ["pm", "dev"])).toEqual({ agents: ["dev"], polpo: false });
  expect(toggleAgentAccess({ agents: "*", polpo: true }, "pm", false, ["pm", "dev", "qa"])).toEqual({ agents: ["dev", "qa"], polpo: true });
  expect(toggleAgentAccess({ agents: "*", polpo: true }, "pm", true, ["pm"]).agents).toBe("*");
  expect(allowedToolsCoverConnector(undefined, "linear")).toBe(true);
  expect(allowedToolsCoverConnector(["read_file", "mcp__linear__*"], "linear")).toBe(true);
  expect(allowedToolsCoverConnector(["mcp__*"], "linear")).toBe(true);
  expect(allowedToolsCoverConnector(["read_file", "mcp__notion__*"], "linear")).toBe(false);
});

test("custom connector validation and the request it builds", () => {
  const form = { ...EMPTY_CUSTOM_FORM };
  expect(Object.keys(validateCustomConnector(form)).sort()).toEqual(["name", "url"]);
  expect(validateCustomConnector({ ...form, name: "X", url: "notaurl" }).url).toMatch(/full URL/);
  expect(validateCustomConnector({ ...form, name: "X", url: "http://tools.example.com/mcp" }).url).toMatch(/https/);
  expect(validateCustomConnector({ ...form, name: "X", url: "http://localhost:8080/mcp" })).toEqual({});
  expect(validateCustomConnector({ ...form, name: "X", url: "https://a.com/mcp", auth: "bearer" }).bearerToken).toBeTruthy();
  expect(validateCustomConnector({ ...form, name: "X", url: "https://a.com/mcp", auth: "headers", headers: [{ name: "Bad Name", value: "v" }] }).headers).toMatch(/letters/);
  expect(validateCustomConnector({ ...form, name: "X", url: "https://a.com/mcp", clientSecret: "s" }).clientId).toBeTruthy();
  expect(validateCustomConnector({ ...form, name: "X", kind: "stdio" }).command).toBeTruthy();

  expect(customConnectorInput({ ...form, name: " Tools ", url: "https://a.com/sse", auth: "bearer", bearerToken: " t0k " })).toEqual({
    name: "Tools", transport: { type: "sse", url: "https://a.com/sse" }, auth: { type: "bearer" }, secrets: { bearerToken: "t0k" },
  });
  expect(customConnectorInput({ ...form, name: "T", url: "https://a.com/mcp", auth: "headers", headers: [{ name: "X-Api-Key", value: "k" }] })).toEqual({
    name: "T", transport: { type: "http", url: "https://a.com/mcp" }, auth: { type: "headers", headerNames: ["X-Api-Key"] }, secrets: { headers: { "X-Api-Key": "k" } },
  });
  expect(customConnectorInput({ ...form, name: "T", url: "https://a.com/mcp", clientId: "cid", clientSecret: "sec", scopes: "read, write" })).toEqual({
    name: "T", transport: { type: "http", url: "https://a.com/mcp" }, auth: { type: "oauth", oauth: { clientId: "cid", scopes: ["read", "write"] } }, secrets: { clientSecret: "sec" },
  });
  expect(customConnectorInput({ ...form, name: "FS", kind: "stdio", command: "npx -y @mcp/fs", args: "'/my data'" })).toEqual({
    name: "FS", transport: { type: "stdio", command: "npx", args: ["-y", "@mcp/fs", "/my data"] }, auth: { type: "none" },
  });
  expect(splitArgs(`a "b c" 'd'`)).toEqual(["a", "b c", "d"]);
});

// ── Page ────────────────────────────────────────────────────────────────────

test("browse: search and category chips filter the catalog; empty workspace opens on Browse", async () => {
  installFetch();
  await renderPage();
  expect(byText(/^Browse/, '[role="tab"]')?.getAttribute("aria-selected")).toBe("true");
  expect(cards()).toEqual(["linear", "notion", "gmail", "stripe", "azure-devops"]);
  // official icon bundled locally (no hotlinking); Gmail's needs-setup state
  expect(container.querySelector('[data-testid="catalog-card-linear"] img')?.getAttribute("src")).toMatch(/^\/?connector-icons\/linear\.svg$/);
  expect(container.querySelector('[aria-label="Set up Gmail"]')?.textContent).toBe("Set up");
  expect(container.textContent).toContain("In Claude directory");

  await type(container.querySelector('input[aria-label="Search connectors"]') as HTMLInputElement, "notion");
  expect(cards()).toEqual(["notion"]);
  await type(container.querySelector('input[aria-label="Search connectors"]') as HTMLInputElement, "");
  await click(byText(/^Payments/));
  expect(cards()).toEqual(["stripe"]);
  await click(byText(/^All/));
  expect(cards()).toHaveLength(5);
});

test("connect (OAuth): creates the connector, opens the sign-in window, and shows Connected with the tool count", async () => {
  installFetch();
  const popup = { closed: false, location: { href: "about:blank" }, close: vi.fn(() => { popup.closed = true; }) };
  const open = vi.spyOn(window, "open").mockImplementation(() => popup as unknown as Window);
  await renderPage();

  await click(container.querySelector('[aria-label="Connect Linear"]'));
  expect(open).toHaveBeenCalledTimes(1); // synchronously, inside the click
  await flush();
  expect(server.calls.find((c) => c.method === "POST" && c.path === "/")?.body).toEqual({ catalogId: "linear" });
  expect(server.calls.some((c) => c.path === "/linear/oauth/start")).toBe(true);
  expect(popup.location.href).toBe("https://auth.linear.com/authorize?state=abc");
  expect(document.body.textContent).toContain("Waiting for you to sign in to Linear");

  // the provider redirects to the callback page, which notifies the opener
  completeSignIn("linear", 3);
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: OAUTH_MESSAGE_TYPE, ok: true, id: "linear" } }));
  });
  await flush();
  expect(document.body.textContent).toContain("Linear is connected.");
  expect(document.body.textContent).toContain("3 tools available.");

  // live: the list follows connector:changed
  await act(async () => { sse.push("connector:changed", { id: "linear", status: "connected", toolCount: 3 }); });
  await flush();
  expect(container.querySelector('[data-testid="catalog-card-linear"]')?.textContent).toContain("Connected");
});

test("connect (OAuth): a blocked window offers the sign-in link instead", async () => {
  installFetch();
  vi.spyOn(window, "open").mockImplementation(() => null);
  await renderPage();
  await click(container.querySelector('[aria-label="Connect Notion"]'));
  await flush();
  expect(document.body.textContent).toContain("Your browser blocked the sign-in window.");
  expect(byText(/Open sign-in page/)).toBeTruthy();
});

test("a registration refusal shows the provider message and can be retried with a shared OAuth app", async () => {
  installFetch();
  server.registrationFailure = "Linear did not accept the OAuth client registration (invalid_client_metadata: Client approval is required).";
  vi.spyOn(window, "open").mockImplementation(() => ({ closed: false, location: { href: "" }, close() {} }) as unknown as Window);
  await renderPage();
  await click(container.querySelector('[aria-label="Connect Linear"]'));
  await flush();
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(server.registrationFailure);

  await click(inDialog("Set up OAuth app"));
  await type(inputByLabel("Client ID"), "approved-client");
  await click(inDialog("Save and continue"));
  await flush();
  await click(inDialog("Connect"));
  await flush();

  expect(server.calls.find((c) => c.method === "PUT")?.path).toBe("/oauth-apps/linear");
  expect(server.calls.find((c) => c.method === "PATCH")?.body).toEqual({ auth: { type: "oauth", oauth: { app: "linear" } } });
  expect(document.body.textContent).toContain("Waiting for you to sign in to Linear");
});

test("a Figma connector created before the catalog change offers OAuth app setup", async () => {
  const figma = entry("figma", "Figma", "Design", { auth: "oauth_preregistered", oauth: { app: "figma" } });
  server.catalog = [figma];
  server.connectors = [connector("figma")];
  installFetch();
  vi.spyOn(window, "open").mockImplementation(() => null);
  await renderPage();
  await act(async () => {
    byText(/^Browse/, '[role="tab"]')?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
  expect(container.querySelector('[data-testid="catalog-card-figma"]')?.textContent).toContain("Needs setup");
  await click(container.querySelector('[aria-label="Set up Figma"]'));
  expect(document.body.textContent).toContain("One-time setup");
  expect(server.calls.some((c) => c.path === "/figma/oauth/start")).toBe(false);
  await type(inputByLabel("Client ID"), "figma-approved");
  await type(inputByLabel("Client secret (if issued)"), "figma-secret");
  await click(inDialog("Save and continue"));
  await flush();
  await click(inDialog("Connect"));
  await flush();
  expect(server.calls.find((c) => c.method === "PUT")?.path).toBe("/oauth-apps/figma");
  expect(server.calls.find((c) => c.method === "PATCH")?.body).toEqual({ auth: { type: "oauth", oauth: { app: "figma" } } });
});

test("needs setup: Google's OAuth app is saved with the exact redirect URI shown, then connect", async () => {
  installFetch();
  const popup = { closed: false, location: { href: "" }, close() {} };
  vi.spyOn(window, "open").mockImplementation(() => popup as unknown as Window);
  await renderPage();

  await click(container.querySelector('[aria-label="Set up Gmail"]'));
  await flush();
  expect(document.body.textContent).toContain("One-time setup");
  expect(document.body.textContent).toContain(`Add this instance's redirect URI to it: ${REDIRECT}`);
  expect(document.querySelector(`code[title="${REDIRECT}"]`)).toBeTruthy();

  await type(inputByLabel("Client ID"), "123.apps.googleusercontent.com");
  await type(inputByLabel("Client secret"), "GOCSPX-secret");
  await click(byText(/Save and continue/));
  await flush();
  expect(server.calls.find((c) => c.method === "PUT")).toMatchObject({ path: "/oauth-apps/google", body: { clientId: "123.apps.googleusercontent.com", clientSecret: "GOCSPX-secret" } });

  await click(inDialog("Connect"));
  await flush();
  expect(server.calls.find((c) => c.method === "POST" && c.path === "/")?.body).toEqual({ catalogId: "gmail" });
  expect(popup.location.href).toContain("https://auth.gmail.com/authorize");
});

test("bearer and URL template entries ask first, then test the connection", async () => {
  installFetch();
  const open = vi.spyOn(window, "open");
  await renderPage();

  await click(container.querySelector('[aria-label="Connect Stripe"]'));
  await flush();
  await click(inDialog("Connect"));
  expect(document.body.textContent).toContain("Paste the key");
  await type(document.querySelector('input[type="password"]') as HTMLInputElement, "sk_live_123");
  await click(inDialog("Connect"));
  await flush();
  expect(open).not.toHaveBeenCalled();
  expect(server.calls.find((c) => c.method === "POST" && c.path === "/")?.body).toEqual({ catalogId: "stripe", secrets: { bearerToken: "sk_live_123" } });
  expect(server.calls.some((c) => c.path === "/stripe/test")).toBe(true);
  expect(document.body.textContent).toContain("Stripe is connected.");
  await click(inDialog("Done"));

  // a per-account URL: the placeholder is asked for, then OAuth starts on that URL
  const popup = { closed: false, location: { href: "" }, close() {} };
  open.mockImplementation(() => popup as unknown as Window);
  await click(container.querySelector('[aria-label="Connect Azure DevOps"]'));
  await flush();
  expect(open).not.toHaveBeenCalled();
  await click(inDialog("Connect"));
  expect(document.body.textContent).toContain("Fill in every field");
  await type(inputByLabel("Organization"), "contoso");
  await click(inDialog("Connect"));
  await flush();
  expect(open).toHaveBeenCalledTimes(1);
  expect(server.calls.filter((c) => c.method === "POST" && c.path === "/").at(-1)?.body).toEqual({ catalogId: "azure-devops", url: "https://mcp.dev.azure.com/contoso" });
  expect(popup.location.href).toContain("https://auth.azure-devops.com/authorize");
});

test("connected tab lists connectors; needs re-auth offers Reconnect", async () => {
  installFetch();
  server.connectors = [connector("linear", { status: "needs_reauth", secrets: { ...connector("linear").secrets, oauth: { authorized: true, clientRegistered: true, pending: false } } })];
  await renderPage();
  expect(byText(/^Connected/, '[role="tab"]')?.getAttribute("aria-selected")).toBe("true");
  const row = container.querySelector('[data-testid="connector-row-linear"]')!;
  expect(row.textContent).toContain(`${DEFAULT_PRODUCT_NAME} lost access to Linear`);
  expect([...row.querySelectorAll("button")].some((b) => b.textContent === "Reconnect")).toBe(true);
});

test("a connector that never finished signing in can be managed (sign in or remove) from its card and its row", async () => {
  installFetch();
  server.connectors = [connector("linear")]; // needs_auth, never authorized
  await renderPage();

  const row = container.querySelector('[data-testid="connector-row-linear"]')!;
  expect([...row.querySelectorAll("button")].some((b) => b.textContent === "Sign in")).toBe(true);
  expect(row.querySelector('[aria-label="Manage Linear"]')).toBeTruthy();

  await act(async () => {
    byText(/^Browse/, '[role="tab"]')?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
  await flush();
  const card = container.querySelector('[data-testid="catalog-card-linear"]')!;
  expect(card.querySelector('[aria-label="Sign in Linear"]')).toBeTruthy();
  // a catalog entry nobody added has only Connect
  expect(container.querySelector('[data-testid="catalog-card-notion"] [aria-label="Manage Notion"]')).toBeNull();

  await click(card.querySelector('[aria-label="Manage Linear"]'));
  await flush();
  const sheet = document.querySelector('[role="dialog"]')!;
  const labels = [...sheet.querySelectorAll("button")].map((b) => b.textContent?.trim());
  expect(labels).toContain("Sign in");
  expect(labels).toContain("Remove");
  expect(labels).not.toContain("Disconnect"); // only for an authorized connector

  await click([...sheet.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Remove"));
  await click([...document.querySelectorAll<HTMLElement>('[role="alertdialog"] button, [role="dialog"] button')].reverse().find((b) => b.textContent?.trim() === "Remove"));
  await flush();
  expect(server.calls.some((c) => c.method === "DELETE" && c.path === "/linear")).toBe(true);
  expect(server.connectors).toEqual([]);
});

test("connect (OAuth): while waiting for sign-in, Cancel and remove deletes the new connector", async () => {
  installFetch();
  const popup = { closed: false, location: { href: "about:blank" }, close: vi.fn(() => { popup.closed = true; }) };
  vi.spyOn(window, "open").mockImplementation(() => popup as unknown as Window);
  await renderPage();
  await click(container.querySelector('[aria-label="Connect Linear"]'));
  await flush();
  expect(document.body.textContent).toContain("Waiting for you to sign in to Linear");

  await click(inDialog("Cancel and remove"));
  await flush();
  expect(server.calls.some((c) => c.method === "DELETE" && c.path === "/linear")).toBe(true);
  expect(server.connectors).toEqual([]);
  expect(popup.close).toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("Waiting for you to sign in");
});

// ── Detail sheet: access + tool policy ──────────────────────────────────────

test("detail sheet: per-agent access and per-tool policy are saved; Ask is marked coming soon", async () => {
  installFetch();
  const linear = connector("linear", { status: "connected", toolCount: 2, secrets: { ...connector("linear").secrets, oauth: { authorized: true, clientRegistered: true, pending: false } } });
  server.connectors = [linear];
  let current = linear;
  const onChanged = vi.fn((c: Connector) => { current = c; rerender(); });
  const rerender = () => root.render(
    <TooltipProvider>
      <ConnectorDetailSheet connector={current} agents={[{ name: "pm", label: "Marco" }, { name: "dev", label: "dev" }]} open onOpenChange={() => {}} onChanged={onChanged} onRemoved={() => {}} onReconnect={() => {}} />
    </TooltipProvider>,
  );
  await act(async () => rerender());
  await flush();

  // tools listed with their policy control
  expect(document.body.textContent).toContain("Create issue");
  expect(document.body.textContent).toContain("create_issue");
  const ask = document.querySelector('[role="radiogroup"][aria-label="Policy for create_issue"] [aria-label="Ask (coming soon)"]') as HTMLButtonElement;
  expect(ask.disabled).toBe(true);

  await click(document.querySelector('[role="radiogroup"][aria-label="Policy for create_issue"] [aria-label="Off"]'));
  await flush();
  expect(server.calls.find((c) => c.method === "PATCH" && c.body && (c.body as { toolPolicy?: unknown }).toolPolicy)?.body).toEqual({ toolPolicy: { create_issue: "off" } });
  expect(current.toolPolicy).toEqual({ create_issue: "off" });

  // grant one agent
  await click(document.querySelector('[role="switch"][aria-label="Marco can use it"]'));
  await flush();
  expect(server.calls.find((c) => c.method === "PATCH" && (c.body as { access?: unknown }).access)?.body).toEqual({ access: { agents: ["pm"], polpo: true } });
  expect(document.querySelector('[role="switch"][aria-label="Marco can use it"]')?.getAttribute("aria-checked")).toBe("true");
});

test("agent page: connectors section grants and revokes this agent", async () => {
  installFetch();
  server.connectors = [
    connector("linear", { status: "connected", access: { agents: ["dev"], polpo: true } }),
    connector("notion", { status: "connected", access: { agents: "*", polpo: false } }),
  ];
  await act(async () => root.render(
    <MemoryRouter><AgentConnectorsSection agentName="pm" allowedTools={["read_file", "mcp__linear__*"]} /></MemoryRouter>,
  ));
  await flush();
  const sw = (id: string) => container.querySelector(`[data-testid="agent-connector-${id}"] [role="switch"]`)!;
  // two tabs: Enabled (open) and Available, so the two never mix
  expect(container.querySelector('[data-testid="agent-connectors-tab-enabled"]')?.textContent).toBe("Enabled (1)");
  expect(container.querySelector('[data-testid="agent-connectors-tab-available"]')?.textContent).toBe("Available (1)");
  expect(container.querySelector('[data-testid="agent-connectors-enabled"] [data-testid="agent-connector-notion"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="agent-connectors-available"] [data-testid="agent-connector-linear"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="agent-connectors-available"]')?.getAttribute("data-state")).toBe("inactive");
  expect(sw("linear").getAttribute("aria-checked")).toBe("false");
  expect(sw("notion").getAttribute("aria-checked")).toBe("true");
  // notion is granted but the agent's allowlist does not cover it
  expect(container.querySelector('[data-testid="agent-connector-notion"]')?.textContent).toContain("mcp__notion__*");

  await click(sw("linear"));
  await flush();
  expect(server.calls.filter((c) => c.method === "PATCH").at(-1)).toMatchObject({ path: "/linear", body: { access: { agents: ["dev", "pm"], polpo: true } } });
  expect(sw("linear").getAttribute("aria-checked")).toBe("true");

  // revoking from "every agent" keeps the others
  await click(sw("notion"));
  await flush();
  expect(server.calls.filter((c) => c.method === "PATCH").at(-1)).toMatchObject({ path: "/notion", body: { access: { agents: ["dev"], polpo: false } } });
});

test("agent page: its own personal connectors and the org's, never another agent's personal ones; each row says Org or Personal", async () => {
  installFetch();
  server.connectors = [
    connector("linear", { status: "connected", access: { agents: ["pm"], polpo: true } }),
    connector("notion", { status: "connected", access: { agents: [], polpo: true } }),
    // pm's own mailbox, not enabled yet
    connector("mail-pm", { name: "Mail PM", status: "connected", access: { agents: [], polpo: false }, scope: { kind: "agent", agent: "pm" } }),
    // pm's own calendar, enabled
    connector("cal-pm", { name: "Cal PM", status: "connected", access: { agents: ["pm"], polpo: false }, scope: { kind: "agent", agent: "pm" } }),
    // Nina's personal mailbox: never on pm's page, even if its access was edited to list pm
    connector("mail-nina", { name: "Mail Nina", status: "connected", access: { agents: ["nina", "pm"], polpo: false }, scope: { kind: "agent", agent: "nina" } }),
  ];
  await act(async () => root.render(<MemoryRouter><AgentConnectorsSection agentName="pm" /></MemoryRouter>));
  await flush();
  const row = (id: string) => container.querySelector(`[data-testid="agent-connector-${id}"]`);
  const chip = (id: string) => row(id)?.querySelector('[data-testid="connector-scope-chip"]')?.textContent;
  expect(row("mail-nina")).toBeNull();
  expect(container.textContent).not.toContain("Mail Nina");
  expect(container.querySelector('[data-testid="agent-connectors-tab-enabled"]')?.textContent).toBe("Enabled (2)");
  expect(container.querySelector('[data-testid="agent-connectors-tab-available"]')?.textContent).toBe("Available (2)");
  expect(container.querySelector('[data-testid="agent-connectors-enabled"] [data-testid="agent-connector-linear"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="agent-connectors-enabled"] [data-testid="agent-connector-cal-pm"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="agent-connectors-available"] [data-testid="agent-connector-notion"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="agent-connectors-available"] [data-testid="agent-connector-mail-pm"]')).not.toBeNull();
  expect(chip("linear")).toBe("Org");
  expect(chip("notion")).toBe("Org");
  expect(chip("cal-pm")).toBe("Personal");
  expect(chip("mail-pm")).toBe("Personal");

  // enabling its own connector from Available writes the connector's access
  await click(row("mail-pm")!.querySelector('[role="switch"]'));
  await flush();
  expect(server.calls.filter((c) => c.method === "PATCH").at(-1)).toMatchObject({ path: "/mail-pm", body: { access: { agents: ["pm"], polpo: false } } });
  expect(container.querySelector('[data-testid="agent-connectors-enabled"] [data-testid="agent-connector-mail-pm"]')).not.toBeNull();
});

test("connector settings: an agent's own connector can only be enabled for its owner", async () => {
  installFetch();
  const current = connector("mail-pm", { name: "Mail PM", status: "connected", access: { agents: ["pm"], polpo: false }, scope: { kind: "agent", agent: "pm" } });
  server.connectors = [current];
  await act(async () => root.render(
    <TooltipProvider>
      <ConnectorDetailSheet connector={current} agents={[{ name: "pm", label: "Marco" }, { name: "dev", label: "dev" }]} open onOpenChange={() => {}} onChanged={() => {}} onRemoved={() => {}} onReconnect={() => {}} />
    </TooltipProvider>,
  ));
  await flush();
  expect(document.querySelector('[data-testid="connector-scope"]')?.textContent).toContain("Personal: only this agent can ever use it");
  expect(document.querySelector('[data-testid="connector-scope"] [aria-label="Belongs to"]')?.textContent).toContain("Marco (personal)");
  // no "All agents", no other agent: only its owner
  expect(document.querySelector('[role="switch"][aria-label="All agents can use it"]')).toBeNull();
  expect(document.querySelector('[role="switch"][aria-label="dev can use it"]')).toBeNull();
  expect(document.querySelector('[role="switch"][aria-label="Marco can use it"]')?.getAttribute("aria-checked")).toBe("true");
});

test("agent page: choose which of a connector's tools the agent gets", async () => {
  installFetch();
  server.connectors = [
    connector("linear", { status: "connected", toolCount: 2, access: { agents: ["pm"], polpo: false }, toolPolicy: {} }),
    connector("notion", { status: "connected", access: { agents: ["pm"], polpo: false } }),
  ];
  const onSaved = vi.fn();
  await act(async () => root.render(
    <MemoryRouter><AgentConnectorsSection agentName="pm" connectorTools={{ notion: ["search", "gone_tool"] }} onConnectorToolsSaved={onSaved} /></MemoryRouter>,
  ));
  await flush();
  expect(container.querySelector('[data-testid="agent-connector-notion"]')?.textContent).toContain("2 selected tools");

  // Linear: "All tools" by default; switch to "Only selected" (starts from every tool), uncheck one, save
  await click(container.querySelector('[aria-label="Choose Linear tools for pm"]'));
  await flush();
  const panel = () => container.querySelector('[data-testid="agent-connector-tools-linear"]')!;
  expect(panel().querySelector('[aria-label="All tools"]')?.getAttribute("aria-checked")).toBe("true");
  expect((byText("Save", '[data-testid="agent-connector-tools-linear"] button') as HTMLButtonElement).disabled).toBe(true);
  await click(panel().querySelector('[aria-label="Only selected"]'));
  await flush();
  const box = (label: string) => panel().querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="${label}"]`)!;
  expect(box("Create issue").checked).toBe(true);
  expect(box("list_issues").checked).toBe(true);
  await click(box("list_issues"));
  expect(box("list_issues").checked).toBe(false);

  // search filters the list; select none / all act on the visible tools
  await type(panel().querySelector('input[aria-label="Search Linear tools"]') as HTMLInputElement, "create");
  expect(panel().querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
  await click(byText("Select none", '[data-testid="agent-connector-tools-linear"] button'));
  expect(box("Create issue").checked).toBe(false);
  await click(byText("Select all", '[data-testid="agent-connector-tools-linear"] button'));
  expect(box("Create issue").checked).toBe(true);
  await type(panel().querySelector('input[aria-label="Search Linear tools"]') as HTMLInputElement, "");

  await click(byText("Save", '[data-testid="agent-connector-tools-linear"] button'));
  await flush();
  // the whole selection is saved: Notion's list is kept
  expect(server.calls.filter((c) => c.method === "PATCH").at(-1)).toEqual({
    method: "PATCH", path: "/api/v1/agents/pm", body: { connectorTools: { notion: ["search", "gone_tool"], linear: ["create_issue"] }, publish: false },
  });
  expect(onSaved).toHaveBeenCalled();
  expect(container.querySelector('[data-testid="agent-connector-linear"]')?.textContent).toContain("1 selected tool");

  // Notion: a name the connector does not list is shown as stale; back to "All tools" drops the key
  await click(container.querySelector('[aria-label="Choose Notion tools for pm"]'));
  await flush();
  const notion = () => container.querySelector('[data-testid="agent-connector-tools-notion"]')!;
  expect(notion().querySelector('[data-testid="stale-connector-tools"]')?.textContent).toContain("gone_tool");
  await click(notion().querySelector('[aria-label="All tools"]'));
  await click(byText("Save", '[data-testid="agent-connector-tools-notion"] button'));
  await flush();
  expect(server.calls.filter((c) => c.method === "PATCH").at(-1)?.body).toEqual({ connectorTools: { linear: ["create_issue"] }, publish: false });
});

// ── Custom connector dialog ─────────────────────────────────────────────────

test("custom connector dialog validates before submitting", async () => {
  const onSubmit = vi.fn();
  await act(async () => root.render(<CustomConnectorDialog open onOpenChange={() => {}} redirectUri={REDIRECT} onSubmit={onSubmit} />));
  await click(byText("Add and sign in"));
  expect(onSubmit).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Give the connector a name");
  expect(document.body.textContent).toContain("Enter the MCP server URL");

  await type(inputByLabel("Name"), "Internal tools");
  await type(inputByLabel("Remote MCP server URL"), "http://tools.example.com/mcp");
  await click(byText("Add and sign in"));
  expect(document.body.textContent).toContain("Use an https:// URL");

  await type(inputByLabel("Remote MCP server URL"), "https://tools.example.com/mcp");
  await click(document.querySelector('input[name="auth"][value="bearer"]'));
  await click(byText("Add"));
  expect(document.body.textContent).toContain("Paste the token");
  await type(inputByLabel("Token"), "secret-token");
  await click(byText("Add"));
  expect(onSubmit).toHaveBeenCalledWith({
    name: "Internal tools", transport: { type: "http", url: "https://tools.example.com/mcp" }, auth: { type: "bearer" }, secrets: { bearerToken: "secret-token" },
  });
});

test("custom connector: stdio is behind Advanced with a warning", async () => {
  const onSubmit = vi.fn();
  await act(async () => root.render(<CustomConnectorDialog open onOpenChange={() => {}} onSubmit={onSubmit} />));
  await click(byText("Advanced"));
  await click(document.querySelector('input[type="checkbox"]'));
  expect(document.body.textContent).toContain(`runs a command on the ${DEFAULT_PRODUCT_NAME} server`);
  await type(inputByLabel("Name"), "Files");
  await type(inputByLabel("Command"), "npx -y @modelcontextprotocol/server-filesystem /data");
  await click(byText("Add"));
  expect(onSubmit).toHaveBeenCalledWith({ name: "Files", transport: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"] }, auth: { type: "none" } });
});

// ── Several accounts of the same app ────────────────────────────────────────

const signedIn = { bearerToken: false, headers: [], clientSecret: false, values: [], oauth: { authorized: true, clientRegistered: true, pending: false } };
const openBrowse = () => act(async () => {
  byText(/^Browse/, '[role="tab"]')?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
});
const popupStub = () => {
  const popup = { closed: false, location: { href: "about:blank" }, close: vi.fn(() => { popup.closed = true; }) };
  vi.spyOn(window, "open").mockImplementation(() => popup as unknown as Window);
  return popup;
};

test("accounts helpers: next default name, what tells accounts apart, suggested name, grouping", () => {
  const gmail = connector("gmail", { name: "Gmail" });
  const gmail2 = connector("gmail-2", { name: "Gmail 2", catalogId: "gmail", account: "info@lumea.dev" });
  const linear = connector("linear");
  expect(nextAccountName({ id: "gmail", name: "Gmail" }, [gmail])).toBe("Gmail 2");
  expect(nextAccountName({ id: "gmail", name: "Gmail" }, [gmail, gmail2])).toBe("Gmail 3");
  expect(nextAccountName({ id: "gmail", name: "Gmail" }, [gmail, connector("gmail-3", { name: "Gmail 2", catalogId: "gmail" })])).toBe("Gmail 3");
  expect(accountLabel(gmail2, [gmail, gmail2])).toBe("info@lumea.dev");
  expect(accountLabel(gmail, [gmail, gmail2])).toBe("gmail"); // no account known: the id
  expect(accountLabel(linear, [gmail, gmail2, linear])).toBeUndefined(); // the only one
  expect(accountLabel({ ...gmail2, name: "Gmail – info@lumea.dev" }, [gmail2])).toBeUndefined();
  expect(suggestedAccountName(gmail2, "Gmail")).toBe("Gmail – info@lumea.dev");
  expect(suggestedAccountName(gmail2)).toBe("Gmail – info@lumea.dev");
  expect(suggestedAccountName({ ...gmail2, name: "Gmail – info@lumea.dev" })).toBeUndefined();
  expect(groupConnectors([gmail, linear, gmail2]).map((g) => g.connectors.map((c) => c.id))).toEqual([["gmail", "gmail-2"], ["linear"]]);
});

test("add another account: from a connected card it asks a name, creates linear-2 and signs it in", async () => {
  server.connectors = [connector("linear", { status: "connected", toolCount: 3, secrets: signedIn })];
  installFetch();
  const popup = popupStub();
  await renderPage();
  await openBrowse();
  const card = container.querySelector('[data-testid="catalog-card-linear"]')!;
  expect(card.textContent).toContain("Connected");

  await click(card.querySelector('[aria-label="Add another Linear account"]'));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Add another Linear account");
  const name = inputByLabel("Account name");
  expect(name.value).toBe("Linear 2");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("e.g. Linear – info@lumea.dev");
  expect(server.calls.some((c) => c.method === "POST")).toBe(false); // nothing created before the name

  await type(name, "Linear – ops@acme.com");
  await click(inDialog("Continue to sign-in"));
  await flush();
  expect(server.calls.find((c) => c.method === "POST" && c.path === "/")?.body).toEqual({ catalogId: "linear", name: "Linear – ops@acme.com" });
  expect(server.calls.some((c) => c.path === "/linear-2/oauth/start")).toBe(true);
  expect(server.calls.some((c) => c.path === "/linear/oauth/start")).toBe(false); // the first account is untouched
  expect(popup.location.href).toBe("https://auth.linear-2.com/authorize?state=abc");

  completeSignIn("linear-2", 4);
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: OAUTH_MESSAGE_TYPE, ok: true, id: "linear-2" } }));
  });
  await flush();
  expect(document.body.textContent).toContain("Linear – ops@acme.com is connected.");
  await click(inDialog("Done"));

  // Connected: both accounts, kept together under the app
  await act(async () => {
    byText(/^Connected/, '[role="tab"]')?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
  const group = container.querySelector('[data-testid="connector-group-linear"]')!;
  expect(group.textContent).toContain("Linear · 2 accounts");
  expect(group.querySelector('[data-testid="connector-row-linear"]')).toBeTruthy();
  expect(group.querySelector('[data-testid="connector-row-linear-2"]')?.textContent).toContain("Linear – ops@acme.com");
  expect(container.querySelector('[data-testid="connector-account-linear"]')?.textContent).toBe("linear");
});

test("add another account: sign-in reveals the account, offered as the name; renamed again in the sheet", async () => {
  server.connectors = [connector("linear", { status: "connected", secrets: signedIn })];
  installFetch();
  popupStub();
  await renderPage();
  await openBrowse();
  await click(container.querySelector('[data-testid="catalog-card-linear"] [aria-label="Add another Linear account"]'));
  await click(inDialog("Continue to sign-in")); // keeps "Linear 2"
  await flush();
  expect(server.calls.find((c) => c.method === "POST")?.body).toEqual({ catalogId: "linear", name: "Linear 2" });

  completeSignIn("linear-2");
  server.connectors = server.connectors.map((c) => (c.id === "linear-2" ? { ...c, account: "ops@acme.com" } : c));
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: OAUTH_MESSAGE_TYPE, ok: true, id: "linear-2" } }));
  });
  await flush();
  expect(document.body.textContent).toContain("Signed in as ops@acme.com. Name it “Linear – ops@acme.com”?");
  await click(inDialog("Use this name"));
  await flush();
  expect(server.calls.find((c) => c.method === "PATCH" && c.path === "/linear-2")?.body).toEqual({ name: "Linear – ops@acme.com" });
  expect(inDialog("Use this name")).toBeUndefined();

  // the sheet: who it is, its id, rename, and another account from here too
  await click(inDialog("Manage access and tools"));
  await flush();
  const identity = document.querySelector('[data-testid="connector-identity"]')!;
  expect(identity.textContent).toContain("Signed in asops@acme.com");
  expect(identity.textContent).toContain("linear-2");
  expect(identity.textContent).toContain("2 Linear accounts connected");
  expect(document.body.textContent).toContain("Who can use this account");
  expect(document.querySelector('[aria-label="Add another Linear account"]')).toBeTruthy();
  await click(document.querySelector('[aria-label="Rename Linear – ops@acme.com"]'));
  await type(document.querySelector('input[aria-label="Connector name"]') as HTMLInputElement, "Ops inbox");
  await click(document.querySelector('[aria-label="Save name"]'));
  await flush();
  expect(server.calls.filter((c) => c.method === "PATCH" && c.path === "/linear-2").at(-1)?.body).toEqual({ name: "Ops inbox" });
  expect(document.querySelector('[aria-label="Rename Ops inbox"]')).toBeTruthy();
});

test("add another account of a token app asks the name and the key together", async () => {
  server.connectors = [connector("stripe", { auth: { type: "bearer" }, status: "connected", secrets: { ...signedIn, bearerToken: true } })];
  installFetch();
  await renderPage();
  await openBrowse();
  await click(container.querySelector('[aria-label="Add another Stripe account"]'));
  expect(inputByLabel("Account name").value).toBe("Stripe 2");
  await type(inputByLabel("Account name"), "Stripe – EU");
  await type(inputByLabel("API key or token"), "sk_eu");
  await click(inDialog("Connect"));
  await flush();
  expect(server.calls.find((c) => c.method === "POST")?.body).toEqual({ catalogId: "stripe", name: "Stripe – EU", secrets: { bearerToken: "sk_eu" } });
  expect(server.calls.some((c) => c.path === "/stripe-2/test")).toBe(true);
});

test("agent page: each account of an app is its own row, named, with its own switch", async () => {
  installFetch();
  server.connectors = [
    connector("gmail", { name: "Gmail", status: "connected", access: { agents: ["pm"], polpo: true } }),
    connector("gmail-2", { name: "Gmail 2", catalogId: "gmail", account: "info@lumea.dev", status: "connected", access: { agents: [], polpo: true } }),
  ];
  await act(async () => root.render(<MemoryRouter><AgentConnectorsSection agentName="pm" /></MemoryRouter>));
  await flush();
  const row = (id: string) => container.querySelector(`[data-testid="agent-connector-${id}"]`)!;
  expect(row("gmail").textContent).toContain("Gmail");
  expect(row("gmail-2").textContent).toContain("Gmail 2info@lumea.dev");
  expect(row("gmail").querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
  expect(row("gmail-2").querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
  await click(row("gmail-2").querySelector('[role="switch"]'));
  await flush();
  expect(server.calls.find((c) => c.method === "PATCH")).toMatchObject({ path: "/gmail-2", body: { access: { agents: ["pm"], polpo: true } } });
});

// ── Dialogs fit the viewport ────────────────────────────────────────────────

test("connector dialogs fit the viewport: header, scrolling body, footer always in view", async () => {
  server.catalog = [CATALOG[2]!];
  installFetch();
  await renderPage();
  await click(container.querySelector('[aria-label="Set up Gmail"]'));
  const content = document.querySelector('[data-slot="dialog-content"]')!;
  expect(content.className).toContain("max-h-[calc(100dvh-2rem)]");
  expect(content.className).toContain("overflow-hidden");
  const body = content.querySelector('[data-slot="dialog-body"]')!;
  expect(body.className).toContain("overflow-y-auto");
  // the actions stay visible while the steps scroll
  const footer = body.querySelector('[data-slot="dialog-footer"]')!;
  expect(footer.className).toContain("sticky");
  expect(footer.textContent).toContain("Save and continue");
  // the long redirect URI truncates next to its copy button instead of widening the dialog
  const uri = [...body.querySelectorAll("code")].find((c) => c.textContent === REDIRECT)!;
  expect(uri.className).toContain("truncate");
  expect(uri.className).toContain("min-w-0");
  expect(body.querySelector('[aria-label="Copy Redirect URI to register"]')).toBeTruthy();
  await click(byText(/^Close$/, '[role="dialog"] button') ?? document.querySelector('[data-slot="dialog-close"]'));

  await click(byText(/OAuth apps/));
  const apps = [...document.querySelectorAll('[data-slot="dialog-content"]')].at(-1)!;
  expect(apps.querySelector('[data-slot="dialog-body"] [data-slot="dialog-footer"]')?.className).toContain("sticky");
});

// ── Per-identity connectors ─────────────────────────────────────────────────

const identityGmail = (extra: Partial<Connector> = {}) => connector("gmail", {
  name: "Gmail", catalogId: "gmail", scope: { kind: "identity" }, status: "disconnected", access: { agents: ["pm", "dev"], polpo: true },
  accounts: [
    account("acc-1", "agent:pm", "sitoinchat", { default: true, status: "connected", account: "pm@sitoinchat.it", secrets: authorized }),
    account("acc-2", "agent:pm", "personale", { status: "connected", secrets: authorized }),
    account("acc-3", "agent:dev", "devmail", { default: true, status: "connected", secrets: authorized }),
    account("acc-4", "person:ada@acme.com", "ada", { default: true }),
    account("acc-5", "org", "shared", { default: true, status: "connected", secrets: authorized }),
  ],
  ...extra,
});
const AGENTS = [{ name: "pm", label: "Marco" }, { name: "dev", label: "dev" }];

/** The detail sheet alone, re-rendered with each change (like the page's upsert). */
async function renderSheet(initial: Connector, props: Partial<React.ComponentProps<typeof ConnectorDetailSheet>> = {}) {
  let current = initial;
  const rerender = () => root.render(
    <TooltipProvider>
      <ConnectorDetailSheet connector={current} agents={AGENTS} open onOpenChange={() => {}} onChanged={(c) => { current = c; rerender(); }} onRemoved={() => {}} onReconnect={() => {}}
        connectors={server.connectors} {...props} />
    </TooltipProvider>,
  );
  await act(async () => rerender());
  await flush();
  return () => current;
}

test("type selector: adding a catalog app per identity creates scope identity, opens no sign-in, then offers Add accounts", async () => {
  installFetch();
  const open = vi.spyOn(window, "open");
  await renderPage();
  await click(container.querySelector('[aria-label="Add Linear as…"]'));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Add Linear");
  expect(document.querySelector('[data-testid="connector-type"]')?.textContent).toContain("Per identity");
  await click(document.querySelector('input[name="connector-type"][value="identity"]'));
  expect(inDialog("Add")).toBeTruthy(); // not "Continue to sign-in"
  await click(inDialog("Add"));
  await flush();
  expect(server.calls.find((c) => c.method === "POST" && c.path === "/")?.body).toEqual({ catalogId: "linear", name: "Linear", scope: { kind: "identity" } });
  expect(open).not.toHaveBeenCalled();
  expect(server.calls.some((c) => c.path.endsWith("/oauth/start"))).toBe(false);
  expect(document.body.textContent).toContain("Linear is added, per identity.");
  await click(inDialog("Add accounts"));
  await flush();
  expect(document.querySelector('[data-testid="connector-accounts"]')).toBeTruthy();
});

test("type selector: a personal connector names its agent; the custom dialog sends per identity without a token", async () => {
  installFetch();
  const onSubmit = vi.fn();
  await act(async () => root.render(<CustomConnectorDialog open onOpenChange={() => {}} redirectUri={REDIRECT} onSubmit={onSubmit} agents={AGENTS} />));
  await type(inputByLabel("Name"), "Mailer");
  await type(inputByLabel("Remote MCP server URL"), "https://mail.example.com/mcp");
  await click(document.querySelector('input[name="auth"][value="bearer"]'));
  await click(document.querySelector('input[name="connector-type"][value="identity"]'));
  expect(document.querySelector('[data-testid="identity-token-note"]')).toBeTruthy();
  expect(inputByLabel("Token")).toBeUndefined(); // each account brings its own
  await click(byText("Add"));
  expect(onSubmit).toHaveBeenCalledWith({
    name: "Mailer", transport: { type: "http", url: "https://mail.example.com/mcp" }, auth: { type: "bearer" }, scope: { kind: "identity" },
  });
  // personal: the first agent is picked
  await click(document.querySelector('input[name="connector-type"][value="agent"]'));
  expect(document.querySelector('[aria-label="Agent it belongs to"]')?.textContent).toContain("Marco");
});

test("identity sheet: accounts listed by identity with the Default badge; no connector-level sign-in", async () => {
  installFetch();
  server.connectors = [identityGmail()];
  await renderSheet(server.connectors[0]!);
  const sheet = document.querySelector('[role="dialog"]')!;
  expect(sheet.querySelector('[data-testid="connector-identity-chip"]')?.textContent).toBe("Identity");
  const names = [...sheet.querySelectorAll('[data-testid="identity-name"]')].map((n) => n.textContent);
  expect(names).toEqual(["dev", "Marco", "ada@acme.com", "Organization (fallback)"]);
  const pm = sheet.querySelector('[data-testid="identity-agent:pm"]')!;
  expect([...pm.querySelectorAll('[data-testid="account-label"]')].map((l) => l.textContent)).toEqual(["sitoinchat", "personale"]);
  expect(pm.querySelector('[data-testid="account-acc-1"] [data-testid="account-default"]')?.textContent).toBe("Default");
  expect(pm.querySelector('[data-testid="account-acc-2"] [data-testid="account-default"]')).toBeNull();
  expect(pm.querySelector('[data-testid="account-acc-1"]')?.textContent).toContain("Signed in as pm@sitoinchat.it");
  // the connector itself has no sign-in, test or disconnect: its accounts do
  const top = [...sheet.querySelectorAll("button")].map((b) => b.textContent?.trim());
  expect(top).not.toContain("Disconnect");
  expect(top).not.toContain("Add another account");
  expect(sheet.querySelector('[aria-label="Add another Gmail account"]')).toBeNull();
  expect(sheet.querySelector('[data-testid="connector-scope"]')?.textContent).toContain("cannot become an organization or personal connector");
});

test("identity sheet: add an account posts identity and label, then signs that account in", async () => {
  installFetch();
  server.connectors = [identityGmail({ accounts: [] })];
  const popup = popupStub();
  await renderSheet(server.connectors[0]!);
  expect(document.body.textContent).toContain("No accounts yet.");
  await click(byText(/Add account/));
  await type(document.querySelector('input[aria-label="Account name"]') as HTMLInputElement, "sitoinchat");
  await click(byText(/Add and sign in/));
  await flush();
  expect(server.calls.find((c) => c.method === "POST" && c.path === "/gmail/accounts")?.body).toEqual({ identity: "agent:pm", label: "sitoinchat" });
  expect(server.calls.some((c) => c.method === "POST" && c.path === "/gmail/accounts/acc-new1/oauth/start")).toBe(true);
  expect(popup.location.href).toBe("https://auth.gmail.com/authorize?account=acc-new1");
  expect(document.querySelector('[data-testid="account-acc-new1"]')?.textContent).toContain("Waiting for the sign-in");

  completeAccountSignIn("gmail", "acc-new1", "pm@sitoinchat.it");
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: OAUTH_MESSAGE_TYPE, ok: true, id: "gmail", account: "acc-new1" } }));
  });
  await flush();
  const row = document.querySelector('[data-testid="account-acc-new1"]')!;
  expect(row.textContent).toContain("Connected");
  expect(row.textContent).toContain("Signed in as pm@sitoinchat.it");
  expect(row.querySelector('[data-testid="account-default"]')).toBeTruthy();
});

test("identity sheet: make default, and the fallback toggle patches the scope", async () => {
  installFetch();
  server.connectors = [identityGmail()];
  const current = await renderSheet(server.connectors[0]!);
  await click(document.querySelector('[aria-label="Make personale the default"]'));
  await flush();
  expect(server.calls.find((c) => c.method === "PATCH" && c.path === "/gmail/accounts/acc-2")?.body).toEqual({ default: true });
  expect(document.querySelector('[data-testid="account-acc-2"] [data-testid="account-default"]')).toBeTruthy();
  expect(document.querySelector('[data-testid="account-acc-1"] [data-testid="account-default"]')).toBeNull();

  const fallback = document.querySelector('[role="switch"][aria-label="Use the organization\'s account as fallback"]')!;
  expect(fallback.getAttribute("aria-checked")).toBe("false"); // off by default
  await click(fallback);
  await flush();
  expect(server.calls.find((c) => c.method === "PATCH" && c.path === "/gmail")?.body).toEqual({ scope: { kind: "identity", fallback: true } });
  expect(current().scope).toEqual({ kind: "identity", fallback: true });
});

test("identity sheet: import a separate connector of the same app, with its owner and account as defaults", async () => {
  installFetch();
  server.connectors = [
    identityGmail({ accounts: [] }),
    connector("mail-pm", { name: "Mail PM", catalogId: "gmail", account: "pm@sitoinchat.it", status: "connected", secrets: signedIn, scope: { kind: "agent", agent: "pm" }, access: { agents: ["pm"], polpo: false } }),
    connector("linear", { status: "connected" }), // another app: not offered
  ];
  await renderPage("/connectors?connector=gmail");
  await click(byText(/Import an existing connector/));
  const dialog = [...document.querySelectorAll('[role="dialog"]')].at(-1)!;
  expect(dialog.querySelector('[aria-label="Connector to import"]')?.textContent).toContain("Mail PM (mail-pm)");
  expect(dialog.querySelector('[aria-label="Whose account it becomes"]')?.textContent).toContain("Marco");
  expect((dialog.querySelector('input[aria-label="Imported account name"]') as HTMLInputElement).value).toBe("pm@sitoinchat.it");
  expect((dialog.querySelector('input[aria-label="Remove the source connector"]') as HTMLInputElement).checked).toBe(true);
  expect(dialog.querySelector('[data-testid="import-rename-warning"]')?.textContent).toContain("mcp__mail-pm__… becomes mcp__gmail__…");
  await click([...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Import"));
  await flush();
  expect(server.calls.find((c) => c.method === "POST" && c.path === "/gmail/accounts/import")?.body).toEqual({
    from: "mail-pm", identity: "agent:pm", label: "pm@sitoinchat.it", removeSource: true,
  });
  expect(document.querySelector('[data-testid="account-acc-imported"]')?.textContent).toContain("imported from mail-pm");
});

test("import helpers: same app and sign-in only; per identity is never switched in place, a separate connector is imported instead", async () => {
  const gmail = identityGmail({ accounts: [] });
  const mailPm = connector("mail-pm", { name: "Mail PM", catalogId: "gmail", status: "connected", secrets: signedIn, scope: { kind: "agent", agent: "pm" }, access: { agents: ["pm"], polpo: false } });
  const orgGmail = connector("gmail-2", { catalogId: "gmail", access: { agents: ["dev"], polpo: true } });
  const sameUrl = connector("mailer", { catalogId: undefined, transport: { type: "http", url: "https://mcp.gmail.com/mcp" } });
  const token = connector("gmail-3", { catalogId: "gmail", auth: { type: "bearer" } });
  expect(importCandidates(gmail, [gmail, mailPm, orgGmail, sameUrl, token, connector("linear")]).map((c) => c.id)).toEqual(["mail-pm", "gmail-2", "mailer"]);
  expect(importIdentity(mailPm)).toBe("agent:pm"); // its owner
  expect(importIdentity(orgGmail)).toBe("agent:dev"); // its only agent
  expect(importIdentity(connector("x", { access: { agents: "*", polpo: true } }))).toBe("org");
  expect(identityTargetFor(mailPm, [gmail, mailPm])?.id).toBe("gmail");
  expect(identityTargetFor(gmail, [gmail, mailPm])).toBeUndefined();
  expect(accountLabelFrom("Gmail – info@acme.com")).toBe("Gmail info@acme.com");

  // the personal connector's sheet keeps its Belongs to (Per identity… is one more choice there)
  installFetch();
  server.connectors = [gmail, mailPm];
  await renderPage("/connectors?connector=mail-pm");
  expect(document.querySelector('[data-testid="scope-identity-help"]')).toBeNull();
  expect(document.querySelector('[data-testid="connector-scope"] [aria-label="Belongs to"]')?.textContent).toContain("Marco (personal)");
});

test("agent page: a per-identity connector has the Identity chip and only this agent's accounts", async () => {
  installFetch();
  server.connectors = [
    identityGmail(),
    connector("notion", { name: "Notion", scope: { kind: "identity", fallback: true }, status: "disconnected", access: { agents: ["pm"], polpo: false },
      accounts: [account("acc-9", "org", "team", { default: true, status: "connected", secrets: authorized })] }),
  ];
  const popup = popupStub();
  await act(async () => root.render(<MemoryRouter><TooltipProvider><AgentConnectorsSection agentName="pm" /></TooltipProvider></MemoryRouter>));
  await flush();
  const row = (id: string) => container.querySelector(`[data-testid="agent-connector-${id}"]`)!;
  expect(row("gmail").querySelector('[data-testid="connector-scope-chip"]')?.textContent).toBe("Identity");
  const mine = container.querySelector('[data-testid="agent-accounts-gmail"]')!;
  expect([...mine.querySelectorAll('[data-testid="account-label"]')].map((l) => l.textContent)).toEqual(["sitoinchat", "personale"]);
  // never another agent's, a person's or the organization's
  expect(mine.textContent).not.toContain("devmail");
  expect(mine.textContent).not.toContain("ada");
  expect(mine.textContent).not.toContain("shared");
  expect(row("gmail").textContent).toContain("2 accounts of its own");
  expect(container.querySelector('[data-testid="agent-accounts-notion"] [data-testid="agent-no-account"]')?.textContent)
    .toBe("No account yet: uses the organization's shared account.");

  // add one for this agent: identity agent:pm, then its sign-in
  await click(container.querySelector('[aria-label="Add a Notion account for Marco"]'));
  const form = container.querySelector('[data-testid="agent-accounts-notion"] [data-testid="add-account-form"]')!;
  expect(form.querySelector('[aria-label="Whose account"]')).toBeNull(); // only this agent
  await type(form.querySelector('input[aria-label="Account name"]') as HTMLInputElement, "personale");
  await click([...form.querySelectorAll("button")].find((b) => b.textContent?.includes("Add and sign in")));
  await flush();
  expect(server.calls.find((c) => c.method === "POST" && c.path === "/notion/accounts")?.body).toEqual({ identity: "agent:pm", label: "personale" });
  expect(popup.location.href).toBe("https://auth.notion.com/authorize?account=acc-new2");

  // set default / remove act on this agent's accounts only
  await click(container.querySelector('[aria-label="Make personale the default"]'));
  await flush();
  expect(server.calls.find((c) => c.method === "PATCH" && c.path === "/gmail/accounts/acc-2")?.body).toEqual({ default: true });
});

test("a setup link opens the connector's sheet on that account, its token input focused", async () => {
  installFetch();
  server.connectors = [connector("stripe", {
    name: "Stripe", catalogId: "stripe", auth: { type: "bearer" }, scope: { kind: "identity" }, status: "disconnected", access: { agents: ["pm"], polpo: true },
    accounts: [account("acc-7", "agent:pm", "eu", { default: true, status: "disconnected" }), account("acc-8", "agent:dev", "us", { default: true, status: "disconnected", secrets: { ...authorized, bearerToken: true } })],
  })];
  await renderPage("/connectors?connector=stripe&focus=account:acc-7&setup=abc");
  const row = document.querySelector('[data-testid="account-acc-7"]')!;
  expect(row.getAttribute("data-focused")).toBe("true");
  expect(document.querySelector('[data-testid="account-acc-8"]')?.getAttribute("data-focused")).toBeNull();
  const input = row.querySelector('input[type="password"]') as HTMLInputElement;
  expect(document.activeElement).toBe(input);
  await type(input, "sk_eu");
  await click([...row.querySelectorAll("button")].find((b) => b.textContent?.includes("Save to vault")));
  await flush();
  expect(server.calls.find((c) => c.method === "PATCH" && c.path === "/stripe/accounts/acc-7")?.body).toEqual({ secrets: { bearerToken: "sk_eu" } });
});

test("connectors list: a per-identity connector shows the Identity chip and its account counts", async () => {
  installFetch();
  server.connectors = [identityGmail()];
  await renderPage();
  const row = container.querySelector('[data-testid="connector-row-gmail"]')!;
  expect(row.querySelector('[data-testid="identity-badge-gmail"]')?.textContent).toBe("Identity");
  expect(row.textContent).toContain("Per identity · 5 accounts · 4 connected");
  expect([...row.querySelectorAll("button")].some((b) => b.textContent === "Sign in")).toBe(false);
});
