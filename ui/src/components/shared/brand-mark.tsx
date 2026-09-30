import { useState } from "react";
import type { InstanceBranding } from "@/hooks/use-polpo";
import { apiUrl } from "@/lib/config";
import { cn } from "@/lib/utils";

function resolveBrandLogoUrl(logoUrl?: string): string | null {
  if (!logoUrl) return null;
  return logoUrl.startsWith("/") ? apiUrl(logoUrl) : logoUrl;
}

export function BrandMark({ branding, className, imageClassName }: {
  branding?: InstanceBranding;
  className?: string;
  imageClassName?: string;
}) {
  const src = resolveBrandLogoUrl(branding?.logoUrl);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = src && failedUrl !== src;

  return (
    <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden bg-primary/10 text-lg", className)}>
      {showImage ? (
        <img
          src={src}
          alt=""
          decoding="async"
          className={cn("h-full w-full object-contain", imageClassName)}
          onError={() => setFailedUrl(src)}
        />
      ) : "🐙"}
    </div>
  );
}
