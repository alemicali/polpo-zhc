import { Outlet } from "react-router-dom";
import { Sidebar } from "./sidebar";
import { Header } from "./header";
import { BottomNav } from "./bottom-nav";

export function AppLayout() {
  return (
    <div className="flex h-[100dvh] w-screen overflow-hidden bg-background text-foreground">
      {/* Desktop sidebar with deep-sea gradient */}
      <div className="hidden lg:flex">
        <Sidebar />
      </div>
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <main className="flex-1 flex flex-col min-h-0 overflow-hidden p-4 lg:p-6 pb-2 lg:pb-3">
          <Outlet />
        </main>
      </div>
      <BottomNav />
    </div>
  );
}
