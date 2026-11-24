import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const client = {
  setWaBusinessSecrets: vi.fn(async () => ({ secrets: { accessToken: true, appSecret: false, verifyToken: true } })),
  removeWaBusinessSecret: vi.fn(async () => ({})),
  generateWaBusinessVerifyToken: vi.fn(async () => ({ verifyToken: "generated-verify-token-123" })),
  getWaBusinessPending: vi.fn(async () => [{ id: "pending_1", waId: "393331234567", pending: { template: "order_update", language: "it", params: ["Mario"], requestedBy: "support", requestedAt: "" } }]),
  approveWaBusinessSend: vi.fn(async () => ({ id: "pending_1", sentAs: "wamid.x" })),
  rejectWaBusinessSend: vi.fn(async () => ({})),
  testWaBusiness: vi.fn(async () => ({ displayPhoneNumber: "+39 02", qualityRating: "GREEN", checkedAt: "" })),
  getWaBusinessEvents: vi.fn(async () => ({ channel: "shop", events: [], total: 0, counts: { accepted: 0, ignored: 0, rejected: 0, error: 0 } })),
  getWaBusinessEvent: vi.fn(),
};
const status = {
  channel: "shop", graphApiVersion: "v23.0", audience: "customers", agent: "support", inbound: true,
  secrets: { accessToken: true, appSecret: false, verifyToken: true }, state: "not-configured", missing: ["appSecret"],
  callbackUrl: "https://host.ts.net/acme/api/v1/channels/whatsapp-business/webhooks/shop",
  funnelCommand: "tailscale funnel --bg --set-path /acme/api/v1/channels/whatsapp-business/webhooks http://127.0.0.1:3890/api/v1/channels/whatsapp-business/webhooks",
  note: "Expose the path.", counts: { accepted: 3, ignored: 1, rejected: 2, error: 0 }, inbox: 0, pendingApprovals: 1, sentToday: 4,
  limits: { businessInitiatedPerDay: 50, perAgentPerDay: {} },
};
vi.mock("@polpo-ai/react", () => ({
  usePolpo: () => ({ client }),
  useWaBusinessStatus: () => ({ status, channels: [status], isLoading: false, error: null, refetch: vi.fn(async () => {}) }),
  useEvents: () => ({ events: [] }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { WaBusinessFields, WaBusinessLive } from "../src/components/config/whatsapp-business-section";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

test("shows secrets only as stored / not set, the callback and the Funnel command, and the queued templates", async () => {
  await act(async () => root.render(<WaBusinessLive channel="shop" />));
  await act(async () => {});
  const text = container.textContent ?? "";
  expect(container.querySelector('[data-testid="wabiz-secret-accessToken"]')?.textContent).toContain("Stored");
  expect(container.querySelector('[data-testid="wabiz-secret-appSecret"]')?.textContent).toContain("Not set");
  expect(container.querySelector('[data-testid="wabiz-callback"]')?.textContent).toBe(status.callbackUrl);
  expect(container.querySelector('[data-testid="wabiz-funnel"]')?.textContent).toContain("tailscale funnel --bg --set-path /acme/");
  expect(text).toContain("Missing: appSecret");
  expect(container.querySelector('[data-testid="wabiz-pending"]')?.textContent).toContain("order_update");
  // the secret inputs are empty password fields with their setup ids
  const input = container.querySelector<HTMLInputElement>('input[data-setup-field="accessToken"]');
  expect(input?.type).toBe("password");
  expect(input?.value).toBe("");
});

test("generates the verify token and shows it once", async () => {
  await act(async () => root.render(<WaBusinessLive channel="shop" />));
  const generate = [...container.querySelectorAll("button")].find((b) => b.textContent === "Generate")!;
  await act(async () => { generate.click(); });
  expect(client.generateWaBusinessVerifyToken).toHaveBeenCalledWith("shop");
  expect(container.querySelector('[data-testid="wabiz-verify-token"]')?.textContent).toBe("generated-verify-token-123");
});

test("the form edits ids, audience and categories without any secret field", async () => {
  const onChange = vi.fn();
  await act(async () => root.render(<WaBusinessFields config={{ type: "whatsapp-business", business: {} }} onChange={onChange} />));
  expect(container.querySelector('input[data-setup-field="accessToken"]')).toBeNull();
  const marketing = [...container.querySelectorAll("button")].find((b) => b.textContent === "marketing")!;
  await act(async () => { marketing.click(); });
  expect(onChange).toHaveBeenCalledWith({ business: { allowedCategories: ["UTILITY", "MARKETING"] } });
});
