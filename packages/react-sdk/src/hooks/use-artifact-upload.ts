import { useCallback, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { Artifact, ArtifactUploadOptions } from "@polpo-ai/sdk";

/** Files larger than this go in parts (with progress); smaller ones in one request. */
export const ARTIFACT_UPLOAD_PART_BYTES = 8 * 1024 * 1024;

export interface UseArtifactUploadReturn {
  /** Create an artifact from a file (type detected from its name and content unless given). */
  upload: (file: Blob, opts?: ArtifactUploadOptions) => Promise<Artifact>;
  /** Replace an artifact's content with a file (the previous one becomes a version). */
  replace: (id: string, file: Blob, opts?: { expectedVersion?: number; filename?: string; note?: string }) => Promise<Artifact>;
  /** Bytes sent and total, while uploading. */
  progress: { sent: number; total: number } | null;
  /** The last artifact created or changed. */
  result: Artifact | null;
  isUploading: boolean;
  error: Error | null;
  reset: () => void;
}

/**
 * Upload artifact contents (up to the instance limit, 100 MB by default): small files in one request,
 * large ones in parts with progress, then create the artifact or replace one's content.
 */
export function useArtifactUpload(options: { partBytes?: number } = {}): UseArtifactUploadReturn {
  const { client } = usePolpoContext();
  const partBytes = options.partBytes ?? ARTIFACT_UPLOAD_PART_BYTES;
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [result, setResult] = useState<Artifact | null>(null);
  const [isUploading, setUploading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const busy = useRef(false);

  const send = useCallback(async (file: Blob, finish: (uploadId?: string) => Promise<Artifact>, filename?: string) => {
    if (busy.current) throw new Error("An upload is in progress");
    busy.current = true;
    setUploading(true);
    setError(null);
    setProgress({ sent: 0, total: file.size });
    try {
      let artifact: Artifact;
      if (file.size <= partBytes) {
        artifact = await finish();
      } else {
        let uploadId: string | undefined;
        for (let at = 0; at < file.size; at += partBytes) {
          const more = at + partBytes < file.size;
          const part = await client.uploadArtifactPart(file.slice(at, at + partBytes), { ...(uploadId ? { appendTo: uploadId } : {}), more, ...(filename ? { filename } : {}) });
          uploadId = part.uploadId;
          setProgress({ sent: part.size, total: file.size });
        }
        artifact = await finish(uploadId);
      }
      setProgress({ sent: file.size, total: file.size });
      setResult(artifact);
      return artifact;
    } catch (err) {
      setError(err as Error);
      throw err;
    } finally {
      busy.current = false;
      setUploading(false);
    }
  }, [client, partBytes]);

  const upload = useCallback((file: Blob, opts: ArtifactUploadOptions = {}) => {
    const filename = opts.filename ?? (file as File).name;
    return send(file, (uploadId) => uploadId
      ? client.finalizeArtifactUpload(uploadId, { ...opts, ...(filename ? { filename } : {}) })
      : client.uploadArtifact(file, { ...opts, ...(filename ? { filename } : {}) }), filename);
  }, [client, send]);

  const replace = useCallback((id: string, file: Blob, opts: { expectedVersion?: number; filename?: string; note?: string } = {}) => {
    const filename = opts.filename ?? (file as File).name;
    return send(file, (uploadId) => uploadId
      ? client.finalizeArtifactUpload(uploadId, { id, ...(opts.expectedVersion ? { expectedVersion: opts.expectedVersion } : {}), ...(opts.note ? { note: opts.note } : {}) })
      : client.replaceArtifactContent(id, file, { ...opts, ...(filename ? { filename } : {}) }), filename);
  }, [client, send]);

  const reset = useCallback(() => { setProgress(null); setResult(null); setError(null); }, []);

  return { upload, replace, progress, result, isUploading, error, reset };
}
