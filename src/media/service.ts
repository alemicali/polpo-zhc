/**
 * The media primitive: generateImage() and editImage() for every surface (REST /api/v1/media/images,
 * MCP polpo_image_generate, Polpo's chat, the agents' image_generate / image_edit tools, missions'
 * and playbooks' image nodes).
 *
 * - The model is settings.imageModel ("gateway:provider/model") or the request's, with
 *   settings.media.fallbackModel tried once when it fails. The gateway is resolved by the shared
 *   gateway resolver (@polpo-ai/core gateways.ts: base URL, the key from the vault entry chosen in
 *   settings.media or the gateway's env var, the only hosts the key may go to; https, no redirects).
 * - The call is the OpenAI-compatible Images API Vercel AI Gateway documents
 *   (POST /v1/images/generations, POST /v1/images/edits; @polpo-ai/core media.ts).
 * - Every image is saved as an asset of the instance (.polpo/media/images/<id>/) with its provenance
 *   in the media log (store.ts); the gateway's usage and cost go to the token usage (source "image").
 *
 * Image analysis is not a primitive: analyzeImage() is a turn of the chat pipeline with the image
 * attached (deps.visionTurn: the agent's or Polpo's model, or one asked for), no provider call here.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  GatewayError, IMAGE_EXTENSIONS, MEDIA_LIMITS, MediaError, describeGatewayKey, formatImageModel, gatewayDefinition, gatewayUrl, gatewaysWith,
  imageEditBody, imageGenerationBody, mediaImageApiPath, normalizeMediaSettings, parseImageModel, parseImagesResponse, resolveGateway, sniffImageMime,
  validateEditImageInput, validateGenerateImageInput,
  type ImageInput, type ImageModelConfig, type MediaAsset, type MediaCaller, type MediaLogEntry, type MediaSettings, type ParsedImage,
  type PolpoSettings, type ValidImageRequest, type VaultStore,
} from "@polpo-ai/core";
import { FileMediaLogStore } from "./store.js";

export { MediaError };

/** Where the dashboard sets the image model. */
export const MEDIA_SETTINGS_PATH = "/config?section=media";

export interface GeneratedImage extends MediaAsset {
  /** The image on this server's disk. */
  file: string;
  /** Its API path (GET, authenticated). */
  url: string;
}

export interface MediaResult {
  /** The media log entry (the request, its variants grouped). */
  id: string;
  kind: "generate" | "edit";
  model: string;
  usedFallback: boolean;
  images: GeneratedImage[];
  costUsd: number;
  latencyMs: number;
  warnings: string[];
}

export interface MediaStatus {
  configured: boolean;
  model?: string;
  gateway?: { id: string; label: string };
  fallbackModel?: string;
  key?: { ok: boolean; source?: "vault" | "env"; detail: string };
  error?: string;
  maxImages: number;
  retention: number;
  retentionDays: number;
  gateways: Array<{ id: string; label: string; envVar: string; docsUrl?: string }>;
  /** Image analysis (image_analyze) is a chat turn with the image: the model the agent or Polpo uses. */
  analysis: "chat";
}

export interface VisionTurnRequest {
  prompt: string;
  image: { data: string; mimeType: string };
  /** A model spec ("provider:model") to look with; else the agent's, else Polpo's. */
  model?: string;
  agent?: string;
}

export interface MediaServiceDeps {
  polpoDir: () => string;
  /** The project folder: request paths may also point there. */
  workDir?: () => string;
  settings: () => PolpoSettings | undefined;
  vault: () => VaultStore | undefined;
  env?: () => Record<string, string | undefined>;
  fetch?: typeof fetch;
  recordUsage?: (u: { provider: string; model: string; inputTokens: number; outputTokens: number; cost: number }) => Promise<void>;
  emit?: (payload: { id: string; kind: "generate" | "edit"; caller: string; callerId?: string; model: string; images: number; costUsd: number; status: "ok" | "error"; error?: string }) => void;
  /** A chat turn of the pipeline with an image attached, without tools (image analysis). */
  visionTurn?: (req: VisionTurnRequest) => Promise<{ text: string; model?: string; costUsd?: number }>;
  /** An image's size and a small preview (default: sharp when it is installed; undefined: none). */
  inspect?: (bytes: Uint8Array) => Promise<{ width?: number; height?: number; thumb?: Uint8Array } | undefined>;
  /** A gateway call's longest wait (default 180 s). */
  timeoutMs?: number;
}

const newId = () => `img_${randomBytes(9).toString("hex")}`;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  return out;
}

