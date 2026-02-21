import { Outlet } from "react-router-dom";
import { Sidebar } from "./sidebar";
import { Header } from "./header";
import { BottomNav } from "./bottom-nav";

export function AppLayout() {
  return (
    <div className="flex h-[100dvh] w-screen overflow-hidden bg-background text-foreground">
      <div className="hidden lg:flex">
        <Sidebar />
      </div>
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <main className="flex-1 flex flex-col overflow-hidden p-4 lg:p-6 pb-bottom-nav lg:pb-6">
          <Outlet />
        </main>
      </div>
      <BottomNav />
    </div>
  );
}
