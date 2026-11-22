import { useState } from "react";
import type { InstanceBranding } from "@/hooks/use-polpo";
import { useResolvedAppearance } from "@/lib/appearance";
import { brandLogoCandidates } from "@/lib/brand-logo";
import { cn } from "@/lib/utils";

export function BrandMark({ branding, className, imageClassName, variant }: {
  branding?: InstanceBranding;
  className?: string;
  imageClassName?: string;
  /** Force the light or dark logo (previews); default: the current theme. */
  variant?: "light" | "dark";
}) {
  const { dark: themeDark } = useResolvedAppearance();
  const dark = variant ? variant === "dark" : themeDark;
  const [failed, setFailed] = useState<string[]>([]);
  const src = brandLogoCandidates(branding, dark).find((url) => !failed.includes(url));

  return (
    <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden bg-primary/10 text-lg", className)}>
      {src ? (
        <img
          key={src}
          src={src}
          alt=""
          decoding="async"
          className={cn("h-full w-full object-contain", imageClassName)}
          onError={() => setFailed((f) => (f.includes(src) ? f : [...f, src]))}
        />
      ) : "🐙"}
    </div>
  );
}
