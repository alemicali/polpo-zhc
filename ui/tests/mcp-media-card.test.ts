/**
 * The MCP media card (widgets/media-card/view.ts) rendered in a DOM from the server's cards
 * (src/server/mcp-media-card.ts): one request's images (data: previews only) with its provenance;
 * the latest requests, one opening its card.
 */
import { describe, expect, it, vi } from "vitest";
import { renderView } from "../../widgets/media-card/view";
import { buildMediaDetailCard, buildMediaListCard, mediaCardItem, mediaCardText, type MediaEntryShape } from "../../src/server/mcp-media-card";

const key = { createdAt: 1, seq: 1 };
const PREVIEW = "data:image/webp;base64,UklGRg==";
const entry: MediaEntryShape = {
  id: "img_0123456789ab", at: "2026-11-26T10:00:00Z", kind: "generate", caller: { kind: "agent", id: "designer" }, model: "vercel-ai-gateway:openai/gpt-image-2",
  costUsd: 0.042, latencyMs: 9000, status: "ok", prompt: "A lighthouse at dawn", size: "1024x1024", seed: 7,
  assets: [{ index: 0, mimeType: "image/png", bytes: 204800, width: 1024, height: 1024 }, { index: 1, mimeType: "image/png", bytes: 102400 }],
};
const env = (card: unknown, extra: Record<string, unknown> = {}) => ({ card: card as never, locale: "en", full: false, canFullscreen: true, busy: false, superseded: false, ...extra });

describe("the media card (MCP App)", () => {
  it("one request: its previews, prompt, model, cost and who asked; only data: images are shown", () => {
    const root = document.createElement("div");
    const card = buildMediaDetailCard({ entry: mediaCardItem(entry, { 0: PREVIEW, 1: "https://evil.test/x.png" }), key });
    renderView(root, env(card));
    const imgs = [...root.querySelectorAll("figure img")] as HTMLImageElement[];
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual([PREVIEW]);
    expect(root.querySelector('[data-image="1"]')!.textContent).toContain("No preview");
    expect(root.textContent).toContain("A lighthouse at dawn");
    expect(root.textContent).toContain("vercel-ai-gateway:openai/gpt-image-2 · $0.0420");
    expect(root.textContent).toContain("agent · designer");
    expect(root.textContent).toContain("seed 7");
    expect(mediaCardText(card)).toContain("prompt: A lighthouse at dawn");
  });

  it("the list opens a request; failures say so; Italian strings", () => {
    const root = document.createElement("div");
    const onShow = vi.fn();
    const list = buildMediaListCard({ entries: [mediaCardItem(entry, { 0: PREVIEW }), mediaCardItem({ ...entry, id: "img_ffffffffffff", status: "error", error: "No image model", assets: [] })], total: 2, key });
    renderView(root, env(list, { onShow }));
    const row = root.querySelector('[data-entry="img_0123456789ab"]')!;
    expect(row.querySelector("img.thumb")!.getAttribute("src")).toBe(PREVIEW);
    expect(root.querySelector('[data-entry="img_ffffffffffff"]')!.textContent).toContain("Failed");
    (row.querySelector(".link-btn") as HTMLButtonElement).click();
    expect(onShow).toHaveBeenCalledWith({ id: "img_0123456789ab" });
    renderView(root, env(list, { locale: "it-IT" }));
    expect(root.textContent).toContain("Immagini");
    expect(root.textContent).toContain("Fallita");
  });
});
