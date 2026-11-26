/**
 * The media card (an MCP App shown by polpo_image_show): one image request's images (previews as
 * data: URLs, so the widget loads nothing) with their provenance — the prompt, the model, the size,
 * the seed, the cost, who asked — or the latest requests. Built from the REST shapes; the widget
 * (widgets/media-card) draws it, the text is for clients without MCP Apps.
 */
export interface MediaCardKey { createdAt: number; seq: number }
type Appearance = { light?: Record<string, string>; dark?: Record<string, string> };

export interface MediaCardImage { index: number; src?: string; width?: number; height?: number; mimeType: string; bytes: number }

export interface MediaCardItem {
  id: string; at: string; kind: string; caller: string; model: string; costUsd: number; latencyMs: number;
  status: "ok" | "error"; error?: string; prompt: string; size?: string; seed?: number; usedFallback?: boolean;
  images: MediaCardImage[];
}

export interface MediaListCard { kind: "media"; key: MediaCardKey; generatedAt: string; entries: MediaCardItem[]; total: number; link?: string; appearance?: Appearance }
export interface MediaDetailCard { kind: "image"; key: MediaCardKey; generatedAt: string; entry: MediaCardItem; link?: string; appearance?: Appearance }
export type MediaCard = MediaListCard | MediaDetailCard;

/** The REST shape the card reads (a media log entry). */
export interface MediaEntryShape {
  id: string; at: string; kind: string; caller: { kind: string; id?: string; label?: string; by?: string }; model: string; costUsd: number; latencyMs: number;
  status: "ok" | "error"; error?: string; prompt: string; size?: string; seed?: number; usedFallback?: boolean;
  assets: Array<{ index: number; mimeType: string; bytes: number; width?: number; height?: number }>;
}

/** Previews: index → data: URL (absent when it could not be read). */
export type MediaPreviews = Record<number, string | undefined>;

export function mediaCardItem(e: MediaEntryShape, previews: MediaPreviews = {}): MediaCardItem {
  return {
    id: e.id, at: e.at, kind: e.kind, caller: [e.caller.kind, e.caller.id ?? e.caller.label].filter(Boolean).join(" · "), model: e.model,
    costUsd: e.costUsd, latencyMs: e.latencyMs, status: e.status, ...(e.error ? { error: e.error } : {}), prompt: e.prompt.slice(0, 2000),
    ...(e.size ? { size: e.size } : {}), ...(e.seed !== undefined ? { seed: e.seed } : {}), ...(e.usedFallback ? { usedFallback: true } : {}),
    images: e.assets.map((a) => ({
      index: a.index, mimeType: a.mimeType, bytes: a.bytes, ...(a.width ? { width: a.width } : {}), ...(a.height ? { height: a.height } : {}),
      ...(previews[a.index] ? { src: previews[a.index] } : {}),
    })),
  };
}

export function buildMediaListCard(o: { entries: MediaCardItem[]; total: number; key: MediaCardKey; link?: string }): MediaListCard {
  return { kind: "media", key: o.key, generatedAt: new Date().toISOString(), entries: o.entries, total: o.total, ...(o.link ? { link: o.link } : {}) };
}

export function buildMediaDetailCard(o: { entry: MediaCardItem; key: MediaCardKey; link?: string }): MediaDetailCard {
  return { kind: "image", key: o.key, generatedAt: new Date().toISOString(), entry: o.entry, ...(o.link ? { link: o.link } : {}) };
}

/** The card as text (clients without MCP Apps). */
export function mediaCardText(card: MediaCard): string {
  const head = (e: MediaCardItem) => `${e.id} · ${e.at.slice(0, 16).replace("T", " ")} · ${e.caller} · ${e.model}${e.usedFallback ? " (fallback)" : ""} · $${e.costUsd.toFixed(4)}`;
  if (card.kind === "media") {
    if (!card.entries.length) return "No images yet (polpo_image_generate).";
    return card.entries.map((e) => `- ${head(e)}${e.status === "error" ? ` · ERROR ${e.error ?? ""}` : ` · ${e.images.length} image(s) · "${e.prompt.slice(0, 80)}"`}`).join("\n");
  }
  const e = card.entry;
  return [
    head(e), e.status === "error" ? `ERROR ${e.error ?? ""}` : "", `prompt: ${e.prompt}`,
    ...(e.size ? [`size: ${e.size}`] : []), ...(e.seed !== undefined ? [`seed: ${e.seed}`] : []),
    ...e.images.map((i) => `image ${i.index}: ${i.mimeType}, ${(i.bytes / 1024).toFixed(0)} KB${i.width && i.height ? `, ${i.width}x${i.height}` : ""}`),
  ].filter(Boolean).join("\n");
}
