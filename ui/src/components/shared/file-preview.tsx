"use client";

import { useState } from "react";
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
import { MermaidFilePreview } from "./mermaid-file-preview";
import {
  fileReadUrl,
  langFromMime,
  previewCategory,
  type FilePreviewItem,
  type FilePreviewState,
} from "./file-preview-utils";

// ── Preview content resolver ──
// Replaces deeply nested ternary chain with early-return pattern.

function PreviewContent({
  loading,
  error,
  category,
  readUrl,
  downloadUrl,
  content,
  item: o,
}: {
  loading: boolean;
  error?: string;
  category: ReturnType<typeof previewCategory>;
  readUrl?: string;
  downloadUrl?: string;
  content?: string;
  item: FilePreviewItem;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <File className="h-10 w-10" />
        <p className="text-sm">{error}</p>
        {downloadUrl && (
          <Button variant="outline" size="sm" asChild>
            <a href={downloadUrl} download>
              <Download className="h-3.5 w-3.5 mr-1.5" /> Download
            </a>
          </Button>
        )}
      </div>
    );
  }

  if (category === "mermaid" && content !== undefined) {
    return <MermaidFilePreview key={o.path ?? o.label} content={content} />;
  }

  // Media types served directly from URL
  if (category === "image" && readUrl) {
    return (
      <div className="flex items-center justify-center h-full p-4 bg-muted/20">
        <img src={readUrl} alt={o.label} className="max-w-full max-h-full object-contain rounded" />
      </div>
    );
  }

  if (category === "audio" && readUrl) {
    return (
      <div className="flex items-center justify-center p-8">
        <audio controls src={readUrl} className="w-full max-w-2xl" />
      </div>
    );
  }

  if (category === "video" && readUrl) {
    return (
      <div className="flex items-center justify-center h-full p-4 bg-black">
        <video controls src={readUrl} className="max-w-full max-h-full" />
      </div>
    );
  }

  if (category === "pdf" && readUrl) {
    return <iframe src={readUrl} className="w-full h-full" title={o.label} />;
  }

  // HTML files: dual preview/code tab
  if ((o.mimeType === "text/html" || /\.html?$/i.test(o.path ?? "")) && (content || readUrl)) {
    return (
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
    );
  }

  // Code and text files
  if ((category === "code" || category === "text") && content) {
    const formatted = category === "code"
      ? `\`\`\`${langFromMime(o.mimeType)}\n${content}\n\`\`\``
      : o.mimeType === "text/markdown" ? content : `\`\`\`\n${content}\n\`\`\``;
    return (
      <ScrollArea className="h-full">
        <div className="p-6">
          <MessageResponse mode="static" className="text-sm">{formatted}</MessageResponse>
        </div>
      </ScrollArea>
    );
  }

  // Inline JSON
  if (o.type === "json" && content) {
    return (
      <ScrollArea className="h-full">
        <div className="p-6">
          <MessageResponse mode="static" className="text-sm">
            {"```json\n" + content + "\n```"}
          </MessageResponse>
        </div>
      </ScrollArea>
    );
  }

  // Plain text fallback
  if (o.text) {
    return (
      <ScrollArea className="h-full">
        <div className="p-6">
          <MessageResponse mode="static" className="text-sm">{o.text}</MessageResponse>
        </div>
      </ScrollArea>
    );
  }

  // External URL with no local path — iframe
  if (o.url && !o.path) {
    return <iframe src={o.url} className="w-full h-full" title={o.label} sandbox="allow-same-origin allow-scripts" />;
  }

  // Fallback: binary / unknown
  return (
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
  );
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
  const category = previewCategory(o.mimeType, o.path ?? o.label);
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
          <PreviewContent
            loading={loading}
            error={error}
            category={category}
            readUrl={readUrl}
            downloadUrl={downloadUrl}
            content={content}
            item={o}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
