/**
 * Shared model picker — reused by setup wizard (ModelStep) and config page (AgentTab).
 *
 * Fetches models from `GET /api/v1/providers/models`, filters by active providers,
 * deduplicates, and renders a searchable list with provider filter pills.
 */

import { useState, useEffect, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Loader2, Zap, Search } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ──

export interface CatalogModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  cost: { input: number; output: number };
}

export interface ModelPickerProps {
  /** Provider names that are currently authenticated/active. */
  configuredProviders: string[];
  /** Provider name → auth source ("env" | "oauth"). Used for badge display. */
  providerSources?: Record<string, string>;
  /** Currently selected model spec ("provider:id") — controls highlight. */
  value?: string | null;
  /** Called when the user clicks a model. Receives "provider:id". */
  onSelect: (modelSpec: string) => void;
  /** API fetch function — must handle `/api/v1` prefix. Default: global fetch wrapper. */
  apiFetch?: (path: string, init?: RequestInit) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  /** Max height for the scrollable list. Default: "240px". */
  maxHeight?: string;
  /** Optional heading override. Set to null to hide. */
  heading?: string | null;
  /** Optional subheading override. Set to null to hide. */
  subheading?: string | null;
}

// ── Helpers ──

function fmtCost(n: number): string {
  if (n === 0) return "free";
  if (n < 1) return `$${n.toFixed(2)}/M`;
  return `$${n.toFixed(0)}/M`;
}

// ── Component ──

export function ModelPicker({
  configuredProviders,
  providerSources,
  value,
  onSelect,
  apiFetch,
  maxHeight = "240px",
  heading,
  subheading,
}: ModelPickerProps) {
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState<string>("all");

  // Fetch models from catalog, filtered by configured providers
  useEffect(() => {
    const doFetch = async () => {
      try {
        let data: CatalogModel[];
        if (apiFetch) {
          const r = await apiFetch("/providers/models");
          if (!r.ok) return;
          data = r.data as CatalogModel[];
        } else {
          const r = await fetch("/api/v1/providers/models");
          const json = await r.json();
          if (!json.ok) return;
          data = json.data as CatalogModel[];
        }

        const seen = new Set<string>();
        const filtered = data
          .filter((m) => configuredProviders.includes(m.provider))
          .filter((m) => {
            const key = `${m.provider}:${m.id}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        setModels(filtered);
      } finally {
        setLoading(false);
      }
    };
    doFetch();
  }, [configuredProviders, apiFetch]);

  // Unique providers with models
  const availableProviders = useMemo(
    () => [...new Set(models.map((m) => m.provider))].sort(),
    [models],
  );

  // Filtered list
  const q = search.toLowerCase().trim();
  const filtered = useMemo(() =>
    models.filter((m) => {
      if (providerFilter !== "all" && m.provider !== providerFilter) return false;
      if (q && !m.name.toLowerCase().includes(q) && !m.id.toLowerCase().includes(q) && !m.provider.toLowerCase().includes(q)) return false;
      return true;
    }),
    [models, providerFilter, q],
  );

  return (
    <div className="space-y-4">
      {/* Heading */}
      {heading !== null && (
        <div>
          {heading !== undefined && <h2 className="text-xl font-semibold tracking-tight">{heading}</h2>}
          {subheading !== undefined && (
            <p className="text-sm text-muted-foreground mt-1">{subheading}</p>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : models.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No models found. Make sure you have at least one provider connected.
        </p>
      ) : (
        <>
          {/* Provider filter pills */}
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setProviderFilter("all")}
              className={cn(
                "px-2.5 py-1 rounded-full text-xs font-medium transition-all",
                providerFilter === "all"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent",
              )}
            >
              All ({models.length})
            </button>
            {availableProviders.map((prov) => {
              const count = models.filter((m) => m.provider === prov).length;
              const source = providerSources?.[prov];
              return (
                <button
                  key={prov}
                  type="button"
                  onClick={() => setProviderFilter(prov === providerFilter ? "all" : prov)}
                  className={cn(
                    "px-2.5 py-1 rounded-full text-xs font-medium transition-all flex items-center gap-1",
                    providerFilter === prov
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-accent",
                  )}
                >
                  <span className="capitalize">{prov}</span>
                  <span className="opacity-60">({count})</span>
                  {source && (
                    <Badge
                      variant="secondary"
                      className={cn(
                        "text-[9px] px-1 py-0 ml-0.5",
                        providerFilter === prov ? "bg-primary-foreground/20 text-primary-foreground" : "",
                      )}
                    >
                      {source === "oauth" ? "sub" : "key"}
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search models..."
              className="pl-9 text-sm"
            />
          </div>

          {/* Model list */}
          <div className="space-y-1.5 overflow-y-auto pr-1" style={{ maxHeight }}>
            {filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">
                No models match "{search || providerFilter}"
              </p>
            ) : filtered.map((m) => {
              const spec = `${m.provider}:${m.id}`;
              return (
                <button
                  key={spec}
                  type="button"
                  onClick={() => onSelect(spec)}
                  className={cn(
                    "w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-left text-sm transition-all",
                    value === spec
                      ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                      : "border-border hover:border-primary/30 hover:bg-accent/50",
                  )}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium truncate">{m.name}</span>
                    <span className="text-xs text-muted-foreground shrink-0">{m.provider}</span>
                    {m.reasoning && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
                        <Zap className="h-2.5 w-2.5 mr-0.5" />reasoning
                      </Badge>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0 ml-2">
                    {m.cost.input === 0 && m.cost.output === 0
                      ? <Badge variant="secondary" className="text-[10px] px-1.5 py-0 text-emerald-600">free</Badge>
                      : `${fmtCost(m.cost.input)} / ${fmtCost(m.cost.output)}`}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
