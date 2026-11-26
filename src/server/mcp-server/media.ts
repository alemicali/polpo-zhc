/**
 * Media: image generation and editing (the media primitive), the media log and its status.
 *
 * Scopes: polpo_image_generate and polpo_image_edit need work (a model call that costs money);
 * polpo_media_log and polpo_media_status need read. The card (polpo_image_show, media-cards.ts)
 * shows the images.
 */
import { z } from "zod";
import { READ, WRITE, apiError, apiGet, apiSend, dashboardLink, enc, looseObject, ok, qs, type McpDeps, type Register } from "./kit.js";

type Image = { index: number; path: string; file?: string; url?: string; mimeType: string; bytes: number; width?: number; height?: number };
type Result = { id: string; kind: string; model: string; usedFallback: boolean; costUsd: number; latencyMs: number; warnings: string[]; images: Image[] };
type Entry = {
  id: string; at: string; kind: string; status: "ok" | "error"; error?: string; model: string; prompt: string; size?: string; n: number; seed?: number;
  caller: { kind: string; id?: string; label?: string; by?: string; taskId?: string; missionId?: string }; costUsd: number; latencyMs: number; assets: Image[]; inputs?: string[];
};

const at = (iso?: string) => (iso ? iso.slice(0, 16).replace("T", " ") : "");
const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const mediaLine = (e: Entry) => `- ${e.id} ${at(e.at)} ${e.kind} · ${e.caller.kind}${e.caller.id ? ` ${e.caller.id}` : ""} · ${e.model} · $${e.costUsd.toFixed(4)}`
  + (e.status === "error" ? ` · ERROR ${e.error ?? ""}` : ` · ${e.assets.length} image${e.assets.length === 1 ? "" : "s"} · "${short(e.prompt)}"`);

const imageInput = z.union([
  z.string().describe("An https URL, a data: URL, a media image (img_…#index) or a file path of the project / .polpo"),
  z.object({ base64: z.string(), mimeType: z.string().optional() }),
  z.object({ url: z.string() }),
  z.object({ mediaId: z.string(), index: z.number().int().optional() }),
  z.object({ path: z.string() }),
]);

function resultText(deps: McpDeps, d: Result): string {
  return [
    ...d.images.map((i) => `- image ${i.index}: ${i.file ?? i.path} (${(i.bytes / 1024).toFixed(0)} KB${i.width && i.height ? `, ${i.width}x${i.height}` : ""})`),
    `(${d.model}${d.usedFallback ? ", the fallback model" : ""} · $${d.costUsd.toFixed(4)} · ${d.latencyMs} ms · media ${d.id})`,
    ...(d.warnings.length ? [`warnings: ${d.warnings.join("; ")}`] : []),
    `Show them with polpo_image_show (id ${d.id}); on the dashboard: ${dashboardLink(deps, `/media?image=${enc(d.id)}`)}`,
  ].join("\n");
}

const notConfigured = (deps: McpDeps) => `Set the image model in Settings → Media: ${dashboardLink(deps, "/config?section=media")}`;

