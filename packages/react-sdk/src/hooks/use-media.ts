import { useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useEvents } from "./use-events.js";
import type { EditImageRequest, GenerateImageRequest, MediaCallerKind, MediaLogPage, MediaResult, MediaStatus } from "@polpo-ai/sdk";

export interface UseGenerateImageReturn {
  /** Generate images; resolves with them (or rejects: 409 when no image model is configured). */
  generate: (req: GenerateImageRequest) => Promise<MediaResult>;
  /** Change an image with a prompt (optionally inside a mask). */
  edit: (req: EditImageRequest) => Promise<MediaResult>;
  result: MediaResult | null;
  isGenerating: boolean;
  error: (Error & { code?: string; status?: number }) | null;
  reset: () => void;
  /** The URL of one of the result's (or the log's) images. */
  imageUrl: (id: string, index: number, opts?: { thumb?: boolean; download?: boolean }) => string;
}

/** generateImage / editImage: the media primitive (the instance's image model through its gateway). */
export function useGenerateImage(): UseGenerateImageReturn {
  const { client } = usePolpoContext();
  const [result, setResult] = useState<MediaResult | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<UseGenerateImageReturn["error"]>(null);
  const run = useCallback(async (fn: () => Promise<MediaResult>) => {
    setIsGenerating(true);
    setError(null);
    try {
      const r = await fn();
      setResult(r);
      return r;
    } catch (err) {
      setError(err as UseGenerateImageReturn["error"]);
      throw err;
    } finally {
      setIsGenerating(false);
    }
  }, []);
  const generate = useCallback((req: GenerateImageRequest) => run(() => client.generateImage(req)), [client, run]);
  const edit = useCallback((req: EditImageRequest) => run(() => client.editImage(req)), [client, run]);
  const reset = useCallback(() => { setResult(null); setError(null); }, []);
  const imageUrl = useCallback((id: string, index: number, opts?: { thumb?: boolean; download?: boolean }) => client.mediaImageUrl(id, index, opts), [client]);
  return { generate, edit, result, isGenerating, error, reset, imageUrl };
}

/** Live: an image request was answered, a mission's image node moved. */
const MEDIA_EVENTS = ["media:generated", "media:node"];

export interface UseMediaLogReturn {
  page: MediaLogPage | undefined;
  /** The image model, its gateway, the fallback and where its key comes from (never the key). */
  status: MediaStatus | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/** The media log (newest first, filtered) and the configuration status, live. */
export function useMediaLog(o: { limit?: number; caller?: MediaCallerKind; callerId?: string; status?: "ok" | "error"; kind?: "generate" | "edit" } = {}): UseMediaLogReturn {
  const { client } = usePolpoContext();
  const [page, setPage] = useState<MediaLogPage | undefined>(undefined);
  const [status, setStatus] = useState<MediaStatus | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const refetch = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([
        client.getMediaLog({
          ...(o.limit ? { limit: o.limit } : {}), ...(o.caller ? { caller: o.caller } : {}), ...(o.callerId ? { callerId: o.callerId } : {}),
          ...(o.status ? { status: o.status } : {}), ...(o.kind ? { kind: o.kind } : {}),
        }),
        client.getMediaStatus(),
      ]);
      setPage(p);
      setStatus(s);
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [client, o.limit, o.caller, o.callerId, o.status, o.kind]);
  useEffect(() => {
    setIsLoading(true);
    refetch().finally(() => setIsLoading(false));
  }, [refetch]);
  const { events } = useEvents(MEDIA_EVENTS, 1);
  const last = events.at(-1);
  const handled = useRef(last?.id);
  useEffect(() => {
    if (!last?.id || handled.current === last.id) return;
    handled.current = last.id;
    void refetch();
  }, [last, refetch]);
  return { page, status, isLoading, error, refetch };
}
