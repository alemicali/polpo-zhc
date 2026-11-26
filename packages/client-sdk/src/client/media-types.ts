/** Media: image generation and editing (the media primitive), the media log, image nodes. */

/** An input image: inline bytes, an https URL, an earlier generated image or a file of the project / .polpo. A string is any of them. */
export type ImageInput =
  | string
  | { base64: string; mimeType?: string }
  | { url: string }
  | { mediaId: string; index?: number }
  | { path: string };

export interface GenerateImageRequest {
  prompt: string;
  /** WIDTHxHEIGHT (e.g. 1024x1024) or auto. */
  size?: string;
  /** How many variants (default 1). */
  n?: number;
  /** Another model than settings.imageModel: "gateway:provider/model". */
  model?: string;
  referenceImages?: ImageInput[];
  seed?: number;
  providerOptions?: Record<string, unknown>;
}

export interface EditImageRequest {
  image: ImageInput | ImageInput[];
  prompt: string;
  mask?: ImageInput;
  size?: string;
  n?: number;
  model?: string;
  providerOptions?: Record<string, unknown>;
}

export interface MediaAsset {
  index: number;
  /** Relative to the .polpo folder. */
  path: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
  sha256: string;
  revisedPrompt?: string;
  thumbPath?: string;
}

export interface MediaImage extends MediaAsset {
  /** The file on the server. */
  file: string;
  /** Its API path (GET, authenticated): client.mediaImageUrl builds a full URL. */
  url: string;
}

export interface MediaResult {
  id: string;
  kind: "generate" | "edit";
  model: string;
  usedFallback: boolean;
  images: MediaImage[];
  costUsd: number;
  latencyMs: number;
  warnings: string[];
}

export type MediaCallerKind = "api" | "mcp" | "chat" | "agent" | "mission" | "playground";

export interface MediaCaller {
  kind: MediaCallerKind;
  id?: string;
  label?: string;
  by?: string;
  taskId?: string;
  missionId?: string;
  sessionId?: string;
  triggerId?: string;
}

export interface MediaLogEntry {
  id: string;
  at: string;
  kind: "generate" | "edit";
  caller: MediaCaller;
  status: "ok" | "error";
  error?: string;
  model: string;
  gateway?: string;
  usedFallback?: boolean;
  prompt: string;
  promptTruncated?: boolean;
  size?: string;
  n: number;
  seed?: number;
  inputs?: string[];
  latencyMs: number;
  costUsd: number;
  usage: { inputTokens?: number; outputTokens?: number; images?: number };
  warnings?: string[];
  assets: MediaAsset[];
}

export interface MediaLogPage { entries: MediaLogEntry[]; nextCursor?: string; total: number }

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
  /** Image analysis is a chat turn with the image. */
  analysis: "chat";
}

/** settings.media. */
export interface MediaSettings {
  fallbackModel?: string;
  credentialRef?: { owner: string; service: string };
  credentialField?: string;
  maxImages?: number;
  retention?: number;
  retentionDays?: number;
}

export interface ImageNodeState {
  group: string;
  missionId?: string;
  node: string;
  status: "generating" | "done" | "failed";
  mediaId?: string;
  files?: string[];
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

/** An image node of a mission or playbook. */
export interface MissionImage {
  name: string;
  afterTasks: string[];
  prompt: string;
  forTasks: string[];
  size?: string;
  n?: number;
  model?: string;
  onError?: "continue" | "fail";
}
