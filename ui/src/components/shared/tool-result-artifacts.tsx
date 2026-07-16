import { useState } from "react";
import { ExternalLink, FileText, Image as ImageIcon } from "lucide-react";
import {
  FilePreviewDialog,
  fileReadUrl,
  mimeFromPath,
  previewCategory,
  useFilePreview,
} from "@/components/shared/file-preview";
import { cn } from "@/lib/utils";

const PATH_FIELD = /(?:^|_)(?:file|path|image|output)(?:$|_)/i;
const PATH_TOKEN = /(?:^|[\s("'`])((?:\.{1,2}\/|\/)[^\s"'`<>()[\]{}]+)(?=$|[\s)"'`,])/gm;
const CODE_PATH = /`((?:\.{1,2}\/|\/)[^`\n]+)`/g;

function cleanPath(value: string): string {
  return value.trim().replace(/^file:\/\//, "").replace(/[.,;:]+$/, "");
}

function looksLikePath(value: string): boolean {
  if (!value || /^https?:\/\//i.test(value) || value.includes("\0")) return false;
  if (/^(?:\.{1,2}\/|\/)/.test(value)) return true;
  return !value.includes("\n") && !value.includes("\r") && !!mimeFromPath(value);
}

/** Extract local file references from common CLI text and structured tool output. */
export function extractToolResultPaths(result: string): string[] {
  const paths = new Set<string>();
  const add = (candidate: string) => {
    const path = cleanPath(candidate);
    if (looksLikePath(path)) paths.add(path);
  };
  const trimmed = result.trim();
  if (trimmed.length < 4096 && !trimmed.includes("\n")) add(trimmed.replace(/^['"`]|['"`]$/g, ""));

  if (result.length < 200_000) {
    try {
      const visit = (value: unknown, key = "") => {
        if (typeof value === "string" && PATH_FIELD.test(key)) add(value);
        else if (Array.isArray(value)) value.forEach((item) => visit(item, key));
        else if (value && typeof value === "object") {
          Object.entries(value as Record<string, unknown>).forEach(([childKey, child]) => visit(child, childKey));
        }
      };
      visit(JSON.parse(result));
    } catch { /* plain text output */ }
  }

  const searchable = result.slice(0, 100_000);
  for (const match of searchable.matchAll(CODE_PATH)) add(match[1]);
  for (const match of searchable.matchAll(PATH_TOKEN)) add(match[1]);
  return Array.from(paths).slice(0, 8);
}

function InlineImage({ path, onOpen }: { path: string; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative min-h-24 overflow-hidden border border-border bg-background text-left"
      title={`Open ${path}`}
    >
      <img
        src={fileReadUrl(path)}
        alt={path.split("/").pop() ?? "Tool result image"}
        className="max-h-48 w-full object-contain bg-muted/20"
        loading="lazy"
        onError={() => setFailed(true)}
      />
      <span className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-background/90 px-2 py-1 text-[10px] text-foreground backdrop-blur-sm">
        <ImageIcon className="h-3 w-3 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate">{path.split("/").pop()}</span>
        <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
      </span>
    </button>
  );
}

export function ToolResultArtifacts({ result, className }: { result: string; className?: string }) {
  const paths = extractToolResultPaths(result);
  const { previewState, openPreview, closePreview } = useFilePreview();
  if (paths.length === 0) return null;

  const openPath = (path: string) => {
    openPreview({
      label: path.split("/").pop() ?? path,
      path,
      mimeType: mimeFromPath(path),
    });
  };
  const images = paths.filter((path) => previewCategory(mimeFromPath(path)) === "image");
  const files = paths.filter((path) => previewCategory(mimeFromPath(path)) !== "image");

  return (
    <>
      <div className={cn("space-y-2", className)}>
        {images.length > 0 && (
          <div className={cn("grid gap-2", images.length > 1 && "sm:grid-cols-2")}>
            {images.map((path) => <InlineImage key={path} path={path} onOpen={() => openPath(path)} />)}
          </div>
        )}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {files.map((path) => (
              <button
                key={path}
                type="button"
                onClick={() => openPath(path)}
                className="inline-flex h-7 max-w-full items-center gap-1.5 border border-border bg-background px-2 text-[10px] text-primary hover:bg-accent"
                title={`Open ${path}`}
              >
                <FileText className="h-3 w-3 shrink-0" />
                <span className="truncate">{path.split("/").pop() ?? path}</span>
                <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
              </button>
            ))}
          </div>
        )}
      </div>
      <FilePreviewDialog preview={previewState} onClose={closePreview} />
    </>
  );
}
