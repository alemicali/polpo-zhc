/**
 * The drill-in sidebar's navigation, as a tree of nodes:
 *
 * - a **link** goes to a page (`to`, which may carry a query, e.g. /config?section=providers);
 * - a **group** opens its children as a new level inside the sidebar (a Back row on top); it may
 *   also go to a page when opened (`to`: Chat opens the chat) and may show a custom panel
 *   instead of (or after) its children (`panel`: Chat shows the chat history);
 * - a **section** is a small header between the entries of a level.
 *
 * A top-level node may be **pinned at the bottom** of the sidebar (`pin: "bottom"`: Settings), out of
 * the top level's list, above the connection footer; it opens its level like any other group.
 *
 * Nothing here is specific to two levels: a group's children may hold groups (an agent's tabs,
 * later). The classic sidebar keeps its own list (components/layout/sidebar.tsx);
 * ui/tests/drill-in-nav.test.tsx checks every page it reaches is reachable here too.
 */
import {
  AppWindow,
  Bell,
  Bot,
  Boxes,
  Brain,
  BrainCircuit,
  Briefcase,
  CalendarClock,
  Webhook,
  Scale,
  Images,
  Cloud,
  Code2,
  Columns3,
  Gauge,
  Database,
  FolderOpen,
  Hash,
  Key,
  LayoutDashboard,
  ListChecks,
  type LucideIcon,
  MessageCircle,
  MessagesSquare,
  Monitor,
  MousePointerClick,
  Palette,
  Plug,
  Radio,
  Send,
  Settings2,
  Shapes,
  Shield,
  ShieldCheck,
  Sparkles,
  Target,
  Terminal,
  Users,
  UsersRound,
  Workflow,
  Wrench,
  Box,
  Gavel,
  Cpu,
} from "lucide-react";

/** A count shown next to an entry (filled in by the sidebar). */
export type NavBadge = "approvals";
/** A label shown next to an entry: "beta" (a page still in beta). */
export type NavTag = "beta";
/** A panel a group shows in its level (rendered by the sidebar). */
export type NavPanel = "chat-history" | "coding";

export interface NavLinkNode {
  kind: "link";
  id: string;
  label: string;
  icon: LucideIcon;
  /** The page: a path, optionally with a query (?section=…). */
  to: string;
  badge?: NavBadge;
  tag?: NavTag;
}

export interface NavGroupNode {
  kind: "group";
  id: string;
  label: string;
  icon: LucideIcon;
  /** Entries of the group's level, in order (links, nested groups, section headers). */
  children: NavEntry[];
  /** A page to open together with the level (Chat opens the chat). */
  to?: string;
  /** A panel shown in the level after its entries. */
  panel?: NavPanel;
  badge?: NavBadge;
  tag?: NavTag;
  /** Top level only: shown at the bottom of the sidebar instead of in the list. */
  pin?: "bottom";
}

export interface NavSectionNode {
  kind: "section";
  id: string;
  label: string;
}

export type NavNode = NavLinkNode | NavGroupNode;
export type NavEntry = NavNode | NavSectionNode;

const link = (id: string, label: string, icon: LucideIcon, to: string, badge?: NavBadge): NavLinkNode =>
  ({ kind: "link", id, label, icon, to, ...(badge ? { badge } : {}) });
const section = (id: string, label: string): NavSectionNode => ({ kind: "section", id, label });
const settings = (id: string, label: string, icon: LucideIcon): NavLinkNode => link(`settings-${id}`, label, icon, `/config?section=${id}`);

