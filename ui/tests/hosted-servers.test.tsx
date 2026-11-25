import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// ── SDK mock: hosted servers ────────────────────────────────────────────────
const state = vi.hoisted(() => ({
  servers: [] as unknown[],
  server: undefined as unknown,
  create: vi.fn(async () => ({ id: "printful", problems: [] })),
  generate: vi.fn(),
  test: vi.fn(),
  publish: vi.fn(async () => ({ version: "1.0.0" })),
  updateSettings: vi.fn(async () => undefined),
  saveDraft: vi.fn(async () => ({ problems: [] })),
  deploy: vi.fn(async () => ({})),
  deploys: [] as unknown[],
}));

vi.mock("@polpo-ai/react", () => ({
  useEvents: () => ({ events: [] }),
  useMcpServers: () => ({
    servers: state.servers,
    templates: [{ id: "printful", name: "Printful", description: "Print on demand", setup: "Add the vault entry polpo-infra/printful (field token)", toolCount: 10, testCount: 3,
      tools: [{ name: "get_product", description: "x", readOnly: true, requiresApproval: false }, { name: "create_order", description: "y", readOnly: false, requiresApproval: true }] }],
    isLoading: false, error: null, refetch: async () => {}, create: state.create, generate: state.generate,
  }),
  useMcpServer: () => ({
    server: state.server, versions: [{ version: "1.0.0", production: true, createdAt: "2026-11-24T10:00:00Z", author: "person:a@b.c", changes: [], toolCount: 2 }], deploys: state.deploys,
    isLoading: false, error: null, refetch: async () => {},
    saveDraft: state.saveDraft, discardDraft: async () => {}, updateSettings: state.updateSettings, test: state.test, runTests: async () => ({ results: [], passed: 0, failed: 0, skipped: 0 }),
    saveTests: async () => {}, publish: state.publish, deploy: state.deploy, rollback: async () => ({}),
    diff: async () => ({ server: "printful", to: "draft", changes: [], unified: "" }), logs: async () => [], pending: async () => [], remove: async () => {},
  }),
}));

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }) }));

import { HostedServersList, CreateServerDialog } from "../src/components/connectors/hosted-servers";
import { HostedServerSheet } from "../src/components/connectors/hosted-server-sheet";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { hostedLabel, sampleInput, schemaParams } from "../src/lib/mcp-servers";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  state.servers = [];
  state.server = undefined;
  state.deploys = [];
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);

const spec = {
  name: "Printful", allowedDomains: ["api.printful.com"], secrets: { token: { owner: "polpo-infra", service: "printful", key: "token" } }, auth: { type: "bearer", secret: "token" },
  tools: [
    { name: "get_product", description: "One product", kind: "http", inputSchema: { type: "object", properties: { product_id: { type: "integer", description: "id" } }, required: ["product_id"] }, annotations: { readOnlyHint: true }, http: { method: "GET", url: "/products/{{input.product_id}}" } },
    { name: "create_order", description: "Draft order", kind: "http", requiresApproval: true, annotations: { destructiveHint: true }, inputSchema: { type: "object", properties: {} }, http: { method: "POST", url: "/orders" } },
  ],
};

test("helpers: schema preview, sample input, hosted label", () => {
  expect(schemaParams(spec.tools[0]!.inputSchema)).toEqual([{ name: "product_id", type: "integer", required: true, description: "id" }]);
  expect(sampleInput(spec.tools[0]!.inputSchema)).toEqual({ product_id: 0 });
  expect(hostedLabel("Polpo", "1.2.0")).toBe("Hosted by Polpo · v1.2.0");
});

test("the list: empty state offers to create; servers show visibility, version and pending approvals", async () => {
  const onCreate = vi.fn();
  await act(async () => root.render(<HostedServersList onOpen={() => {}} onCreate={onCreate} />));
  expect(container.textContent).toMatch(/No hosted servers yet/);
  await act(async () => button("Create server")!.click());
  expect(onCreate).toHaveBeenCalled();

  state.servers = [{ id: "printful", name: "Printful", visibility: "public", toolCount: 10, production: "1.2.0", draftChanged: true, pendingApprovals: 2, versionCount: 3, createdAt: "", updatedAt: "", createdBy: "" }];
  const onOpen = vi.fn();
  await act(async () => root.render(<HostedServersList onOpen={onOpen} onCreate={onCreate} />));
  const row = container.querySelector('[data-testid="hosted-server-printful"]')!;
  expect(row.textContent).toMatch(/Public/);
  expect(row.textContent).toMatch(/v1\.2\.0 in production · draft has changes · 10 tools · 2 waiting for approval/);
  await act(async () => row.querySelector("button")!.click());
  expect(onOpen).toHaveBeenCalledWith("printful");
});

