import { Outlet } from "react-router-dom";
import { Sidebar } from "./sidebar";
import { Header } from "./header";
import { BottomNav } from "./bottom-nav";
import { ChatSidebar } from "./chat-sidebar";
import { ChatNavigationEffects } from "./chat-navigation-effects";

export function AppLayout() {
  return (
    <div className="flex h-[100dvh] w-screen overflow-hidden bg-background text-foreground">
      {/* Desktop sidebar with deep-sea gradient */}
      <div className="hidden lg:flex">
        <Sidebar />
      </div>
      <div className="flex flex-1 flex-col overflow-hidden min-w-0">
        <Header />
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <main className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden p-4 lg:p-6 pb-2 lg:pb-3">
            <Outlet />
          </main>
          <ChatSidebar />
        </div>
      </div>
      <BottomNav />
      {/* Root-level chat navigation effects (open_file, navigate_to, open_tab) */}
      <ChatNavigationEffects />
    </div>
  );
}
