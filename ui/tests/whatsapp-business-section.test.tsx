import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { WaBusinessMessage, WaBusinessTemplate } from "@polpo-ai/react";

const client = {
  setWaBusinessSecrets: vi.fn(async () => ({ secrets: { accessToken: true, appSecret: false, verifyToken: true } })),
  removeWaBusinessSecret: vi.fn(async () => ({})),
  generateWaBusinessVerifyToken: vi.fn(async () => ({ verifyToken: "generated-verify-token-123" })),
  getWaBusinessPending: vi.fn(async () => [{
    id: "pending_1", channel: "shop", waId: "393331234567", direction: "out", type: "template", status: "pending_approval", statuses: [], createdAt: "", updatedAt: "",
    template: { name: "order_update", language: "it", category: "UTILITY" }, text: "Ciao Mario, il tuo ordine A-77 è partito",
    pending: {
      template: "order_update", language: "it", params: [], requestedBy: "support", requestedAt: "2026-11-26T09:00:00.000Z", reason: "The customer asked",
      components: { header: { type: "image", link: "https://cdn.example.com/box.jpg" }, body: { name: "Mario", order: "A-77" }, buttons: [{ index: 0, text: "A-77" }] },
    },
  }]),
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
  phone: { displayPhoneNumber: "+39 02 1234", qualityRating: "YELLOW", messagingLimitTier: "TIER_1K", nameStatus: "APPROVED", checkedAt: "2026-11-26T08:00:00.000Z" },
  capabilities: { media: { download: true, maxBytes: 16 * 1024 * 1024 }, catalogId: "555", payments: { market: "IN" }, marketingMessagesApi: false, profilePhoto: true, sharedRoutes: ["777"] },
  lastAccountEvent: { field: "phone_number_quality_update", summary: "quality YELLOW", at: "2026-11-26T08:30:00.000Z" },
};
const live = vi.hoisted(() => ({
  update: (() => {}) as (...a: unknown[]) => unknown,
  setBlocked: (() => {}) as (...a: unknown[]) => unknown,
  unblock: (() => {}) as (...a: unknown[]) => unknown,
  setOverride: (() => {}) as (...a: unknown[]) => unknown,
  phoneAction: (() => {}) as (...a: unknown[]) => unknown,
  profile: {} as Record<string, unknown>,
  analytics: undefined as unknown,
  media: {} as Record<string, { url: string; contentType: string; filename?: string }>,
  conversation: undefined as unknown,
  templates: [] as unknown[],
}));
vi.mock("@polpo-ai/react", () => ({
  usePolpo: () => ({ client }),
  useWaBusinessStatus: () => ({ status, channels: [status], isLoading: false, error: null, refetch: vi.fn(async () => {}) }),
  useEvents: () => ({ events: [] }),
  useWaMedia: (_c: string, id: string | undefined, enabled = true) => (id && enabled && live.media[id] ? { ...live.media[id], isLoading: false, error: null } : { isLoading: false, error: null }),
  useWaConversation: () => ({ conversation: live.conversation, isLoading: false, error: null, refetch: vi.fn(async () => {}), send: vi.fn(), sendTemplate: vi.fn(), react: vi.fn(async () => {}), markRead: vi.fn(async () => {}) }),
  useWaTemplates: () => ({ templates: live.templates, isLoading: false, error: null, sync: vi.fn(), create: vi.fn(), edit: vi.fn(), remove: vi.fn() }),
  useWaBusinessProfile: () => ({ profile: live.profile, isLoading: false, error: null, refetch: vi.fn(), update: live.update }),
  useWaBlocked: () => ({ blocked: ["393330000000"], isLoading: false, error: null, refetch: vi.fn(), block: vi.fn(), unblock: live.unblock }),
  useWaAnalytics: (_c: string, q: unknown) => ({ data: q ? live.analytics : undefined, isLoading: false, error: null, refetch: vi.fn() }),
  useWaAccountEvents: () => ({ events: [{ id: "a1", channel: "shop", field: "message_template_status_update", at: "2026-11-26T08:00:00.000Z", summary: "order_update APPROVED", value: { event: "APPROVED" } }], isLoading: false, error: null, refetch: vi.fn() }),
  useWaPhone: (_c: string, o: { loadWebhook?: boolean } = {}) => ({
    webhook: o.loadWebhook ? { callbackUrl: "https://me.ts.net/x", current: { application: "https://app.example.com/hook" } } : undefined,
    isLoading: false, error: null, refetch: vi.fn(), setOverride: live.setOverride, action: live.phoneAction,
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { WaBusinessFields, WaBusinessLive } from "../src/components/config/whatsapp-business-section";
import { WaTranscript } from "../src/components/config/whatsapp-business/transcript";
import { WaComposer } from "../src/components/config/whatsapp-business/composer";
import { WaContactSheet } from "../src/components/config/whatsapp-business/contact-sheet";
import {
  WaAccountEventsList, WaAnalyticsPanel, WaBlockedList, WaPhonePanel, WaProfileEditor,
} from "../src/components/config/whatsapp-business/manage";
import { analyticsRows, componentsProblem, templateInputProblems, templateNeeds, templatePreviewText, outboundProblem } from "../src/components/config/whatsapp-business/wabiz-lib";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  live.update = vi.fn(async (p: unknown) => p);
  live.setBlocked = vi.fn(async () => ({ done: ["393331234567"], failed: [] }));
  live.unblock = vi.fn(async () => ({ done: ["393330000000"], failed: [] }));
  live.setOverride = vi.fn(async () => ({}));
  live.phoneAction = vi.fn(async () => {});
  live.profile = { about: "Hi", vertical: "RETAIL" };
  live.analytics = undefined;
  live.media = {};
  live.conversation = undefined;
  live.templates = [];
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const all = () => [...document.querySelectorAll<HTMLButtonElement>("button")];
const byText = (text: string | RegExp, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLElement>("button")].find((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? "")));
async function click(el: HTMLElement | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => { el!.click(); });
  await act(async () => {});
}
async function type(el: Element | null | undefined, value: string) {
  expect(el).toBeTruthy();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function pick(trigger: Element | null, option: RegExp) {
  expect(trigger).toBeTruthy();
  await act(async () => { (trigger as HTMLElement).focus(); trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  const opt = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => option.test(o.textContent ?? ""));
  expect(opt, String(option)).toBeTruthy();
  await act(async () => { opt!.focus(); opt!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await act(async () => {});
}
const q = (id: string, scope: ParentNode = document) => scope.querySelector<HTMLElement>(`[data-testid="${id}"]`);

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
  // capabilities, quality and the last account update
  expect(q("wabiz-capabilities")?.textContent).toContain("catalog 555");
  expect(q("wabiz-capabilities")?.textContent).toContain("payments India");
  expect(q("wabiz-quality")?.className).toContain("text-warning");
  expect(q("wabiz-last-account-event")?.textContent).toContain("phone_number_quality_update");
});

test("generates the verify token and shows it once", async () => {
  await act(async () => root.render(<WaBusinessLive channel="shop" />));
  const generate = [...container.querySelectorAll("button")].find((b) => b.textContent === "Generate")!;
  await act(async () => { generate.click(); });
  expect(client.generateWaBusinessVerifyToken).toHaveBeenCalledWith("shop");
  expect(container.querySelector('[data-testid="wabiz-verify-token"]')?.textContent).toBe("generated-verify-token-123");
});

describe("approvals", () => {
  test("show the full preview and every component's value, then approve", async () => {
    await act(async () => root.render(<WaBusinessLive channel="shop" />));
    await act(async () => {});
    const row = q("wabiz-pending")!;
    expect(q("wabiz-pending-preview", row)?.textContent).toBe("Ciao Mario, il tuo ordine A-77 è partito");
    const values = q("wabiz-pending-values", row)!.textContent!;
    expect(values).toContain("https://cdn.example.com/box.jpg");
    expect(values).toContain("{{name}}Mario");
    expect(values).toContain("{{order}}A-77");
    expect(values).toContain("button 1A-77");
    expect(row.textContent).toContain("The customer asked");
    expect(row.textContent).toContain("utility");
    await click(q("wabiz-approve", row));
    expect(client.approveWaBusinessSend).toHaveBeenCalledWith("shop", "pending_1");
  });

  test("reject with a reason", async () => {
    await act(async () => root.render(<WaBusinessLive channel="shop" />));
    await act(async () => {});
    await click(q("wabiz-reject"));
    await type(q("wabiz-reject-reason"), "Wrong customer");
    await click(q("wabiz-reject-confirm"));
    expect(client.rejectWaBusinessSend).toHaveBeenCalledWith("shop", "pending_1", "Wrong customer");
  });
});

const msg = (over: Partial<WaBusinessMessage> & { id: string }): WaBusinessMessage => ({
  channel: "shop", waId: "393331234567", direction: "in", type: "text", status: "received", statuses: [], createdAt: `2026-11-26T10:00:${over.id.padStart(2, "0").slice(-2)}.000Z`, updatedAt: "", ...over,
});

describe("transcript", () => {
  test("renders media, interactive messages, templates, replies, orders, reactions, quotes, flags and statuses", async () => {
    live.media = {
      "11": { url: "blob:image", contentType: "image/jpeg" },
      "12": { url: "blob:voice", contentType: "audio/ogg" },
      "15": { url: "blob:sticker", contentType: "image/webp" },
    };
    const messages: WaBusinessMessage[] = [
      msg({ id: "10", text: "Ciao, avete la taglia M?", context: { forwarded: true }, reactions: [{ emoji: "👍", by: "business", at: "" }] }),
      msg({ id: "11", type: "image", text: "la foto", media: { kind: "image", mimeType: "image/jpeg", stored: "a.jpg", caption: "la foto" } }),
      msg({ id: "12", type: "voice", text: "Vorrei sapere gli orari", media: { kind: "audio", voice: true, mimeType: "audio/ogg", stored: "v.ogg" } }),
      msg({ id: "13", type: "video", media: { kind: "video", mimeType: "video/mp4", size: 2_000_000, stored: "v.mp4" } }),
      msg({ id: "14", type: "document", media: { kind: "document", mimeType: "application/pdf", filename: "invoice.pdf", stored: "i.pdf" } }),
      msg({ id: "15", type: "sticker", media: { kind: "sticker", mimeType: "image/webp", stored: "s.webp" } }),
      msg({ id: "16", type: "image", media: { kind: "image", mimeType: "image/png", size: 50_000_000, skipped: "over 16 MB" } }),
      msg({ id: "20", direction: "out", type: "buttons", status: "read", sentBy: "support", context: { id: "10" }, content: { type: "buttons", body: "Quale taglia?", buttons: [{ id: "s", title: "S" }, { id: "m", title: "M" }] } }),
      msg({ id: "21", direction: "out", type: "list", status: "delivered", content: { type: "list", body: "Scegli", button: "Opzioni", sections: [{ title: "Taglie", rows: [{ id: "l", title: "L", description: "Large" }] }] } }),
      msg({ id: "22", direction: "out", type: "cta_url", status: "sent", content: { type: "cta_url", body: "Il sito", displayText: "Apri", url: "https://shop.example.com" } }),
      msg({ id: "23", direction: "out", type: "flow", status: "sent", content: { type: "flow", body: "Prenota", cta: "Prenota ora", flowName: "booking" } }),
      msg({ id: "24", direction: "out", type: "product_list", status: "sent", content: { type: "product_list", header: "Novità", body: "Guarda", sections: [{ title: "Scarpe", productRetailerIds: ["sku-1", "sku-2"] }] } }),
      msg({ id: "25", direction: "out", type: "order_details", status: "sent", content: { type: "order_details", body: "Il tuo ordine", referenceId: "ORD-9", items: [{ name: "Maglia", amount: 20, quantity: 2 }], shipping: 5, paymentSettings: [{}] } }),
      msg({ id: "26", direction: "out", type: "template", status: "failed", template: { name: "order_update", language: "it", category: "UTILITY" }, text: "Ciao Mario", content: { components: { body: { name: "Mario" } } }, error: { code: 131047, title: "Re-engagement message" } }),
      msg({ id: "27", direction: "out", type: "location_request", status: "sent", content: { type: "location_request", body: "Dove sei?" } }),
      msg({ id: "30", type: "interactive.button_reply", context: { id: "20" }, content: { reply: "button", id: "m", title: "M", to: "20" } }),
      msg({ id: "31", type: "interactive.list_reply", content: { reply: "list", id: "l", title: "L", description: "Large" } }),
      msg({ id: "32", type: "interactive.nfm_reply", content: { reply: "flow", name: "flow", response: { date: "2026-12-01", people: 2, flow_token: "t" } } }),
      msg({ id: "33", type: "order", content: { order: { catalogId: "555", items: [{ productRetailerId: "sku-1", quantity: 1, itemPrice: 30, currency: "EUR" }], total: 30, currency: "EUR" } } }),
      msg({ id: "34", type: "payment", content: { payment: { referenceId: "ORD-9", status: "captured", amount: 45, currency: "INR" } } }),
      msg({ id: "35", type: "location", content: { latitude: 45.46, longitude: 9.19, name: "Duomo" } }),
      msg({ id: "36", text: "corretto", edited: { at: "" } }),
      msg({ id: "37", revoked: { at: "" } }),
    ];
    const onReact = vi.fn();
    await act(async () => root.render(<WaTranscript channel="shop" messages={[...messages].reverse()} onReply={vi.fn()} onReact={onReact} onMarkRead={vi.fn()} />));
    const bubbles = [...container.querySelectorAll<HTMLElement>('[data-testid="wabiz-message"]')];
    expect(bubbles.map((b) => b.dataset.type)[0]).toBe("text"); // oldest first
    const text = container.textContent ?? "";
    // media
    expect(container.querySelector<HTMLImageElement>('img[data-testid="wabiz-media-image"]')?.src).toBe("blob:image");
    expect(container.querySelector<HTMLAudioElement>("audio")?.getAttribute("src")).toBe("blob:voice");
    expect(q("wabiz-transcript")?.textContent).toContain("Vorrei sapere gli orari");
    expect(q("wabiz-media-video")?.textContent).toContain("Play video");
    expect(q("wabiz-media-document")?.textContent).toContain("invoice.pdf");
    expect(container.querySelector<HTMLImageElement>('img[data-testid="wabiz-media-sticker"]')?.src).toBe("blob:sticker");
    expect(q("wabiz-media-skipped")?.textContent).toContain("over 16 MB");
    // interactive messages sent
    expect(q("wabiz-out-buttons")?.textContent).toBe("SM");
    expect(q("wabiz-out-list")?.textContent).toContain("Large");
    expect(q("wabiz-out-cta")?.getAttribute("href")).toBe("https://shop.example.com");
    expect(q("wabiz-out-flow")?.textContent).toContain("Prenota ora");
    expect(q("wabiz-out-products")?.textContent).toContain("sku-1, sku-2");
    expect(q("wabiz-out-order")?.textContent).toContain("Total 45");
    expect(q("wabiz-out-location-request")).toBeTruthy();
    // template with its failure
    expect(q("wabiz-template")?.textContent).toContain("order_update");
    expect(q("wabiz-template")?.textContent).toContain("Ciao Mario");
    expect(q("wabiz-status-failed")?.textContent).toContain("Re-engagement message");
    // replies, order, payment, location
    expect(q("wabiz-reply-button")?.textContent).toContain("M");
    expect(q("wabiz-reply-list")?.textContent).toContain("Chose: L");
    expect(q("wabiz-reply-flow")?.textContent).toContain("people2");
    expect(q("wabiz-reply-flow")?.textContent).not.toContain("flow token");
    expect(q("wabiz-order")?.textContent).toContain("Total 30 EUR");
    expect(q("wabiz-payment")?.textContent).toContain("captured");
    expect(q("wabiz-location")?.textContent).toContain("Duomo");
    // quotes, flags, reactions, ticks
    expect(q("wabiz-quoted")?.textContent).toContain("Ciao, avete la taglia M?");
    expect(q("wabiz-forwarded")).toBeTruthy();
    expect(q("wabiz-edited")).toBeTruthy();
    expect(q("wabiz-revoked")).toBeTruthy();
    expect(text).toContain("This message was deleted.");
    expect(q("wabiz-reactions")?.textContent).toContain("👍");
    expect(q("wabiz-status-read")?.className).toContain("text-info");
    expect(q("wabiz-status-delivered")).toBeTruthy();
    // react from the picker
    await click(byText(/React/, bubbles[0]!));
    await click(container.querySelector<HTMLElement>('[aria-label="React ❤️"]'));
    expect(onReact).toHaveBeenCalledWith(expect.objectContaining({ id: "10" }), "❤️");
  });
});

describe("composer", () => {
  const props = (over: Partial<Parameters<typeof WaComposer>[0]> = {}) => ({
    windowOpen: true, templates: [] as WaBusinessTemplate[], send: vi.fn(async () => ({})), sendTemplate: vi.fn(async () => ({ status: "sent" as const, ids: ["w"] })), ...over,
  });

  test("buttons: checked against Meta's limits, then sent", async () => {
    const p = props();
    await act(async () => root.render(<WaComposer {...p} />));
    await click(byText("Buttons"));
    expect(q("wabiz-composer-problem")?.textContent).toBe("The body is required");
    expect(q("wabiz-composer-send")).toHaveProperty("disabled", true);
    await type(q("wabiz-composer-body"), "Confermi?");
    expect(q("wabiz-composer-problem")?.textContent).toBe("Button 1: the title is required");
    await type(q("wabiz-button-title-0"), "Sì, confermo l'ordine adesso");
    expect(q("wabiz-composer-problem")?.textContent).toContain("Button 1 title: at most 20 characters");
    await type(q("wabiz-button-title-0"), "Sì");
    expect(q("wabiz-composer-problem")).toBeNull();
    await click(q("wabiz-composer-send"));
    expect(p.send).toHaveBeenCalledWith({ type: "buttons", body: "Confermi?", buttons: [{ id: "yes", title: "Sì" }] }, undefined);
  });

  test("media: a file is checked against its kind and sent as base64; a quoted reply is kept", async () => {
    const p = props({ replyTo: msg({ id: "wamid.9", text: "Mandami la foto" }) });
    await act(async () => root.render(<WaComposer {...p} />));
    expect(q("wabiz-replying-to")?.textContent).toContain("Mandami la foto");
    await click(byText("Media"));
    const input = container.querySelector<HTMLInputElement>('[data-testid="wabiz-composer-file"]')!;
    const setFiles = async (f: File) => act(async () => {
      Object.defineProperty(input, "files", { value: [f], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await setFiles(new File([new Uint8Array(10)], "a.gif", { type: "image/gif" }));
    // a GIF goes out as a document (any type): fine; as an image it would be refused
    expect(q("wabiz-composer-problem")).toBeNull();
    await setFiles(new File([new Uint8Array(6 * 1024 * 1024)], "big.png", { type: "image/png" }));
    expect(q("wabiz-composer-problem")?.textContent).toContain("A WhatsApp image can be at most 5 MB");
    await setFiles(new File([new Uint8Array([104, 105])], "hi.png", { type: "image/png" }));
    await type(q("wabiz-composer-body"), "ecco");
    await click(q("wabiz-composer-send"));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(p.send).toHaveBeenCalledWith({ type: "media", kind: "image", caption: "ecco", replyTo: "wamid.9" }, { data: "aGk=", mimeType: "image/png", filename: "hi.png" });
  });

  test("list and link button validation", async () => {
    const p = props();
    await act(async () => root.render(<WaComposer {...p} />));
    await click(byText("List"));
    await type(q("wabiz-composer-body"), "Scegli");
    expect(q("wabiz-composer-problem")?.textContent).toBe("The list button's label is required");
    await type(q("wabiz-list-button"), "Opzioni");
    expect(q("wabiz-composer-problem")?.textContent).toBe("Every row needs an id and a title");
    await type(q("wabiz-row-title-0-0"), "Ritiro in negozio");
    expect(q("wabiz-composer-problem")).toBeNull();
    await click(byText("Link button"));
    await type(q("wabiz-composer-body"), "Il sito");
    await type(q("wabiz-cta-label"), "Apri");
    await type(q("wabiz-cta-url"), "http://insecure.example.com");
    expect(q("wabiz-composer-problem")?.textContent).toBe("The URL must be https");
  });

  test("outside the window only templates can be sent", async () => {
    const p = props({ windowOpen: false });
    await act(async () => root.render(<WaComposer {...p} />));
    expect(byText("Text")).toHaveProperty("disabled", true);
    expect(byText("Buttons")).toHaveProperty("disabled", true);
    expect(container.textContent).toContain("only approved templates can be sent");
    expect(container.textContent).toContain("No approved templates");
  });

  const orderTemplate: WaBusinessTemplate = {
    id: "t1", name: "order_update", language: "it", status: "APPROVED", category: "UTILITY", parameterFormat: "NAMED",
    components: [
      { type: "HEADER", format: "TEXT", text: "Ordine {{order}}" },
      { type: "BODY", text: "Ciao {{name}}, il tuo ordine {{order}} è partito." },
      { type: "FOOTER", text: "Grazie" },
      { type: "BUTTONS", buttons: [{ type: "URL", text: "Traccia", url: "https://shop.example.com/t/{{1}}" }, { type: "QUICK_REPLY", text: "Grazie" }] },
    ],
  };

  test("a template shows which values it needs, checks them and previews the filled text", async () => {
    const p = props({ windowOpen: false, templates: [orderTemplate, { ...orderTemplate, name: "draft_one", status: "PENDING" }] });
    await act(async () => root.render(<WaComposer {...p} />));
    await pick(q("wabiz-tpl-select"), /order_update/);
    expect(document.querySelectorAll('[role="option"]').length).toBe(0);
    const needs = q("wabiz-tpl-needs")!.textContent!;
    expect(needs).toContain("named body variables {{name}}, {{order}}");
    expect(needs).toContain("button 1 URL variable");
    expect(needs).toContain("header text");
    expect(q("wabiz-composer-problem")?.textContent).toBe("Still needed: Header text, Body {{name}}, Body {{order}}, Button 1 \"Traccia\": the URL's variable");
    await type(q("wabiz-tpl-header-text"), "A-77");
    await type(q("wabiz-tpl-body-name"), "Mario");
    await type(q("wabiz-tpl-body-order"), "A-77");
    expect(q("wabiz-composer-problem")?.textContent).toBe("Still needed: Button 1 \"Traccia\": the URL's variable");
    await type(q("wabiz-tpl-button-0"), "A-77");
    expect(q("wabiz-composer-problem")).toBeNull();
    expect(q("wabiz-tpl-preview")?.textContent).toContain("Ordine A-77");
    expect(q("wabiz-tpl-preview")?.textContent).toContain("Ciao Mario, il tuo ordine A-77 è partito.");
    await click(q("wabiz-composer-send"));
    expect(p.sendTemplate).toHaveBeenCalledWith({
      template: "order_update", language: "it",
      components: { header: { type: "text", text: "A-77" }, body: { name: "Mario", order: "A-77" }, buttons: [{ index: 0, text: "A-77" }] },
    });
  });

  test("template needs: positional, media header, carousel and OTP", () => {
    const auth = templateNeeds({ category: "AUTHENTICATION", components: [{ type: "BODY", text: "{{1}} is your code" }, { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: "Copy" }] }] });
    expect(auth.authentication).toBe(true);
    expect(templateInputProblems(auth, {})).toEqual(["Body {{1}}", "The one-time code"]);
    expect(templateInputProblems(auth, { otp: "123456" })).toEqual([]);
    expect(templatePreviewText(auth, { otp: "123456" })).toBe("123456 is your code");
    const media = templateNeeds({ category: "MARKETING", components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hi {{1}} {{2}}" }] });
    expect(media.named).toBe(false);
    expect(templateInputProblems(media, { body: ["a"] })).toEqual(["Header image (link or media id)", "Body {{2}}"]);
    expect(templateInputProblems(media, { header: { type: "image", link: "http://x" }, body: ["a", "b"] })).toEqual(["Header image: the link must be https"]);
    const carousel = templateNeeds({ category: "MARKETING", components: [{ type: "BODY", text: "Look" }, { type: "CAROUSEL", cards: [
      { components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Card {{1}}" }] },
      { components: [{ type: "HEADER", format: "VIDEO" }, { type: "BODY", text: "Card {{1}}" }] },
    ] }] });
    expect(carousel.cards).toHaveLength(2);
    expect(templateInputProblems(carousel, { carousel: [{ header: { type: "image", link: "https://a" }, body: ["x"] }] })).toEqual(["Card 2 video (link or media id)", "Card 2 body {{1}}"]);
    expect(outboundProblem({ type: "location", latitude: 95, longitude: 0 })).toBe("Latitude: −90 to 90");
  });
});

describe("contact sheet", () => {
  test("shows the conversation and blocks the contact after confirming", async () => {
    live.conversation = {
      contact: { channel: "shop", waId: "393331234567", name: "Mario", optIn: null, optOut: null, createdAt: "", updatedAt: "", marketing: { value: "stop", at: "" } },
      window: { open: true, closesAt: "2026-11-27T10:00:00.000Z" }, optedOut: false,
      messages: [msg({ id: "1", text: "Buongiorno" })],
    };
    const setOptIn = vi.fn(async () => {});
    await act(async () => root.render(
      <WaContactSheet channel="shop" contact={{ channel: "shop", waId: "393331234567", name: "Mario", optIn: null, optOut: null, createdAt: "", updatedAt: "" }}
        onOpenChange={vi.fn()} setOptIn={setOptIn} setBlocked={live.setBlocked as never} erase={vi.fn(async () => {})} />,
    ));
    const sheet = q("wabiz-contact-sheet")!;
    expect(sheet.textContent).toContain("Buongiorno");
    expect(sheet.textContent).toContain("Window open");
    expect(sheet.textContent).toContain("Marketing stopped in WhatsApp");
    expect(q("wabiz-composer", sheet)).toBeTruthy();
    await click(q("wabiz-block-toggle", sheet));
    expect(live.setBlocked).not.toHaveBeenCalled();
    await click(all().filter((b) => b.textContent?.trim() === "Block").at(-1));
    expect(live.setBlocked).toHaveBeenCalledWith("393331234567", true);
  });

  test("a blocked contact cannot be written to and can be unblocked", async () => {
    live.conversation = {
      contact: { channel: "shop", waId: "393331234567", optIn: null, optOut: null, createdAt: "", updatedAt: "", blocked: { at: "", by: "operator" } },
      window: { open: true }, optedOut: false, messages: [],
    };
    await act(async () => root.render(
      <WaContactSheet channel="shop" contact={{ channel: "shop", waId: "393331234567", optIn: null, optOut: null, createdAt: "", updatedAt: "" }}
        onOpenChange={vi.fn()} setOptIn={vi.fn(async () => {})} setBlocked={live.setBlocked as never} erase={vi.fn(async () => {})} />,
    ));
    expect(q("wabiz-contact-blocked")).toBeTruthy();
    expect(q("wabiz-composer-blocked")?.textContent).toContain("unblock it to write");
    await click(q("wabiz-block-toggle"));
    expect(live.setBlocked).toHaveBeenCalledWith("393331234567", false);
  });
});

describe("management panels", () => {
  test("profile: limits checked, then saved", async () => {
    await act(async () => root.render(<WaProfileEditor channel="shop" canUploadPhoto />));
    expect(container.querySelector<HTMLInputElement>('[data-testid="wabiz-profile-about"]')?.value).toBe("Hi");
    await type(q("wabiz-profile-about"), "x".repeat(140));
    expect(q("wabiz-profile-problem")?.textContent).toBe("About: at most 139 characters");
    await type(q("wabiz-profile-about"), "Aperti 9-18");
    await type(q("wabiz-profile-email"), "not-an-email");
    expect(q("wabiz-profile-problem")?.textContent).toBe("Email: not an address");
    await type(q("wabiz-profile-email"), "ciao@shop.example.com");
    await click(q("wabiz-profile-save"));
    expect(live.update).toHaveBeenCalledWith({ about: "Aperti 9-18", description: "", address: "", email: "ciao@shop.example.com", websites: [], vertical: "RETAIL" });
  });

  test("blocked list: unblock", async () => {
    await act(async () => root.render(<WaBlockedList channel="shop" />));
    await click(byText("Unblock", q("wabiz-blocked-393330000000")!));
    expect(live.unblock).toHaveBeenCalledWith(["393330000000"]);
  });

  test("phone number: details, PIN, and the webhook override", async () => {
    await act(async () => root.render(<WaPhonePanel channel="shop" status={status as never} />));
    expect(q("wabiz-phone-qualityRating")?.textContent).toBe("YELLOW");
    expect(q("wabiz-phone-messagingLimitTier")?.textContent).toBe("TIER_1K");
    expect(byText("Set PIN")).toHaveProperty("disabled", true);
    await type(q("wabiz-phone-pin"), "123456");
    await click(byText("Set PIN"));
    expect(live.phoneAction).toHaveBeenCalledWith({ action: "set_pin", pin: "123456" });
    await click(byText("Subscribe the app"));
    expect(live.phoneAction).toHaveBeenLastCalledWith({ action: "subscribe_app" });
    await click(q("wabiz-webhook-check"));
    expect(q("wabiz-webhook")?.textContent).toContain("https://app.example.com/hook");
    await click(byText("Point it here"));
    expect(live.setOverride).toHaveBeenCalledWith(true);
  });

  test("analytics: Meta's data points as a table", async () => {
    live.analytics = { analytics: { granularity: "DAY", data_points: [{ start: 1764115200, end: 1764201600, sent: 12, delivered: 11 }] } };
    expect(analyticsRows({ data: [{ data_points: [{ template_id: "1", sent: 3, clicked: [{ type: "url", count: 2 }] }] }] })).toEqual([{ template_id: "1", sent: 3, clicked: [{ type: "url", count: 2 }] }]);
    await act(async () => root.render(<WaAnalyticsPanel channel="shop" />));
    await click(q("wabiz-analytics-load"));
    const table = q("wabiz-analytics-table")!;
    expect(table.textContent).toContain("sent");
    expect(table.textContent).toContain("12");
    expect(table.textContent).toContain("11");
  });

  test("account updates and the template components editor's checks", async () => {
    await act(async () => root.render(<WaAccountEventsList channel="shop" />));
    expect(q("wabiz-account-event")?.textContent).toContain("order_update APPROVED");
    expect(componentsProblem("{")).toContain("Not valid JSON");
    expect(componentsProblem('[{"type":"FOOTER","text":"x"}]')).toBe("Every template has a BODY");
    expect(componentsProblem('[{"type":"BODY","text":"Hi {{1}}"}]')).toBeUndefined();
  });
});

describe("settings form", () => {
  test("ids, audience and categories without any secret field", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<WaBusinessFields config={{ type: "whatsapp-business", business: {} }} onChange={onChange} />));
    expect(container.querySelector('input[data-setup-field="accessToken"]')).toBeNull();
    const marketing = [...container.querySelectorAll("button")].find((b) => b.textContent === "marketing")!;
    await act(async () => { marketing.click(); });
    expect(onChange).toHaveBeenCalledWith({ business: { allowedCategories: ["UTILITY", "MARKETING"] } });
  });

  test("media, catalog, payments, marketing API, app id and shared-app routes", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<WaBusinessFields config={{ type: "whatsapp-business", phoneNumberId: "111111", business: {} }} onChange={onChange} />));
    await click(q("wabiz-media-download"));
    expect(onChange).toHaveBeenLastCalledWith({ business: { media: { download: false } } });
    await type(q("wabiz-media-max"), "8");
    expect(onChange).toHaveBeenLastCalledWith({ business: { media: { maxBytes: 8 * 1024 * 1024 } } });
    await type(q("wabiz-catalog"), "555666");
    expect(onChange).toHaveBeenLastCalledWith({ business: { catalogId: "555666" } });
    await type(q("wabiz-app-id"), "777888");
    expect(onChange).toHaveBeenLastCalledWith({ business: { appId: "777888" } });
    await click(q("wabiz-mm-api"));
    expect(onChange).toHaveBeenLastCalledWith({ business: { marketingMessagesApi: true } });
    await pick(q("wabiz-payments"), /India/);
    expect(onChange).toHaveBeenLastCalledWith({ business: { payments: { market: "IN" } } });
    const routes = q("wabiz-shared-routes")!;
    await click(byText(/Add a route/, routes));
    await type(routes.querySelector('[aria-label="Phone number id"]'), "111111");
    expect(routes.textContent).toContain("that is this channel's own number");
    await type(routes.querySelector('[aria-label="Phone number id"]'), "222333");
    await type(routes.querySelector('[aria-label="Webhook URL"]'), "https://other.ts.net/b/api/v1/channels/whatsapp-business/webhooks/shop");
    expect(onChange).toHaveBeenLastCalledWith({ business: { sharedApp: { routes: { "222333": "https://other.ts.net/b/api/v1/channels/whatsapp-business/webhooks/shop" } } } });
  });

  test("India payments ask for the payment configuration", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<WaBusinessFields config={{ type: "whatsapp-business", business: { payments: { market: "IN" } } }} onChange={onChange} />));
    await type(q("wabiz-payments-config"), "upi-main");
    expect(onChange).toHaveBeenLastCalledWith({ business: { payments: { market: "IN", configurationName: "upi-main" } } });
  });
});