export function registerMediaTools(tool: Register, deps: McpDeps): void {
  tool("core", "polpo_image_generate", {
    title: "Generate images",
    description: "Generate images from a prompt with the instance's image model (settings.imageModel, e.g. vercel-ai-gateway:openai/gpt-image-2) through Vercel AI Gateway. "
      + "Optional reference images guide style or subject. Every image is kept as an asset with its provenance (who asked, prompt, model, size, seed, cost) in the media log; "
      + "each call costs money. Show the result with polpo_image_show.",
    inputSchema: {
      prompt: z.string().min(1).describe("What to draw"),
      size: z.string().optional().describe("WIDTHxHEIGHT, e.g. 1024x1024, 1536x1024 (default: the model's)"),
      n: z.number().int().min(1).max(10).optional().describe("How many variants (default 1)"),
      model: z.string().optional().describe("Another image model, \"gateway:provider/model\""),
      reference_images: z.array(imageInput).max(16).optional().describe("Images the result should follow"),
      seed: z.number().int().optional().describe("For reproducible results (models that support it)"),
    },
    outputSchema: { id: z.string(), model: z.string(), costUsd: z.number(), images: z.array(looseObject), usedFallback: z.boolean().optional(), warnings: z.array(z.string()).optional() },
    annotations: { ...WRITE, openWorldHint: true },
  }, async ({ reference_images, ...args }) => {
    const r = await apiSend(deps, "POST", "/media/images", { ...args, ...(reference_images?.length ? { referenceImages: reference_images } : {}) });
    if (!r.ok) return apiError(r, "Generating the image", r.code === "NOT_CONFIGURED" || r.status === 409 ? notConfigured(deps) : undefined);
    const d = r.data as Result;
    return ok(resultText(deps, d), d as unknown as Record<string, unknown>);
  });

  tool("core", "polpo_image_edit", {
    title: "Edit an image",
    description: "Change an image with a prompt (or compose several), optionally inside a mask (its transparent areas are replaced), with the image model "
      + "(it must take image inputs, e.g. openai/gpt-image-2). The image: an https URL, a data: URL, an earlier generated image (img_…#index) or a project file. "
      + "The result is kept in the media log like a generation; each call costs money.",
    inputSchema: {
      image: z.union([imageInput, z.array(imageInput).max(16)]).describe("The image to change, or several to compose"),
      prompt: z.string().min(1).describe("What to change"),
      mask: imageInput.optional().describe("Transparent areas mark the region to replace (same size as the image)"),
      size: z.string().optional().describe("WIDTHxHEIGHT of the result (default: the model's)"),
      n: z.number().int().min(1).max(10).optional().describe("How many variants (default 1)"),
      model: z.string().optional().describe("Another image model, \"gateway:provider/model\""),
    },
    outputSchema: { id: z.string(), model: z.string(), costUsd: z.number(), images: z.array(looseObject), usedFallback: z.boolean().optional(), warnings: z.array(z.string()).optional() },
    annotations: { ...WRITE, openWorldHint: true },
  }, async (args) => {
    const r = await apiSend(deps, "POST", "/media/images/edits", args);
    if (!r.ok) return apiError(r, "Editing the image", r.code === "NOT_CONFIGURED" || r.status === 409 ? notConfigured(deps) : undefined);
    const d = r.data as Result;
    return ok(resultText(deps, d), d as unknown as Record<string, unknown>);
  });

  tool("core", "polpo_media_log", {
    title: "The media log",
    description: "The media log (every image request: who asked — the API, MCP, Polpo's chat, an agent and its task, a mission's image node — the prompt, the model, the size, "
      + "the seed, the cost, its images), newest first; with id, one request with its provenance; with nodes, missions' image nodes.",
    inputSchema: {
      id: z.string().optional().describe("One request (img_…)"),
      nodes: z.boolean().optional().describe("Missions' image nodes instead of the log"),
      caller: z.enum(["api", "mcp", "chat", "agent", "mission", "playground"]).optional().describe("Only requests by this kind of caller"),
      caller_id: z.string().optional().describe("An agent's name, a mission id…"),
      status: z.enum(["ok", "error"]).optional().describe("Only requests that succeeded (ok) or failed (error)"),
      limit: z.number().int().min(1).max(100).optional().describe("Default 20"),
      cursor: z.string().optional().describe("next_cursor of the previous page"),
    },
    outputSchema: { entries: z.array(looseObject).optional(), entry: looseObject.optional(), nodes: z.array(looseObject).optional(), next_cursor: z.string().nullable().optional(), total: z.number().optional() },
    annotations: READ,
  }, async ({ id, nodes, caller, caller_id, status, limit, cursor }) => {
    if (nodes) {
      const r = await apiGet(deps, "/media/nodes");
      if (!r.ok) return apiError(r, "Listing image nodes");
      const list = r.data as Array<{ group: string; node: string; status: string; mediaId?: string; error?: string }>;
      return ok(list.map((n) => `- ${n.group} → ${n.node}: ${n.status}${n.mediaId ? ` (media ${n.mediaId})` : ""}${n.error ? ` · ${n.error}` : ""}`).join("\n") || "No mission image node is running.", { nodes: list });
    }
    if (id) {
      const r = await apiGet(deps, `/media/images/${enc(id)}`);
      if (!r.ok) return apiError(r, "Reading the request");
      const e = r.data as Entry;
      return ok([
        mediaLine(e).slice(2),
        `prompt: ${e.prompt}`,
        ...(e.size ? [`size: ${e.size}`] : []), ...(e.seed !== undefined ? [`seed: ${e.seed}`] : []),
        `asked by: ${[e.caller.kind, e.caller.id, e.caller.label, e.caller.by].filter(Boolean).join(" · ")}`,
        ...(e.inputs?.length ? [`inputs: ${e.inputs.join(", ")}`] : []),
        ...e.assets.map((a) => `- image ${a.index}: .polpo/${a.path} (${a.mimeType}, ${(a.bytes / 1024).toFixed(0)} KB)`),
      ].join("\n"), { entry: e as unknown as Record<string, unknown> });
    }
    const r = await apiGet(deps, `/media/images${qs({ limit: limit ?? 20, cursor, caller, callerId: caller_id, status })}`);
    if (!r.ok) return apiError(r, "Listing the media log");
    const p = r.data as { entries: Entry[]; nextCursor?: string; total: number };
    return ok(`${p.entries.map(mediaLine).join("\n") || "No images yet (polpo_image_generate)."}${p.nextCursor ? `\n(more: cursor ${p.nextCursor})` : ""}`,
      { entries: p.entries as unknown as Record<string, unknown>[], next_cursor: p.nextCursor ?? null, total: p.total });
  });

  tool("core", "polpo_media_status", {
    title: "Media status",
    description: "The image model, its gateway, the fallback model, where the gateway's key comes from (never the key) and whether it works, the limits and the log's retention.",
    inputSchema: {},
    outputSchema: { status: looseObject },
    annotations: READ,
  }, async () => {
    const r = await apiGet(deps, "/media/status");
    if (!r.ok) return apiError(r, "Reading the media status");
    const s = r.data as { configured: boolean; model?: string; fallbackModel?: string; key?: { ok: boolean; detail: string }; error?: string; maxImages: number; retention: number; retentionDays: number };
    return ok([
      s.configured ? `image model: ${s.model}` : `no image model${s.error ? ` (${s.error})` : ""} — ${notConfigured(deps)}`,
      ...(s.fallbackModel ? [`fallback: ${s.fallbackModel}`] : []),
      ...(s.key ? [`key: ${s.key.ok ? "ok" : "not usable"} — ${s.key.detail}`] : []),
      `at most ${s.maxImages} images a request · log kept: ${s.retention} requests, ${s.retentionDays ? `${s.retentionDays} days` : "no age limit"}`,
      "image analysis: a chat turn with the image (the agent's or Polpo's vision-capable model)",
    ].join("\n"), { status: s as unknown as Record<string, unknown> });
  });
}
