/**
 * The one way a feature picks a credential: an existing vault entry (an agent's, possibly shared
 * with other agents), stored as a reference (owner + service). No key input fields anywhere else:
 * keys are added in the owner agent's Credentials tab.
 *
 * Shows names only (owner · service, label, type, key names), never values.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Check, ChevronDown, KeyRound, Loader2, RefreshCw, Search, Users, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  CREDENTIAL_NAMES,
  credentialsTabPath,
  fetchVaultCatalog,
  groupCatalog,
  missingCredentials,
  sameVaultRef,
  type CredentialName,
  type VaultCatalogEntry,
  type VaultRef,
} from "@/lib/vault-ref";

// One catalog request shared by every picker on the page; refreshed on demand.
let cached: Promise<VaultCatalogEntry[]> | null = null;

/** Forget the cached catalog (tests, or after adding an entry). */
export function resetVaultCatalogCache(): void {
  cached = null;
}

export function useVaultCatalog() {
  const [entries, setEntries] = useState<VaultCatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async (fresh = false) => {
    if (fresh || !cached) cached = fetchVaultCatalog();
    const promise = cached;
    setLoading(true);
    try {
      setEntries(await promise);
      setError(null);
    } catch (e) {
      if (cached === promise) cached = null;
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return { entries, error, loading, reload: () => load(true) };
}

const TYPE_LABEL: Record<VaultCatalogEntry["type"], string> = {
  api_key: "API key", login: "Login", oauth: "OAuth", smtp: "SMTP", imap: "IMAP", custom: "Custom",
};

function sharedLabel(entry: VaultCatalogEntry): string | null {
  const n = entry.allowedAgents.length;
  return n ? `shared with ${n}` : null;
}

function expectedNames(required: CredentialName[]): string {
  return required.map((name) => CREDENTIAL_NAMES[name].slice(0, 3).join(" / ")).join(" + ");
}

export interface VaultRefPickerProps {
  value: VaultRef | null | undefined;
  onChange: (value: VaultRef | null) => void;
  /** Credentials the feature reads (aliases accepted): warns when the chosen entry has none. */
  requiredKeys?: CredentialName[];
  placeholder?: string;
  disabled?: boolean;
  /** Owner suggested by the "add it" link when nothing fits. */
  suggestOwner?: string;
  className?: string;
  "aria-label"?: string;
}

export function VaultRefPicker({
  value, onChange, requiredKeys = [], placeholder = "Choose a vault entry", disabled, suggestOwner, className, ...rest
}: VaultRefPickerProps) {
  const { entries, error, loading, reload } = useVaultCatalog();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = useMemo(
    () => (value ? entries?.find((e) => sameVaultRef(e, value)) : undefined),
    [entries, value],
  );
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = (entries ?? []).filter((e) => !q
      || [e.owner, e.service, e.label ?? "", TYPE_LABEL[e.type], ...e.keys].some((s) => s.toLowerCase().includes(q)));
    return groupCatalog(filtered);
  }, [entries, query]);
  const fitting = (entries ?? []).filter((e) => missingCredentials(e.keys, requiredKeys).length === 0);
  const missing = selected ? missingCredentials(selected.keys, requiredKeys) : [];
  const notFound = !!value && !!entries && !selected;
  const addOwner = value?.owner ?? suggestOwner ?? groups[0]?.owner;

  return (
    <div className={cn("space-y-1", className)}>
      <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(""); }}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label={rest["aria-label"] ?? placeholder}
            className={cn(
              "flex h-8 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-transparent px-2.5 text-left text-xs shadow-xs transition-[color,box-shadow] outline-none",
              "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50",
              (notFound || missing.length > 0) && "border-amber-500/50",
            )}
          >
            <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {value ? (
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="truncate font-mono">{value.owner} · {value.service}</span>
                {selected?.label && <span className="truncate text-muted-foreground">{selected.label}</span>}
              </span>
            ) : (
              <span className="flex-1 truncate text-muted-foreground">{placeholder}</span>
            )}
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(26rem,calc(100vw-2rem))] p-0">
          <div className="flex items-center gap-1.5 border-b border-border/40 px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search agent, service or key"
              className="h-7 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:text-foreground"
              onClick={() => void reload()}
              aria-label="Reload vault entries"
              title="Reload vault entries"
            >
              <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto py-1" role="listbox">
            {error && <p className="px-3 py-2 text-xs text-destructive">{error}</p>}
            {!entries && !error && (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading vault…</div>
            )}
            {entries && groups.length === 0 && (
              <p className="px-3 py-2 text-xs text-muted-foreground">{query ? "No entry matches." : "No agent has vault entries yet."}</p>
            )}
            {groups.map((group) => (
              <div key={group.owner} className="py-0.5">
                <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">{group.owner}</div>
                {group.entries.map((entry) => {
                  const isSelected = sameVaultRef(entry, value);
                  const lacks = missingCredentials(entry.keys, requiredKeys).length > 0;
                  const shared = sharedLabel(entry);
                  return (
                    <button
                      key={entry.service}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-vault-ref={`${entry.owner}/${entry.service}`}
                      onClick={() => { onChange({ owner: entry.owner, service: entry.service }); setOpen(false); setQuery(""); }}
                      className={cn(
                        "flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground",
                        isSelected && "bg-accent/60",
                      )}
                    >
                      <Check className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", isSelected ? "opacity-100" : "opacity-0")} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate font-mono">{entry.owner} · {entry.service}</span>
                          <span className="shrink-0 rounded border border-border/50 px-1 text-[9.5px] text-muted-foreground">{TYPE_LABEL[entry.type]}</span>
                          {shared && (
                            <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-sky-500/10 px-1.5 text-[9.5px] text-sky-400" title={entry.allowedAgents.join(", ")}>
                              <Users className="h-2.5 w-2.5" /> {shared}
                            </span>
                          )}
                        </span>
                        {entry.label && <span className="block truncate text-muted-foreground">{entry.label}</span>}
                        <span className={cn("block truncate font-mono text-[10px]", lacks ? "text-amber-500/80" : "text-muted-foreground/70")}>
                          {entry.keys.length ? entry.keys.join(", ") : "no keys"}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          {entries && requiredKeys.length > 0 && fitting.length === 0 && addOwner && (
            <div className="border-t border-border/40 px-3 py-2 text-[11px] text-muted-foreground">
              No entry holds {expectedNames(requiredKeys)}.{" "}
              <Link to={credentialsTabPath(addOwner)} className="text-primary underline" onClick={() => setOpen(false)}>
                Add it in the agent's Credentials tab
              </Link>
            </div>
          )}
          {entries && entries.length === 0 && (
            <div className="border-t border-border/40 px-3 py-2 text-[11px] text-muted-foreground">
              Keys live in an agent's vault (shared with other agents when needed).{" "}
              <Link to="/agents" className="text-primary underline" onClick={() => setOpen(false)}>Open Agents</Link>
            </div>
          )}
          {value && (
            <div className="border-t border-border/40 px-1 py-1">
              <button
                type="button"
                onClick={() => { onChange(null); setOpen(false); }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                <X className="h-3.5 w-3.5" /> Clear
              </button>
            </div>
          )}
        </PopoverContent>
      </Popover>
      {notFound && (
        <p className="flex items-center gap-1 text-[10.5px] text-amber-500">
          <AlertTriangle className="h-3 w-3 shrink-0" /> Not found in {value!.owner}'s vault.{" "}
          <Link to={credentialsTabPath(value!.owner)} className="underline">Add it in the agent's Credentials tab</Link>
        </p>
      )}
      {!notFound && missing.length > 0 && (
        <p className="flex items-center gap-1 text-[10.5px] text-amber-500">
          <AlertTriangle className="h-3 w-3 shrink-0" /> This entry has no {expectedNames(missing)} key.
        </p>
      )}
    </div>
  );
}
