"use client";

import type { DimensionScore } from "@orchestra/react";
import { cn } from "@/lib/utils";

function scoreColor(score: number): string {
  if (score >= 4) return "bg-status-done";
  if (score >= 3) return "bg-status-running";
  if (score >= 2) return "bg-yellow-500";
  return "bg-status-failed";
}

export function AssessmentScores({
  dimensions,
}: {
  dimensions: DimensionScore[];
}) {
  if (dimensions.length === 0) return null;

  return (
    <div className="space-y-2">
      {dimensions.map((dim) => (
        <div key={dim.dimension} className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="capitalize text-muted-foreground">
              {dim.dimension.replace(/_/g, " ")}
            </span>
            <span className="font-medium tabular-nums">{dim.score.toFixed(1)}/5</span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-300",
                scoreColor(dim.score)
              )}
              style={{ width: `${(dim.score / 5) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
