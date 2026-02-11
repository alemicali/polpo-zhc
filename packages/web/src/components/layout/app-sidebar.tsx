"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ListTodo,
  Map,
  Users,
  ScrollText,
  MessageCircle,
  BookOpen,
  Settings,
  PanelLeft,
  PanelLeftClose,
} from "lucide-react";
import { useOrchestra, useStats } from "@orchestra/react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuBadge,
  SidebarHeader,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { label: "Dashboard", icon: LayoutDashboard, path: "" },
  { label: "Tasks", icon: ListTodo, path: "/tasks" },
  { label: "Plans", icon: Map, path: "/plans" },
  { label: "Team", icon: Users, path: "/team" },
  { label: "Memory", icon: BookOpen, path: "/memory" },
  { label: "Logs", icon: ScrollText, path: "/logs" },
  { label: "Chat", icon: MessageCircle, path: "/chat" },
];

export function AppSidebar({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const { connectionStatus } = useOrchestra();
  const stats = useStats();
  const basePath = `/projects/${projectId}`;

  const settingsHref = `${basePath}/settings`;
  const settingsActive = pathname.startsWith(settingsHref);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="px-3 py-3">
        <LogoToggle
          projectId={projectId}
          connectionStatus={connectionStatus}
        />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => {
                const href = `${basePath}${item.path}`;
                const isActive =
                  item.path === ""
                    ? pathname === basePath
                    : pathname.startsWith(href);

                return (
                  <SidebarMenuItem key={item.label}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      tooltip={item.label}
                    >
                      <Link href={href}>
                        <item.icon className="h-4 w-4" />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                    {item.label === "Tasks" && stats && stats.running > 0 && (
                      <SidebarMenuBadge>{stats.running}</SidebarMenuBadge>
                    )}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={settingsActive}
              tooltip="Settings"
            >
              <Link href={settingsHref}>
                <Settings className="h-4 w-4" />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

/**
 * Logo area with integrated sidebar toggle.
 * - Expanded: logo + "Polpo" + close button (replaces green dot)
 * - Collapsed: just "O" icon, hover reveals expand button
 */
function LogoToggle({
  projectId,
  connectionStatus,
}: {
  projectId: string;
  connectionStatus: string;
}) {
  const { state, toggleSidebar } = useSidebar();
  const expanded = state === "expanded";

  if (expanded) {
    return (
      <div className="flex items-center gap-2">
        <Link
          href={`/projects/${projectId}`}
          className="flex items-center gap-2 flex-1 min-w-0"
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 shrink-0">
            <span className="text-sm font-bold text-primary">O</span>
          </div>
          <span className="font-semibold tracking-tight text-sm">Polpo</span>
        </Link>
        <button
          onClick={toggleSidebar}
          className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shrink-0"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>
    );
  }

  // Collapsed: "O" icon, hover reveals expand toggle
  return (
    <div className="flex justify-center group/logo relative">
      <Link
        href={`/projects/${projectId}`}
        className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 group-hover/logo:opacity-0 transition-opacity"
      >
        <span className="text-sm font-bold text-primary">O</span>
        {/* Connection dot */}
        <span
          className={cn(
            "absolute bottom-0 right-0 h-1.5 w-1.5 rounded-full ring-1 ring-background",
            connectionStatus === "connected"
              ? "bg-status-done"
              : connectionStatus === "reconnecting"
              ? "bg-status-running animate-pulse"
              : "bg-status-failed"
          )}
        />
      </Link>
      {/* Expand button on hover */}
      <button
        onClick={toggleSidebar}
        className="absolute inset-0 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-all opacity-0 group-hover/logo:opacity-100"
      >
        <PanelLeft className="h-4 w-4" />
      </button>
    </div>
  );
}
