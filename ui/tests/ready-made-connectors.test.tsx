import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// ── SDK mock: the catalog and one hosted server ─────────────────────────────
const state = vi.hoisted(() => ({
  templates: [] as unknown[],
  server: undefined as unknown,
  install: vi.fn(),
  saveSecret: vi.fn(async () => undefined),
  updateSettings: vi.fn(async () => undefined),
}));

vi.mock("@polpo-ai/react", () => ({
  useEvents: () => ({ events: [] }),
  useMcpServers: () => ({ servers: [], templates: state.templates, isLoading: false, error: null, refetch: async () => {}, create: vi.fn(), generate: vi.fn(), install: state.install }),
  useMcpServer: () => ({
    server: state.server, versions: [], deploys: [], isLoading: false, error: null, refetch: async () => {},
    saveDraft: vi.fn(), discardDraft: async () => {}, updateSettings: state.updateSettings, test: vi.fn(), runTests: async () => ({ results: [], passed: 0, failed: 0, skipped: 0 }),
    saveTests: async () => {}, saveSecret: state.saveSecret, publish: vi.fn(), deploy: async () => ({}), rollback: async () => ({}),
    diff: async () => ({ server: "printful", to: "draft", changes: [], unified: "" }), logs: async () => [], pending: async () => [], remove: async () => {},
  }),
}));

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }) }));

import { ReadyMadeConnectors, installOutcome, templateStatusLabel } from "../src/components/connectors/ready-made-connectors";
import { HostedServerSheet } from "../src/components/connectors/hosted-server-sheet";
import { settingsPayload } from "../src/components/connectors/template-fields";
import { TooltipProvider } from "../src/components/ui/tooltip";

const TOKEN = "pf_secret_token_123456";
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
const type = async (el: HTMLInputElement | HTMLSelectElement, value: string) => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
};

const printful = (over: Record<string, unknown> = {}) => ({
  id: "printful", name: "Printful", vendor: "Printful", category: "Print on demand", description: "Print-on-demand catalog and draft orders", icon: "printful",
  docs: "https://developers.printful.com/docs/", setup: "token", revision: 2, changelog: [{ revision: 2, note: "find_variant" }],
  maturity: { testedWithLiveApi: false, note: "recorded-shaped responses only" },
  secrets: [{ name: "token", label: "Private token", howTo: "Developers → Your tokens", url: "https://developers.printful.com/tokens", scopes: ["View orders"], recommendation: "Only the scopes you need", vault: { owner: "polpo-infra", service: "printful", key: "token" } }],
  settings: [{ key: "store_id", label: "Store id", type: "string", help: "With an account-level token" }],
  toolCount: 3, testCount: 2,
  tools: [{ name: "find_variant", description: "x", readOnly: true, requiresApproval: false, destructive: false }, { name: "create_order", description: "y", readOnly: false, requiresApproval: true, destructive: true }],
  readOnlyTools: ["find_variant", "get_product"], approvalTools: ["create_order"],
  status: "available", installs: [],
  ...over,
});
const agents = [{ name: "designer", label: "Designer" }, { name: "ops", label: "Ops" }];

test("the catalog: vendor, category, read-only and approval tools, maturity, status per template", async () => {
  state.templates = [
    printful(),
    printful({ id: "gelato", name: "Gelato", vendor: "Gelato", status: "installed", installs: [{ serverId: "gelato", production: "1.0.0", revision: 1, status: "installed" }] }),
    printful({ id: "printify", name: "Printify", vendor: "Printify", status: "update_available", installs: [{ serverId: "printify", production: "1.2.0", revision: 1, status: "update_available" }] }),
  ];
  const onOpen = vi.fn();
  await act(async () => root.render(<ReadyMadeConnectors agents={agents} onOpenServer={onOpen} />));
  expect(container.textContent).toMatch(/Ready-made \(hosted by/);
  const card = container.querySelector('[data-testid="ready-made-printful"]')!;
  expect(card.textContent).toMatch(/Printful · Print on demand/);
  expect(card.textContent).toMatch(/2 read-only: find_variant, get_product/);
  expect(card.textContent).toMatch(/Needs approval: create_order/);
  expect(card.textContent).toMatch(/Not yet tested with the live API · revision 2/);
  expect(card.textContent).toMatch(/Available/);
  expect(container.querySelector('[data-testid="ready-made-gelato"]')!.textContent).toMatch(/Installed · v1\.0\.0/);
  expect(container.querySelector('[data-testid="ready-made-printify"]')!.textContent).toMatch(/update available \(revision 2\)/);
  const open = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="ready-made-gelato"] button')].find((b) => b.textContent === "Open")!;
  await act(async () => open.click());
  expect(onOpen).toHaveBeenCalledWith("gelato");
  expect(templateStatusLabel(printful({ status: "draft", installs: [{ serverId: "printful", status: "draft" }] }) as never)).toBe("Install not finished");
});

