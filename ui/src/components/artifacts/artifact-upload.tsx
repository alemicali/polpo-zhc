/**
 * Uploading files as artifacts: the Upload button and drag & drop on the Artifacts page, and the
 * "Replace content" of an artifact. Large files go in parts with progress (artifactsApi.upload).
 */
import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Artifact } from "@/lib/artifacts-api";
import { ARTIFACT_UPLOAD_ACCEPT } from "@/lib/artifact-upload";
import { useArtifactFileUpload } from "@/hooks/use-artifact-file-upload";
import { cn } from "@/lib/utils";

export function ArtifactUploadButton({ onUploaded }: { onUploaded?: (artifacts: Artifact[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const { upload, uploading } = useArtifactFileUpload(onUploaded);
  return (
    <>
      <Button size="icon-sm" variant="ghost" aria-label="Upload artifacts" title="Upload files as artifacts (Markdown, HTML, SVG, Mermaid, workspace JSON, CSV, XLSX)"
        disabled={uploading} onClick={() => input.current?.click()}>
        <Upload className="size-4" />
      </Button>
      <input ref={input} type="file" multiple hidden accept={ARTIFACT_UPLOAD_ACCEPT} data-testid="artifact-upload-input"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          void upload(files);
        }} />
    </>
  );
}

const hasFiles = (event: DragEvent) => [...event.dataTransfer.types].includes("Files");

/** Drop files anywhere inside to upload them as artifacts. */
export function ArtifactDropZone({ children, className, onUploaded }: { children: ReactNode; className?: string; onUploaded?: (artifacts: Artifact[]) => void }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const { upload } = useArtifactFileUpload(onUploaded);
  return (
    <div className={cn("relative", className)} data-testid="artifact-drop-zone"
      onDragEnter={(event) => { if (!hasFiles(event)) return; event.preventDefault(); depth.current += 1; setOver(true); }}
      onDragOver={(event) => { if (hasFiles(event)) event.preventDefault(); }}
      onDragLeave={() => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); }}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        depth.current = 0;
        setOver(false);
        void upload([...event.dataTransfer.files]);
      }}>
      {children}
      {over && (
        <div role="status" className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-card border-2 border-dashed border-primary bg-background/80 text-sm font-medium text-foreground">
          <Upload className="mr-2 size-4 text-primary" /> Drop files to upload them as artifacts
        </div>
      )}
    </div>
  );
}
