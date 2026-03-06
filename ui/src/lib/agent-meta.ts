/**
 * Shared constants and utility functions for agent-related UI.
 *
 * Extracted from agent-detail.tsx to enable reuse across
 * agent-detail, agents list, dashboard, task-detail, etc.
 */

import {
  FileCode,
  FilePlus,
  FileEdit,
  Terminal,
  Search,
  Globe,
  ArrowUpRight,
  GitBranch,
  Table2,
  FileText,
  Mail,
  KeyRound,
  Mic,
  Image,
  Video,
  Package,
  Target,
  Wrench,
  Clock,
  Loader2,
  Eye,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  Brain,
  RefreshCw,
  Layers,
  Plug,
  ListChecks,
  Wand2,
  Palette,
  Upload,
  type LucideIcon,
} from "lucide-react";
import type { TaskStatus } from "@lumea-labs/polpo-react";

// ── Tool icon & color mapping ──

export type ToolMeta = { icon: LucideIcon; color: string; bg: string };

export function getToolMeta(name: string): ToolMeta {
  const n = name.toLowerCase();
  if (n === "read") return { icon: FileCode, color: "text-teal-400", bg: "bg-teal-500/10" };
  if (n === "write") return { icon: FilePlus, color: "text-emerald-400", bg: "bg-emerald-500/10" };
  if (n === "edit" || n === "multi_edit") return { icon: FileEdit, color: "text-sky-400", bg: "bg-sky-500/10" };
  if (n === "bash" || n === "ls") return { icon: Terminal, color: "text-amber-400", bg: "bg-amber-500/10" };
  if (n === "glob" || n === "grep" || n === "regex_replace") return { icon: Search, color: "text-blue-400", bg: "bg-blue-500/10" };
  if (n.startsWith("browser_")) return { icon: Globe, color: "text-indigo-400", bg: "bg-indigo-500/10" };
  if (n.startsWith("http_")) return { icon: ArrowUpRight, color: "text-cyan-400", bg: "bg-cyan-500/10" };
  if (n.startsWith("git_")) return { icon: GitBranch, color: "text-green-400", bg: "bg-green-500/10" };
  if (n.startsWith("excel_")) return { icon: Table2, color: "text-green-400", bg: "bg-green-500/10" };
  if (n.startsWith("pdf_")) return { icon: FileText, color: "text-red-400", bg: "bg-red-500/10" };
  if (n.startsWith("docx_")) return { icon: FileText, color: "text-blue-400", bg: "bg-blue-500/10" };
  if (n.startsWith("email_")) return { icon: Mail, color: "text-rose-400", bg: "bg-rose-500/10" };
  if (n.startsWith("vault_")) return { icon: KeyRound, color: "text-amber-400", bg: "bg-amber-500/10" };
  if (n.startsWith("audio_")) return { icon: Mic, color: "text-pink-400", bg: "bg-pink-500/10" };
  if (n.startsWith("image_")) return { icon: Image, color: "text-emerald-400", bg: "bg-emerald-500/10" };
  if (n.startsWith("video_")) return { icon: Video, color: "text-red-400", bg: "bg-red-500/10" };
  if (n.startsWith("search_")) return { icon: Search, color: "text-cyan-400", bg: "bg-cyan-500/10" };
  if (n.startsWith("dep_") || n === "bulk_rename") return { icon: Package, color: "text-amber-400", bg: "bg-amber-500/10" };
  if (n === "register_outcome") return { icon: Target, color: "text-teal-400", bg: "bg-teal-500/10" };
  return { icon: Wrench, color: "text-muted-foreground", bg: "bg-muted/30" };
}

// ── Skill icon & color mapping ──

export function getSkillMeta(name: string): { icon: LucideIcon; color: string } {
  const n = name.toLowerCase();
  if (n.includes("git") || n.includes("commit") || n.includes("feature-dev")) return { icon: GitBranch, color: "text-green-400" };
  if (n.includes("browser")) return { icon: Globe, color: "text-indigo-400" };
  if (n.includes("test")) return { icon: CheckCircle2, color: "text-teal-400" };
  if (n.includes("deploy") || n.includes("vercel") || n.includes("ship")) return { icon: Upload, color: "text-blue-400" };
  if (n.includes("design") || n.includes("frontend") || n.includes("ui") || n.includes("web-design")) return { icon: Palette, color: "text-pink-400" };
  if (n.includes("email")) return { icon: Mail, color: "text-rose-400" };
  if (n.includes("mcp")) return { icon: Plug, color: "text-cyan-400" };
  if (n.includes("linear")) return { icon: ListChecks, color: "text-purple-400" };
  if (n.includes("docker") || n.includes("runner")) return { icon: Package, color: "text-orange-400" };
  if (n.includes("skill") || n.includes("find")) return { icon: Wand2, color: "text-amber-400" };
  if (n.includes("llm") || n.includes("model") || n.includes("litellm")) return { icon: Brain, color: "text-violet-400" };
  if (n.includes("key") || n.includes("binding")) return { icon: KeyRound, color: "text-zinc-400" };
  if (n.includes("review") || n.includes("audit") || n.includes("best-practice")) return { icon: Eye, color: "text-sky-400" };
  if (n.includes("propagat") || n.includes("sync") || n.includes("change")) return { icon: RefreshCw, color: "text-yellow-400" };
  if (n.includes("remotion") || n.includes("video")) return { icon: Image, color: "text-red-400" };
  if (n.includes("composition") || n.includes("pattern")) return { icon: Layers, color: "text-orange-400" };
  return { icon: Sparkles, color: "text-violet-400" };
}

