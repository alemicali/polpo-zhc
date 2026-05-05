/**
 * ChatSidebar — a right-side panel that renders an explicit compact variant
 * of the chat UI.
 *
 * Uses ChatPage with `compact` prop — no session sidebar, no negative margin
 * hacks. The panel auto-hides when the user is on /chat (since the full-page
 * chat is already visible). State is shared via ChatProvider context.
 */

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useLocation } from "react-router-dom";
import { useSidebarOpen } from "@/hooks/chat-context";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputSubmit,
} from "@/components/ai-elements/prompt-input";

// Lazy-load ChatPage so it stays code-split (same as the route in app.tsx)
const ChatPage = lazy(() =>
  import("@/pages/chat").then((m) => ({ default: m.ChatPage }))
);

const CHAT_SIDEBAR_WIDTH_KEY = "polpo-chat-sidebar-width";
const CHAT_SIDEBAR_DEFAULT_WIDTH = 480;
const CHAT_SIDEBAR_MIN_WIDTH = 380;
const CHAT_SIDEBAR_MAX_WIDTH = 760;

const clampSidebarWidth = (value: number) => {
  const viewportCap = typeof window === "undefined"
    ? CHAT_SIDEBAR_MAX_WIDTH
    : Math.max(CHAT_SIDEBAR_MIN_WIDTH, Math.min(CHAT_SIDEBAR_MAX_WIDTH, window.innerWidth - 520));
  return Math.min(Math.max(value, CHAT_SIDEBAR_MIN_WIDTH), viewportCap);
};

const readStoredSidebarWidth = () => {
  if (typeof window === "undefined") return CHAT_SIDEBAR_DEFAULT_WIDTH;
  const parsed = Number(localStorage.getItem(CHAT_SIDEBAR_WIDTH_KEY));
  return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : CHAT_SIDEBAR_DEFAULT_WIDTH;
};

/**
 * Suspense fallback — matches the ChatLoadingSkeleton layout so there's no
 * visual shift when the JS chunk finishes loading.
 * The prompt input is real (disabled) so the user always sees a consistent UI.
 */
function SidebarSkeleton() {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Toolbar skeleton */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border/40 shrink-0">
        <Skeleton className="h-7 w-7 rounded-md" />
        <Skeleton className="h-7 w-7 rounded-md" />
        <Skeleton className="h-4 w-32 rounded" />
        <div className="flex-1" />
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>

      {/* Messages skeleton */}
      <div className="flex-1 overflow-hidden">
        <div className="mx-auto max-w-3xl p-4 space-y-6">
          <div className="flex justify-end">
            <Skeleton className="h-10 w-48 rounded-2xl rounded-br-sm" />
          </div>
          <div className="flex gap-3">
            <Skeleton className="h-7 w-7 rounded-full shrink-0" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-16 rounded" />
              <Skeleton className="h-4 w-full rounded" />
              <Skeleton className="h-4 w-3/4 rounded" />
              <Skeleton className="h-4 w-5/6 rounded" />
            </div>
          </div>
          <div className="flex justify-end">
            <Skeleton className="h-10 w-36 rounded-2xl rounded-br-sm" />
          </div>
          <div className="flex gap-3">
            <Skeleton className="h-7 w-7 rounded-full shrink-0" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-16 rounded" />
              <Skeleton className="h-4 w-full rounded" />
              <Skeleton className="h-4 w-2/3 rounded" />
            </div>
          </div>
        </div>
      </div>

      {/* Real prompt input — disabled during loading */}
      <div className="bg-background/80 backdrop-blur-md px-4 pt-2 pb-1.5 shrink-0">
        <div className="mx-auto max-w-3xl">
          <PromptInput onSubmit={() => {}} className="[&_[data-slot=input-group]]:rounded-[calc(var(--radius)+8px)]">
            <PromptInputTextarea placeholder="Message Polpo..." disabled />
            <PromptInputFooter>
              <div className="flex items-center gap-1" />
              <PromptInputSubmit disabled />
            </PromptInputFooter>
          </PromptInput>
          <p className="text-[10px] text-muted-foreground text-center mt-0.5">
            @ to mention · Enter to send · Shift+Enter for new line.
          </p>
        </div>
      </div>
    </div>
  );
}

export function ChatSidebar() {
  const sidebarOpen = useSidebarOpen();
  const { pathname } = useLocation();
  const [width, setWidth] = useState(readStoredSidebarWidth);

  // Auto-hide on /chat — the full-page chat is already visible
  const isOnChatPage = pathname === "/chat";
  const visible = sidebarOpen && !isOnChatPage;

  useEffect(() => {
    localStorage.setItem(CHAT_SIDEBAR_WIDTH_KEY, String(width));
  }, [width]);

  const startResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handlePointerMove = (moveEvent: PointerEvent) => {
      setWidth(clampSidebarWidth(startWidth + startX - moveEvent.clientX));
    };

    const stopResize = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }, [width]);

  if (!visible) return null;

  return (
    <div
      className="relative hidden lg:flex flex-col shrink-0 h-full py-2 pr-2"
      style={{ width }}
    >
      <button
        type="button"
        aria-label="Resize chat sidebar"
        onPointerDown={startResize}
        className="absolute inset-y-3 -left-1 z-20 w-2 cursor-col-resize rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary/40 group"
      >
        <span className="absolute inset-y-2 left-1/2 w-px -translate-x-1/2 rounded-full bg-border transition-all group-hover:w-[3px] group-hover:bg-primary/40" />
      </button>
      <div className="flex flex-col flex-1 min-h-0 rounded-xl border bg-card/50 overflow-hidden">
        <Suspense fallback={<SidebarSkeleton />}>
          <ChatPage compact />
        </Suspense>
      </div>
    </div>
  );
}
