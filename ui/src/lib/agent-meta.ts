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
  PhoneCall,
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
  Database,
  HardDrive,
  type LucideIcon,
  Shapes,
} from "lucide-react";
import type { TaskStatus } from "@polpo-ai/react";
import { agentColorClasses } from "@/lib/agent-colors";

/**
 * A tool or skill kind's colour: one of the look's categorical agent colours (--agent-1 …
 * --agent-10), so every palette and custom look recolours them; never a fixed Tailwind hue.
 */
function kind(n: number): { color: string; bg: string } {
  const c = agentColorClasses(n);
  return { color: c.text, bg: c.bg };
}

// ── Tool icon & color mapping ──

export type ToolMeta = { icon: LucideIcon; color: string; bg: string };

export function getToolMeta(name: string): ToolMeta {
  const n = name.toLowerCase();
  if (n === "read") return { icon: FileCode, ...kind(9) };
  if (n === "write") return { icon: FilePlus, ...kind(3) };
  if (n === "edit" || n === "multi_edit") return { icon: FileEdit, ...kind(6) };
  if (n === "bash" || n === "ls") return { icon: Terminal, ...kind(5) };
  if (n === "glob" || n === "grep" || n === "regex_replace") return { icon: Search, ...kind(1) };
  if (n.startsWith("browser_")) return { icon: Globe, ...kind(7) };
  if (n.startsWith("http_")) return { icon: ArrowUpRight, ...kind(6) };
  if (n.startsWith("git_")) return { icon: GitBranch, ...kind(3) };
  if (n.startsWith("excel_")) return { icon: Table2, ...kind(3) };
  if (n.startsWith("pdf_")) return { icon: FileText, ...kind(2) };
  if (n.startsWith("docx_")) return { icon: FileText, ...kind(1) };
  if (n.startsWith("email_")) return { icon: Mail, ...kind(10) };
  if (n.startsWith("phone_")) return { icon: PhoneCall, ...kind(8) };
  if (n.startsWith("vault_")) return { icon: KeyRound, ...kind(5) };
  if (n.startsWith("audio_")) return { icon: Mic, ...kind(10) };
  if (n.startsWith("image_")) return { icon: Image, ...kind(3) };
  if (n.startsWith("video_")) return { icon: Video, ...kind(2) };
  if (n.startsWith("search_")) return { icon: Search, ...kind(6) };
  if (n.startsWith("data_")) return { icon: Database, ...kind(9) };
  if (n.startsWith("artifact_")) return { icon: Shapes, ...kind(4) };
  if (n.startsWith("dep_") || n === "bulk_rename") return { icon: Package, ...kind(5) };
  if (n === "register_outcome") return { icon: Target, ...kind(9) };
  return { icon: Wrench, color: "text-muted-foreground", bg: "bg-muted/30" };
}

// ── Skill icon & color mapping ──

export function getSkillMeta(name: string): { icon: LucideIcon; color: string } {
  const n = name.toLowerCase();
  if (n.includes("git") || n.includes("commit") || n.includes("feature-dev")) return { icon: GitBranch, color: kind(3).color };
  if (n.includes("browser")) return { icon: Globe, color: kind(7).color };
  if (n.includes("test")) return { icon: CheckCircle2, color: kind(9).color };
  if (n.includes("deploy") || n.includes("vercel") || n.includes("ship")) return { icon: Upload, color: kind(1).color };
  if (n.includes("design") || n.includes("frontend") || n.includes("ui") || n.includes("web-design")) return { icon: Palette, color: kind(10).color };
  if (n.includes("email")) return { icon: Mail, color: kind(10).color };
  if (n.includes("mcp")) return { icon: Plug, color: kind(6).color };
  if (n.includes("linear")) return { icon: ListChecks, color: kind(7).color };
  if (n.includes("docker") || n.includes("runner")) return { icon: Package, color: kind(5).color };
  if (n.includes("skill") || n.includes("find")) return { icon: Wand2, color: kind(5).color };
  if (n.includes("llm") || n.includes("model") || n.includes("litellm")) return { icon: Brain, color: kind(7).color };
  if (n.includes("key") || n.includes("binding")) return { icon: KeyRound, color: "text-muted-foreground" };
  if (n.includes("review") || n.includes("audit") || n.includes("best-practice")) return { icon: Eye, color: kind(6).color };
  if (n.includes("propagat") || n.includes("sync") || n.includes("change")) return { icon: RefreshCw, color: kind(8).color };
  if (n.includes("remotion") || n.includes("video")) return { icon: Image, color: kind(2).color };
  if (n.includes("composition") || n.includes("pattern")) return { icon: Layers, color: kind(5).color };
  return { icon: Sparkles, color: kind(7).color };
}

