import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// the dashboard talks to the API with a key: icons must be fetched with it (an <img src> could not send it)
vi.hoisted(() => { (globalThis as { __POLPO_RUNTIME_CONFIG__?: unknown }).__POLPO_RUNTIME_CONFIG__ = { apiKey: "test-key" }; });

import { TooltipProvider } from "../src/components/ui/tooltip";
import { ConnectorIcon, clearConnectorIconCache } from "../src/components/connectors/connector-icon";
import { ConnectorDetailSheet } from "../src/components/connectors/connector-detail-sheet";
import { CustomConnectorDialog } from "../src/components/connectors/custom-connector-dialog";
import { applyDiscovery, EMPTY_CUSTOM_FORM, iconSourceLabel, type Connector, type ConnectorDiscovery } from "../src/lib/connectors-api";

const REDIRECT = "https://polpo.example.com/api/v1/connectors/oauth/callback";

function connector(id: string, extra: Partial<Connector> = {}): Connector {
  return {
    id, name: id[0]!.toUpperCase() + id.slice(1), kind: "mcp", transport: { type: "http", url: `https://mcp.${id}.com/mcp` },
    auth: { type: "oauth" }, access: { agents: [], polpo: true }, enabled: true, createdAt: "2026-11-22T00:00:00Z", status: "connected",
    secrets: { bearerToken: false, headers: [], clientSecret: false, values: [], oauth: { authorized: true, clientRegistered: true, pending: false } },
    ...extra,
  };
}

const SITO: ConnectorDiscovery = {
  url: "https://mcp.sitoinchat.it/", reachable: true, transport: "http", authRequired: true,
  resource: { resourceName: "SitoInChat", scopes: ["sites:read", "sites:write", "sites:publish"], authorizationServers: ["https://sitoinchat.it/api/auth"] },
  authorizationServer: { issuer: "https://sitoinchat.it/api/auth", registration: true, cimd: false, pkceMethods: ["S256"], tokenAuthMethods: ["none"] },
  options: [
    { auth: "oauth-dcr", recommended: true, description: "Sign in with OAuth; Polpo registers itself with the server automatically." },
    { auth: "oauth-preregistered", recommended: false, description: "Sign in with OAuth using a client id you create." },
    { auth: "bearer", recommended: false, description: "Paste an API key or token." },
  ],
  recommendation: {
    transport: "http", auth: "oauth-dcr", recommended: true, scopes: ["sites:read", "sites:write", "sites:publish"], name: "SitoInChat",
    icon: { dataUri: "data:image/svg+xml;base64,PHN2Zy8+", source: "website", src: "https://sitoinchat.it/brand/favicon.svg" },
    notes: ["Sign-in at sitoinchat.it (dynamic client registration)."],
  },
};

let calls: Array<{ method: string; path: string; body?: unknown; auth?: string | null }>;
let discovery: ConnectorDiscovery;
let iconStatus: number;

function installFetch() {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ method, path: `${url.pathname}${url.search}`, body, auth });
    const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200 });
    if (url.pathname === "/api/v1/connectors/discover") return ok(discovery);
    if (/\/icon$/.test(url.pathname) && method === "GET") {
      return iconStatus === 200 ? new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml" } }) : new Response("{}", { status: iconStatus });
    }
    if (/\/icon\/refresh$/.test(url.pathname)) return ok(connector("acme", { catalogId: undefined, iconAsset: { source: "website", mimeType: "image/svg+xml", hash: "h2", fetchedAt: "x", src: "https://acme.dev/logo.svg" }, iconUrl: "/api/v1/connectors/acme/icon?v=h2" }));
    if (url.pathname.startsWith("/api/v1/connectors/") && url.pathname.endsWith("/tools")) return ok({ tools: [] });
    throw new Error(`unexpected ${method} ${url.pathname}`);
  }));
}

let root: Root;
let container: HTMLDivElement;
let blobs = 0;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  URL.createObjectURL = vi.fn(() => `blob:icon-${++blobs}`);
  clearConnectorIconCache();
  discovery = SITO;
  iconStatus = 200;
  installFetch();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const click = (el: Element | null | undefined) => act(async () => { (el as HTMLElement).click(); });
const byText = (text: string | RegExp, selector = "button") =>
  [...document.querySelectorAll<HTMLElement>(selector)].find((el) => (typeof text === "string" ? el.textContent?.trim() === text : text.test(el.textContent ?? "")));
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

// ── the icon ──

test("a catalog connector shows its bundled official icon, without asking the API", async () => {
  await act(async () => root.render(<ConnectorIcon catalogId="linear" name="Linear" iconUrl="/connector-icons/linear.svg" />));
  await flush();
  expect(container.querySelector("img")?.getAttribute("src")).toMatch(/connector-icons\/linear\.svg$/);
  expect(calls).toEqual([]);
});

