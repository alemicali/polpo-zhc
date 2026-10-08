import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@polpo-ai/react", () => ({
  useEvents: () => ({ events: [] }),
  useAgents: () => ({ agents: [{ name: "alice" }], isLoading: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

import { MemoryRouter } from "react-router-dom";
import { VolumeDialog } from "../src/components/files/volume-dialog";
import { useStorage } from "../src/hooks/use-storage";
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

/** The Files page's dialog for a new volume, or for the stored one. */
function Harness({ edit }: { edit?: boolean }) {
  const storage = useStorage();
  const entry = edit ? storage.entries[0] : undefined;
  if (edit && !entry) return null;
  return <VolumeDialog open entry={entry as any} projectRoot="/srv/project" storage={storage} onClose={() => {}} />;
}

async function render(edit = false) {
  await act(async () => root.render(<MemoryRouter><TooltipProvider><Harness edit={edit} /></TooltipProvider></MemoryRouter>));
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

const dialog = () => document.querySelector("[role=dialog]") as HTMLElement;
const inputs = () => [...dialog().querySelectorAll("input")] as HTMLInputElement[];
const byPlaceholder = (text: string) => inputs().find((i) => i.placeholder === text)!;
const posted = () => requests.find((r) => r.method === "POST" && r.url.endsWith("/api/v1/storage"))?.body as Record<string, any> | undefined;

test("adds an R2 bucket volume: endpoint from the account id, keys referenced from the vault, never typed", async () => {
  await render();
  expect(dialog().textContent).toContain("Add a volume");
  expect(inputs().some((i) => i.type === "password")).toBe(false);
  await act(async () => {
    type(byPlaceholder("listini"), "Media");
    type(byPlaceholder("polpo-listini"), "media-bucket");
    type(byPlaceholder("0123456789abcdef0123456789abcdef"), "abc123");
  });
  expect(dialog().textContent).toContain("https://abc123.r2.cloudflarestorage.com");
  expect(dialog().textContent).toContain("In sandboxes: /volumes/media");
  expect(button("Add volume", dialog()).disabled).toBe(true); // the access key's entry is required
  await pick(dialog(), "Access key vault entry", "alice/r2-main");
  await pick(dialog(), "Sandbox key vault entry", "alice/r2-limited");
  await act(async () => button("Add volume", dialog()).click());
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(posted()).toMatchObject({
    name: "Media", slug: "media", provider: "s3", bucket: "media-bucket", endpoint: "https://abc123.r2.cloudflarestorage.com", region: "auto",
    pathStyle: true, driver: "rclone", readOnly: false, enabled: true,
    credentials: { owner: "alice", service: "r2-main" }, sandboxCredentials: { owner: "alice", service: "r2-limited" }, temporaryCredentials: null,
    volume: { strategy: "mounted", access: "read-write" },
  });
  expect(posted()!.prefix).toBeUndefined();
});

test("bucket volumes are live by default; write-back is asked only for copies", async () => {
  await render();
  const modeTrigger = [...dialog().querySelectorAll("label")].find((l) => l.textContent?.startsWith("Mode"))!.querySelector("button")!;
  expect(modeTrigger.textContent).toContain("Live");
  expect(dialog().textContent).not.toContain("Write back");
});

test("adds a folder of this server: no bucket, no keys, stays on the host", async () => {
  await render();
  await act(async () => button("Folder on this server", dialog()).click());
  expect(dialog().textContent).not.toContain("Access key (vault entry)");
  expect(dialog().textContent).not.toContain("In sandboxes");
  await act(async () => {
    type(byPlaceholder("listini"), "Progetto X");
    type(byPlaceholder("dev/progetto-x"), "dev/progetto-x");
  });
  await act(async () => button("Add volume", dialog()).click());
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(posted()).toMatchObject({ name: "Progetto X", slug: "progetto-x", provider: "local", path: "dev/progetto-x", readOnly: false, volume: { strategy: "mounted", access: "read-write" } });
  expect(posted()!.credentials).toBeUndefined();
});

test("editing keeps the references; temporary R2 keys reference the API token entry", async () => {
  await render(true);
  expect(dialog().textContent).toContain("Volume Shared docs");
  expect(dialog().textContent).toContain("alice · r2-main");
  await act(async () => button("Temporary keys per run", dialog()).click());
  const parent = inputs().find((i) => i.closest("label")?.textContent?.includes("Parent access key ID"))!;
  await act(async () => type(parent, "PARENT"));
  expect(button("Save changes", dialog()).disabled).toBe(true); // the token entry is required
  await pick(dialog(), "Cloudflare API token vault entry", "ops/cloudflare");
  await act(async () => button("Save changes", dialog()).click());
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const put = requests.find((r) => r.method === "PUT" && r.url.endsWith("/api/v1/storage/e1"));
  expect(put?.body).toMatchObject({
    credentials: { owner: "alice", service: "r2-main" }, sandboxCredentials: null,
    // an existing prefix is kept as it is
    prefix: "team/",
    temporaryCredentials: { kind: "r2", accountId: "acct", parentAccessKeyId: "PARENT", token: { owner: "ops", service: "cloudflare" } },
  });
});

test("switching to AWS S3 clears the endpoint and uses virtual-hosted addressing", async () => {
  await render();
  await act(async () => button("AWS S3", dialog()).click());
  expect(byPlaceholder("us-east-1").value).toBe("us-east-1");
  expect(dialog().textContent).not.toContain("Cloudflare account ID");
  const pathStyle = [...dialog().querySelectorAll("label")].find((l) => l.textContent?.includes("Path-style URLs"))!.querySelector("input") as HTMLInputElement;
  expect(pathStyle.checked).toBe(false);
});

test("removing a volume asks for confirmation first, and never touches the bucket", async () => {
  await render(true);
  await act(async () => button("Remove", dialog()).click());
  expect(requests.some((r) => r.method === "DELETE")).toBe(false);
  await act(async () => button("Confirm remove", dialog()).click());
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(requests.some((r) => r.method === "DELETE" && r.url.endsWith("/api/v1/storage/e1"))).toBe(true);
});
