/**
 * Media in the dashboard: the Settings form ↔ settings.imageModel / settings.media, and how a log
 * entry reads (who asked, from where).
 */
import type { MediaLogEntry, MediaSettings } from "@polpo-ai/react";
import type { VaultRef } from "@/lib/vault-ref";

export interface MediaForm {
  gateway: string;
  model: string;
  fallbackModel: string;
  credentialRef: VaultRef | null;
  credentialField: string;
  maxImages: string;
  retention: string;
  retentionDays: string;
}

/** "gateway:provider/model" → its parts (a bare provider/model is on Vercel AI Gateway). */
export function splitImageModel(spec: string | undefined): { gateway: string; model: string } {
  const s = (spec ?? "").trim();
  const i = s.indexOf(":");
  return i > 0 && !s.slice(0, i).includes("/") ? { gateway: s.slice(0, i), model: s.slice(i + 1) } : { gateway: "vercel-ai-gateway", model: s };
}

/** The form from the saved settings. */
export function mediaFormFrom(imageModel: string | undefined, s: MediaSettings | undefined): MediaForm {
  const m = splitImageModel(imageModel);
  return {
    gateway: m.gateway, model: m.model, fallbackModel: s?.fallbackModel ?? "",
    credentialRef: s?.credentialRef ?? null, credentialField: s?.credentialField ?? "",
    maxImages: s?.maxImages ? String(s.maxImages) : "",
    retention: s?.retention ? String(s.retention) : "",
    retentionDays: s?.retentionDays !== undefined ? String(s.retentionDays) : "",
  };
}

/** The settings PATCH from the form (an empty model removes the image model). */
export function mediaPatchFrom(f: MediaForm): { imageModel: string | null; media: MediaSettings | null } {
  const fb = f.fallbackModel.trim();
  const media: MediaSettings = {
    ...(fb ? { fallbackModel: fb.includes(":") ? fb : `${f.gateway}:${fb}` } : {}),
    ...(f.credentialRef ? { credentialRef: f.credentialRef } : {}),
    ...(f.credentialRef && f.credentialField.trim() ? { credentialField: f.credentialField.trim() } : {}),
    ...(f.maxImages.trim() && Number(f.maxImages) >= 1 ? { maxImages: Math.min(10, Math.floor(Number(f.maxImages))) } : {}),
    ...(f.retention.trim() && Number(f.retention) >= 1 ? { retention: Math.floor(Number(f.retention)) } : {}),
    ...(f.retentionDays.trim() && Number(f.retentionDays) >= 0 ? { retentionDays: Math.floor(Number(f.retentionDays)) } : {}),
  };
  return { imageModel: f.model.trim() ? `${f.gateway}:${f.model.trim()}` : null, media: Object.keys(media).length ? media : null };
}

/** Who asked, in a few words: "agent · writer · task t1". */
export function mediaCallerText(e: Pick<MediaLogEntry, "caller">): string {
  const c = e.caller;
  return [c.kind, c.id ?? c.label, c.taskId ? `task ${c.taskId}` : undefined, c.missionId && c.missionId !== c.id ? `mission ${c.missionId}` : undefined, c.by]
    .filter(Boolean).join(" · ");
}
