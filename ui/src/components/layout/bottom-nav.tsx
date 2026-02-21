import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  MessageSquare,
  Map,
  ListChecks,
  Bot,
  Activity,
  Brain,
  Bell,
  ShieldCheck,
  Workflow,
  MoreHorizontal,
} from "lucide-react";
import { usePolpo } from "@openpolpo/react-sdk";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

const primaryNav = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Home" },
  { to: "/chat", icon: MessageSquare, label: "Chat" },
  { to: "/plans", icon: Map, label: "Plans" },
  { to: "/tasks", icon: ListChecks, label: "Tasks" },
  { to: "/agents", icon: Bot, label: "Agents" },
];

const secondaryNav = [
  { to: "/activity", icon: Activity, label: "Activity" },
  { to: "/memory", icon: Brain, label: "Memory" },
  { to: "/notifications", icon: Bell, label: "Notifications" },
  { to: "/approvals", icon: ShieldCheck, label: "Approvals" },
  { to: "/workflows", icon: Workflow, label: "Workflows" },
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
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 pb-safe px-safe">
        <div className="flex h-16 items-stretch">
        {primaryNav.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                "flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] min-h-[44px] transition-colors relative",
                isActive
                  ? "text-primary"
                  : "text-muted-foreground active:text-primary/70"
              )
            }
          >
            {({ isActive }) => (
              <>
                <Icon className="h-5 w-5" />
                <span>{label}</span>
                {to === "/dashboard" && connectionStatus === "connected" && (
                  <span className="absolute top-2 right-1/2 translate-x-4 h-1.5 w-1.5 rounded-full bg-emerald-500" />
                )}
                {isActive && (
                  <span className="absolute top-0 left-1/2 -translate-x-1/2 h-0.5 w-8 rounded-full bg-primary" />
                )}
              </>
            )}
          </NavLink>
        ))}

        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          className={cn(
            "flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] min-h-[44px] transition-colors relative",
            isSecondaryActive
              ? "text-primary"
              : "text-muted-foreground active:text-primary/70"
          )}
        >
          <MoreHorizontal className="h-5 w-5" />
          <span>More</span>
          {isSecondaryActive && (
            <span className="absolute top-0 left-1/2 -translate-x-1/2 h-0.5 w-8 rounded-full bg-primary" />
          )}
        </button>
        </div>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="rounded-t-2xl pb-safe">
          <SheetHeader>
            <SheetTitle className="text-sm">More</SheetTitle>
          </SheetHeader>
          <div className="grid grid-cols-3 gap-4 px-4 pb-6">
            {secondaryNav.map(({ to, icon: Icon, label }) => (
              <NavLink
                key={to}
                to={to}
                onClick={() => setMoreOpen(false)}
                className={({ isActive }) =>
                  cn(
                    "flex flex-col items-center gap-2 rounded-xl p-3 text-xs transition-colors",
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground active:bg-muted"
                  )
                }
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-muted">
                  <Icon className="h-5 w-5" />
                </div>
                {label}
              </NavLink>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