/** sharp, when installed: the size and a 512 px webp preview. */
async function sharpInspect(bytes: Uint8Array): Promise<{ width?: number; height?: number; thumb?: Uint8Array } | undefined> {
  try {
    const sharp = (await import("sharp")).default;
    const img = sharp(Buffer.from(bytes), { failOn: "none" });
    const meta = await img.metadata();
    const thumb = await img.resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true }).webp({ quality: 70 }).toBuffer();
    return { ...(meta.width ? { width: meta.width } : {}), ...(meta.height ? { height: meta.height } : {}), thumb: new Uint8Array(thumb) };
  } catch { return undefined; }
}

/** An input as people read it in the log (never its bytes). */
function describeInput(i: ImageInput): string {
  if ("mediaId" in i) return `media ${i.mediaId}#${i.index ?? 0}`;
  if ("url" in i) return i.url.length > 200 ? `${i.url.slice(0, 200)}…` : i.url;
  if ("path" in i) return `file ${i.path}`;
  return `inline image (${Math.round((i.base64.length * 3) / 4 / 1024)} KB)`;
}

export class MediaService {
  readonly store: FileMediaLogStore;

  constructor(private readonly deps: MediaServiceDeps) {
    this.store = new FileMediaLogStore(deps.polpoDir);
  }

  private mediaSettings(): MediaSettings {
    return normalizeMediaSettings(this.deps.settings()?.media) ?? {};
  }

  /** The configured image model (throws 409 when settings.imageModel is invalid). */
  configuredModel(): ImageModelConfig | undefined {
    let m: Pick<ImageModelConfig, "gateway" | "model"> | undefined;
    try { m = parseImageModel(this.deps.settings()?.imageModel); } catch (err) {
      throw new MediaError(`settings.imageModel is invalid: ${(err as Error).message}. Fix it in Settings → Media (${MEDIA_SETTINGS_PATH}).`, 409, "NOT_CONFIGURED");
    }
    return m ? this.withKey(m) : undefined;
  }

  /** The key chosen in settings.media applies to its gateway. */
  private withKey(m: Pick<ImageModelConfig, "gateway" | "model">): ImageModelConfig {
    const ms = this.mediaSettings();
    return { ...m, ...(ms.credentialRef ? { credentialRef: ms.credentialRef } : {}), ...(ms.credentialField ? { credentialField: ms.credentialField } : {}) };
  }

  /** What is configured, for Settings and the Media page (never a key). */
  async status(): Promise<MediaStatus> {
    const ms = this.mediaSettings();
    const base = {
      maxImages: ms.maxImages ?? MEDIA_LIMITS.defaultMaxImages,
      retention: ms.retention ?? MEDIA_LIMITS.defaultRetention,
      retentionDays: ms.retentionDays ?? MEDIA_LIMITS.defaultRetentionDays,
      gateways: gatewaysWith("images").map((g) => ({ id: g.id, label: g.label, envVar: g.envVar, ...(g.docsUrl ? { docsUrl: g.docsUrl } : {}) })),
      analysis: "chat" as const,
      ...(ms.fallbackModel ? { fallbackModel: ms.fallbackModel } : {}),
    };
    let cfg: ImageModelConfig | undefined;
    try { cfg = this.configuredModel(); } catch (err) { return { configured: false, error: (err as Error).message, ...base }; }
    if (!cfg) return { configured: false, ...base };
    const def = gatewayDefinition(cfg.gateway);
    let key: MediaStatus["key"];
    try {
      const g = await resolveGateway(cfg.gateway, cfg, { vault: this.deps.vault(), env: this.deps.env?.(), capability: "images" });
      key = { ok: true, source: g.keySource.kind, detail: describeGatewayKey(g.keySource) };
    } catch (err) {
      key = { ok: false, detail: (err as Error).message };
    }
    return { configured: true, model: formatImageModel(cfg), ...(def ? { gateway: { id: def.id, label: def.label } } : {}), key, ...base };
  }

  /** Generate images from a prompt (and reference images). Throws MediaError (400, 409, 429, 502, 504). */
  async generateImage(input: unknown, caller: MediaCaller): Promise<MediaResult> {
    return this.run(validateGenerateImageInput(input, { maxImages: this.mediaSettings().maxImages }), caller);
  }

  /** Change an image (or compose several) with a prompt, optionally inside a mask. */
  async editImage(input: unknown, caller: MediaCaller): Promise<MediaResult> {
    return this.run(validateEditImageInput(input, { maxImages: this.mediaSettings().maxImages }), caller);
  }

