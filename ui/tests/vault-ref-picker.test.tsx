import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { MemoryRouter } from "react-router-dom";
import { VaultRefPicker, resetVaultCatalogCache } from "../src/components/vault/vault-ref-picker";
import { RemoteProvidersCard } from "../src/components/sandbox/remote-providers-card";
import { hasCredential, missingCredentials, CREDENTIAL_NAMES } from "../src/lib/vault-ref";
import { withRemoteProvider, compactSandbox } from "../src/lib/sandbox-api";
import type { VaultRef } from "../src/lib/vault-ref";

const CATALOG = [
  { owner: "bob", service: "github", type: "login", keys: ["user", "pass"], allowedAgents: [] },
  { owner: "alice", service: "daytona", type: "api_key", label: "Daytona key", keys: ["API_KEY"], allowedAgents: ["bob", "carol"] },
  { owner: "alice", service: "smtp", type: "smtp", keys: ["host", "port"], allowedAgents: [] },
];

let root: Root;
let container: HTMLDivElement;
let requests: Array<{ url: string; method: string; body?: any }>;
let catalog: typeof CATALOG;
let instanceSandbox: Record<string, unknown> | null;
let providers: unknown[];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  requests = [];
  catalog = CATALOG;
  instanceSandbox = { provider: "bwrap", network: { mode: "open" }, providers: { e2b: { credential: { owner: "ops", service: "e2b" } } } };
  providers = [
    { id: "daytona", configured: false, keyFound: false },
    { id: "e2b", configured: true, keyFound: true, credential: { owner: "ops", service: "e2b" } },
  ];
  resetVaultCatalogCache();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const data = url.endsWith("/vault-catalog") ? catalog
      : url.endsWith("/sandbox/providers") ? providers
      : url.endsWith("/api/v1/sandbox") ? { available: ["local"], settings: instanceSandbox, polpo: {}, agents: [] }
      : {};
    return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { "content-type": "application/json" } });
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function Harness({ initial = null, requiredKeys }: { initial?: VaultRef | null; requiredKeys?: Array<keyof typeof CREDENTIAL_NAMES> }) {
  const [value, setValue] = useState<VaultRef | null>(initial);
  return (
    <>
      <VaultRefPicker value={value} onChange={setValue} requiredKeys={requiredKeys} aria-label="Key entry" />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  );
}

async function open() {
  await act(async () => (container.querySelector('button[aria-label="Key entry"]') as HTMLButtonElement).click());
  await flush();
}

test("alias lists match the backend's and accept any casing or separator", () => {
  expect(hasCredential(["API_KEY"], "apiKey")).toBe(true);
  expect(hasCredential(["token"], "apiToken")).toBe(true);
  expect(hasCredential(["AWS-Access-Key-ID"], "accessKeyId")).toBe(true);
  expect(missingCredentials(["user", "password"], ["accessKeyId", "secretAccessKey"])).toEqual([]);
  expect(missingCredentials(["host"], ["apiKey"])).toEqual(["apiKey"]);
});

test("lists entries grouped by owner with key names and sharing, never values; picking returns owner + service", async () => {
  await act(async () => root.render(<MemoryRouter><Harness requiredKeys={["apiKey"]} /></MemoryRouter>));
  await open();
  const options = [...document.querySelectorAll("[data-vault-ref]")].map((o) => o.getAttribute("data-vault-ref"));
  expect(options).toEqual(["alice/daytona", "alice/smtp", "bob/github"]);
  const daytona = document.querySelector('[data-vault-ref="alice/daytona"]')!;
  expect(daytona.textContent).toContain("Daytona key");
  expect(daytona.textContent).toContain("API key");
  expect(daytona.textContent).toContain("API_KEY");
  expect(daytona.textContent).toContain("shared with 2");
  await act(async () => (daytona as HTMLButtonElement).click());
  expect(container.querySelector('[data-testid="value"]')!.textContent).toBe(JSON.stringify({ owner: "alice", service: "daytona" }));
  expect(container.textContent).not.toContain("This entry has no");
});

