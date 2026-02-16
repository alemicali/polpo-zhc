/**
 * Shared topic definitions used by both TopicBar and Sidebar filtering.
 * Single source of truth for section-to-URL mapping.
 */

export interface Topic {
  label: string;
  href: string;
  /** URL prefixes that belong to this topic */
  match: string[];
  /** URL prefixes to exclude from this topic (matched first) */
  exclude?: string[];
  /** Sidebar group labels that belong to this topic (for group-type entries).
   *  If empty, top-level (ungrouped) items matching the path will be shown. */
  sidebarGroups?: string[];
  /** Sidebar slugs (ungrouped top-level items) to show for this topic */
  sidebarSlugs?: string[];
}

export const topics: Topic[] = [
  {
    label: "Getting Started",
    href: "/introduction/",
    match: ["/introduction", "/getting-started", "/configuration", "/guides/first-plan"],
    sidebarSlugs: ["introduction", "getting-started", "guides/first-plan", "configuration"],
  },
  {
    label: "Core Concepts",
    href: "/concepts/architecture/",
    match: ["/concepts/"],
    sidebarGroups: ["Core Concepts"],
  },
  {
    label: "Features",
    href: "/features/tools-and-mcp/",
    match: ["/features/"],
    sidebarGroups: ["Features"],
  },
  {
    label: "Usage",
    href: "/usage/cli/",
    match: ["/usage/"],
    sidebarGroups: ["Usage"],
  },
  {
    label: "Reference",
    href: "/reference/config/",
    match: ["/reference/"],
    sidebarGroups: ["Reference"],
  },
];

/** Find the active topic for a given URL path */
export function getActiveTopic(pathname: string): Topic | undefined {
  return topics.find((t) => {
    const excluded = t.exclude?.some((e) => pathname.startsWith(e)) ?? false;
    if (excluded) return false;
    return t.match.some((m) => pathname.startsWith(m));
  });
}
