/**
 * ChatSidebar — a right-side panel that renders the full ChatPage component.
 *
 * This is a zero-refactor wrapper: ChatPage is rendered exactly as-is inside a
 * resizable right panel. The panel auto-hides when the user is on /chat (since
 * the full-page chat is already visible). State is shared via ChatProvider context.
 */

import { lazy, Suspense } from "react";
import { useLocation } from "react-router-dom";
import { useChatContext } from "@/hooks/chat-context";
import { Loader2 } from "lucide-react";

// Lazy-load ChatPage so it stays code-split (same as the route in app.tsx)
const ChatPage = lazy(() =>
  import("@/pages/chat").then((m) => ({ default: m.ChatPage }))
);

function SidebarLoader() {
  return (
    <div className="flex items-center justify-center flex-1">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}

export function ChatSidebar() {
  const { sidebarOpen } = useChatContext();
  const { pathname } = useLocation();

  // Auto-hide on /chat — the full-page chat is already visible
  const isOnChatPage = pathname === "/chat";
  const visible = sidebarOpen && !isOnChatPage;

  if (!visible) return null;

  return (
    <div className="hidden lg:flex flex-col border-l border-border/50 bg-background w-[480px] shrink-0 h-full overflow-hidden">
      {/* Provide the padding that ChatPage's negative margins expect to cancel */}
      <div className="flex flex-col flex-1 min-h-0 p-4 lg:p-6 pb-2 lg:pb-3">
        <Suspense fallback={<SidebarLoader />}>
          <ChatPage />
        </Suspense>
      </div>
    </div>
  );
}
