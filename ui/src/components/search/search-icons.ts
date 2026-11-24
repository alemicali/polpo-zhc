/**
 * The icon of each kind of search result (files and folders, tables and views differ from their
 * type's). Kept apart from the components (fast refresh wants component-only modules).
 */
import {
  AppWindow, Bell, Bot, Boxes, Brain, BrainCircuit, CalendarClock, Database, File, FileText, Folder, LayoutGrid, ListChecks,
  MessageCircle, Monitor, Plug, Send, Shapes, ShieldCheck, Sparkles, Table2, Target, Terminal, Users, UsersRound, Workflow,
  type LucideIcon,
} from "lucide-react";
import type { SearchType } from "@polpo-ai/react";

export type ResultKind = SearchType | "page" | "action";

export const TYPE_ICONS: Record<ResultKind, LucideIcon> = {
  chat: MessageCircle, room: UsersRound, agent: Bot, task: ListChecks, mission: Target, schedule: CalendarClock, playbook: Workflow,
  approval: ShieldCheck, artifact: Shapes, file: FileText, data: Database, connector: Plug, skill: Sparkles, memory: Brain,
  brain: BrainCircuit, computer: Monitor, app: Boxes, channel: Send, member: Users, event: Bell, page: LayoutGrid, action: Terminal,
};

export function iconFor(kind: ResultKind, meta?: Record<string, unknown>): LucideIcon {
  if (kind === "file") return meta?.kind === "directory" ? Folder : File;
  if (kind === "data") return meta?.kind === "table" ? Table2 : meta?.kind === "view" ? AppWindow : Database;
  return TYPE_ICONS[kind];
}