  private async run(valid: ValidImageRequest, caller: MediaCaller): Promise<MediaResult> {
    const ms = this.mediaSettings();
    const model = valid.model ? this.withKey(valid.model) : this.configuredModel();
    if (!model) {
      throw new MediaError(
        `No image model is configured. Set one in Settings → Media (${MEDIA_SETTINGS_PATH}), e.g. vercel-ai-gateway:openai/gpt-image-2.`, 409, "NOT_CONFIGURED",
      );
    }
    const t0 = Date.now();
    const id = newId();
    const promptStored = valid.prompt.slice(0, MEDIA_LIMITS.storedPromptChars);
    const entryBase = {
      id, at: new Date().toISOString(), kind: valid.kind, caller, prompt: promptStored,
      ...(valid.prompt.length > promptStored.length ? { promptTruncated: true } : {}),
      ...(valid.size ? { size: valid.size } : {}), n: valid.n, ...(valid.seed !== undefined ? { seed: valid.seed } : {}),
      ...(valid.images.length || valid.mask ? { inputs: [...valid.images.map(describeInput), ...(valid.mask ? [`mask: ${describeInput(valid.mask)}`] : [])] } : {}),
    };
    let label = formatImageModel(model);
    try {
      // the inputs as URLs the gateway takes (data: or https), read once for both attempts
      const images = await Promise.all(valid.images.map((i) => this.inputUrl(i)));
      const mask = valid.mask ? await this.inputUrl(valid.mask) : undefined;
      let usedFallback = false;
      let r: Awaited<ReturnType<MediaService["callGateway"]>>;
      try {
        r = await this.callGateway(model, valid, images, mask);
      } catch (err) {
        const fb = ms.fallbackModel ? parseFallback(ms.fallbackModel) : undefined;
        const retryable = err instanceof MediaError && (err.code === "UPSTREAM" || err.code === "BAD_ANSWER");
        if (!fb || !retryable || formatImageModel(fb) === formatImageModel(model)) throw err;
        usedFallback = true;
        label = formatImageModel(fb);
        r = await this.callGateway(this.withKey(fb), valid, images, mask);
      }
      label = `${r.gateway}:${r.model}`;
      const assets = await this.saveAssets(id, r.images);
      const costUsd = Math.round((r.costUsd ?? 0) * 1e8) / 1e8;
      await this.deps.recordUsage?.({
        provider: r.gateway, model: r.model, inputTokens: r.usage.inputTokens ?? 0, outputTokens: r.usage.outputTokens ?? 0, cost: costUsd,
      }).catch(() => undefined);
      const latencyMs = Date.now() - t0;
      const entry: MediaLogEntry = {
        ...entryBase, status: "ok", model: label, gateway: r.gateway, ...(usedFallback ? { usedFallback: true } : {}),
        latencyMs, costUsd, usage: r.usage, ...(r.warnings.length ? { warnings: r.warnings } : {}), assets,
      };
      this.record(entry);
      return {
        id, kind: valid.kind, model: label, usedFallback, costUsd, latencyMs, warnings: r.warnings,
        images: assets.map((a) => ({ ...a, file: join(this.deps.polpoDir(), a.path), url: mediaImageApiPath(id, a.index) })),
      };
    } catch (err) {
      const e = err instanceof MediaError ? err : err instanceof GatewayError
        ? new MediaError(`${err.message} (Settings → Media: ${MEDIA_SETTINGS_PATH})`, 409, "NOT_CONFIGURED")
        : new MediaError(`The image request failed: ${err instanceof Error ? err.message : String(err)}`, 502, "UPSTREAM");
      this.record({ ...entryBase, status: "error", error: e.message, model: label, gateway: model.gateway, latencyMs: Date.now() - t0, costUsd: 0, usage: {}, assets: [] });
      throw e;
    }
  }

  private record(entry: MediaLogEntry): void {
    const ms = this.mediaSettings();
    try {
      this.store.add(entry, { count: ms.retention ?? MEDIA_LIMITS.defaultRetention, days: ms.retentionDays ?? MEDIA_LIMITS.defaultRetentionDays });
    } catch { /* the log is best-effort: the images stand */ }
    this.deps.emit?.({
      id: entry.id, kind: entry.kind, caller: entry.caller.kind, ...(entry.caller.id ? { callerId: entry.caller.id } : {}), model: entry.model,
      images: entry.assets.length, costUsd: entry.costUsd, status: entry.status, ...(entry.error ? { error: entry.error } : {}),
    });
  }

