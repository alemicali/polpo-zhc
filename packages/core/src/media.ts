/**
 * Media: image generation and editing as a primitive, for every surface (REST, MCP, Polpo's chat,
 * the agents' image_generate / image_edit tools, missions' and playbooks' image nodes).
 *
 *   generateImage({ prompt, size?, n?, model?, referenceImages?, seed? }) → images saved as assets
 *   editImage({ image, prompt, mask?, size?, n?, model? })                → the same
 *
 * The model is `settings.imageModel` ("gateway:provider/model", e.g.
 * "vercel-ai-gateway:openai/gpt-image-2"), with an optional fallback model (`settings.media`).
 * The gateway is reached through the shared gateway resolver (gateways.ts: base URL, the key from
 * the vault entry or the gateway's env var, the hosts the key may go to). The wire shape is the
 * OpenAI-compatible Images API that Vercel AI Gateway documents:
 *
 *   POST {base}/images/generations  { model, prompt, n, size?, response_format: "b64_json", seed?, providerOptions? }
 *   POST {base}/images/edits        { model, prompt, images: [{ image_url }], mask?: { image_url }, n?, size? }
 *     → { data: [{ b64_json | url, revised_prompt? }], usage?, providerMetadata?.gateway.cost }
 *
 * Generating with reference images goes to the edits endpoint (the documented way to compose
 * several source images). Pure: no Node API, no network. The service (src/media/service.ts) calls.
 */
import type { GatewayCredential } from "./gateways.js";
import { normalizeVaultRef } from "./vault-ref.js";

// ── Settings ─────────────────────────────────────────────────────────

export const DEFAULT_IMAGE_GATEWAY = "vercel-ai-gateway";

export const MEDIA_LIMITS = {
  maxPromptChars: 32_000,
  maxImages: 10,
  defaultMaxImages: 4,
  maxReferenceImages: 16,
  /** One input image (reference, source, mask), decoded. */
  maxInputBytes: 20 * 1024 * 1024,
  /** One generated image, decoded. */
  maxOutputBytes: 50 * 1024 * 1024,
  defaultRetention: 1000,
  maxRetention: 20_000,
  defaultRetentionDays: 90,
  /** The prompt kept in the log. */
  storedPromptChars: 8_000,
} as const;

/** settings.media: the fallback model, the gateway key, limits and the media log's retention. */
export interface MediaSettings extends GatewayCredential {
  /** Tried once when the image model fails (an error, not a refusal of the request): "gateway:model". */
  fallbackModel?: string;
  /** Images one request may ask for (default 4, at most 10). */
  maxImages?: number;
  /** Media log entries kept (their images too; default 1000). */
  retention?: number;
  /** Days entries are kept (default 90; 0: no age limit). */
  retentionDays?: number;
}

/** An image model, resolved: the gateway and its model id, the key's vault entry. */
export interface ImageModelConfig extends GatewayCredential {
  gateway: string;
  model: string;
}

