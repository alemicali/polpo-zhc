/**
 * Settings → MCP access: who may use this instance's MCP connector, and with which scopes.
 * OAuth grants (a client a person allowed on the consent page) can be revoked here; MCP keys are
 * listed by name with their scopes (their values never reach the dashboard).
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, KeyRound, Loader2, Plug, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { KEY_SOURCE_LABEL, mcpAccessApi, scopeLabel, visibleScopes, type McpAccess, type McpGrant } from "@/lib/mcp-access-api";

function formatWhen(iso: string | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function ScopeBadges({ scopes, all }: { scopes: string[]; all: McpAccess["scopes"] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {visibleScopes(scopes).map((s) => (
        <Badge
          key={s}
          variant={s === "polpo:admin" ? "destructive" : "secondary"}
          className="text-[10px] font-normal"
          title={all.find((x) => x.id === s)?.description}
        >
          {scopeLabel(s, all)}
        </Badge>
      ))}
    </div>
  );
}

export function McpAccessSection() {
  const [access, setAccess] = useState<McpAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<McpGrant | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => mcpAccessApi.get().then(
    (next) => { setAccess(next); setError(null); },
    (e: Error) => setError(e.message),
  ), []);
  useEffect(() => { void load(); }, [load]);

  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    try {
      await mcpAccessApi.revokeGrant(revoking.id);
      toast.success(`${revoking.client_name} disconnected`);
      setRevoking(null);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (!access) return <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading MCP access…</div>;

  return (
    <div className="space-y-6 max-w-3xl">
      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
          <Plug className="h-3.5 w-3.5" /> Connected apps
        </h3>
        <p className="text-xs text-muted-foreground mb-2">
          Apps (Claude, ChatGPT, Claude Code…) allowed on the consent page to use this instance through its MCP connector, with the scopes they were given.
          Revoking one disconnects it at once; it can connect again, asking you anew.
        </p>
        <Card className="bg-card/80 border-border/40 py-0 gap-0">
          <CardContent className="p-0">
            {access.grants.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-muted-foreground">No app is connected.</p>
            ) : (
              <div className="divide-y divide-border/40" data-testid="mcp-grants">
                {access.grants.map((g) => (
                  <div key={g.id} className="flex items-start gap-3 px-4 py-3" data-testid={`mcp-grant-${g.id}`}>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium truncate">{g.client_name}</span>
                        <span className="text-xs text-muted-foreground">allowed by {g.subject === "api-key" ? "an API or MCP key" : g.subject === "local" ? "this server (no login)" : g.subject}</span>
                      </div>
                      <ScopeBadges scopes={g.scopes} all={access.scopes} />
                      {g.legacy && (
                        <p className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                          <AlertTriangle className="h-3 w-3" /> Connected before scopes: it has every scope. Revoke it and connect again to choose fewer.
                        </p>
                      )}
                      <p className="text-[11px] text-muted-foreground">
                        Connected {formatWhen(g.created_at)} · last used {formatWhen(g.last_used_at)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 gap-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      onClick={() => setRevoking(g)}
                      aria-label={`Revoke ${g.client_name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Revoke
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
          <KeyRound className="h-3.5 w-3.5" /> Keys
        </h3>
        <p className="text-xs text-muted-foreground mb-2">
          Keys that open the connector directly. Their values are never shown here. Narrow <code className="font-mono">POLPO_MCP_KEY</code> with{" "}
          <code className="font-mono">POLPO_MCP_KEY_SCOPES</code>, or add named keys in <code className="font-mono">settings.mcp.keys</code> (values in the vault).
        </p>
        <Card className="bg-card/80 border-border/40 py-0 gap-0">
          <CardContent className="p-0">
            {access.keys.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-muted-foreground">No key: only signed-in people and connected apps use the connector.</p>
            ) : (
              <div className="divide-y divide-border/40" data-testid="mcp-keys">
                {access.keys.map((k) => (
                  <div key={`${k.source}:${k.name}`} className="flex items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{k.name}</span>
                        <span className="text-xs text-muted-foreground">{KEY_SOURCE_LABEL[k.source]}{k.ref ? ` · vault ${k.ref}` : ""}</span>
                      </div>
                      <ScopeBadges scopes={k.scopes} all={access.scopes} />
                      {k.source === "env" && !k.explicit && (
                        <p className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                          <AlertTriangle className="h-3 w-3" /> Every scope, as before scopes existed. Set POLPO_MCP_KEY_SCOPES to give it only what it needs.
                        </p>
                      )}
                      {k.problem && <p className="text-[11px] text-destructive">{k.problem}</p>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Scopes</h3>
        <div className="grid gap-1.5">
          {access.scopes.map((s) => (
            <div key={s.id} className="text-xs">
              <code className="font-mono">{s.id}</code> <span className="font-medium">{s.label}</span>
              <span className="text-muted-foreground"> — {s.description} ({access.tools.filter((t) => t.scope === s.id).length} tools)</span>
            </div>
          ))}
        </div>
      </section>

      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(open) => { if (!open) setRevoking(null); }}
        title={`Revoke ${revoking?.client_name ?? "this app"}?`}
        description="It stops working at once, on every device where it was allowed by the same person. It can connect again by asking you anew."
        confirmLabel="Revoke"
        destructive
        loading={busy}
        onConfirm={() => void revoke()}
      />
    </div>
  );
}