  /** An input image as a data: URL (or the https URL as given). */
  private async inputUrl(i: ImageInput): Promise<string> {
    if ("url" in i) return i.url;
    let bytes: Uint8Array;
    let mime: string | undefined;
    if ("base64" in i) {
      const raw = i.base64.startsWith("data:") ? i.base64.slice(i.base64.indexOf(",") + 1) : i.base64;
      if (i.base64.startsWith("data:")) mime = /^data:([^;,]+)/.exec(i.base64)?.[1];
      bytes = new Uint8Array(Buffer.from(raw, "base64"));
      mime ??= i.mimeType;
    } else if ("mediaId" in i) {
      const e = this.store.get(i.mediaId);
      const a = e?.assets.find((x) => x.index === (i.index ?? 0));
      const file = a ? this.store.assetFile(a.path) : undefined;
      if (!file) throw new MediaError(`There is no image ${i.mediaId}#${i.index ?? 0} in the media log`, 400);
      bytes = new Uint8Array(readFileSync(file));
      mime = a!.mimeType;
    } else {
      const file = this.allowedFile(i.path);
      if (!file) throw new MediaError(`The file "${i.path}" is not in the project or .polpo folder`, 400);
      try { bytes = new Uint8Array(readFileSync(file)); } catch { throw new MediaError(`The file "${i.path}" could not be read`, 400); }
    }
    if (bytes.byteLength > MEDIA_LIMITS.maxInputBytes) throw new MediaError(`An input image is larger than ${MEDIA_LIMITS.maxInputBytes / 1024 / 1024} MB`, 400);
    const type = sniffImageMime(bytes) ?? mime;
    if (!type || !IMAGE_EXTENSIONS[type]) throw new MediaError("An input image is not a PNG, JPEG, WebP or GIF", 400);
    return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
  }

