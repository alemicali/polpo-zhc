import { useState, useCallback, useRef, useEffect } from "react";
import {
  fileReadUrl,
  filePreviewUrl,
  mimeFromPath,
  previewCategory,
  type FilePreviewItem,
  type FilePreviewState,
} from "./file-preview-utils";

// ── Hook for opening file previews ──

export function useFilePreview() {
  const [previewState, setPreviewState] = useState<FilePreviewState | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const openPreview = useCallback(async (input: FilePreviewItem) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const item = { ...input, mimeType: input.mimeType ?? mimeFromPath(input.path ?? input.label) };
    const category = previewCategory(item.mimeType, item.path ?? item.label);
    const update = (state: FilePreviewState) => {
      if (!controller.signal.aborted) setPreviewState(state);
    };

    // Binary-served types: no content fetch needed
    if (["image", "audio", "video", "pdf"].includes(category)) {
      setPreviewState({ item, loading: false });
      return;
    }

    // Inline text
    if (item.text !== undefined) {
      setPreviewState({ item, content: item.text, loading: false });
      return;
    }

    // Inline JSON
    if (item.type === "json" && item.data !== undefined) {
      setPreviewState({ item, content: JSON.stringify(item.data, null, 2), loading: false });
      return;
    }

    // Binary/unknown types: skip fetch, let fallback UI handle it
    if (category === "binary") {
      setPreviewState({ item, loading: false });
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
      // Mermaid must not be truncated at the preview endpoint's 500-line limit.
      if (category === "mermaid" || item.mimeType === "text/html" || /\.html?$/i.test(item.path)) {
        if (category === "mermaid" && (item.size ?? 0) > 1024 * 1024) throw new Error("Mermaid file exceeds the 1 MB preview limit. Download it to view the source.");
        const resp = await fetch(fileReadUrl(item.path), { signal: controller.signal });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        if (category === "mermaid" && Number(resp.headers.get("Content-Length")) > 1024 * 1024) throw new Error("Mermaid file exceeds the 1 MB preview limit. Download it to view the source.");
        const text = await resp.text();
        if (category === "mermaid" && text.length > 1024 * 1024) throw new Error("Mermaid file exceeds the 1 MB preview limit. Download it to view the source.");
        update({ item, content: text, loading: false });
        return;
      }

      // Other text/code files: fetch via preview endpoint
      const resp = await fetch(filePreviewUrl(item.path), { signal: controller.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      if (json.ok && typeof json.data?.content === "string") {
        update({ item, content: json.data.content, loading: false });
      } else {
        update({ item, loading: false, error: json.error || "Preview not available" });
      }
    } catch (err) {
      update({ item, loading: false, error: err instanceof Error ? err.message : "Failed to load preview" });
    }
  }, []);

  const closePreview = useCallback(() => {
    request.current?.abort();
    setPreviewState(null);
  }, []);

  return { previewState, openPreview, closePreview };
}
