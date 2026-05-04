"use client";

import { cn } from "@/lib/utils";
import type { ElementType } from "react";
import { memo } from "react";

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}

const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration: _duration = 2,
  spread: _spread = 2,
}: TextShimmerProps) => {
  return (
    <Component
      className={cn(
        "inline-block animate-pulse text-muted-foreground",
        className
      )}
    >
      {children}
    </Component>
  );
};

export const Shimmer = memo(ShimmerComponent);
