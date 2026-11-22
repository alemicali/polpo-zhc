import { useState } from "react";
import { useResolvedAppearance } from "@/lib/appearance";
import { useInstanceBranding, type InstanceBranding } from "@/lib/branding";
import { brandLogoCandidates } from "@/lib/brand-logo";
import { cn } from "@/lib/utils";

/**
 * The instance's logo. Framed in a tile ("box", the default) or bare ("none": the same height, its
 * own width up to `bareMaxWidthClassName`, no background). Without a `branding` prop it shows the
 * instance branding, known from the first render (runtime-config.js or this browser's cached copy).
 */
export function BrandMark({ branding: given, className, imageClassName, variant, bareMaxWidthClassName = "max-w-32" }: {
  branding?: InstanceBranding;
  className?: string;
  imageClassName?: string;
  /** Force the light or dark logo (previews); default: the current theme. */
  variant?: "light" | "dark";
  /** The widest a bare logo may be (e.g. narrower in the collapsed sidebar). */
  bareMaxWidthClassName?: string;
}) {
  const instance = useInstanceBranding();
  const branding = given ?? instance;
  const { dark: themeDark } = useResolvedAppearance();
  const dark = variant ? variant === "dark" : themeDark;
  const [failed, setFailed] = useState<string[]>([]);
  const src = brandLogoCandidates(branding, dark).find((url) => !failed.includes(url));
  const bare = branding?.logoFrame === "none";

  return (
    <div
      data-logo-frame={bare ? "none" : "box"}
      className={bare
        ? cn("flex h-9 shrink-0 items-center justify-center text-lg", className, "w-auto min-w-0 rounded-none border-0 bg-transparent p-0 shadow-none", bareMaxWidthClassName)
        : cn("flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden bg-primary/10 text-lg", className)}
    >
      {src ? (
        <img
          key={src}
          src={src}
          alt=""
          decoding="async"
          fetchPriority="high"
          className={bare ? cn("h-full w-auto max-w-full object-contain", imageClassName) : cn("h-full w-full object-contain", imageClassName)}
          onError={() => setFailed((f) => (f.includes(src) ? f : [...f, src]))}
        />
      ) : "🐙"}
    </div>
  );
}
