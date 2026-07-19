import { type ReactNode, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  Bell,
  Bot,
  Brain,
  Code2,
  AppWindow,
  Boxes,
  LayoutDashboard,
  ListChecks,
  MessageCircle,
  Monitor,
  Moon,
  ShieldCheck,
  Sun,
  Target,
  Terminal,
  Settings2,
  Workflow,
  MousePointerClick,
  CalendarClock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useTheme } from "@/hooks/use-theme";

/** Single source of truth for mobile nav entries — grouped semantically. */
const NAV_GROUPS: { title: string; items: { to: string; icon: typeof LayoutDashboard; label: string }[] }[] = [
  {
    title: "Workspace",
    items: [
      { to: "/dashboard", icon: LayoutDashboard, label: "Home" },
      { to: "/chat", icon: MessageCircle, label: "Chat" },
      { to: "/tasks", icon: ListChecks, label: "Tasks" },
      { to: "/missions", icon: Target, label: "Missions" },
      { to: "/agents", icon: Bot, label: "Agents" },
    ],
  },
  {
    title: "Build",
    items: [
      { to: "/coding", icon: Code2, label: "Coding" },
      { to: "/apps", icon: Boxes, label: "Apps" },
      { to: "/terminal", icon: Terminal, label: "Terminal" },
      { to: "/browser", icon: AppWindow, label: "App Preview" },
      { to: "/agent-live", icon: MousePointerClick, label: "Browser Automation" },
      { to: "/playbooks", icon: Workflow, label: "Playbooks" },
    ],
  },
  {
    title: "Operate",
    items: [
      { to: "/approvals", icon: ShieldCheck, label: "Approvals" },
      { to: "/notifications", icon: Bell, label: "Notifications" },
      { to: "/schedules", icon: CalendarClock, label: "Schedules" },
      { to: "/memory", icon: Brain, label: "Memory" },
      { to: "/config", icon: Settings2, label: "Config" },
    ],
  },
];

/**
 * Mobile-wide navigation sheet. Any caller can open it by wrapping a trigger:
 *
 *   <MobileNavSheet>
 *     <button>...</button>
 *   </MobileNavSheet>
 *
 * Opens a bottom drawer with all sections grouped (Workspace · Build · Operate).
 * Used by the BottomNav "More" entry AND by the chat-page hamburger when the
 * BottomNav itself is hidden.
 */
export function MobileNavSheet({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const { theme, setTheme } = useTheme();

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>{children}</SheetTrigger>
      <SheetContent
        side="bottom"
        className="rounded-t-2xl pb-safe bg-popover/95 backdrop-blur-xl border-border/40 max-h-[85dvh] overflow-y-auto"
      >
        <SheetHeader className="px-1">
          <SheetTitle className="text-sm font-bold tracking-tight">Navigate</SheetTitle>
        </SheetHeader>
        <div className="space-y-5 px-1 pb-4">
          {NAV_GROUPS.map((group) => (
            <div key={group.title}>
              <div className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">
                {group.title}
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {group.items.map(({ to, icon: Icon, label }) => {
                  const isActive = pathname === to || pathname.startsWith(`${to}/`);
                  return (
                    <NavLink
                      key={to}
                      to={to}
                      onClick={() => setOpen(false)}
                      className={cn(
                        "flex flex-col items-center gap-1.5 rounded-xl p-2.5 text-[11px] font-medium transition-colors",
                        isActive
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground active:bg-accent",
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-10 w-10 items-center justify-center rounded-xl border transition-colors",
                          isActive
                            ? "border-primary/30 bg-primary/10 text-primary"
                            : "border-border/50 bg-muted/50 text-foreground/80",
                        )}
                      >
                        <Icon className="h-5 w-5" />
                      </span>
                      <span className="truncate tracking-wide">{label}</span>
                    </NavLink>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Theme switcher — segmented control, lives at the bottom of the
              drawer so the most-used nav stays at thumb level. */}
          <div>
            <div className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">
              Appearance
            </div>
            <div className="grid grid-cols-3 gap-1.5 rounded-xl bg-muted/40 p-1">
              {(
                [
                  { id: "light" as const, label: "Light", icon: Sun },
                  { id: "dark" as const, label: "Dark", icon: Moon },
                  { id: "system" as const, label: "System", icon: Monitor },
                ]
              ).map(({ id, label, icon: Icon }) => {
                const active = theme === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTheme(id)}
                    className={cn(
                      "flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-medium transition-colors",
                      active
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
