import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { artifactLink, artifactsApi, saveArtifactFile, type ArtifactSummary } from "@/lib/artifacts-api";

export const artifactPath = (id: string) => `/artifacts/${encodeURIComponent(id)}`;

/** Open, download, copy the link, delete: the same actions wherever an artifact is listed. */
export function useArtifactActions(onChanged?: () => void) {
  const navigate = useNavigate();
  const open = useCallback((a: Pick<ArtifactSummary, "id">) => navigate(artifactPath(a.id)), [navigate]);
  const download = useCallback(async (a: Pick<ArtifactSummary, "id">) => {
    try {
      const full = await artifactsApi.get(a.id);
      saveArtifactFile(full, full.content);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, []);
  const copyLink = useCallback(async (a: Pick<ArtifactSummary, "id">) => {
    try {
      await navigator.clipboard.writeText(artifactLink(a.id));
      toast.success("Link copied");
    } catch {
      toast.error("Could not copy the link");
    }
  }, []);
  const remove = useCallback(async (a: Pick<ArtifactSummary, "id" | "title">) => {
    if (!window.confirm(`Delete "${a.title}" and its versions?`)) return false;
    try {
      await artifactsApi.remove(a.id);
      toast.success(`"${a.title}" deleted`);
      onChanged?.();
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }
  }, [onChanged]);
  return { open, download, copyLink, remove };
}

export type ArtifactActions = ReturnType<typeof useArtifactActions>;
