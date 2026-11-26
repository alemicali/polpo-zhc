/**
 * The media card: an MCP App (interactive UI in Claude, ChatGPT…; text elsewhere) shown by
 * polpo_image_show — one image request's images with their provenance, or the latest requests.
 * The previews travel inside the card as data: URLs (the widget loads nothing). Its UI calls the
 * same tool to refresh and to open a request.
 */
import { z } from "zod";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildMediaDetailCard, buildMediaListCard, mediaCardItem, mediaCardText, type MediaCard, type MediaEntryShape, type MediaPreviews } from "../mcp-media-card.js";
import { MEDIA_CARD_HTML } from "../mcp-widgets.generated.js";
import { cardAppearance } from "./card-appearance.js";
import { READ, allowed, dashboardLink, enc, fail, looseObject, unwrap, type McpDeps, type McpPrincipal, type ToolScope, type ToolsetName } from "./kit.js";

export const MEDIA_CARD_URI = "ui://polpo/media-card.html";
let seq = 0;
const key = () => ({ createdAt: Date.now(), seq: ++seq });

/** A preview is at most this big inside the card (the full image when there is no thumbnail and it is small). */
const MAX_PREVIEW_BYTES = 1_500_000;

type Loaded = { ok: true; card: MediaCard } | { ok: false; error: string };

/** The previews of an entry's first images: the thumbnail (webp), as data: URLs. */
async function previews(deps: McpDeps, e: MediaEntryShape, max: number): Promise<MediaPreviews> {
  const out: MediaPreviews = {};
  for (const a of e.assets.slice(0, max)) {
    const r = await deps.api("GET", `/api/v1/media/images/${enc(e.id)}/${a.index}?thumb=1`).catch(() => undefined);
    if (!r || r.status !== 200 || !r.bytes?.byteLength || r.bytes.byteLength > MAX_PREVIEW_BYTES) continue;
    const type = r.headers.get("content-type") ?? a.mimeType;
    out[a.index] = `data:${type};base64,${Buffer.from(r.bytes).toString("base64")}`;
  }
  return out;
}

export async function loadMediaCard(deps: McpDeps, args: { id?: string; limit?: number }): Promise<Loaded> {
  let card: MediaCard;
  if (args.id) {
    const r = unwrap(await deps.api("GET", `/api/v1/media/images/${enc(args.id)}`));
    if (!r.ok) return { ok: false, error: r.status === 404 ? `There is no image request "${args.id}" (polpo_media_log).` : r.error };
    const e = r.data as MediaEntryShape;
    card = buildMediaDetailCard({ entry: mediaCardItem(e, await previews(deps, e, 4)), key: key(), link: dashboardLink(deps, `/media?image=${enc(args.id)}`) });
  } else {
    const r = unwrap(await deps.api("GET", `/api/v1/media/images?limit=${args.limit ?? 8}`));
    if (!r.ok) return { ok: false, error: r.error };
    const p = r.data as { entries: MediaEntryShape[]; total: number };
    const entries = [];
    for (const e of p.entries) entries.push(mediaCardItem(e, await previews(deps, e, 1)));
    card = buildMediaListCard({ entries, total: p.total, key: key(), link: dashboardLink(deps, "/media") });
  }
  const appearance = await cardAppearance(deps);
  return { ok: true, card: appearance ? { ...card, appearance } : card };
}

const output = z.object({
  kind: z.enum(["media", "image"]).optional(),
  key: z.object({ createdAt: z.number(), seq: z.number() }).passthrough().optional(),
  generatedAt: z.string().optional(),
  entry: looseObject.optional().describe("image view: the request's images (previews), prompt, model, size, seed, cost, caller"),
  entries: z.array(looseObject).optional().describe("media view: the latest requests with a preview each"),
  total: z.number().optional(),
}).passthrough();

export function registerMediaCards(server: McpServer, deps: McpDeps, enabled: ReadonlySet<ToolsetName>, principal: McpPrincipal, catalog?: ToolScope[]): void {
  if (!allowed(enabled, principal, "core", READ, catalog, ["polpo_image_show"])) return;

  registerAppResource(server, "Media card", MEDIA_CARD_URI, {
    description: "Generated images with their prompt, model and cost, or the latest image requests.",
  }, async () => ({
    contents: [{
      uri: MEDIA_CARD_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: MEDIA_CARD_HTML,
      _meta: { ui: { prefersBorder: false, csp: { resourceDomains: ["https://assets.claude.ai"] } } },
    }],
  }));

  registerAppTool(server, "polpo_image_show", {
    title: "Show images",
    description: "Show generated images as a card: the request's images with their prompt, model, size, seed, cost and who asked; without id, the latest image requests. "
      + "Use it right after polpo_image_generate or polpo_image_edit (pass its id) or when the person asks to see images.",
    inputSchema: {
      id: z.string().optional().describe("An image request id (img_…, from polpo_image_generate or polpo_media_log)"),
      limit: z.number().int().min(1).max(20).optional().describe("Latest requests shown (default 8)"),
    },
    annotations: { title: "Show images", ...READ },
    outputSchema: output,
    _meta: { ui: { resourceUri: MEDIA_CARD_URI } },
  }, async (args) => {
    const r = await loadMediaCard(deps, args);
    return r.ok ? { content: [{ type: "text" as const, text: mediaCardText(r.card) }], structuredContent: r.card as unknown as Record<string, unknown> } : fail(r.error);
  });
}