/** The top level of the drill-in sidebar. */
export const DRILL_IN_NAV: NavNode[] = [
  link("dashboard", "Dashboard", LayoutDashboard, "/dashboard"),
  { kind: "group", id: "chat", label: "Chat", icon: MessageCircle, to: "/chat", panel: "chat-history", children: [] },
  link("approvals", "Approvals", ShieldCheck, "/approvals", "approvals"),
  {
    kind: "group", id: "work", label: "Work", icon: Briefcase, children: [
      link("missions", "Missions", Target, "/missions"),
      link("tasks", "Tasks", ListChecks, "/tasks"),
      link("schedules", "Schedules", CalendarClock, "/schedules"),
      link("triggers", "Triggers", Webhook, "/triggers"),
      link("decisions", "Decisions", Scale, "/decisions"),
      link("media", "Media", Images, "/media"),
      link("playbooks", "Playbooks", Workflow, "/playbooks"),
      link("events", "Events", Radio, "/events"),
    ],
  },
  {
    kind: "group", id: "team", label: "Team", icon: UsersRound, children: [
      link("agents", "Agents", Bot, "/agents"),
      link("benchmarks", "Benchmarks", Gauge, "/benchmarks"),
      link("playground", "Playground", Columns3, "/playground"),
      link("agent-talk", "Agent conversations", MessagesSquare, "/agent-talk"),
      link("skills", "Skills", Sparkles, "/skills"),
      link("memory", "Memory", Brain, "/memory"),
    ],
  },
  {
    kind: "group", id: "content", label: "Content", icon: Shapes, children: [
      { ...link("artifacts", "Artifacts", Shapes, "/artifacts"), tag: "beta" },
      link("files", "Files", FolderOpen, "/files"),
      link("data", "Data", Database, "/data"),
      link("brain", "Company Brain", BrainCircuit, "/brain"),
    ],
  },
  {
    kind: "group", id: "tools", label: "Tools", icon: Wrench, children: [
      // Coding opens its own level: projects → worktrees → sessions (the page has no sidebar of its own)
      { kind: "group", id: "coding", label: "Coding", icon: Code2, to: "/coding", panel: "coding", children: [] },
      link("terminal", "Terminal", Terminal, "/terminal"),
      link("apps", "Apps", Boxes, "/apps"),
      link("browser", "App Preview", AppWindow, "/browser"),
      link("agent-live", "Browser Automation", MousePointerClick, "/agent-live"),
      link("computers", "Computers", Monitor, "/computers"),
    ],
  },
  {
    kind: "group", id: "settings", label: "Settings", icon: Settings2, pin: "bottom", children: [
      section("settings-workspace", "Workspace"),
      settings("general", "General", Hash),
      settings("appearance", "Appearance", Palette),
      settings("members", "Members", Users),
      settings("sync", "Cloud sync", Cloud),
      section("settings-models", "Models & agents"),
      settings("providers", "Providers", Key),
      settings("harnesses", "Harnesses", Cpu),
      settings("decisions", "Decisions", Scale),
      settings("media", "Media", Images),
      // the section configures Polpo itself, the master agent (its id stays "agent")
      settings("agent", "Orchestrator", Bot),
      section("settings-execution", "Execution"),
      settings("sandbox", "Sandbox", Box),
      settings("computers", "Computers", Monitor),
      settings("policies", "Policies", Shield),
      settings("rules", "Rules", Gavel),
      section("settings-integrations", "Integrations"),
      link("connectors", "Connectors", Plug, "/connectors"),
      settings("channels", "Channels", Send),
      settings("mcp", "MCP access", Plug),
      link("notifications", "Notifications", Bell, "/notifications"),
    ],
  },
];

/** The Configuration page's default section (what /config without ?section= shows). */
const CONFIG_DEFAULT_SECTION = "general";

/** Other names a Configuration section answers to in ?section= (the old or the new name). */
export const CONFIG_SECTION_ALIASES: Readonly<Record<string, string>> = { orchestrator: "agent" };

/** The Configuration section a ?section= value names (aliases resolved). */
export function configSectionId(value: string | null | undefined): string | null {
  if (!value) return null;
  return CONFIG_SECTION_ALIASES[value] ?? value;
}

