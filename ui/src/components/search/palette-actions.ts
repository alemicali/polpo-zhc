/**
 * The commands the search palette runs (the ">" prefix): start a chat, a task, a mission or an
 * agent with Polpo, a group, switch the theme or the sidebar, open a Settings section…
 *
 * Commands that take words ("New task …") read them from the query: "> new task fix the login"
 * runs New task with "fix the login". Picked without words, the palette waits for them.
 */
import { Megaphone, MessageSquarePlus, Moon, PanelLeft, Settings2, Sun, Target, Trash2, UserPlus, UsersRound, ListPlus, type LucideIcon } from "lucide-react";
import { foldText, localMatch, pageEntries, type PageEntry } from "@/lib/global-search";
import type { SearchRange } from "@polpo-ai/react";

export interface PaletteContext {
  navigate: (to: string) => void;
  /** Start a new chat with Polpo, optionally sending a first message. */
  newChat: (firstMessage?: string) => void;
  newGroup: () => void;
  theme: "light" | "dark";
  setTheme: (t: "light" | "dark" | "system") => void;
  sidebarStyle: "classic" | "drill-in";
  setSidebarStyle: (s: "classic" | "drill-in") => void;
  openWhatsNew: () => void;
  clearRecents: () => void;
}

export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  keywords?: string;
  /** Takes words after its name (what the task / mission / agent is about). */
  argument?: { placeholder: string };
  run: (ctx: PaletteContext, argument?: string) => void;
}

export function paletteActions(ctx: Pick<PaletteContext, "theme" | "sidebarStyle">, pages: PageEntry[] = pageEntries()): PaletteAction[] {
  const actions: PaletteAction[] = [
    {
      id: "new-chat", label: "New chat", hint: "A new conversation with Polpo", icon: MessageSquarePlus, keywords: "conversation talk ask polpo",
      argument: { placeholder: "your first message (optional)" },
      run: (c, arg) => c.newChat(arg || undefined),
    },
    {
      id: "new-task", label: "New task", hint: "Ask Polpo to create a task", icon: ListPlus, keywords: "create add todo",
      argument: { placeholder: "what the task is about" },
      run: (c, arg) => c.newChat(arg ? `Create a task: ${arg}` : undefined),
    },
    {
      id: "new-mission", label: "New mission", hint: "Ask Polpo to plan a mission", icon: Target, keywords: "create plan project",
      argument: { placeholder: "the goal of the mission" },
      run: (c, arg) => c.newChat(arg ? `Plan a mission: ${arg}` : undefined),
    },
    {
      id: "new-agent", label: "New agent", hint: "Ask Polpo to add an agent to the team", icon: UserPlus, keywords: "create hire team member",
      argument: { placeholder: "the role of the agent" },
      run: (c, arg) => c.newChat(arg ? `Add an agent to the team: ${arg}` : undefined),
    },
    { id: "new-group", label: "New group", hint: "A group chat with people and agents", icon: UsersRound, keywords: "room create", run: (c) => c.newGroup() },
    ctx.theme === "dark"
      ? { id: "theme", label: "Switch to light theme", icon: Sun, keywords: "toggle theme appearance mode", run: (c) => c.setTheme("light") }
      : { id: "theme", label: "Switch to dark theme", icon: Moon, keywords: "toggle theme appearance mode", run: (c) => c.setTheme("dark") },
    { id: "theme-system", label: "Use the system theme", icon: Moon, keywords: "toggle theme appearance mode auto", run: (c) => c.setTheme("system") },
    ctx.sidebarStyle === "drill-in"
      ? { id: "sidebar", label: "Switch to the classic sidebar", icon: PanelLeft, keywords: "navigation menu layout", run: (c) => c.setSidebarStyle("classic") }
      : { id: "sidebar", label: "Switch to the drill-in sidebar", icon: PanelLeft, keywords: "navigation menu layout", run: (c) => c.setSidebarStyle("drill-in") },
    { id: "whats-new", label: "What's new", hint: "The latest changes", icon: Megaphone, keywords: "novità changelog release", run: (c) => c.openWhatsNew() },
    { id: "clear-recents", label: "Clear recent searches", icon: Trash2, keywords: "history forget", run: (c) => c.clearRecents() },
  ];
  // every Settings section as "Open … settings"
  for (const p of pages) {
    if (!p.to.startsWith("/config")) continue;
    actions.push({ id: `settings-${p.id}`, label: `Open ${p.label} settings`, icon: p.icon ?? Settings2, keywords: `settings configuration ${p.section}`, run: (c) => c.navigate(p.to) });
  }
  return actions;
}

export interface MatchedAction {
  action: PaletteAction;
  /** Words typed after the command's name. */
  argument?: string;
  score: number;
  highlights: SearchRange[];
}

/** Commands for the typed text, best first; "new task fix login" → New task with "fix login". */
export function matchActions(actions: PaletteAction[], text: string): MatchedAction[] {
  const folded = foldText(text).trim();
  const out: MatchedAction[] = [];
  for (const action of actions) {
    const name = foldText(action.label);
    if (action.argument && folded.startsWith(`${name} `)) {
      const argument = text.trim().slice(action.label.length).trim();
      out.push({ action, argument, score: 10, highlights: [[0, action.label.length]] });
      continue;
    }
    const m = localMatch(text, action.label, action.keywords);
    if (m.score) out.push({ action, score: m.score, highlights: m.highlights });
  }
  return out.sort((a, b) => b.score - a.score);
}
