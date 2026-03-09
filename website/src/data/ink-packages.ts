export type PackageType = "playbook" | "agent" | "company";

export interface InkPackage {
  name: string;
  type: PackageType;
  description: string;
  source: string; // owner/repo
  tags: string[];
  version?: string;
  author?: string;
  /** Longer description shown on detail page */
  details?: string;
  /** File convention path */
  conventionPath?: string;
  /** What's included — list of features/files */
  includes?: string[];
  /** Total install count */
  installs: number;
  /** Installs in the last 24 hours */
  installs24h: number;
  /** Date the package was first published */
  publishedAt: string; // ISO date
}

/** All unique tags across packages */
export function getAllTags(packages: InkPackage[]): string[] {
  const set = new Set<string>();
  for (const p of packages) for (const t of p.tags) set.add(t);
  return Array.from(set).sort();
}

/** Format install count (e.g. 4820 -> "4.8K") */
export function formatInstalls(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}