/** The top level's list (without the entries pinned at the bottom). */
export function listedNodes(nodes: NavNode[]): NavNode[] {
  return nodes.filter((node) => !(node.kind === "group" && node.pin));
}

/** The top-level entries pinned at the bottom of the sidebar. */
export function pinnedNodes(nodes: NavNode[]): NavGroupNode[] {
  return nodes.filter((node): node is NavGroupNode => node.kind === "group" && node.pin === "bottom");
}

/** The path part of a link target. */
export function linkPath(to: string): string {
  const q = to.indexOf("?");
  return q === -1 ? to : to.slice(0, q);
}

/** Does a link point at the current page? Paths match themselves and their detail pages; a query must match too. */
export function isLinkActive(to: string, pathname: string, search = ""): boolean {
  const path = linkPath(to);
  if (pathname !== path && !pathname.startsWith(`${path}/`)) return false;
  const q = to.indexOf("?");
  if (q === -1) return true;
  const want = new URLSearchParams(to.slice(q + 1));
  const have = new URLSearchParams(search);
  for (const [key, value] of want) {
    const current = path === "/config" && key === "section"
      ? configSectionId(have.get(key)) ?? CONFIG_DEFAULT_SECTION
      : have.get(key);
    if (current !== value) return false;
  }
  return true;
}

export function isNavNode(entry: NavEntry): entry is NavNode {
  return entry.kind !== "section";
}

/** A group's own entry points at the current page (its `to`, e.g. Chat on /chat). */
function groupOwnsPage(group: NavGroupNode, pathname: string, search: string): boolean {
  return !!group.to && isLinkActive(group.to, pathname, search);
}

/** The groups leading to the current page ([] when nothing in the tree is the current page). */
export function activeTrail(nodes: NavNode[], pathname: string, search = ""): NavGroupNode[] {
  return findActiveTrail(nodes, pathname, search) ?? [];
}

/**
 * The groups leading to the current page, outermost first: on /tasks → [work]; on /chat →
 * [chat]; on /dashboard → [] (the top level); null when the tree has no entry for the page.
 * The sidebar opens at the last one. Links win over groups' own pages; the first match in tree
 * order wins.
 */
export function findActiveTrail(nodes: NavNode[], pathname: string, search = ""): NavGroupNode[] | null {
  const walk = (entries: NavEntry[], trail: NavGroupNode[]): NavGroupNode[] | null => {
    for (const entry of entries) {
      if (entry.kind === "link" && isLinkActive(entry.to, pathname, search)) return trail;
      if (entry.kind === "group") {
        const inner = walk(entry.children, [...trail, entry]);
        if (inner) return inner;
      }
    }
    for (const entry of entries) {
      if (entry.kind === "group" && groupOwnsPage(entry, pathname, search)) return [...trail, entry];
    }
    return null;
  };
  return walk(nodes, []);
}

/** Is a node (a link, or a group holding the current page) on the way to the current page? */
export function isNodeActive(node: NavNode, pathname: string, search = ""): boolean {
  if (node.kind === "link") return isLinkActive(node.to, pathname, search);
  return activeTrail([node], pathname, search).length > 0;
}

/** Find a group anywhere in the tree. */
export function findGroup(nodes: NavEntry[], id: string): NavGroupNode | undefined {
  for (const entry of nodes) {
    if (entry.kind !== "group") continue;
    if (entry.id === id) return entry;
    const inner = findGroup(entry.children, id);
    if (inner) return inner;
  }
  return undefined;
}

/** Every page target the tree reaches (links and groups' own pages). */
export function navTargets(nodes: NavEntry[]): string[] {
  const out: string[] = [];
  for (const entry of nodes) {
    if (entry.kind === "link") out.push(entry.to);
    if (entry.kind === "group") {
      if (entry.to) out.push(entry.to);
      out.push(...navTargets(entry.children));
    }
  }
  return out;
}
