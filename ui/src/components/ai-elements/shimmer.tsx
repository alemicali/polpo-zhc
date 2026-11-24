"use client";

import { cn } from "@/lib/utils";
import type { ElementType } from "react";
import { memo } from "react";

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  /** Kept for API compatibility; the sweep speed comes from the `.text-shimmer` class. */
  duration?: number;
  spread?: number;
}

/**
 * Muted text with a light band sweeping over it: the "still working" look of a running tool
 * call or of thinking. Colours are the theme tokens; under prefers-reduced-motion it is plain
 * muted text (see `.text-shimmer` in index.css).
 */
const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
}: TextShimmerProps) => {
  return (
    <Component className={cn("inline-block text-shimmer", className)} data-shimmer="">
      {children}
    </Component>
  );
};

export const Shimmer = memo(ShimmerComponent);
