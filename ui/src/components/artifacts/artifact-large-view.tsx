/**
 * An artifact too large to open in the editors (over the server's viewer limit, 10 MB): its size, a
 * download, a replace, its outline (tabs, slides, sheets, boards, scenes) and a light preview read in
 * pages of 64 KB as asked — never the whole content in the browser.
 */
import { useCallback, useEffect, useState } from "react";
import { Download, FileWarning, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { artifactsApi, downloadArtifactContent, type Artifact } from "@/lib/artifacts-api";
import { formatSize } from "@/lib/artifact-upload";

const PAGE_BYTES = 64 * 1024;

export function ArtifactLargeView({ artifact, version, onReplace }: { artifact: Artifact; version?: number; onReplace?: () => void }) {
  const size = version ? artifact.versions.find((v) => v.version === version)?.size ?? 0 : artifact.size ?? 0;
  const [outline, setOutline] = useState<string>();
  const [pages, setPages] = useState<string[]>([]);
  const [next, setNext] = useState<number | undefined>(0);
  const [loading, setLoading] = useState(false);

  const loadPage = useCallback(async (offset: number) => {
    setLoading(true);
    try {
      const read = await artifactsApi.read(artifact.id, { offset, limit: PAGE_BYTES, ...(version ? { version } : {}) });
      setPages((current) => [...current, read.text]);
      setNext(read.more ? read.end : undefined);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [artifact.id, version]);

  useEffect(() => {
    setPages([]);
    setNext(undefined);
    setOutline(undefined);
    const controller = new AbortController();
    artifactsApi.read(artifact.id, { offset: 0, limit: PAGE_BYTES, ...(version ? { version } : {}) }, controller.signal).then((read) => {
      setPages([read.text]);
      setNext(read.more ? read.end : undefined);
    }, (error: Error) => { if (!controller.signal.aborted) toast.error(error.message); });
    // the outline needs the server to read the whole content: only within its edit limit (it answers 413 otherwise)
    artifactsApi.read(artifact.id, { outline: true, ...(version ? { version } : {}) }, controller.signal)
      .then((read) => setOutline(read.text), () => setOutline(undefined));
    return () => controller.abort();
  }, [artifact.id, version]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-4" data-testid="artifact-large-view">
      <div className="flex flex-wrap items-center gap-3 rounded-card border border-warning/40 bg-warning/5 px-3 py-2 text-sm" role="status">
        <FileWarning className="size-4 shrink-0 text-warning" />
        <span className="min-w-0 flex-1">
          This artifact is {formatSize(size)}: too large to open in the editor here. Download it, replace its content,
          or ask an agent to change parts of it.
        </span>
        <Button size="sm" variant="outline" onClick={() => void downloadArtifactContent(artifact, version).catch((e: Error) => toast.error(e.message))}>
          <Download className="size-3.5" /> Download
        </Button>
        {onReplace && <Button size="sm" variant="outline" onClick={onReplace}><Upload className="size-3.5" /> Replace content</Button>}
      </div>
      {outline && (
        <section aria-label="Outline">
          <h3 className="mb-1 text-xs font-semibold text-muted-foreground">Outline</h3>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/20 p-2 font-mono text-xs">{outline}</pre>
        </section>
      )}
      <section aria-label="Preview" className="min-h-0">
        <h3 className="mb-1 text-xs font-semibold text-muted-foreground">Preview (the beginning)</h3>
        <pre className="whitespace-pre-wrap break-words rounded-md border bg-muted/20 p-2 font-mono text-xs">{pages.join("")}</pre>
        {next !== undefined && pages.length > 0 && (
          <Button className="mt-2" size="sm" variant="ghost" disabled={loading} onClick={() => void loadPage(next)}>
            {loading ? "Loading…" : `Show more (${formatSize(next)} of ${formatSize(size)} shown)`}
          </Button>
        )}
      </section>
    </div>
  );
}