test("hosted servers are connector rows: Hosted by badge, status pill, the vendor's mark or a letter tile, the gear", async () => {
  state.servers = [
    { id: "printful", name: "Printful", icon: "printful", template: "printful", visibility: "private", toolCount: 10, production: "1.1.0", draftChanged: false, pendingApprovals: 0, versionCount: 2, createdAt: "", updatedAt: "", createdBy: "" },
    // made before the Gelato template had an icon: its template's mark
    { id: "gelato", name: "Gelato", icon: "🖨️", template: "gelato", visibility: "private", toolCount: 8, draftChanged: false, pendingApprovals: 0, versionCount: 0, createdAt: "", updatedAt: "", createdBy: "" },
    { id: "my-api", name: "my API", visibility: "private", toolCount: 1, disabled: true, production: "1.0.0", draftChanged: false, pendingApprovals: 0, versionCount: 1, createdAt: "", updatedAt: "", createdBy: "" },
  ];
  const onOpen = vi.fn();
  await act(async () => root.render(<HostedServersList onOpen={onOpen} onCreate={() => {}} />));
  const row = (id: string) => container.querySelector(`[data-testid="hosted-server-${id}"]`)!;
  for (const id of ["printful", "gelato", "my-api"]) {
    expect(row(id).getAttribute("data-slot")).toBe("connector-row");
    expect(row(id).querySelector(`[data-testid="hosted-server-badge-${id}"]`)!.textContent).toMatch(/^Hosted by /);
  }
  const pill = (id: string) => row(id).querySelector('[data-slot="status-pill"]')!;
  expect([pill("printful").textContent, pill("printful").getAttribute("data-tone")]).toEqual(["Live v1.1.0", "success"]);
  expect([pill("gelato").textContent, pill("gelato").getAttribute("data-tone")]).toEqual(["Draft", "muted"]);
  expect([pill("my-api").textContent, pill("my-api").getAttribute("data-tone")]).toEqual(["Switched off", "muted"]);
  expect(row("printful").querySelector("img")!.getAttribute("src")).toBe("/hosted-server-icons/printful.svg");
  expect(row("gelato").querySelector("img")!.getAttribute("src")).toBe("/hosted-server-icons/gelato.svg");
  // a custom server: the letter tile, like any custom connector without an icon
  expect(row("my-api").querySelector("img")).toBeNull();
  expect(row("my-api").querySelector('[data-testid="connector-letter-avatar"]')!.textContent).toBe("M");
  await act(async () => (row("my-api").querySelector('[aria-label="Manage my API"]') as HTMLButtonElement).click());
  expect(onOpen).toHaveBeenCalledWith("my-api");
});

test("create from the Printful template: one click, the setup step is said", async () => {
  const onCreated = vi.fn();
  await act(async () => root.render(<TooltipProvider><CreateServerDialog open onOpenChange={() => {}} onCreated={onCreated} /></TooltipProvider>));
  const card = document.querySelector('[data-testid="template-printful"]')!;
  expect(card.textContent).toMatch(/1 need approval/);
  expect(card.querySelector("img")!.getAttribute("src")).toBe("/hosted-server-icons/printful.svg");
  await act(async () => (card.querySelector("button") as HTMLButtonElement).click());
  await flush();
  expect(state.create).toHaveBeenCalledWith({ template: "printful" });
  expect(onCreated).toHaveBeenCalledWith("printful");
});

