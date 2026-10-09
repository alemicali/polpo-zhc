import { useCallback, useEffect, useState } from "react";
import { fetchVaultCatalog, type VaultCatalogEntry } from "@/lib/vault-ref";

// One catalog request shared by every picker on the page; refreshed on demand.
let cached: Promise<VaultCatalogEntry[]> | null = null;

/** Forget the cached catalog (tests, or after adding an entry). */
export function resetVaultCatalogCache(): void {
  cached = null;
}

export function useVaultCatalog() {
  const [entries, setEntries] = useState<VaultCatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // state is only updated in the promise callbacks (never synchronously), so the effect can load
  const load = useCallback((fresh = false) => {
    if (fresh || !cached) cached = fetchVaultCatalog();
    const promise = cached;
    return promise.then(
      (next) => { setEntries(next); setError(null); },
      (e: Error) => {
        if (cached === promise) cached = null;
        setError(e.message);
      },
    ).finally(() => setLoading(false));
  }, []);
  useEffect(() => { void load(); }, [load]);
  const reload = useCallback(() => {
    setLoading(true);
    return load(true);
  }, [load]);
  return { entries, error, loading, reload };
}