test("a custom connector's icon is fetched from the API with the key (never hotlinked) and cached", async () => {
  const path = "/api/v1/connectors/acme/icon?v=abc";
  await act(async () => root.render(<><ConnectorIcon name="Acme" iconUrl={path} /><ConnectorIcon name="Acme" iconUrl={path} size="sm" /></>));
  await flush();
  const imgs = [...container.querySelectorAll("img")];
  expect(imgs).toHaveLength(2);
  expect(new Set(imgs.map((i) => i.getAttribute("src"))).size).toBe(1);
  expect(imgs[0]!.getAttribute("src")).toMatch(/^blob:icon-/);
  expect(calls.filter((c) => c.path === path)).toHaveLength(1);
  expect(calls[0]!.auth).toBe("Bearer test-key");
});

test("no icon, or it fails to load: the letter tile", async () => {
  iconStatus = 404;
  await act(async () => root.render(<ConnectorIcon name="sitoinchat" color="3D82DE" iconUrl="/api/v1/connectors/sitoinchat/icon?v=zzz" />));
  await flush();
  const tile = container.querySelector('[data-testid="connector-letter-avatar"]') as HTMLElement;
  expect(tile.textContent).toBe("S");
  expect(tile.style.backgroundColor).toBe("rgb(61, 130, 222)");
  expect(container.querySelector("img")).toBeNull();
  // a third-party URL is never used as an image source
  await act(async () => root.render(<ConnectorIcon name="Evil" iconUrl="https://evil.example/logo.png" />));
  await flush();
  expect(container.querySelector("img")).toBeNull();
});

test("a dark variant is shown on a dark tile in dark mode", async () => {
  await act(async () => root.render(<ConnectorIcon name="Acme" iconUrl="/api/v1/connectors/acme/icon?v=l" iconDarkUrl="/api/v1/connectors/acme/icon?theme=dark&v=d" />));
  await flush();
  expect(container.querySelector('[data-testid="connector-icon-light"]')?.className).toContain("dark:hidden");
  expect(container.querySelector('[data-testid="connector-icon-dark"]')?.className).toContain("dark:inline-flex");
  expect(calls.map((c) => c.path)).toEqual(expect.arrayContaining(["/api/v1/connectors/acme/icon?v=l", "/api/v1/connectors/acme/icon?theme=dark&v=d"]));
});

test("icon source labels", () => {
  expect(iconSourceLabel(undefined)).toMatch(/first letter/);
  expect(iconSourceLabel({ source: "website", mimeType: "image/svg+xml", hash: "h", fetchedAt: "x", src: "https://sitoinchat.it/brand/favicon.svg" })).toBe("From sitoinchat.it");
  expect(iconSourceLabel({ source: "mcp", mimeType: "image/png", hash: "h", fetchedAt: "x" })).toBe("From the MCP server");
  expect(iconSourceLabel({ source: "upload", mimeType: "image/png", hash: "h", fetchedAt: "x", pinned: true })).toBe("Uploaded");
});

test("the sheet offers the icon editor for custom connectors only", async () => {
  const custom = connector("acme", { iconUrl: "/api/v1/connectors/acme/icon?v=h1", iconAsset: { source: "upload", mimeType: "image/png", hash: "h1", fetchedAt: "x", pinned: true } });
  const onChanged = vi.fn();
  await act(async () => root.render(<TooltipProvider><ConnectorDetailSheet connector={custom} agents={[]} open onOpenChange={() => {}} onChanged={onChanged} onRemoved={() => {}} onReconnect={() => {}} /></TooltipProvider>));
  await flush();
  const editor = document.querySelector('[data-testid="connector-icon-editor"]')!;
  expect(editor.textContent).toContain("Uploaded");
  expect(byText(/Automatic/)).toBeTruthy();
  // an uploaded icon is kept by a refresh: the button is off
  expect((byText(/Refresh icon/) as HTMLButtonElement).disabled).toBe(true);

  await act(async () => root.render(<TooltipProvider><ConnectorDetailSheet connector={{ ...custom, iconAsset: undefined, iconUrl: undefined }} agents={[]} open onOpenChange={() => {}} onChanged={onChanged} onRemoved={() => {}} onReconnect={() => {}} /></TooltipProvider>));
  await click(byText(/Refresh icon/));
  await flush();
  expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/connectors/acme/icon/refresh")).toBe(true);
  expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ iconAsset: expect.objectContaining({ source: "website" }) }));

  await act(async () => root.render(<TooltipProvider><ConnectorDetailSheet connector={connector("linear", { catalogId: "linear" })} agents={[]} open onOpenChange={() => {}} onChanged={onChanged} onRemoved={() => {}} onReconnect={() => {}} /></TooltipProvider>));
  await flush();
  expect(document.querySelector('[data-testid="connector-icon-editor"]')).toBeNull();
});

