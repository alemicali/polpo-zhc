import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  MessageCircle,
  Target,
  ListChecks,
  Bot,
  Brain,
  Bell,
  ShieldCheck,
  Workflow,
  Settings2,
  Terminal,
  Code2,
  MoreHorizontal,

} from "lucide-react";
import { usePolpo } from "@polpo-ai/react";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

const primaryNav = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Home" },
  { to: "/chat", icon: MessageCircle, label: "Chat" },
  { to: "/missions", icon: Target, label: "Missions" },
  { to: "/tasks", icon: ListChecks, label: "Tasks" },
  { to: "/agents", icon: Bot, label: "Agents" },
];

const secondaryNav = [
  { to: "/memory", icon: Brain, label: "Memory" },
  { to: "/notifications", icon: Bell, label: "Notifications" },
  { to: "/approvals", icon: ShieldCheck, label: "Approvals" },
  { to: "/playbooks", icon: Workflow, label: "Playbooks" },
  { to: "/coding", icon: Code2, label: "Coding" },
  { to: "/terminal", icon: Terminal, label: "Terminal" },
  { to: "/config", icon: Settings2, label: "Config" },
];

export function BottomNav() {
  const { pathname } = useLocation();
  const { connectionStatus } = usePolpo();
  const [moreOpen, setMoreOpen] = useState(false);

  const isSecondaryActive = secondaryNav.some((n) =>
    pathname.startsWith(n.to)
  );

  return (
    <>
      <nav className="fixed inset-x-3 z-50 mx-auto max-w-md rounded-3xl border border-white/10 bg-background/88 p-1 shadow-[0_18px_60px_oklch(0_0_0_/_45%),0_0_0_1px_oklch(1_0_0_/_5%)] backdrop-blur-2xl supports-[backdrop-filter]:bg-background/72 lg:hidden bottom-[var(--mobile-nav-offset)]">
        <div className="flex h-[3.55rem] items-center">
          {primaryNav.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  "relative flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl px-1 text-[10px] font-medium transition-all duration-200",
                  isActive
                    ? "bg-primary text-primary-foreground shadow-[0_10px_24px_oklch(0.7_0.15_200_/_22%)]"
                    : "text-muted-foreground active:scale-95 active:text-primary"
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon className={cn("h-5 w-5", isActive && "drop-shadow-[0_0_8px_oklch(1_0_0_/_26%)]")} />
                  <span className="max-w-full truncate tracking-wide">{label}</span>
                  {to === "/dashboard" && connectionStatus === "connected" && (
                    <span className="absolute top-2 right-1/2 h-1.5 w-1.5 translate-x-4 rounded-full bg-teal-400 bio-pulse" />
                  )}
                </>
              )}
            </NavLink>
          ))}

          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            className={cn(
              "relative flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl px-1 text-[10px] font-medium transition-all duration-200",
              isSecondaryActive
                ? "bg-primary text-primary-foreground shadow-[0_10px_24px_oklch(0.7_0.15_200_/_22%)]"
                : "text-muted-foreground active:scale-95 active:text-primary"
            )}
          >
            <MoreHorizontal className="h-5 w-5" />
            <span className="tracking-wide">More</span>
          </button>
        </div>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent
          side="bottom"
          className="rounded-t-2xl pb-safe bg-popover/95 backdrop-blur-xl border-border/40"
        >
          <SheetHeader>
            <SheetTitle className="text-sm font-bold tracking-tight">
              More
            </SheetTitle>
          </SheetHeader>
          <div className="grid grid-cols-3 gap-3 px-4 pb-6">
            {secondaryNav.map(({ to, icon: Icon, label }) => (
              <NavLink
                key={to}
                to={to}
                onClick={() => setMoreOpen(false)}
                className={({ isActive }) =>
                  cn(
                    "flex flex-col items-center gap-2.5 rounded-xl p-3 text-xs font-medium transition-all duration-200",
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-accent/50 active:bg-accent"
                  )
                }
              >
                <div
                  className={cn(
                    "flex h-12 w-12 items-center justify-center rounded-xl border border-border/50 transition-all",
                    "bg-muted/50"
                  )}
                >
                  <Icon className="h-5 w-5" />
                </div>
                <span className="tracking-wide">{label}</span>
              </NavLink>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
