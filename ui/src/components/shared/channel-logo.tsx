/**
 * ChannelLogo — brand-coloured icon for a notification channel type.
 *
 * Uses the Iconify `logos` pack (registered offline at boot in
 * iconify-bootstrap.ts) for real brand marks instead of generic lucide
 * placeholders. Falls back to a lucide icon for channel types that have no
 * good brand logo (webhook, push, generic email).
 */

import type { LucideIcon } from "lucide-react";
import { Icon } from "@iconify/react";
import { Link2, Bell, Mail, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";

/** Channel type → iconify "logos:" id. Null when we want a lucide fallback. */
const LOGO_BY_TYPE: Record<string, string | null> = {
  telegram: "logos:telegram",
  slack: "logos:slack-icon",
  whatsapp: "logos:whatsapp-icon",
  // Email defaults to a generic envelope (provider-specific brand is decided
  // at the provider field, not at the channel level)
  email: "logos:google-gmail",
  // Webhook + push: no real brand — keep lucide
  webhook: null,
  push: null,
};

const FALLBACK_BY_TYPE: Record<string, LucideIcon> = {
  webhook: Link2,
  push: Bell,
  email: Mail,
  telegram: MessageSquare,
  slack: MessageSquare,
  whatsapp: MessageSquare,
};

export function ChannelLogo({
  type,
  size = 16,
  className,
}: {
  type: string;
  /** Pixel size — the wrapper sets the same value on width/height. */
  size?: number;
  className?: string;
}) {
  const logoId = LOGO_BY_TYPE[type];
  if (logoId) {
    return (
      <Icon
        icon={logoId}
        width={size}
        height={size}
        className={cn("shrink-0", className)}
      />
    );
  }
  const Fallback = FALLBACK_BY_TYPE[type] ?? Bell;
  return <Fallback className={cn("shrink-0", className)} style={{ width: size, height: size }} />;
}
