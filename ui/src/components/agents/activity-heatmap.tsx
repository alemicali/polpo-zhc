/**
 * ActivityHeatmap — GitHub-style contribution graph for agent tasks.
 * Pure component: receives tasks as props.
 */

import { useMemo } from "react";
import { Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Task } from "@polpo-ai/react";

const HEATMAP_WEEKS = 20;
const DAY_NAMES = ["", "Mon", "", "Wed", "", "Fri", ""];

type DayData = { count: number; done: number; failed: number; scores: number[] };

export function ActivityHeatmap({ tasks }: { tasks: Task[] }) {
  const { grid, maxCount, totalActive, streakDays } = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayOfWeek = today.getDay();
    const endSunday = new Date(today);
    endSunday.setDate(today.getDate() - dayOfWeek + 6);
    const startDate = new Date(endSunday);
    startDate.setDate(endSunday.getDate() - (HEATMAP_WEEKS * 7 - 1));

    const dayMap = new Map<string, DayData>();

    for (const t of tasks) {
      const d = new Date(t.updatedAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const existing = dayMap.get(key) ?? { count: 0, done: 0, failed: 0, scores: [] };
      existing.count++;
      if (t.status === "done") existing.done++;
      if (t.status === "failed") existing.failed++;
      if (t.result?.assessment?.globalScore != null) existing.scores.push(t.result.assessment.globalScore);
      dayMap.set(key, existing);
    }

    const weeks: { date: Date; key: string; data: DayData | null }[][] = [];
    let max = 0;
    const cursor = new Date(startDate);
    let currentWeek: typeof weeks[number] = [];

    const startDay = cursor.getDay();
    if (startDay !== 0) {
      for (let i = 0; i < startDay; i++) {
        currentWeek.push({ date: new Date(0), key: "", data: null });
      }
    }

    const totalDays = HEATMAP_WEEKS * 7;
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(cursor);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const data = dayMap.get(key) ?? { count: 0, done: 0, failed: 0, scores: [] };
      if (data.count > max) max = data.count;
      const isFuture = d > now;
      currentWeek.push({ date: d, key, data: isFuture ? null : data });
      if (currentWeek.length === 7) {
        weeks.push(currentWeek);
        currentWeek = [];
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    if (currentWeek.length > 0) weeks.push(currentWeek);

    let streak = 0;
    const checkDate = new Date(today);
    for (let i = 0; i < 365; i++) {
      const k = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, "0")}-${String(checkDate.getDate()).padStart(2, "0")}`;
      const d = dayMap.get(k);
      if (d && d.count > 0) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else if (i === 0) {
        checkDate.setDate(checkDate.getDate() - 1);
        continue;
      } else {
        break;
      }
    }

    const total = tasks.filter(t => t.status !== "draft" && t.status !== "pending").length;

    return { grid: weeks, maxCount: max, totalActive: total, streakDays: streak };
  }, [tasks]);

  if (tasks.length === 0) return null;

  const getCellColor = (data: DayData | null) => {
    if (!data) return "bg-muted/20";
    if (data.count === 0) return "bg-muted/30";
    const ratio = maxCount > 0 ? data.count / maxCount : 0;
    const failRatio = data.count > 0 ? data.failed / data.count : 0;
    if (failRatio > 0.5) {
      if (ratio > 0.7) return "bg-red-500";
      if (ratio > 0.4) return "bg-red-500/70";
      return "bg-red-500/40";
    }
    if (ratio > 0.75) return "bg-emerald-400";
    if (ratio > 0.5) return "bg-emerald-400/70";
    if (ratio > 0.25) return "bg-emerald-400/50";
    return "bg-emerald-400/30";
  };

  const formatDate = (d: Date) =>
    d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  return (
    <div className="space-y-2">
      {/* Stats row */}
      <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">{totalActive} tasks</span>
        <span>in the last {HEATMAP_WEEKS} weeks</span>
        {streakDays > 0 && (
          <span className="ml-auto flex items-center gap-1">
            <Zap className="h-3 w-3 text-amber-400" />
            <span className="font-medium text-foreground">{streakDays}d</span> streak
          </span>
        )}
      </div>

      {/* Heatmap grid */}
      <div className="flex gap-[3px]">
        {/* Day labels */}
        <div className="flex flex-col gap-[3px] pr-1.5 pt-0">
          {DAY_NAMES.map((name, i) => (
            <div key={i} className="h-[11px] flex items-center">
              <span className="text-[9px] text-muted-foreground/60 leading-none w-5">{name}</span>
            </div>
          ))}
        </div>
        {/* Weeks */}
        {grid.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-[3px]">
            {week.map((cell, di) => {
              let title = "";
              if (cell.data) {
                title = formatDate(cell.date);
                if (cell.data.count > 0) {
                  title += `\n${cell.data.count} task${cell.data.count !== 1 ? "s" : ""}: ${cell.data.done} done, ${cell.data.failed} failed`;
                  if (cell.data.scores.length > 0) {
                    title += `\navg score ${(cell.data.scores.reduce((a: number, b: number) => a + b, 0) / cell.data.scores.length).toFixed(1)}/5`;
                  }
                } else {
                  title += "\nNo activity";
                }
              }
              return (
                <div
                  key={cell.key || `empty-${di}`}
                  title={title || undefined}
                  className={cn(
                    "h-[11px] w-[11px] rounded-[2px] transition-colors",
                    getCellColor(cell.data),
                    cell.data && cell.data.count > 0 && "hover:ring-1 hover:ring-primary/50"
                  )}
                />
              );
            })}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-1.5 justify-end">
        <span className="text-[9px] text-muted-foreground/60">Less</span>
        <div className="h-[9px] w-[9px] rounded-[2px] bg-muted/30" />
        <div className="h-[9px] w-[9px] rounded-[2px] bg-emerald-400/30" />
        <div className="h-[9px] w-[9px] rounded-[2px] bg-emerald-400/50" />
        <div className="h-[9px] w-[9px] rounded-[2px] bg-emerald-400/70" />
        <div className="h-[9px] w-[9px] rounded-[2px] bg-emerald-400" />
        <span className="text-[9px] text-muted-foreground/60">More</span>
      </div>
    </div>
  );
}
