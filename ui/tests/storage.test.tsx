import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@polpo-ai/react", () => ({
  useEvents: () => ({ events: [] }),
  useAgents: () => ({ agents: [{ name: "alice" }], isLoading: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { MemoryRouter } from "react-router-dom";
import { StoragePage } from "../src/pages/storage";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { resetVaultCatalogCache } from "../src/components/vault/vault-ref-picker";

const CATALOG = [
  { owner: "alice", service: "r2-main", type: "custom", label: "R2 main key", keys: ["accessKeyId", "secretAccessKey"], allowedAgents: [] },
  { owner: "alice", service: "r2-limited", type: "custom", keys: ["access_key_id", "secret_access_key"], allowedAgents: ["bob", "carol"] },
  { owner: "ops", service: "cloudflare", type: "api_key", keys: ["token"], allowedAgents: [] },
];

const ENTRY = {
  id: "e1", name: "Shared docs", slug: "shared-docs", provider: "s3", endpoint: "https://acct.r2.cloudflarestorage.com", region: "auto",
  bucket: "docs", prefix: "team/", pathStyle: true, driver: "rclone", readOnly: false, enabled: true,
  grants: [{ id: "g1", agent: "alice", access: "write", prefix: "clients/acme/" }],
  credentials: { owner: "alice", service: "r2-main" },
  keys: { credentials: "set", sandboxCredentials: "not set", temporaryToken: "not set" },
  mount: { entryId: "e1", slug: "shared-docs", state: "mounted", path: "/srv/project/.polpo/mounts/shared-docs", since: "2026-10-06T00:00:00Z", restarts: 0 },
  createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z",
};

let root: Root;
let container: HTMLDivElement;
let requests: Array<{ url: string; method: string; body?: unknown }>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  requests = [];
  resetVaultCatalogCache();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const data = url.endsWith("/api/v1/vault-catalog") ? CATALOG
      : method === "POST" && url.endsWith("/api/v1/storage") ? { ...ENTRY, id: "e2", slug: "media", name: "Media" }
      : method === "PUT" ? ENTRY
      : method === "GET" ? [ENTRY] : { ok: true, latencyMs: 5 };
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

async function render() {
  await act(async () => root.render(<MemoryRouter><TooltipProvider><StoragePage /></TooltipProvider></MemoryRouter>));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === label || b.textContent?.includes(label));
  if (!found) throw new Error(`No button "${label}"`);
  return found as HTMLButtonElement;
}

async function pick(dialog: HTMLElement, label: string, ref: string) {
  const trigger = dialog.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
  if (!trigger) throw new Error(`No picker "${label}"`);
  await act(async () => { trigger.click(); await new Promise((r) => setTimeout(r, 0)); });
  const option = document.querySelector(`[data-vault-ref="${ref}"]`) as HTMLButtonElement;
  if (!option) throw new Error(`No option "${ref}"`);
  await act(async () => option.click());
}

test("lists buckets with their mount state and which vault entries hold the keys, never values", async () => {
  await render();
  expect(container.textContent).toContain("Shared docs");
  expect(container.textContent).toContain("Mounted");
  expect(container.textContent).toContain("acct.r2.cloudflarestorage.com/docs/team/");
  expect(container.textContent).toContain("Set");
  expect(container.textContent).toContain("alice · r2-main");
  expect(container.textContent).toContain("Not set");
  expect(button("Unmount", container)).toBeTruthy();
  expect(button("Browse in Files", container)).toBeTruthy();
});

test("adds an R2 bucket from the preset: endpoint from the account id, keys referenced from the vault", async () => {
  await render();
  await act(async () => button("Add bucket", container).click());
  const dialog = document.querySelector("[role=dialog]") as HTMLElement;
  expect(dialog.textContent).toContain("Cloudflare R2");
  expect(dialog.textContent).toContain("Sandbox key (optional)");
  // no key input fields: only vault entries are chosen
  expect([...dialog.querySelectorAll("input")].some((i) => (i as HTMLInputElement).type === "password")).toBe(false);
  const inputs = () => [...dialog.querySelectorAll("input")] as HTMLInputElement[];
  const byPlaceholder = (text: string) => inputs().find((i) => i.placeholder === text)!;
  await act(async () => {
    type(byPlaceholder("Shared documents"), "Media");
    type(byPlaceholder("my-bucket"), "media-bucket");
    type(byPlaceholder("0123456789abcdef0123456789abcdef"), "abc123");
  });
  expect(dialog.textContent).toContain("https://abc123.r2.cloudflarestorage.com");
  expect(button("Add bucket", dialog).disabled).toBe(true); // the main keys' entry is required
  await pick(dialog, "Access key vault entry", "alice/r2-main");
  await pick(dialog, "Sandbox key vault entry", "alice/r2-limited");
  expect(dialog.textContent).toContain("alice · r2-limited");
  await act(async () => button("Add bucket", dialog).click());
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const post = requests.find((r) => r.method === "POST" && r.url.endsWith("/api/v1/storage"));
  expect(post?.body).toMatchObject({
    name: "Media", slug: "media", bucket: "media-bucket", endpoint: "https://abc123.r2.cloudflarestorage.com", region: "auto",
    pathStyle: true, driver: "rclone", readOnly: false, enabled: true,
    credentials: { owner: "alice", service: "r2-main" }, sandboxCredentials: { owner: "alice", service: "r2-limited" }, temporaryCredentials: null,
  });
});

test("editing keeps the references; temporary R2 keys reference the API token entry", async () => {
  await render();
  await act(async () => button("Settings", container).click());
  const dialog = document.querySelector("[role=dialog]") as HTMLElement;
  expect(dialog.textContent).toContain("alice · r2-main");
  await act(async () => button("Temporary keys per run", dialog).click());
  const parent = [...dialog.querySelectorAll("input")].find((i) => i.closest("label")?.textContent?.includes("Parent access key ID")) as HTMLInputElement;
  await act(async () => type(parent, "PARENT"));
  expect(button("Save changes", dialog).disabled).toBe(true); // the token entry is required
  await pick(dialog, "Cloudflare API token vault entry", "ops/cloudflare");
  await act(async () => button("Save changes", dialog).click());
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const put = requests.find((r) => r.method === "PUT" && r.url.endsWith("/api/v1/storage/e1"));
  expect(put?.body).toMatchObject({
    credentials: { owner: "alice", service: "r2-main" }, sandboxCredentials: null,
    temporaryCredentials: { kind: "r2", accountId: "acct", parentAccessKeyId: "PARENT", token: { owner: "ops", service: "cloudflare" } },
  });
});

test("switching to AWS S3 clears the endpoint and uses virtual-hosted addressing", async () => {
  await render();
  await act(async () => button("Add bucket", container).click());
  const dialog = document.querySelector("[role=dialog]") as HTMLElement;
  await act(async () => button("AWS S3", dialog).click());
  const region = [...dialog.querySelectorAll("input")].find((i) => (i as HTMLInputElement).placeholder === "us-east-1") as HTMLInputElement;
  expect(region.value).toBe("us-east-1");
  expect(dialog.textContent).not.toContain("Cloudflare account ID");
  const pathStyle = [...dialog.querySelectorAll("label")].find((l) => l.textContent?.includes("Path-style URLs"))!.querySelector("input") as HTMLInputElement;
  expect(pathStyle.checked).toBe(false);
});

test("removing a bucket asks for confirmation first", async () => {
  await render();
  await act(async () => button("Remove bucket", container).click());
  expect(requests.some((r) => r.method === "DELETE")).toBe(false);
  const dialog = document.querySelector("[role=dialog]") as HTMLElement;
  expect(dialog.textContent).toContain("Remove Shared docs?");
  await act(async () => button("Remove bucket", dialog).click());
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(requests.some((r) => r.method === "DELETE" && r.url.endsWith("/api/v1/storage/e1"))).toBe(true);
});