// ── Tool category definitions ──

export const toolCategories: { prefix: string; label: string; tools: string; icon: LucideIcon; color: string }[] = [
  { prefix: "browser_", label: "Browser", tools: "browser_navigate, browser_click, browser_fill, browser_snapshot, browser_screenshot, ...", icon: Globe, color: "text-indigo-400" },
  { prefix: "email_", label: "Email", tools: "email_send, email_draft, email_verify, email_list, email_read, email_search, email_download_attachment", icon: Mail, color: "text-rose-400" },
  { prefix: "image_", label: "Image", tools: "image_generate (fal.ai FLUX), image_analyze (OpenAI/Anthropic vision)", icon: Image, color: "text-emerald-400" },
  { prefix: "video_", label: "Video", tools: "video_generate (fal.ai Wan 2.2 text-to-video)", icon: Video, color: "text-red-400" },
  { prefix: "audio_", label: "Audio", tools: "audio_transcribe (STT), audio_speak (TTS)", icon: Mic, color: "text-pink-400" },
  { prefix: "search_", label: "Web Search", tools: "search_web (Exa semantic search), search_find_similar", icon: Search, color: "text-cyan-400" },
];

// ── Task status display config ──

export const taskStatusConfig: Record<TaskStatus, { color: string; icon: React.ElementType; label: string }> = {
  draft: { color: "text-zinc-500", icon: Clock, label: "Draft" },
  pending: { color: "text-zinc-400", icon: Clock, label: "Queued" },
  awaiting_approval: { color: "text-amber-400", icon: Clock, label: "Approval" },
  assigned: { color: "text-violet-400", icon: Clock, label: "Assigned" },
  in_progress: { color: "text-blue-400", icon: Loader2, label: "Running" },
  review: { color: "text-amber-400", icon: Eye, label: "Review" },
  done: { color: "text-emerald-400", icon: CheckCircle2, label: "Done" },
  failed: { color: "text-red-400", icon: AlertTriangle, label: "Failed" },
};

// ── Responsibility priority colors ──

export const responsibilityPriorityColors: Record<string, string> = {
  critical: "text-red-400 border-red-500/30",
  high: "text-amber-400 border-amber-500/30",
  medium: "text-blue-400 border-blue-500/30",
  low: "text-zinc-400 border-zinc-500/30",
};

// ── Reasoning effort metadata ──

export const reasoningMeta: Record<string, { label: string; color: string }> = {
  off: { label: "Off", color: "text-zinc-500" },
  minimal: { label: "Minimal", color: "text-zinc-400" },
  low: { label: "Low", color: "text-blue-400" },
  medium: { label: "Medium", color: "text-violet-400" },
  high: { label: "High", color: "text-amber-400" },
  xhigh: { label: "X-High", color: "text-red-400" },
};

// ── Task status sort order ──

export const taskStatusOrder: Record<string, number> = {
  in_progress: 0,
  review: 1,
  assigned: 2,
  pending: 3,
  awaiting_approval: 4,
  draft: 5,
  done: 6,
  failed: 7,
};

// ── Utility: format agent age ──

export function formatAgentAge(isoDate: string): string {
  const created = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - created.getTime();
  const days = Math.floor(diffMs / 86_400_000);
  if (days < 1) return "born today";
  if (days === 1) return "1 day old";
  if (days < 30) return `${days} days old`;
  const months = Math.floor(days / 30);
  const remainDays = days % 30;
  if (months < 12) {
    if (remainDays === 0) return `${months} month${months > 1 ? "s" : ""} old`;
    return `${months}m ${remainDays}d old`;
  }
  const years = Math.floor(months / 12);
  const remainMonths = months % 12;
  if (remainMonths === 0) return `${years} year${years > 1 ? "s" : ""} old`;
  return `${years}y ${remainMonths}m old`;
}
