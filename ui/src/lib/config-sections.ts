/**
 * The Configuration page's sections (ids are kept forever: links use /config?section=<id>), the
 * aliases ?section= also answers to, and whether the sidebar lists them (the drill-in sidebar in
 * the sidebar layout: the page then shows the section's title instead of its own tab bar).
 */
import {
  Bell,
  Bot,
  Box as SandboxIcon,
  Cloud as CloudIcon,
  Hash,
  Key,
  Monitor,
  Palette as PaletteIcon,
  Plug,
  Scale,
  Send,
  Shield,
  Users,
} from "lucide-react";
import { configSectionId } from "@/lib/nav-tree";
import { useSidebarStyle } from "@/hooks/use-sidebar-style";
import { useLayoutMode } from "@/hooks/use-layout-mode";

export const baseSections = [
  { id: "general", label: "General", icon: Hash },
  { id: "members", label: "Members", icon: Users },
  // Polpo itself, the master agent (the id, and ?section=agent, stay; ?section=orchestrator works too)
  { id: "agent", label: "Orchestrator", icon: Bot },
  { id: "providers", label: "Providers", icon: Key },
  { id: "channels", label: "Channels", icon: Send },
  { id: "rules", label: "Rules", icon: Bell },
  { id: "policies", label: "Policies", icon: Shield },
  { id: "sandbox", label: "Sandbox", icon: SandboxIcon },
  { id: "harnesses", label: "Harnesses", icon: Bot },
  { id: "decisions", label: "Decisions", icon: Scale },
  { id: "computers", label: "Computers", icon: Monitor },
  { id: "mcp", label: "MCP access", icon: Plug },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "sync", label: "Cloud sync", icon: CloudIcon },
] as const;

export type ConfigSectionId = (typeof baseSections)[number]["id"];

/** The section a ?section= value names (its id, or an alias such as orchestrator → agent). */
export function findConfigSection(value: string | null | undefined): ConfigSectionId | undefined {
  const id = configSectionId(value);
  return baseSections.find((section) => section.id === id)?.id;
}

/** Does the sidebar list the sections (the drill-in sidebar, in the sidebar layout)? */
export function useConfigSectionsInSidebar(): boolean {
  const sidebarStyle = useSidebarStyle();
  const layoutMode = useLayoutMode();
  return sidebarStyle === "drill-in" && layoutMode === "sidebar";
}
