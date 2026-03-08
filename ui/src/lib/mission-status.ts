import type { MissionStatus } from "@lumea-technologies/polpo-react";
import {
  Clock,
  Calendar,
  Repeat,
  Loader2,
  Pause,
  CheckCircle2,
  AlertTriangle,
  XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// ── Mission status visual config ──
// Shared across missions list, mission detail, and anywhere MissionStatus badges appear.

export interface MissionStatusStyle {
  color: string;
  bg: string;
  label: string;
  icon: LucideIcon;
}

export const missionStatusStyles: Record<MissionStatus, MissionStatusStyle> = {
  draft:     { color: "text-zinc-400",    bg: "bg-zinc-500/10",    label: "Draft",     icon: Clock },
  scheduled: { color: "text-blue-400",    bg: "bg-blue-500/10",    label: "Scheduled", icon: Calendar },
  recurring: { color: "text-violet-400",  bg: "bg-violet-500/10",  label: "Recurring", icon: Repeat },
  active:    { color: "text-blue-400",    bg: "bg-blue-500/10",    label: "Running",   icon: Loader2 },
  paused:    { color: "text-amber-400",   bg: "bg-amber-500/10",   label: "Paused",    icon: Pause },
  completed: { color: "text-emerald-400", bg: "bg-emerald-500/10", label: "Completed", icon: CheckCircle2 },
  failed:    { color: "text-red-400",     bg: "bg-red-500/10",     label: "Failed",    icon: AlertTriangle },
  cancelled: { color: "text-zinc-500",    bg: "bg-zinc-500/10",    label: "Cancelled", icon: XCircle },
};

// ── Filter options (for status filter popovers) ──

export interface MissionStatusFilterOption {
  value: MissionStatus;
  label: string;
  color: string;
}

export const missionStatusFilterOptions: MissionStatusFilterOption[] = [
  { value: "active",    label: "Running",   color: "text-blue-400" },
  { value: "scheduled", label: "Scheduled", color: "text-blue-400" },
  { value: "recurring", label: "Recurring", color: "text-violet-400" },
  { value: "paused",    label: "Paused",    color: "text-amber-400" },
  { value: "draft",     label: "Draft",     color: "text-zinc-400" },
  { value: "completed", label: "Completed", color: "text-emerald-400" },
  { value: "failed",    label: "Failed",    color: "text-red-400" },
  { value: "cancelled", label: "Cancelled", color: "text-zinc-500" },
];
