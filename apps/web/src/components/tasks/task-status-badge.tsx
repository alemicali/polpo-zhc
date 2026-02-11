"use client";

import { Badge } from "@/components/ui/badge";
import { STATUS_COLORS, STATUS_LABELS } from "@/lib/orchestra";
import type { TaskStatus } from "@orchestra/react";
import { cn } from "@/lib/utils";

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return (
    <Badge variant="outline" className={cn("text-[10px]", STATUS_COLORS[status])}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}
