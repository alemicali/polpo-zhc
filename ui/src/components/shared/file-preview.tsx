"use client";

import { useState, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Loader2,
  Download,
  Maximize2,
  Minimize2,
  X,
  File,
} from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { config } from "@/lib/config";

// ── Helpers ──

/** Build a URL to the files API endpoint for reading a file */
export function fileReadUrl(path: string, download?: boolean): string {
  const base = config.baseUrl || "";
  const params = new URLSearchParams({ path });
  if (download) params.set("download", "1");
  return `${base}/api/v1/files/read?${params.toString()}`;
}

/** Build a URL to the files API preview endpoint */
export function filePreviewUrl(path: string): string {
  const base = config.baseUrl || "";
  return `${base}/api/v1/files/preview?path=${encodeURIComponent(path)}`;
}

/** Determine the preview category from a MIME type */
export function previewCategory(mime?: string): "image" | "audio" | "video" | "pdf" | "code" | "text" | "binary" {
  if (!mime) return "binary";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  if (
    mime.startsWith("text/x-") ||
    mime === "text/typescript" ||
    mime === "text/javascript" ||
    mime === "text/css" ||
    mime === "text/html" ||
    mime === "application/json" ||
    mime === "application/x-ndjson" ||
    mime === "application/xml"
  ) return "code";
  if (mime.startsWith("text/")) return "text";
  return "binary";
}

/** Extract a language hint from MIME type for code blocks */
export function langFromMime(mime?: string): string {
  if (!mime) return "";
  const map: Record<string, string> = {
    "text/typescript": "typescript", "text/javascript": "javascript",
    "text/css": "css", "text/html": "html", "text/x-python": "python",
    "text/x-ruby": "ruby", "text/x-go": "go", "text/x-rust": "rust",
    "text/x-java": "java", "text/x-c": "c", "text/x-c++": "cpp",
    "text/x-sql": "sql", "text/x-shellscript": "bash",
    "text/yaml": "yaml", "text/markdown": "markdown",
    "application/json": "json", "application/x-ndjson": "json", "application/xml": "xml",
  };
  return map[mime] ?? "";
}

/** Guess MIME type from file extension */
export function mimeFromPath(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  if (!ext) return undefined;
  const map: Record<string, string> = {
    ts: "text/typescript", tsx: "text/typescript",
    js: "text/javascript", jsx: "text/javascript", mjs: "text/javascript",
    css: "text/css", html: "text/html", htm: "text/html",
    json: "application/json", jsonl: "application/json", xml: "application/xml",
    py: "text/x-python", rb: "text/x-ruby", go: "text/x-go",
    rs: "text/x-rust", java: "text/x-java", c: "text/x-c",
    cpp: "text/x-c++", h: "text/x-c", hpp: "text/x-c++",
    sql: "text/x-sql", sh: "text/x-shellscript", bash: "text/x-shellscript",
    yaml: "text/yaml", yml: "text/yaml",
    md: "text/markdown", mdx: "text/markdown",
    txt: "text/plain", csv: "text/csv", log: "text/plain",
    svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg",
    jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    ico: "image/x-icon", bmp: "image/bmp",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
    mp4: "video/mp4", webm: "video/webm",
    pdf: "application/pdf",
    zip: "application/zip", gz: "application/gzip",
    wasm: "application/wasm",
    toml: "text/plain", env: "text/plain", gitignore: "text/plain",
    dockerfile: "text/plain", makefile: "text/plain",
  };
  return map[ext];
}

// ── Preview state ──

export interface FilePreviewItem {
  label: string;
  path?: string;
  url?: string;
  mimeType?: string;
  size?: number;
  text?: string;
  data?: unknown;
  type?: string;
}

export interface FilePreviewState {
  item: FilePreviewItem;
  content?: string;
  loading: boolean;
  error?: string;
}

// ── Hook for opening file previews ──

export function useFilePreview() {
  const [previewState, setPreviewState] = useState<FilePreviewState | null>(null);

  const openPreview = useCallback(async (item: FilePreviewItem) => {
    const category = previewCategory(item.mimeType);

    // Binary-served types: no content fetch needed
    if (["image", "audio", "video", "pdf"].includes(category)) {
      setPreviewState({ item, loading: false });
      return;
    }

    // Inline text
    if (item.text) {
      setPreviewState({ item, content: item.text, loading: false });
      return;
    }

    // Inline JSON
    if (item.type === "json" && item.data !== undefined) {
      setPreviewState({ item, content: JSON.stringify(item.data, null, 2), loading: false });
      return;
    }

    // External URL (no local path)
    if (!item.path && item.url) {
      setPreviewState({ item, loading: false });
      return;
    }

    if (!item.path) {
      setPreviewState({ item, loading: false, error: "No file path available" });
      return;
    }

    // Fetch content from API
    setPreviewState({ item, loading: true });

    try {
      // HTML files: fetch full content via read endpoint
      if (item.mimeType === "text/html" || /\.html?$/i.test(item.path)) {
        const resp = await fetch(fileReadUrl(item.path));
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const text = await resp.text();
        setPreviewState({ item, content: text, loading: false });
        return;
      }

      // Other text/code files: fetch via preview endpoint
      const resp = await fetch(filePreviewUrl(item.path));
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      if (json.ok && json.data?.content) {
        setPreviewState({ item, content: json.data.content, loading: false });
      } else {
        setPreviewState({ item, loading: false, error: json.error || "Preview not available" });
      }
    } catch (err) {
      setPreviewState({ item, loading: false, error: err instanceof Error ? err.message : "Failed to load preview" });
    }
  }, []);

  const closePreview = useCallback(() => setPreviewState(null), []);

  return { previewState, openPreview, closePreview };
}