test("install: settings, the secret (sent once, never kept or shown), the agents chosen explicitly; the outcome", async () => {
  state.templates = [printful()];
  state.install.mockResolvedValue({ id: "printful", template: "printful", revision: 2, status: "installed", version: "1.0.0", tests: { passed: 4, failed: 0, skipped: 0, results: [] }, settings: { store_id: "4242" }, access: { agents: ["designer"], polpo: true } });
  const onOpen = vi.fn();
  await act(async () => root.render(<ReadyMadeConnectors agents={agents} onOpenServer={onOpen} />));
  await act(async () => button("Install")!.click());
  const dialog = document.querySelector('[data-testid="install-template-dialog"]')!;
  expect(dialog.textContent).toMatch(/Not yet tested with the live API: recorded-shaped responses only/);
  expect(dialog.textContent).toMatch(/Developers → Your tokens/);
  expect(dialog.textContent).toMatch(/Vault entry polpo-infra \/ printful, field token/);
  // nobody chosen yet: said explicitly
  expect(document.querySelector('[data-testid="no-agents-note"]')?.textContent).toMatch(/only .* will see its tools/);
  await type(document.querySelector<HTMLInputElement>("#setting-store_id")!, "4242");
  const secret = document.querySelector<HTMLInputElement>("#secret-token")!;
  expect(secret.type).toBe("password");
  await type(secret, TOKEN);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Designer"]')!.click());
  expect(document.querySelector('[data-testid="no-agents-note"]')).toBeNull();
  await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Install")!.click());
  await flush();
  expect(state.install).toHaveBeenCalledWith("printful", { settings: { store_id: "4242" }, secrets: { token: TOKEN }, agents: ["designer"] });
  expect(document.querySelector('[data-testid="install-outcome"]')?.textContent).toMatch(/Installed: printful v1\.0\.0.*4 passed/);
  expect(document.body.innerHTML).not.toContain(TOKEN);
  await act(async () => button("Open the server")!.click());
  expect(onOpen).toHaveBeenCalledWith("printful");
});

test("outcomes: a missing secret, a failing test, an update draft with its changes", () => {
  expect(installOutcome({ id: "p", template: "p", revision: 2, status: "needs_secrets", missingSecrets: ["token"], settings: {} }).lines[0]).toMatch(/Paste token/);
  expect(installOutcome({ id: "p", template: "p", revision: 2, status: "tests_failed", settings: {}, tests: { passed: 0, failed: 1, skipped: 0, results: [{ tool: "list_stores", ok: false, text: "", error: "Printful refused the token", ms: 1, passed: false }] } }))
    .toMatchObject({ tone: "warn", lines: ["list_stores: Printful refused the token"] });
  expect(installOutcome({ id: "p", template: "p", revision: 2, status: "upgrade_draft", settings: {}, diff: { server: "p", to: "draft", changes: [{ field: "tools.find_variant", kind: "added" }], unified: "" } }).lines[0])
    .toBe("added tools.find_variant");
  expect(settingsPayload({ a: "1", b: undefined, c: "" }, { b: "x" })).toEqual({ a: "1", b: null });
});

test("the server's Settings tab: settings saved without a new version; secrets written to the vault, never shown", async () => {
  state.server = {
    id: "printful", name: "Printful", visibility: "private", toolCount: 1, production: "1.0.0", draftChanged: false, pendingApprovals: 0, versionCount: 1, createdAt: "", updatedAt: "u1", createdBy: "",
    template: "printful", settings: { store_id: "4242" }, effectiveSettings: { store_id: "4242" },
    settingsSchema: [{ key: "store_id", label: "Store id", type: "string" }],
    templateInfo: { id: "printful", name: "Printful", latestRevision: 2, installedRevision: 2, docs: "", maturity: { testedWithLiveApi: false }, secrets: { token: { label: "Private token", howTo: "Developers → Your tokens" } } },
    draft: { spec: { name: "Printful", allowedDomains: ["api.printful.com"], secrets: { token: { owner: "polpo-infra", service: "printful", key: "token" } }, auth: { type: "bearer", secret: "token" }, tools: [] }, updatedAt: "", updatedBy: "", problems: [] },
    secrets: { token: false }, tests: [], rateLimits: { perIpPerMinute: 30, globalPerMinute: 300 },
  };
  window.history.replaceState(null, "", "/connectors?tab=servers&server=printful&focus=secret%3Atoken");
  await act(async () => root.render(<TooltipProvider><HostedServerSheet id="printful" open onOpenChange={() => {}} /></TooltipProvider>));
  await flush();
  // the setup link opens on the Settings tab with the secret's input
  const values = document.querySelector('[data-testid="server-values"]')!;
  expect(values.textContent).toMatch(/Private token/);
  expect(values.textContent).toMatch(/not set/);
  expect(document.activeElement?.id).toBe("secret-token");
  expect(document.querySelector<HTMLInputElement>("#setting-store_id")!.value).toBe("4242");
  await type(document.querySelector<HTMLInputElement>("#setting-store_id")!, "77");
  await act(async () => button("Save settings")!.click());
  expect(state.updateSettings).toHaveBeenCalledWith({ settings: { store_id: "77" } });
  const secret = document.querySelector<HTMLInputElement>("#secret-token")!;
  await type(secret, TOKEN);
  await act(async () => button("Save to vault")!.click());
  await flush();
  expect(state.saveSecret).toHaveBeenCalledWith("token", TOKEN);
  expect(document.querySelector<HTMLInputElement>("#secret-token")!.value).toBe("");
  expect(document.body.innerHTML).not.toContain(TOKEN);
  window.history.replaceState(null, "", "/");
});
