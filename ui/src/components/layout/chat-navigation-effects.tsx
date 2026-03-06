/**
 * ChatNavigationEffects — root-level component that handles navigation side
 * effects triggered by the chat LLM (open_file, navigate_to, open_tab).
 *
 * These effects are lifted out of ChatPage so they fire regardless of which
 * chat surface is active (full page, sidebar, or even none — the provider
 * still holds pending state from SSE events).
 *
 * Mount this component inside any layout that has access to both the
 * ChatProvider context and the react-router navigation.
 */

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useChatState, useChatActions, sidebarActions } from "@/hooks/chat-context";
import { useFilePreview, mimeFromPath, FilePreviewDialog } from "@/components/shared/file-preview";

export function ChatNavigationEffects() {
  const {
    pendingOpenFile,
    pendingNavigateTo,
    pendingOpenTab,
  } = useChatState();
  const {
    consumeOpenFile,
    consumeNavigateTo,
    consumeOpenTab,
  } = useChatActions();

  const navigate = useNavigate();

  // open_file — reuse the same FilePreviewDialog from the file browser
  const { previewState, openPreview, closePreview } = useFilePreview();

  // Auto-open file preview when open_file fires
  useEffect(() => {
    if (!pendingOpenFile) return;
    const filePath = pendingOpenFile.path;
    const basename = filePath.split("/").pop() ?? filePath;
    openPreview({ label: basename, path: filePath, mimeType: mimeFromPath(filePath) });
    // Resume the LLM conversation immediately — user closes the preview when they want
    consumeOpenFile();
  }, [pendingOpenFile, openPreview, consumeOpenFile]);

  // Auto-navigate to any page when navigate_to fires
  useEffect(() => {
    if (!pendingNavigateTo) return;
    const { target, id, name, path, highlight } = pendingNavigateTo;

    let route: string;
    switch (target) {
      case "dashboard":  route = "/dashboard"; break;
      case "tasks":      route = "/tasks"; break;
      case "task":       route = id ? `/tasks/${encodeURIComponent(id)}` : "/tasks"; break;
      case "missions":   route = "/missions"; break;
      case "mission":    route = id ? `/missions/${encodeURIComponent(id)}` : "/missions"; break;
      case "agents":     route = "/agents"; break;
      case "agent":      route = name ? `/agents/${encodeURIComponent(name)}` : "/agents"; break;
      case "skills":     route = "/skills"; break;
      case "skill":      route = name ? `/skills/${encodeURIComponent(name)}` : "/skills"; break;
      case "activity":       route = "/activity"; break;
      case "chat":           route = "/chat"; break;
      case "memory":         route = "/memory"; break;
      case "notifications":  route = "/notifications"; break;
      case "approvals":      route = "/approvals"; break;
      case "templates":      route = "/templates"; break;
      case "config":
      case "settings":       route = "/config"; break;
      case "files": {
        const dir = path ?? ".";
        const params = new URLSearchParams({ path: dir });
        if (highlight) params.set("highlight", highlight);
        route = `/files?${params.toString()}`;
        break;
      }
      default:           route = `/${target}`; break;
    }

    navigate(route);
    // Keep the chat sidebar open so the user can continue the conversation
    if (target !== "chat") {
      sidebarActions.setSidebarOpen(true);
    }
    consumeNavigateTo();
  }, [pendingNavigateTo, navigate, consumeNavigateTo]);

  // Auto-open URL in new tab when open_tab fires
  useEffect(() => {
    if (!pendingOpenTab) return;
    window.open(pendingOpenTab.url, "_blank");
    consumeOpenTab();
  }, [pendingOpenTab, consumeOpenTab]);

  return <FilePreviewDialog preview={previewState} onClose={closePreview} />;
}
