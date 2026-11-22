import type { InstanceBranding } from "@/lib/branding";
import { apiUrl } from "@/lib/config";

function resolveBrandLogoUrl(logoUrl?: string): string | null {
  if (!logoUrl) return null;
  return logoUrl.startsWith("/") ? apiUrl(logoUrl) : logoUrl;
}

/**
 * The logos to try, in order: in dark mode the dark logo, then the light one (a dark logo that
 * fails to load falls back to it); in light mode the light one.
 */
export function brandLogoCandidates(branding: InstanceBranding | undefined, dark: boolean): string[] {
  const light = resolveBrandLogoUrl(branding?.logoUrl);
  const darkLogo = resolveBrandLogoUrl(branding?.logoDarkUrl);
  return [...(dark && darkLogo ? [darkLogo] : []), ...(light ? [light] : [])];
}