test("the editor: the hosted label, what blocks publishing, tool badges (approval, read-only)", async () => {
  state.server = {
    id: "printful", name: "Printful", visibility: "private", toolCount: 2, production: "1.0.0", draftChanged: false, pendingApprovals: 0, versionCount: 1, createdAt: "", updatedAt: "u1", createdBy: "",
    connectorId: "printful", draft: { spec, updatedAt: "", updatedBy: "", problems: ["create_order: describe it better"] }, secrets: { token: false }, tests: [], rateLimits: { perIpPerMinute: 30, globalPerMinute: 300 },
  };
  state.test.mockResolvedValue({ tool: "create_order", ok: true, text: "Not sent", ms: 3, skipped: "Destructive or approval tool: not sent.", request: { method: "POST", url: "https://api.printful.com/orders", headers: { authorization: "••••" } } });
  const onOpenConnector = vi.fn();
  await act(async () => root.render(<TooltipProvider><HostedServerSheet id="printful" open onOpenChange={() => {}} onOpenConnector={onOpenConnector} /></TooltipProvider>));
  await flush();
  expect(document.body.textContent).toMatch(/Hosted by .* · v1\.0\.0/);
  // the connector sheet's header: the mark (a letter tile: no template icon here), the status pill, who can use it
  expect(document.querySelector('[data-testid="hosted-server-status"] [data-slot="status-pill"]')?.textContent).toBe("Live v1.0.0");
  await act(async () => button("Who can use it")!.click());
  expect(onOpenConnector).toHaveBeenCalledWith("printful");
  for (const tab of ["Tools", "Settings", "Test", "Versions", "Logs"]) expect([...document.querySelectorAll('[role="tab"]')].some((t) => t.textContent?.trim() === tab), tab).toBe(true);
  expect(document.querySelector('[data-testid="draft-problems"]')?.textContent).toMatch(/describe it better/);
  expect(document.querySelector('[data-testid="tool-create_order"]')?.textContent).toMatch(/approval/);
  expect(document.querySelector('[data-testid="tool-get_product"]')?.textContent).toMatch(/read-only/);
});

test("a required suite blocks the deploy: published, not deployed; Deploy anyway with a reason; the history shows the gate", async () => {
  state.server = {
    id: "printful", name: "Printful", visibility: "private", toolCount: 2, production: "1.0.0", draftChanged: true, pendingApprovals: 0, versionCount: 1, createdAt: "", updatedAt: "u1", createdBy: "",
    connectorId: "printful", draft: { spec, updatedAt: "", updatedBy: "", problems: [] }, secrets: { token: true }, tests: [], rateLimits: { perIpPerMinute: 30, globalPerMinute: 300 },
  };
  state.deploys = [
    { id: "d2", from: "1.0.0", to: "1.0.1", action: "deploy", actor: "admin", at: "2026-11-25T10:00:00Z", gate: { decision: "override", reason: "hotfix", by: "admin" } },
    { id: "d1", to: "1.0.0", action: "initial", actor: "admin", at: "2026-11-24T10:00:00Z", gate: { decision: "pass", runId: "sr-1" } },
  ];
  state.publish.mockResolvedValueOnce({ version: "1.1.0", deployBlocked: { reason: "Blocked by the suite: Item: text does not contain Lamp", runId: "sr-2", failures: ["Item: text does not contain Lamp"] } } as never);
  await act(async () => root.render(<TooltipProvider><HostedServerSheet id="printful" open onOpenChange={() => {}} /></TooltipProvider>));
  await flush();
  const versions = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent?.trim() === "Versions")!;
  await act(async () => { versions.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })); });
  await flush();
  expect([...document.querySelectorAll('[data-testid="hosted-deploy-entry"]')].map((e) => e.textContent)).toEqual([
    expect.stringContaining("override by admin: hotfix"), expect.stringContaining("suite passed"),
  ]);
  await act(async () => button("Publish")!.click());
  await flush();
  expect(state.publish).toHaveBeenCalledWith({ deploy: true });
  const blocked = document.querySelector('[data-testid="hosted-gate-blocked"]')!;
  expect(blocked.textContent).toContain("1.1.0 was not deployed");
  expect(blocked.textContent).toContain("Item: text does not contain Lamp");
  await act(async () => (document.querySelector('[data-testid="hosted-gate-override"]') as HTMLButtonElement).click());
  await flush();
  const reason = document.querySelector('[data-testid="override-reason"]') as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(reason, "upstream changed its field names");
    reason.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => (document.querySelector('[data-testid="override-confirm"]') as HTMLButtonElement).click());
  await flush();
  expect(state.deploy).toHaveBeenCalledWith("1.1.0", undefined, { override: { reason: "upstream changed its field names" } });
  expect(document.querySelector('[data-testid="hosted-gate-blocked"]')).toBeNull();
});