export class MediaError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "INVALID", readonly problems?: string[]) {
    super(message);
    this.name = "MediaError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

/** "gateway:model" (a model without a gateway goes to Vercel AI Gateway). Undefined when not set. */
export function parseImageModel(setting: unknown, where = "imageModel"): Pick<ImageModelConfig, "gateway" | "model"> | undefined {
  if (setting === undefined || setting === null || setting === "") return undefined;
  if (typeof setting !== "string") throw new MediaError(`${where} must be "gateway:provider/model", e.g. ${DEFAULT_IMAGE_GATEWAY}:openai/gpt-image-2`);
  const s = setting.trim();
  // "provider/model" has no gateway; "gateway:provider/model" has one (the gateway never contains "/")
  const i = s.indexOf(":");
  const gateway = i > 0 && !s.slice(0, i).includes("/") ? s.slice(0, i) : DEFAULT_IMAGE_GATEWAY;
  const model = (i > 0 && !s.slice(0, i).includes("/") ? s.slice(i + 1) : s).trim();
  if (!model) throw new MediaError(`${where} needs a model, e.g. ${DEFAULT_IMAGE_GATEWAY}:openai/gpt-image-2`);
  return { gateway, model };
}

export function formatImageModel(c: Pick<ImageModelConfig, "gateway" | "model">): string {
  return `${c.gateway}:${c.model}`;
}

/** Keep only well-formed media settings (unknown keys dropped). */
export function normalizeMediaSettings(raw: unknown): MediaSettings | undefined {
  if (!isObj(raw)) return undefined;
  const out: MediaSettings = {};
  if (str(raw.fallbackModel)) out.fallbackModel = str(raw.fallbackModel);
  const ref = raw.credentialRef === undefined || raw.credentialRef === null ? undefined : normalizeVaultRef(raw.credentialRef);
  if (ref) out.credentialRef = ref;
  if (str(raw.credentialField)) out.credentialField = str(raw.credentialField);
  const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);
  const max = int(raw.maxImages);
  if (max !== undefined && max >= 1) out.maxImages = Math.min(max, MEDIA_LIMITS.maxImages);
  const retention = int(raw.retention);
  if (retention !== undefined && retention >= 1) out.retention = Math.min(retention, MEDIA_LIMITS.maxRetention);
  const days = int(raw.retentionDays);
  if (days !== undefined) out.retentionDays = days;
  return Object.keys(out).length ? out : undefined;
}

// ── Requests ─────────────────────────────────────────────────────────

/** An input image: inline bytes (base64 or a data: URL), an https URL, or an earlier generated image. */
export type ImageInput =
  | { base64: string; mimeType?: string }
  | { url: string }
  | { mediaId: string; index?: number }
  /** A file of the workspace or of .polpo (resolved by the service; agents give their own files). */
  | { path: string };

export interface GenerateImageInput {
  prompt: string;
  /** "WIDTHxHEIGHT" (e.g. 1024x1024) or "auto". */
  size?: string;
  /** How many variants (default 1). */
  n?: number;
  /** Another model than settings.imageModel: "gateway:provider/model". */
  model?: string;
  /** Images the result should follow (style, subject…): the request goes to the edits endpoint. */
  referenceImages?: ImageInput[];
  seed?: number;
  /** Passed through to the gateway (e.g. { blackForestLabs: { outputFormat: "jpeg" } }). */
  providerOptions?: Record<string, unknown>;
}

export interface EditImageInput {
  /** The image to change (or several, composed). */
  image: ImageInput | ImageInput[];
  prompt: string;
  /** Its transparent areas mark the region to replace (same size as the image). */
  mask?: ImageInput;
  size?: string;
  n?: number;
  model?: string;
  providerOptions?: Record<string, unknown>;
}

export interface ValidImageRequest {
  kind: "generate" | "edit";
  prompt: string;
  size?: string;
  n: number;
  model?: Pick<ImageModelConfig, "gateway" | "model">;
  images: ImageInput[];
  mask?: ImageInput;
  seed?: number;
  providerOptions?: Record<string, unknown>;
}

const SIZE = /^(auto|\d{2,5}x\d{2,5})$/;