// ── Tool category definitions ──

export const toolCategories: { prefix: string; label: string; tools: string; icon: LucideIcon; color: string }[] = [
  { prefix: "browser_", label: "Browser", tools: "browser_navigate, browser_click, browser_fill, browser_snapshot, browser_screenshot, ...", icon: Globe, color: kind(7).color },
  { prefix: "email_", label: "Email", tools: "email_send, email_draft, email_verify, email_list, email_read, email_search, email_count, email_download_attachment", icon: Mail, color: kind(10).color },
  { prefix: "image_", label: "Image", tools: "image_generate (fal.ai FLUX), image_analyze (OpenAI/Anthropic vision)", icon: Image, color: kind(3).color },
  { prefix: "video_", label: "Video", tools: "video_generate (fal.ai Wan 2.2 text-to-video)", icon: Video, color: kind(2).color },
  { prefix: "audio_", label: "Audio", tools: "audio_transcribe (STT), audio_speak (TTS)", icon: Mic, color: kind(10).color },
  { prefix: "search_", label: "Web Search", tools: "search_web (Exa semantic search), search_find_similar", icon: Search, color: kind(6).color },
  { prefix: "phone_", label: "Phone (VAPI)", tools: "phone_call, phone_get_call, phone_list_calls, phone_hangup, inbound call configuration", icon: PhoneCall, color: kind(8).color },
  { prefix: "data_", label: "Structured Data", tools: "source registry, scoped grants, typed queries and mutations", icon: Database, color: kind(9).color },
  { prefix: "artifact_", label: "Artifacts", tools: "artifact_create, artifact_update, artifact_get, artifact_list, artifact_delete (documents, html dashboards and designs on its data sources, diagrams)", icon: Shapes, color: kind(4).color },
  { prefix: "storage_", label: "Storage", tools: "storage_list, storage_read, storage_write, storage_delete, storage_presign (S3/R2 buckets granted to the agent)", icon: HardDrive, color: kind(6).color },
];

// ── Task status display config ──

export const taskStatusConfig: Record<TaskStatus, { color: string; icon: React.ElementType; label: string }> = {
  draft: { color: "text-muted-foreground/70", icon: Clock, label: "Draft" },
  pending: { color: "text-status-queued", icon: Clock, label: "Queued" },
  awaiting_approval: { color: "text-warning", icon: Clock, label: "Approval" },
  assigned: { color: "text-status-assigned", icon: Clock, label: "Assigned" },
  in_progress: { color: "text-status-running", icon: Loader2, label: "Running" },
  review: { color: "text-warning", icon: Eye, label: "Review" },
  done: { color: "text-success", icon: CheckCircle2, label: "Done" },
  failed: { color: "text-destructive", icon: AlertTriangle, label: "Failed" },
};

// ── Responsibility priority colors ──

export const responsibilityPriorityColors: Record<string, string> = {
  critical: "text-destructive border-destructive/30",
  high: "text-warning border-warning/30",
  medium: "text-info border-info/30",
  low: "text-muted-foreground border-border",
};

// ── Reasoning effort metadata ──

export const reasoningMeta: Record<string, { label: string; color: string }> = {
  off: { label: "Off", color: "text-muted-foreground/70" },
  minimal: { label: "Minimal", color: "text-muted-foreground" },
  low: { label: "Low", color: "text-info" },
  medium: { label: "Medium", color: "text-primary" },
  high: { label: "High", color: "text-warning" },
  xhigh: { label: "X-High", color: "text-destructive" },
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
