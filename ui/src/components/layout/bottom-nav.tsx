import { NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  ListChecks,
  MessageCircle,
  MoreHorizontal,
} from "lucide-react";
import { usePolpo } from "@polpo-ai/react";
import { cn } from "@/lib/utils";
import { MobileNavSheet } from "./mobile-nav-sheet";

/**
 * Compact 4-slot bottom nav (Home · Chat · Tasks · More) — phone-first.
 * Hidden on /chat to give the conversation a true full-screen feel à la
 * Claude/ChatGPT mobile apps; on those pages the chat header surfaces a
 * hamburger that opens the same nav drawer.
 */
const PRIMARY_NAV = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Home" },
  { to: "/chat", icon: MessageCircle, label: "Chat" },
  { to: "/tasks", icon: ListChecks, label: "Tasks" },
];

const HIDDEN_ON: (string | RegExp)[] = [/^\/chat(\/|$)/, /^\/coding(\/|$)/];

export function BottomNav() {
  const { pathname } = useLocation();
  const { connectionStatus } = usePolpo();

  const hidden = HIDDEN_ON.some((rule) =>
    typeof rule === "string" ? pathname === rule : rule.test(pathname),
  );
  if (hidden) return null;

  return (
    <nav
      className={cn(
        "fixed inset-x-3 z-50 mx-auto max-w-md rounded-3xl border border-white/10 bg-background/88",
        "shadow-[0_18px_60px_oklch(0_0_0_/_45%),0_0_0_1px_oklch(1_0_0_/_5%)]",
        "backdrop-blur-2xl supports-[backdrop-filter]:bg-background/72",
        "lg:hidden bottom-[var(--mobile-nav-offset)] p-1",
      )}
    >
      <div className="flex h-[3.55rem] items-center">
        {PRIMARY_NAV.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                "relative flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl px-1 text-[10px] font-medium transition-all duration-200",
                isActive
                  ? "bg-primary text-primary-foreground shadow-[0_10px_24px_oklch(0.7_0.15_200_/_22%)]"
                  : "text-muted-foreground active:scale-95 active:text-primary",
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

        <MobileNavSheet>
          <button
            type="button"
            className={cn(
              "relative flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl px-1 text-[10px] font-medium transition-all duration-200",
              "text-muted-foreground active:scale-95 active:text-primary",
            )}
          >
            <MoreHorizontal className="h-5 w-5" />
            <span className="tracking-wide">More</span>
          </button>
        </MobileNavSheet>
      </div>
    </nav>
  );
}