// ── detection in "Add custom connector" ──

test("prefilling from a detection keeps a name the person typed", () => {
  const filled = applyDiscovery(EMPTY_CUSTOM_FORM, SITO);
  expect(filled).toMatchObject({ name: "SitoInChat", auth: "oauth", detected: "oauth-dcr", transport: "http", scopes: "sites:read sites:write sites:publish" });
  expect(applyDiscovery({ ...EMPTY_CUSTOM_FORM, name: "Mine" }, SITO).name).toBe("Mine");
  expect(applyDiscovery({ ...EMPTY_CUSTOM_FORM, name: "Old auto" }, SITO, "Old auto").name).toBe("SitoInChat");
  expect(applyDiscovery(EMPTY_CUSTOM_FORM, { ...SITO, recommendation: undefined })).toBe(EMPTY_CUSTOM_FORM);
});

test("entering a URL detects how to connect: recommended option preselected, name, scopes and icon prefilled", async () => {
  const onSubmit = vi.fn();
  await act(async () => root.render(<CustomConnectorDialog open onOpenChange={() => {}} redirectUri={REDIRECT} onSubmit={onSubmit} />));
  await type(inputByLabel("Remote MCP server URL"), "https://mcp.sitoinchat.it");
  expect(calls).toEqual([]); // debounced
  await wait(700);
  await flush();
  expect(calls.filter((c) => c.path === "/api/v1/connectors/discover")).toEqual([expect.objectContaining({ method: "POST", body: { url: "https://mcp.sitoinchat.it/" } })]);

  const panel = document.querySelector('[data-testid="connector-detected"]')!;
  expect(panel.textContent).toContain("Streamable HTTP");
  const recommended = [...panel.querySelectorAll("label")].find((l) => l.textContent?.includes("Recommended"))!;
  expect(recommended.textContent).toContain("OAuth (automatic registration)");
  expect((recommended.querySelector("input") as HTMLInputElement).checked).toBe(true);
  expect(panel.textContent).toContain("Polpo registers itself with the server automatically");
  expect(panel.querySelector("img")?.getAttribute("src")).toBe("data:image/svg+xml;base64,PHN2Zy8+");
  expect(inputByLabel("Name").value).toBe("SitoInChat");

  // every scope preselected; the person can untick one
  const scopes = [...panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(scopes.map((s) => s.checked)).toEqual([true, true, true]);
  await click(scopes[2]);
  await click(byText("Add and sign in"));
  expect(onSubmit).toHaveBeenCalledWith({
    name: "SitoInChat", transport: { type: "http", url: "https://mcp.sitoinchat.it" },
    auth: { type: "oauth", oauth: { scopes: ["sites:read", "sites:write"] } },
  });
});

test("the person can override the detection (a token instead), and a pre-registered client needs its id", async () => {
  discovery = { ...SITO, options: [{ ...SITO.options[1]!, recommended: true }, SITO.options[2]!], recommendation: { ...SITO.recommendation!, auth: "oauth-preregistered", transport: "sse" } };
  const onSubmit = vi.fn();
  await act(async () => root.render(<CustomConnectorDialog open onOpenChange={() => {}} redirectUri={REDIRECT} onSubmit={onSubmit} />));
  await type(inputByLabel("Name"), "Sito");
  await type(inputByLabel("Remote MCP server URL"), "https://mcp.sitoinchat.it/sse");
  await wait(700);
  await flush();
  expect(inputByLabel("Name").value).toBe("Sito"); // typed by the person: kept
  expect(document.querySelector('[data-testid="connector-own-client"]')?.textContent).toContain(REDIRECT);
  await click(byText("Add and sign in"));
  expect(onSubmit).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Enter the client id");

  await click(document.querySelector('input[name="detected-auth"][value="bearer"]'));
  await type(inputByLabel("Token"), "tok");
  await click(byText("Add"));
  expect(onSubmit).toHaveBeenCalledWith({ name: "Sito", transport: { type: "sse", url: "https://mcp.sitoinchat.it/sse" }, auth: { type: "bearer" }, secrets: { bearerToken: "tok" } });
});

test("an unreachable server: a short note, and the manual choices", async () => {
  discovery = { url: "https://down.example/", reachable: false, error: "Could not reach the server: ENOTFOUND", options: [] };
  await act(async () => root.render(<CustomConnectorDialog open onOpenChange={() => {}} onSubmit={() => {}} />));
  await type(inputByLabel("Remote MCP server URL"), "https://down.example");
  await wait(700);
  await flush();
  expect(document.querySelector('[data-testid="connector-detect-failed"]')?.textContent).toContain("ENOTFOUND");
  expect(document.querySelector('input[name="auth"][value="headers"]')).toBeTruthy();
});