// ── Dialog component ──

export function FilePreviewDialog({
  preview,
  onClose,
}: {
  preview: FilePreviewState | null;
  onClose: () => void;
}) {
  const [isFullscreen, setIsFullscreen] = useState(true);

  if (!preview) return null;
  const { item: o, content, loading, error } = preview;
  const category = previewCategory(o.mimeType);
  const readUrl = o.path ? fileReadUrl(o.path) : o.url;
  const downloadUrl = o.path ? fileReadUrl(o.path, true) : o.url;

  const sizeClasses = isFullscreen
    ? "max-w-[calc(100vw-2rem)] sm:max-w-[calc(100vw-2rem)] w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] h-[calc(100vh-2rem)]"
    : "max-w-4xl sm:max-w-4xl w-full max-h-[80vh] h-[80vh]";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className={cn(sizeClasses, "flex flex-col p-0 gap-0 transition-all duration-200")}
      >
        {/* Custom header with all controls */}
        <DialogHeader className="flex flex-row items-center gap-2 px-4 py-2.5 border-b border-border/40 shrink-0">
          <DialogTitle className="text-sm font-medium truncate flex-1">{o.label}</DialogTitle>
          <div className="flex items-center gap-1 shrink-0">
            {o.mimeType && (
              <Badge variant="outline" className="text-[9px]">{o.mimeType}</Badge>
            )}
            {o.size != null && (
              <span className="text-[10px] text-muted-foreground">
                {o.size > 1024 * 1024
                  ? `${(o.size / 1024 / 1024).toFixed(1)} MB`
                  : `${(o.size / 1024).toFixed(1)} KB`}
              </span>
            )}
            <div className="w-px h-4 bg-border/60 mx-1" />
            {downloadUrl && (
              <Button variant="ghost" size="icon" className="h-7 w-7" asChild>
                <a href={downloadUrl} download title="Download">
                  <Download className="h-3.5 w-3.5" />
                </a>
              </Button>
            )}
            <Button
              variant="ghost" size="icon" className="h-7 w-7"
              onClick={() => setIsFullscreen(!isFullscreen)}
              title={isFullscreen ? "Reduce" : "Fullscreen"}
            >
              {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost" size="icon" className="h-7 w-7"
              onClick={onClose}
              title="Close"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </DialogHeader>

        {/* Content area */}
        <div className="flex-1 min-h-0 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-full text-sm text-destructive">{error}</div>
          ) : category === "image" && readUrl ? (
            <div className="flex items-center justify-center h-full p-4 bg-muted/20">
              <img src={readUrl} alt={o.label} className="max-w-full max-h-full object-contain rounded" />
            </div>
          ) : category === "audio" && readUrl ? (
            <div className="flex items-center justify-center p-8">
              <audio controls src={readUrl} className="w-full max-w-2xl" />
            </div>
          ) : category === "video" && readUrl ? (
            <div className="flex items-center justify-center h-full p-4 bg-black">
              <video controls src={readUrl} className="max-w-full max-h-full" />
            </div>
          ) : category === "pdf" && readUrl ? (
            <iframe src={readUrl} className="w-full h-full" title={o.label} />
          ) : (o.mimeType === "text/html" || /\.html?$/i.test(o.path ?? "")) && (content || readUrl) ? (
            <Tabs defaultValue="preview" className="h-full flex flex-col">
              <div className="px-4 pt-2 shrink-0">
                <TabsList className="w-fit">
                  <TabsTrigger value="preview">Preview</TabsTrigger>
                  <TabsTrigger value="code">Code</TabsTrigger>
                </TabsList>
              </div>
              <div className="flex-1 min-h-0">
                <TabsContent value="preview" className="h-full m-0 p-0">
                  <iframe
                    src={readUrl}
                    className="w-full h-full border-0"
                    title={o.label}
                    sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
                  />
                </TabsContent>
                <TabsContent value="code" className="h-full m-0 overflow-auto">
                  <ScrollArea className="h-full">
                    <div className="p-6">
                      <MessageResponse mode="static" className="text-sm">
                        {content ? `\`\`\`html\n${content}\n\`\`\`` : "Loading..."}
                      </MessageResponse>
                    </div>
                  </ScrollArea>
                </TabsContent>
              </div>
            </Tabs>
          ) : (category === "code" || category === "text") && content ? (
            <ScrollArea className="h-full">
              <div className="p-6">
                <MessageResponse mode="static" className="text-sm">
                  {category === "code"
                    ? `\`\`\`${langFromMime(o.mimeType)}\n${content}\n\`\`\``
                    : o.mimeType === "text/markdown" ? content : `\`\`\`\n${content}\n\`\`\``}
                </MessageResponse>
              </div>
            </ScrollArea>
          ) : o.type === "json" && content ? (
            <ScrollArea className="h-full">
              <div className="p-6">
                <MessageResponse mode="static" className="text-sm">
                  {"```json\n" + content + "\n```"}
                </MessageResponse>
              </div>
            </ScrollArea>
          ) : o.text ? (
            <ScrollArea className="h-full">
              <div className="p-6">
                <MessageResponse mode="static" className="text-sm">{o.text}</MessageResponse>
              </div>
            </ScrollArea>
          ) : o.url && !o.path ? (
            <iframe src={o.url} className="w-full h-full" title={o.label} sandbox="allow-same-origin allow-scripts" />
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
              <File className="h-10 w-10" />
              <p className="text-sm">Preview not available for this file type</p>
              {downloadUrl && (
                <Button variant="outline" size="sm" asChild>
                  <a href={downloadUrl} download>
                    <Download className="h-3.5 w-3.5 mr-1.5" /> Download
                  </a>
                </Button>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
