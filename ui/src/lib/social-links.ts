/**
 * Agent identity socials (`identity.socials`: platform → handle or URL) as links: the platform's
 * mark, the text to show and where it points. Values may be a URL, a handle ("@alice"), or both
 * ("@alice (https://instagram.com/alice)"); a link is only ever http(s).
 */
import type { SocialIconName } from "@/generated/social-icons";

const ALIASES: Record<string, SocialIconName | "website" | "linkedin" | "email"> = {
  instagram: "instagram", ig: "instagram", insta: "instagram",
  facebook: "facebook", fb: "facebook",
  x: "x", twitter: "x",
  tiktok: "tiktok", youtube: "youtube", yt: "youtube",
  github: "github", gh: "github",
  threads: "threads", whatsapp: "whatsapp", wa: "whatsapp", telegram: "telegram", tg: "telegram",
  pinterest: "pinterest", bluesky: "bluesky", bsky: "bluesky", discord: "discord", mastodon: "mastodon",
  twitch: "twitch", reddit: "reddit", snapchat: "snapchat", linktree: "linktree",
  tripadvisor: "tripadvisor", googlemaps: "googlemaps", maps: "googlemaps", google_maps: "googlemaps",
  linkedin: "linkedin",
  website: "website", web: "website", site: "website", sito: "website", blog: "website", url: "website",
  email: "email", mail: "email",
};

export type SocialKind = SocialIconName | "website" | "linkedin" | "email" | "other";

/** The platform a socials key names ("Twitter", "ig", "Sito" …). */
export function socialKind(platform: string): SocialKind {
  return ALIASES[platform.trim().toLowerCase().replace(/[\s-]+/g, "_")] ?? "other";
}

const PROFILE: Partial<Record<SocialKind, (handle: string) => string>> = {
  instagram: (h) => `https://www.instagram.com/${h}/`,
  facebook: (h) => `https://www.facebook.com/${h}`,
  x: (h) => `https://x.com/${h}`,
  tiktok: (h) => `https://www.tiktok.com/@${h}`,
  youtube: (h) => `https://www.youtube.com/@${h}`,
  github: (h) => `https://github.com/${h}`,
  threads: (h) => `https://www.threads.net/@${h}`,
  telegram: (h) => `https://t.me/${h}`,
  pinterest: (h) => `https://www.pinterest.com/${h}/`,
  twitch: (h) => `https://www.twitch.tv/${h}`,
  reddit: (h) => `https://www.reddit.com/user/${h}`,
  snapchat: (h) => `https://www.snapchat.com/add/${h}`,
  linktree: (h) => `https://linktr.ee/${h}`,
  bluesky: (h) => `https://bsky.app/profile/${h}`,
  linkedin: (h) => `https://www.linkedin.com/in/${h}`,
};

const URL_IN_TEXT = /https?:\/\/[^\s()<>"']+/i;
const HANDLE = /^@?([A-Za-z0-9._-]{1,64})$/;
const DOMAIN = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i;

function httpUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export interface SocialLink {
  kind: SocialKind;
  /** What to show: the handle, or the URL without the scheme. */
  text: string;
  /** Where it points (http/https only), when it can be worked out. */
  href?: string;
}

export function socialLink(platform: string, value: unknown): SocialLink {
  const kind = socialKind(platform);
  const raw = String(value ?? "").trim();
  const inText = raw.match(URL_IN_TEXT)?.[0];
  if (inText) {
    const href = httpUrl(inText);
    const rest = raw.replace(inText, "").replace(/[()\s]+$/g, "").replace(/\(\s*\)/g, "").trim();
    return { kind, text: rest || inText.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, ""), ...(href ? { href } : {}) };
  }
  if (kind === "email" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return { kind, text: raw, href: `mailto:${raw}` };
  if (kind === "whatsapp") {
    const digits = raw.replace(/[^\d]/g, "");
    if (digits.length >= 6) return { kind, text: raw, href: `https://wa.me/${digits}` };
  }
  const handle = raw.match(HANDLE)?.[1];
  const profile = PROFILE[kind];
  if (handle && profile) return { kind, text: raw, href: profile(handle) };
  if (DOMAIN.test(raw)) {
    const href = httpUrl(`https://${raw}`);
    return { kind, text: raw, ...(href ? { href } : {}) };
  }
  return { kind, text: raw };
}
