import { useCallback, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { SkillBundleInstallOptions, SkillBundleInstallResult, SkillBundlePreview } from "@polpo-ai/sdk";

export interface UseSkillBundleUploadReturn {
  /** Upload a .skill / .zip archive and preview it (nothing installed yet). */
  preview: (file: Blob, filename?: string) => Promise<SkillBundlePreview>;
  /** Install the previewed archive with the choices made. */
  install: (opts?: SkillBundleInstallOptions) => Promise<SkillBundleInstallResult>;
  /** The current preview (after preview(), until reset()). */
  current: SkillBundlePreview | null;
  /** The last install's result. */
  result: SkillBundleInstallResult | null;
  isUploading: boolean;
  isInstalling: boolean;
  error: Error | null;
  reset: () => void;
}

/**
 * Upload a skill bundle in two steps — preview (validation, files, conflicts), then install —
 * the dashboard's upload dialog in a hook.
 */
export function useSkillBundleUpload(): UseSkillBundleUploadReturn {
  const { client } = usePolpoContext();
  const [current, setCurrent] = useState<SkillBundlePreview | null>(null);
  const [result, setResult] = useState<SkillBundleInstallResult | null>(null);
  const [isUploading, setUploading] = useState(false);
  const [isInstalling, setInstalling] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const preview = useCallback(async (file: Blob, filename?: string) => {
    setUploading(true);
    setError(null);
    setResult(null);
    try {
      const p = await client.previewSkillBundle(file, filename ?? ((file as File).name || "bundle.skill"));
      setCurrent(p);
      return p;
    } catch (err) {
      setError(err as Error);
      setCurrent(null);
      throw err;
    } finally {
      setUploading(false);
    }
  }, [client]);

  const install = useCallback(async (opts?: SkillBundleInstallOptions) => {
    if (!current) throw new Error("Preview an archive first");
    setInstalling(true);
    setError(null);
    try {
      const r = await client.installSkillBundle(current.uploadId, opts);
      setResult(r);
      return r;
    } catch (err) {
      setError(err as Error);
      throw err;
    } finally {
      setInstalling(false);
    }
  }, [client, current]);

  const reset = useCallback(() => { setCurrent(null); setResult(null); setError(null); }, []);

  return { preview, install, current, result, isUploading, isInstalling, error, reset };
}