function imageInput(raw: unknown, where: string, problems: string[]): ImageInput | undefined {
  if (typeof raw === "string") {
    const s = raw.trim();
    if (/^https:\/\//i.test(s)) return { url: s };
    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(s)) return { base64: s };
    if (/^img_[a-z0-9]+(#\d+)?$/.test(s)) { const [id, idx] = s.split("#"); return { mediaId: id, ...(idx ? { index: Number(idx) } : {}) }; }
    if (s) return { path: s };
    problems.push(`${where} is empty`);
    return undefined;
  }
  if (!isObj(raw)) { problems.push(`${where} must be { base64, mimeType? }, { url }, { mediaId, index? } or { path }`); return undefined; }
  if (str(raw.base64)) return { base64: str(raw.base64)!, ...(str(raw.mimeType) ? { mimeType: str(raw.mimeType) } : {}) };
  if (str(raw.url)) {
    if (!/^https:\/\//i.test(str(raw.url)!)) { problems.push(`${where}.url must be https`); return undefined; }
    return { url: str(raw.url)! };
  }
  if (str(raw.mediaId)) {
    const index = num(raw.index);
    return { mediaId: str(raw.mediaId)!, ...(index !== undefined ? { index: Math.max(0, Math.floor(index)) } : {}) };
  }
  if (str(raw.path)) return { path: str(raw.path)! };
  problems.push(`${where} must be { base64, mimeType? }, { url }, { mediaId, index? } or { path }`);
  return undefined;
}

function common(raw: Record<string, unknown>, problems: string[], maxImages: number) {
  const prompt = str(raw.prompt);
  if (!prompt) problems.push("prompt is required");
  else if (prompt.length > MEDIA_LIMITS.maxPromptChars) problems.push(`prompt is longer than ${MEDIA_LIMITS.maxPromptChars} characters`);
  const size = str(raw.size);
  if (size && !SIZE.test(size)) problems.push(`size must be "WIDTHxHEIGHT" (e.g. 1024x1024) or "auto"`);
  const nRaw = raw.n === undefined || raw.n === null ? 1 : num(raw.n);
  if (nRaw === undefined || !Number.isInteger(nRaw) || nRaw < 1 || nRaw > maxImages) problems.push(`n must be a whole number from 1 to ${maxImages}`);
  let model: ValidImageRequest["model"];
  try { model = parseImageModel(raw.model, "model"); } catch (err) { problems.push((err as Error).message); }
  const providerOptions = raw.providerOptions === undefined ? undefined : isObj(raw.providerOptions) ? raw.providerOptions : (problems.push("providerOptions must be an object"), undefined);
  return { prompt: prompt ?? "", ...(size ? { size } : {}), n: nRaw ?? 1, ...(model ? { model } : {}), ...(providerOptions ? { providerOptions } : {}) };
}

/** Check a generate request (400 with every problem). */
export function validateGenerateImageInput(raw: unknown, opts: { maxImages?: number } = {}): ValidImageRequest {
  if (!isObj(raw)) throw new MediaError("The request must be an object { prompt, size?, n?, model?, referenceImages?, seed? }");
  const problems: string[] = [];
  const base = common(raw, problems, opts.maxImages ?? MEDIA_LIMITS.defaultMaxImages);
  const images: ImageInput[] = [];
  if (raw.referenceImages !== undefined) {
    if (!Array.isArray(raw.referenceImages)) problems.push("referenceImages must be a list");
    else if (raw.referenceImages.length > MEDIA_LIMITS.maxReferenceImages) problems.push(`at most ${MEDIA_LIMITS.maxReferenceImages} referenceImages`);
    else raw.referenceImages.forEach((r, i) => { const x = imageInput(r, `referenceImages[${i}]`, problems); if (x) images.push(x); });
  }
  const seed = raw.seed === undefined || raw.seed === null ? undefined : num(raw.seed);
  if (raw.seed !== undefined && raw.seed !== null && (seed === undefined || !Number.isInteger(seed))) problems.push("seed must be a whole number");
  if (problems.length) throw new MediaError(`Invalid image request: ${problems.join("; ")}`, 400, "INVALID", problems);
  return { kind: images.length ? "edit" : "generate", ...base, images, ...(seed !== undefined ? { seed } : {}) };
}

/** Check an edit request (400 with every problem). */
export function validateEditImageInput(raw: unknown, opts: { maxImages?: number } = {}): ValidImageRequest {
  if (!isObj(raw)) throw new MediaError("The request must be an object { image, prompt, mask?, size?, n?, model? }");
  const problems: string[] = [];
  const base = common(raw, problems, opts.maxImages ?? MEDIA_LIMITS.defaultMaxImages);
  const list = Array.isArray(raw.image) ? raw.image : raw.image === undefined || raw.image === null ? [] : [raw.image];
  if (!list.length) problems.push("image is required (the image to change)");
  if (list.length > MEDIA_LIMITS.maxReferenceImages) problems.push(`at most ${MEDIA_LIMITS.maxReferenceImages} images`);
  const images = list.map((r, i) => imageInput(r, Array.isArray(raw.image) ? `image[${i}]` : "image", problems)).filter((x): x is ImageInput => !!x);
  const mask = raw.mask === undefined || raw.mask === null ? undefined : imageInput(raw.mask, "mask", problems);
  if (problems.length) throw new MediaError(`Invalid image edit: ${problems.join("; ")}`, 400, "INVALID", problems);
  return { kind: "edit", ...base, images, ...(mask ? { mask } : {}) };
}

/** POST {base}/images/generations: the OpenAI-compatible body. */
export function imageGenerationBody(model: string, req: Pick<ValidImageRequest, "prompt" | "n" | "size" | "seed" | "providerOptions">): Record<string, unknown> {
  return {
    model, prompt: req.prompt, n: req.n, response_format: "b64_json",
    ...(req.size && req.size !== "auto" ? { size: req.size } : {}),
    ...(req.seed !== undefined ? { seed: req.seed } : {}),
    ...(req.providerOptions ? { providerOptions: req.providerOptions } : {}),
  };
}

/** POST {base}/images/edits (JSON form): images and mask as data: or https URLs. */
export function imageEditBody(model: string, req: Pick<ValidImageRequest, "prompt" | "n" | "size" | "seed" | "providerOptions">, images: string[], mask?: string): Record<string, unknown> {
  return {
    model, prompt: req.prompt, n: req.n, response_format: "b64_json",
    images: images.map((image_url) => ({ image_url })),
    ...(mask ? { mask: { image_url: mask } } : {}),
    ...(req.size && req.size !== "auto" ? { size: req.size } : {}),
    ...(req.seed !== undefined ? { seed: req.seed } : {}),
    ...(req.providerOptions ? { providerOptions: req.providerOptions } : {}),
  };
}

// ── Responses ────────────────────────────────────────────────────────

export interface ImageUsage { inputTokens?: number; outputTokens?: number; images?: number }

export interface ParsedImage {
  /** Base64 bytes, or a URL to download (when the gateway answered with one). */
  b64?: string;
  url?: string;
  mimeType?: string;
  revisedPrompt?: string;
}

/**
 * Read an Images API response: { data: [{ b64_json | url, revised_prompt? }], usage?, cost or
 * providerMetadata.gateway.cost }. Throws a MediaError (502) when it holds no image.
 */
export function parseImagesResponse(body: unknown): { images: ParsedImage[]; model?: string; usage: ImageUsage; costUsd?: number; warnings: string[] } {
  if (!isObj(body)) throw new MediaError("The image model answered something that is not JSON", 502, "BAD_ANSWER");
  const data = Array.isArray(body.data) ? body.data : Array.isArray(body.images) ? body.images : [];
  const images: ParsedImage[] = [];
  for (const d of data) {
    if (typeof d === "string") { images.push(d.startsWith("data:") ? splitDataUrl(d) : { b64: d }); continue; }
    if (!isObj(d)) continue;
    const b64 = str(d.b64_json) ?? str(d.base64);
    const url = str(d.url);
    const revisedPrompt = str(d.revised_prompt);
    const mimeType = str(d.mime_type) ?? str(d.mediaType);
    if (b64) images.push({ ...(b64.startsWith("data:") ? splitDataUrl(b64) : { b64 }), ...(revisedPrompt ? { revisedPrompt } : {}), ...(mimeType ? { mimeType } : {}) });
    else if (url?.startsWith("data:")) images.push({ ...splitDataUrl(url), ...(revisedPrompt ? { revisedPrompt } : {}) });
    else if (url) images.push({ url, ...(revisedPrompt ? { revisedPrompt } : {}), ...(mimeType ? { mimeType } : {}) });
  }
  if (!images.length) throw new MediaError("The image model returned no image", 502, "BAD_ANSWER");
  const u = isObj(body.usage) ? body.usage : {};
  const usage: ImageUsage = {};
  const inTok = num(u.input_tokens ?? u.inputTokens ?? u.prompt_tokens);
  const outTok = num(u.output_tokens ?? u.outputTokens ?? u.completion_tokens);
  if (inTok !== undefined) usage.inputTokens = inTok;
  if (outTok !== undefined) usage.outputTokens = outTok;
  usage.images = images.length;
  const meta = isObj(body.providerMetadata) ? body.providerMetadata : isObj(body.provider_metadata) ? body.provider_metadata : undefined;
  const gw = meta && isObj(meta.gateway) ? meta.gateway : undefined;
  const cost = num(gw?.cost ?? body.cost ?? u.cost);
  const warnings = Array.isArray(body.warnings)
    ? body.warnings.map((w) => (isObj(w) ? str(w.message) ?? str(w.details) ?? (str(w.feature) ? `unsupported: ${str(w.feature)}` : undefined) : str(w))).filter((w): w is string => !!w)
    : [];
  return { images, ...(str(body.model) ? { model: str(body.model) } : {}), usage, ...(cost !== undefined ? { costUsd: cost } : {}), warnings };
}

/** "data:image/png;base64,AAA" → { b64, mimeType }. */
export function splitDataUrl(url: string): { b64: string; mimeType?: string } {
  const m = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s.exec(url);
  return m ? { b64: m[2], ...(m[1] ? { mimeType: m[1] } : {}) } : { b64: url };
}

/** The image type from its first bytes (PNG, JPEG, WebP, GIF), else undefined. */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  return undefined;
}

export const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

// ── The media log ────────────────────────────────────────────────────

/** Who asked for an image. */
export interface MediaCaller {
  kind: "api" | "mcp" | "chat" | "agent" | "mission" | "playground";
  /** The agent, mission… */
  id?: string;
  label?: string;
  /** The person, when known. */
  by?: string;
  /** Where it was asked from. */
  taskId?: string;
  missionId?: string;
  sessionId?: string;
  triggerId?: string;
}

/** One generated image of a request (a variant). */
export interface MediaAsset {
  index: number;
  /** Relative to the .polpo directory: media/images/<id>/<index>.<ext>. */
  path: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
  sha256: string;
  revisedPrompt?: string;
  /** A small preview (webp, at most 512 px), when it could be made. */
  thumbPath?: string;
}

/** A request in the media log: its provenance and its images (the variants, grouped). */
export interface MediaLogEntry {
  id: string;
  at: string;
  kind: "generate" | "edit";
  caller: MediaCaller;
  status: "ok" | "error";
  error?: string;
  /** "gateway:model" that answered (the fallback's when it answered). */
  model: string;
  gateway?: string;
  /** The fallback answered because the image model failed. */
  usedFallback?: boolean;
  prompt: string;
  promptTruncated?: boolean;
  size?: string;
  n: number;
  seed?: number;
  /** The inputs (references, sources, mask) as described, never their bytes. */
  inputs?: string[];
  latencyMs: number;
  costUsd: number;
  usage: ImageUsage;
  warnings?: string[];
  assets: MediaAsset[];
}

export type MediaLogSummary = MediaLogEntry;

export interface MediaLogPage { entries: MediaLogSummary[]; nextCursor?: string; total: number }

const MEDIA_ID = /^img_[a-z0-9]{6,40}$/;
export const isMediaId = (id: string): boolean => MEDIA_ID.test(id);

/** The API path of one image of an entry. */
export function mediaImageApiPath(id: string, index: number, opts: { thumb?: boolean } = {}): string {
  return `/api/v1/media/images/${id}/${index}${opts.thumb ? "?thumb=1" : ""}`;
}

/** A short line about an entry, for tools and notes. */
export function describeMediaEntry(e: Pick<MediaLogEntry, "id" | "model" | "assets" | "costUsd" | "status" | "error">): string {
  if (e.status === "error") return `${e.id}: failed (${e.error ?? "error"})`;
  return `${e.id}: ${e.assets.length} image${e.assets.length === 1 ? "" : "s"} · ${e.model} · $${e.costUsd.toFixed(4)}`;
}

// ── Image nodes in missions and playbooks ────────────────────────────

/**
 * An image node of a mission: once every after task has finished, an image is generated from the
 * prompt (a template with {{tasks.<title>}}, that task's result); the tasks in `forTasks` wait for
 * it and get the image's files in their description.
 */
export interface MissionImage {
  name: string;
  afterTasks: string[];
  /** The prompt: a template with {{tasks.<title>}} (that task's result). */
  prompt: string;
  /** The tasks that wait for the image and receive it. */
  forTasks: string[];
  size?: string;
  n?: number;
  /** Another model than settings.imageModel ("gateway:provider/model"). */
  model?: string;
  /** The generation failed: "continue" (default: the tasks go on, told it failed) or "fail" (they fail). */
  onError?: "continue" | "fail";
}

export interface ImageNodeState {
  group: string;
  missionId?: string;
  node: string;
  status: "generating" | "done" | "failed";
  mediaId?: string;
  /** Absolute paths of the generated images. */
  files?: string[];
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface ImageNodeStore {
  load(): Promise<Record<string, ImageNodeState>>;
  save(state: Record<string, ImageNodeState>): Promise<void>;
}

/** Generates a node's image (the media service, wired by the server). */
export type MissionImager = (req: {
  prompt: string; size?: string; n?: number; model?: string;
  caller: { id?: string; label: string; missionId?: string };
}) => Promise<{ id: string; files: string[]; urls: string[]; model: string }>;

/** The node's prompt: its template with {{tasks.<title>}} replaced by that task's result. */
export function renderImageNodePrompt(node: Pick<MissionImage, "prompt">, tasks: Array<{ title: string; status: string; result?: { stdout?: string } }>): string {
  return node.prompt.replace(/\{\{\s*tasks\.([^}]+?)\s*\}\}/g, (_m, title: string) => {
    const t = tasks.find((x) => x.title === title.trim().replace(/\.result$/, ""));
    return (t?.result?.stdout ?? "").trim();
  }).trim();
}

function dependsOn(from: string, target: string, deps: Map<string, Set<string>>, seen = new Set<string>()): boolean {
  if (seen.has(from)) return false;
  seen.add(from);
  for (const d of deps.get(from) ?? []) if (d === target || dependsOn(d, target, deps, seen)) return true;
  return false;
}

/** A node's problems against the mission's tasks (unknown titles, a task both before and after it, a cycle). */
export function missionImageProblems(node: MissionImage, titles: Set<string>, deps: Map<string, Set<string>>): string[] {
  const p: string[] = [];
  const at = `image "${node.name}"`;
  if (!str(node.prompt)) p.push(`${at}: prompt is required`);
  for (const t of node.afterTasks ?? []) if (!titles.has(t)) p.push(`${at}: afterTasks references unknown task "${t}"`);
  if (!node.forTasks?.length) p.push(`${at}: forTasks needs at least one task (the tasks that receive the image)`);
  for (const t of node.forTasks ?? []) {
    if (!titles.has(t)) { p.push(`${at}: forTasks references unknown task "${t}"`); continue; }
    if (node.afterTasks.includes(t)) p.push(`${at}: task "${t}" cannot be both before the image and receive it`);
    if (node.afterTasks.some((a) => dependsOn(a, t, deps))) p.push(`${at}: an after task depends on "${t}": the image could never be made`);
  }
  if (node.size !== undefined && !SIZE.test(node.size)) p.push(`${at}: size must be "WIDTHxHEIGHT" or "auto"`);
  if (node.n !== undefined && (!Number.isInteger(node.n) || node.n < 1 || node.n > MEDIA_LIMITS.maxImages)) p.push(`${at}: n must be 1–${MEDIA_LIMITS.maxImages}`);
  if (node.model !== undefined) { try { parseImageModel(node.model, `${at}: model`); } catch (err) { p.push((err as Error).message); } }
  if (node.onError !== undefined && node.onError !== "continue" && node.onError !== "fail") p.push(`${at}: onError must be "continue" or "fail"`);
  return p;
}

/** The note the tasks receiving a node's image get in their description. */
export function imageNodeNote(node: Pick<MissionImage, "name">, st: Pick<ImageNodeState, "status" | "mediaId" | "files" | "error">, urls: string[] = []): string {
  if (st.status !== "done") return `\n\n## Image "${node.name}"\nThe image could not be generated: ${st.error ?? "unknown error"}.`;
  const lines = (st.files ?? []).map((f, i) => `- ${f}${urls[i] ? ` (${urls[i]})` : ""}`);
  return `\n\n## Image "${node.name}"\nGenerated (media ${st.mediaId}):\n${lines.join("\n")}`;
}
