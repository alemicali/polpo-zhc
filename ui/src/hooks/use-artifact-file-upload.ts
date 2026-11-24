/** Upload files as new artifacts from the dashboard (the Upload button and drag & drop). */
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { artifactsApi, type Artifact } from "@/lib/artifacts-api";
import { formatSize, prepareArtifactFile } from "@/lib/artifact-upload";
import { artifactPath } from "@/hooks/use-artifact-actions";

const percent = (sent: number, total: number) => (total ? Math.min(100, Math.round((sent / total) * 100)) : 100);

/** Upload files as new artifacts (one toast each, with progress); opens the artifact when there is one file. */
export function useArtifactFileUpload(onUploaded?: (artifacts: Artifact[]) => void) {
  const navigate = useNavigate();
  const [uploading, setUploading] = useState(false);
  const upload = useCallback(async (files: File[]) => {
    if (!files.length) return [];
    setUploading(true);
    const done: Artifact[] = [];
    try {
      for (const original of files) {
        const toastId = toast.loading(`Uploading ${original.name}…`);
        try {
          const prepared = await prepareArtifactFile(original);
          const artifact = await artifactsApi.upload(prepared.file, {
            title: prepared.title, filename: prepared.filename, ...(prepared.type ? { type: prepared.type } : {}), ...(prepared.kind ? { kind: prepared.kind } : {}),
            onProgress: (sent, total) => toast.loading(`Uploading ${original.name}… ${percent(sent, total)}% of ${formatSize(total)}`, { id: toastId }),
          });
          done.push(artifact);
          toast.success(`${artifact.title} uploaded`, { id: toastId });
        } catch (error) {
          toast.error((error as Error).message, { id: toastId });
        }
      }
      onUploaded?.(done);
      if (files.length === 1 && done[0]) navigate(artifactPath(done[0].id));
      return done;
    } finally {
      setUploading(false);
    }
  }, [navigate, onUploaded]);
  return { upload, uploading };
}

