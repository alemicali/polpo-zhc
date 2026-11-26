/**
 * The MCP WhatsApp Business card (widgets/wabiz-card/view.ts) rendered in a DOM from the server's
 * card (src/server/mcp-wabiz-card.ts): the overview (status, approvals with approve / reject,
 * conversations with thumbnails, one opening its transcript) and a transcript drawn as WhatsApp
 * bubbles (photos, voice notes, buttons, lists, links, flows, products, orders, reactions, ticks).
 */
import { describe, expect, it, vi } from "vitest";
import { renderView } from "../../widgets/wabiz-card/view";
import { buildWabizCard, type WabizMessageShape } from "../../src/server/mcp-wabiz-card";

const key = { createdAt: 1, seq: 1 };
const at = "2026-11-24T10:00:00Z";
const WA = "393331234567";
const status = { state: "receiving", audience: "customers", agent: "support", phone: { displayPhoneNumber: "+39 02 1234", qualityRating: "GREEN", messagingLimitTier: "TIER_1K" }, sentToday: 3, limits: { businessInitiatedPerDay: 50 }, pendingApprovals: 1, missing: [] };
const env = (card: unknown, extra: Record<string, unknown> = {}) => ({ card: card as never, locale: "en", full: false, canFullscreen: true, busy: false, superseded: false, ...extra });

const pendingMsg: WabizMessageShape = {
  id: "pending_1", direction: "out", type: "template", status: "pending_approval", createdAt: at, waId: WA, text: "Ciao Mario, il tuo ordine A1 è pronto.",
  template: { name: "order_update", language: "it" }, pending: { template: "order_update", language: "it", params: ["Mario", "A1"], requestedBy: "sales", requestedAt: at, reason: "order ready" },
};