test("warns when the chosen entry has none of the required keys", async () => {
  await act(async () => root.render(<MemoryRouter><Harness initial={{ owner: "alice", service: "smtp" }} requiredKeys={["apiKey"]} /></MemoryRouter>));
  await flush();
  expect(container.textContent).toMatch(/This entry has no apiKey \/ api_key \/ key key/);
});

test("an entry that is not in the vault points to the owner's Credentials tab", async () => {
  await act(async () => root.render(<MemoryRouter><Harness initial={{ owner: "dave", service: "gone" }} /></MemoryRouter>));
  await flush();
  expect(container.textContent).toContain("Not found in dave's vault");
  expect(container.querySelector("a")!.getAttribute("href")).toBe("/agents/dave?tab=credentials");
});

test("when nothing fits, links to the agent's Credentials tab", async () => {
  catalog = [CATALOG[0]!];
  await act(async () => root.render(<MemoryRouter><Harness requiredKeys={["apiKey"]} /></MemoryRouter>));
  await open();
  const link = [...document.querySelectorAll("a")].find((a) => a.textContent?.includes("Add it in the agent's Credentials tab"));
  expect(link?.getAttribute("href")).toBe("/agents/bob?tab=credentials");
});

test("sandbox settings helpers keep the other settings and providers", () => {
  const current = { provider: "bwrap" as const, providers: { e2b: { credential: { owner: "ops", service: "e2b" } } } };
  expect(withRemoteProvider(current, "daytona", { credential: { owner: "alice", service: "daytona" }, target: "eu", apiUrl: "" })).toEqual({
    provider: "bwrap",
    providers: { e2b: { credential: { owner: "ops", service: "e2b" } }, daytona: { credential: { owner: "alice", service: "daytona" }, target: "eu" } },
  });
  expect(withRemoteProvider(current, "e2b", null)).toEqual({ provider: "bwrap" });
  // saving the isolation settings must not drop the providers
  expect(compactSandbox(current).providers).toEqual(current.providers);
});

test("remote providers: no key field; choosing the vault entry saves a reference with the other sandbox settings", async () => {
  await act(async () => root.render(<MemoryRouter><RemoteProvidersCard /></MemoryRouter>));
  await flush();
  expect([...container.querySelectorAll("input")].some((i) => (i as HTMLInputElement).type === "password")).toBe(false);
  expect(container.textContent).toContain("Not connected");
  expect(container.textContent).toContain("Key found");
  await act(async () => (container.querySelector('button[aria-label="Daytona API key vault entry"]') as HTMLButtonElement).click());
  await flush();
  await act(async () => (document.querySelector('[data-vault-ref="alice/daytona"]') as HTMLButtonElement).click());
  const region = [...container.querySelectorAll("input")].find((i) => (i as HTMLInputElement).placeholder === "eu") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(region, "eu");
    region.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const save = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save" && !b.disabled)!;
  await act(async () => save.click());
  await flush();
  const patch = requests.find((r) => r.method === "PATCH" && r.url.endsWith("/config/settings"));
  expect(patch?.body).toEqual({
    sandbox: {
      provider: "bwrap", network: { mode: "open" },
      providers: { e2b: { credential: { owner: "ops", service: "e2b" } }, daytona: { credential: { owner: "alice", service: "daytona" }, target: "eu" } },
    },
  });
});

test("remote providers: Disconnect removes only that provider", async () => {
  await act(async () => root.render(<MemoryRouter><RemoteProvidersCard /></MemoryRouter>));
  await flush();
  await act(async () => (container.querySelector('button[aria-label="Disconnect E2B"]') as HTMLButtonElement).click());
  await flush();
  const patch = requests.find((r) => r.method === "PATCH" && r.url.endsWith("/config/settings"));
  expect(patch?.body).toEqual({ sandbox: { provider: "bwrap", network: { mode: "open" } } });
});
