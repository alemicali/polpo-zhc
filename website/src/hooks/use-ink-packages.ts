import { useState, useEffect } from "react";
import { type InkPackage } from "../data/ink-packages";

const INK_API_URL = "/api";

interface ApiPackage {
  source: string;
  name: string;
  type: string;
  description: string;
  tags: string[];
  version: string;
  author: string;
  installs: number;
  installs24h: number;
  firstSeen: string;
  lastInstalled: string;
}

/**
 * Fetch packages from the Ink Hub API.
 * No fallback — shows only real data from the database.
 */
export function useInkPackages(): {
  packages: InkPackage[];
  loading: boolean;
  error: boolean;
} {
  const [packages, setPackages] = useState<InkPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function fetchPackages() {
      try {
        const res = await fetch(`${INK_API_URL}/packages`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json() as { packages: ApiPackage[] };
        if (cancelled) return;

        const mapped: InkPackage[] = data.packages.map((api) => ({
          name: api.name,
          type: api.type as InkPackage["type"],
          description: api.description,
          source: api.source,
          tags: api.tags ?? [],
          version: api.version,
          author: api.author,
          installs: api.installs,
          installs24h: api.installs24h,
          publishedAt: api.firstSeen,
        }));

        setPackages(mapped);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchPackages();
    return () => { cancelled = true; };
  }, []);

  return { packages, loading, error };
}
