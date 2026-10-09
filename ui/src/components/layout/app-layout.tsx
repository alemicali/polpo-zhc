import { useLocation } from "react-router-dom";
import { Sidebar } from "./sidebar";
import { Header } from "./header";
import { BottomNav } from "./bottom-nav";
import { ChatSidebar } from "./chat-sidebar";
import { ChatNavigationEffects } from "./chat-navigation-effects";
import { ChatRoomRouteSync } from "./chat-room-route-sync";
import { ChatFirstLayout } from "./chat-first-layout";
import { PersistentPageOutlet } from "./persistent-page-outlet";
import { useLayoutMode } from "@/hooks/use-layout-mode";
import { WhatsNewBar } from "@/components/whats-new/whats-new-bar";
import { WhatsNewDrawer } from "@/components/whats-new/whats-new-drawer";

/** Tool surfaces that should meet the surrounding pane edges. */
function hasNoPagePadding(pathname: string): boolean {
  return pathname === "/chat"
    || pathname === "/coding"
    || pathname.startsWith("/coding/")
    || pathname === "/terminal"
    || pathname === "/browser"
    || pathname === "/agent-live"
    || pathname.startsWith("/apps/");
}

export function AppLayout() {
  const layoutMode = useLayoutMode();
  const { pathname } = useLocation();
  const noPagePadding = hasNoPagePadding(pathname);

  // Both branches return a root <div> so React reconciles without remounting.
  // The key ensures each layout mode has a stable identity.

  if (layoutMode === "chat-first") {
    return (
      <div className="flex h-[100dvh] w-full max-w-full flex-col overflow-hidden bg-background text-foreground">
        <WhatsNewBar />
        <div className="flex min-h-0 w-full flex-1 overflow-hidden">
          <ChatFirstLayout />
        </div>
        <BottomNav />
        <ChatNavigationEffects />
        <WhatsNewDrawer />
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] w-full max-w-full overflow-hidden bg-background text-foreground">
      <div className="hidden lg:flex">
        <Sidebar />
      </div>
      <div className="flex flex-1 flex-col overflow-hidden min-w-0">
        <WhatsNewBar />
        <Header />
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <main
            className={noPagePadding
              ? "flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden"
              : "flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden p-4 lg:p-6 pb-2 lg:pb-3"}
          >
            <PersistentPageOutlet />
          </main>
          <ChatSidebar />
        </div>
      </div>
      <BottomNav />
      <ChatNavigationEffects />
      <ChatRoomRouteSync />
      <WhatsNewDrawer />
    </div>
  );
}