  /** A path inside the project or .polpo (relative to the project), else undefined. */
  private allowedFile(path: string): string | undefined {
    if (path.includes("\0")) return undefined;
    const roots = [this.deps.workDir?.(), this.deps.polpoDir()].filter((r): r is string => !!r).map((r) => resolve(r));
    for (const root of roots) {
      const abs = isAbsolute(path) ? resolve(path) : resolve(roots[0], path);
      const rel = relative(root, abs);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("..")) return abs;
    }
    return undefined;
  }

  /** POST {gateway}/images/generations (or /images/edits with input images) with the gateway's key, to its allowed hosts only. */
  private async callGateway(model: ImageModelConfig, valid: ValidImageRequest, images: string[], mask?: string) {
    const g = await resolveGateway(model.gateway, model, { vault: this.deps.vault(), env: this.deps.env?.(), capability: "images" });
    const edit = images.length > 0;
    const url = gatewayUrl(g, edit ? "images/edits" : "images/generations");
    const body = edit ? imageEditBody(model.model, valid, images, mask) : imageGenerationBody(model.model, valid);
    const doFetch = this.deps.fetch ?? fetch;
    const timeoutMs = this.deps.timeoutMs ?? 180_000;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: { ...g.headers, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const timedOut = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
      throw new MediaError(timedOut ? `${g.label} did not answer within ${Math.round(timeoutMs / 1000)} s` : `${g.label} could not be reached: ${scrub((err as Error).message, [g.key])}`, timedOut ? 504 : 502, "UPSTREAM");
    }
    const raw = await res.text().catch(() => "");
    let json: unknown;
    try { json = raw ? JSON.parse(raw) : undefined; } catch { json = undefined; }
    if (!res.ok) {
      const e = json && typeof json === "object" ? (json as { error?: { message?: string } | string; message?: string }) : undefined;
      const message = typeof e?.error === "string" ? e.error : e?.error?.message ?? e?.message ?? raw.slice(0, 300);
      throw new MediaError(`${g.label} refused the image request (HTTP ${res.status}): ${scrub(String(message || res.statusText), [g.key]).slice(0, 500)}`, res.status === 429 ? 429 : 502, "UPSTREAM");
    }
    const parsed = parseImagesResponse(json);
    const decoded = await Promise.all(parsed.images.map((p) => this.decode(p, doFetch, g.key)));
    return { gateway: model.gateway, model: parsed.model ?? model.model, images: decoded, usage: parsed.usage, ...(parsed.costUsd !== undefined ? { costUsd: parsed.costUsd } : {}), warnings: parsed.warnings };
  }

  /** An image's bytes: base64, or (when the gateway answered with a URL) downloaded from https without credentials. */
  private async decode(p: ParsedImage, doFetch: typeof fetch, key: string): Promise<{ bytes: Uint8Array; mimeType: string; revisedPrompt?: string }> {
    let bytes: Uint8Array;
    if (p.b64) bytes = new Uint8Array(Buffer.from(p.b64, "base64"));
    else {
      if (!p.url || !/^https:\/\//i.test(p.url)) throw new MediaError("The image model returned an image URL that is not https", 502, "BAD_ANSWER");
      const res = await doFetch(p.url, { redirect: "follow", signal: AbortSignal.timeout(60_000) }).catch((err) => {
        throw new MediaError(`The generated image could not be downloaded: ${scrub((err as Error).message, [key])}`, 502, "UPSTREAM");
      });
      if (!res.ok) throw new MediaError(`The generated image could not be downloaded (HTTP ${res.status})`, 502, "UPSTREAM");
      bytes = new Uint8Array(await res.arrayBuffer());
    }
    if (!bytes.byteLength) throw new MediaError("The image model returned an empty image", 502, "BAD_ANSWER");
    if (bytes.byteLength > MEDIA_LIMITS.maxOutputBytes) throw new MediaError("The image model returned an image that is too large", 502, "BAD_ANSWER");
    const mimeType = sniffImageMime(bytes) ?? p.mimeType ?? "image/png";
    return { bytes, mimeType, ...(p.revisedPrompt ? { revisedPrompt: p.revisedPrompt } : {}) };
  }

  /** Save a request's images under media/images/<id>/ with their hash, size and preview. */
  private async saveAssets(id: string, images: Array<{ bytes: Uint8Array; mimeType: string; revisedPrompt?: string }>): Promise<MediaAsset[]> {
    const dir = this.store.imagesDir(id);
    mkdirSync(dir, { recursive: true });
    const inspect = this.deps.inspect ?? sharpInspect;
    const out: MediaAsset[] = [];
    for (const [index, img] of images.entries()) {
      const ext = IMAGE_EXTENSIONS[img.mimeType] ?? "png";
      const file = join(dir, `${index}.${ext}`);
      writeFileSync(file, img.bytes);
      const info = await inspect(img.bytes).catch(() => undefined);
      let thumbPath: string | undefined;
      if (info?.thumb?.byteLength) {
        writeFileSync(join(dir, `${index}.thumb.webp`), info.thumb);
        thumbPath = relative(this.deps.polpoDir(), join(dir, `${index}.thumb.webp`)).split(sep).join("/");
      }
      out.push({
        index, path: relative(this.deps.polpoDir(), file).split(sep).join("/"), mimeType: img.mimeType, bytes: img.bytes.byteLength,
        ...(info?.width ? { width: info.width } : {}), ...(info?.height ? { height: info.height } : {}), sha256: sha256(img.bytes),
        ...(img.revisedPrompt ? { revisedPrompt: img.revisedPrompt } : {}), ...(thumbPath ? { thumbPath } : {}),
      });
    }
    return out;
  }

  /** An image of the log: its file and type (the preview with thumb, when there is one). */
  imageFile(id: string, index: number, opts: { thumb?: boolean } = {}): { file: string; mimeType: string } | undefined {
    const a = this.store.get(id)?.assets.find((x) => x.index === index);
    if (!a) return undefined;
    if (opts.thumb && a.thumbPath) {
      const t = this.store.assetFile(a.thumbPath);
      if (t) return { file: t, mimeType: "image/webp" };
    }
    const file = this.store.assetFile(a.path);
    return file ? { file, mimeType: a.mimeType } : undefined;
  }

  /**
   * Look at an image and answer: a turn of the chat pipeline with the image attached (the agent's or
   * Polpo's model, or the one asked for), without tools. Its usage is a chat's.
   */
  async analyzeImage(req: VisionTurnRequest): Promise<{ text: string; model?: string; costUsd?: number }> {
    if (!this.deps.visionTurn) throw new MediaError("Image analysis needs the chat, which is not available here", 503, "UNAVAILABLE");
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(req.image.mimeType)) throw new MediaError("Only PNG, JPEG, WebP and GIF images can be analyzed", 400);
    return this.deps.visionTurn(req);
  }
}

function parseFallback(setting: string): Pick<ImageModelConfig, "gateway" | "model"> | undefined {
  try { return parseImageModel(setting, "media.fallbackModel"); } catch { return undefined; }
}

// ── The instance's service (the agents' tools reach it by .polpo directory) ──

const services = new Map<string, MediaService>();

export function registerMediaService(polpoDir: string, service: MediaService): void {
  services.set(polpoDir, service);
}

export function mediaServiceFor(polpoDir: string): MediaService | undefined {
  return services.get(polpoDir);
}