describe("the WhatsApp Business card (MCP App)", () => {
  it("overview: status chips, approvals that call back with the decision, conversations with a thumbnail that open the transcript", () => {
    const root = document.createElement("div");
    const onDecide = vi.fn();
    const onShow = vi.fn();
    const card = buildWabizCard({
      channel: "shop", channels: ["shop"], status, key, pending: [pendingMsg],
      contacts: [{ waId: WA, name: "Mario", masked: "39•••••••567", window: { open: true }, optOut: null, blocked: null }, { waId: "393330000002", window: { open: false }, optOut: { at, keyword: "STOP" }, blocked: { at, by: "alice" } }],
      lastMessages: { [WA]: { id: "m1", direction: "in", type: "image", status: "received", createdAt: at, waId: WA, media: { kind: "image", stored: "a.jpg" } } },
      thumbs: { m1: "data:image/jpeg;base64,AA==" },
    });
    renderView(root, env(card, { onDecide, onShow }));
    expect(root.querySelector('[data-state="receiving"]')!.textContent).toBe("Receiving");
    expect(root.textContent).toContain("quality GREEN");
    expect(root.textContent).toContain("templates today 3/50");
    const pending = root.querySelector('[data-pending="pending_1"]')!;
    expect(pending.textContent).toContain("Ciao Mario, il tuo ordine A1 è pronto.");
    expect(pending.textContent).toContain("by sales");
    const [approve, reject] = [...pending.querySelectorAll("button")];
    approve!.click();
    reject!.click();
    expect(onDecide.mock.calls).toEqual([["pending_1", true], ["pending_1", false]]);
    const mario = root.querySelector(`[data-contact="${WA}"]`)!;
    expect((mario.querySelector("img.thumb") as HTMLImageElement).src).toContain("data:image/jpeg;base64,AA==");
    expect(mario.textContent).toContain("Window open");
    const other = root.querySelector('[data-contact="393330000002"]')!;
    expect(other.textContent).toContain("Opted out");
    expect(other.textContent).toContain("Blocked");
    (mario.querySelector(".link-btn") as HTMLButtonElement).click();
    expect(onShow).toHaveBeenCalledWith({ to: WA });
  });

  it("transcript: media, interactive messages, replies, reactions, ticks and deleted messages as WhatsApp bubbles; Italian strings", () => {
    const root = document.createElement("div");
    const messages: WabizMessageShape[] = [
      { id: "1", direction: "in", type: "image", status: "received", createdAt: at, waId: WA, media: { kind: "image", caption: "scontrino", stored: "a.jpg" }, reactions: [{ emoji: "👍", by: "business" }] },
      { id: "2", direction: "in", type: "voice", status: "received", createdAt: at, waId: WA, media: { kind: "audio", voice: true, stored: "v.ogg" } },
      { id: "3", direction: "out", type: "list", status: "read", createdAt: at, waId: WA, content: { type: "list", body: "Quando?", button: "Orari", sections: [{ rows: [{ id: "9", title: "9:00" }, { id: "15", title: "15:00" }] }] } },
      { id: "4", direction: "in", type: "interactive.list_reply", status: "received", createdAt: at, waId: WA, content: { reply: "list", id: "9", title: "9:00" }, context: { id: "3" } },
      { id: "5", direction: "out", type: "cta_url", status: "delivered", createdAt: at, waId: WA, content: { type: "cta_url", body: "Il sito", displayText: "Apri", url: "https://shop.example.com" } },
      { id: "6", direction: "out", type: "product_list", status: "failed", createdAt: at, waId: WA, content: { type: "product_list", body: "Novità", sections: [{ productRetailerIds: ["S1", "S2"] }] }, error: { code: 131026, title: "Undeliverable" } },
      { id: "7", direction: "in", type: "order", status: "received", createdAt: at, waId: WA, content: { order: { items: [{ quantity: 2, productRetailerId: "S1", itemPrice: 9, currency: "EUR" }], total: 18, currency: "EUR" } } },
      { id: "8", direction: "in", type: "text", status: "received", createdAt: at, waId: WA, text: "x", revoked: { at } },
    ];
    const card = buildWabizCard({
      channel: "shop", channels: ["shop"], status, key, pending: [], contacts: [], lastMessages: {}, thumbs: { "1": "data:image/jpeg;base64,AA==" },
      conversation: { contact: { waId: WA, name: "Mario", masked: "39•••••••567" }, window: { open: true, closesAt: at }, optedOut: false, messages: [...messages].reverse() },
    });
    const onShow = vi.fn();
    renderView(root, env(card, { onShow }));
    const bubble = (id: string) => root.querySelector(`[data-message="${id}"]`)!;
    expect((bubble("1").querySelector("img.photo") as HTMLImageElement).alt).toBe("scontrino");
    expect(bubble("1").querySelector(".reactions")!.textContent).toBe("👍");
    expect(bubble("2").querySelector('[data-media="voice"]')!.textContent).toBe("Voice message");
    expect([...bubble("3").querySelectorAll(".rows li")].map((li) => li.textContent)).toEqual(["9:00", "15:00"]);
    expect(bubble("3").querySelector(".tick")!.textContent).toBe("✓✓ read");
    expect(bubble("4").querySelector(".reply")!.textContent).toBe("9:00");
    expect(bubble("5").querySelector('[data-kind="link"]')!.textContent).toBe("↗ Apri");
    expect(bubble("6").textContent).toContain("Products: S1, S2");
    expect(bubble("6").textContent).toContain("131026 Undeliverable");
    expect(bubble("7").querySelector('[data-media="order"]')!.textContent).toBe("Order: 2× S1 9 EUR · Total 18 EUR");
    expect(bubble("8").textContent).toContain("Deleted");
    (([...root.querySelectorAll("button")].find((b) => b.textContent === "Conversations")) as HTMLButtonElement).click();
    expect(onShow).toHaveBeenCalledWith({});
    renderView(root, env(card, { locale: "it-IT" }));
    expect(root.querySelector('[data-message="2"]')!.textContent).toContain("Messaggio vocale");
    expect(root.textContent).toContain("Finestra aperta");
  });
});
