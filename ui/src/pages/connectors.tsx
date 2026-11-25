/**
 * Connectors: the apps Polpo and the agents can use over MCP (Linear, Notion, GitHub, Google…).
 *
 * "Connected" lists the workspace's connectors with their status; "Browse" is the catalog of
 * official remote MCP servers with search and categories. Connecting opens the service's sign-in
 * in a window (OAuth), or asks for a key / URL / region first; vendors without self-registration
 * get a one-time OAuth app setup. Each connector's sheet sets who can use it and per-tool policy.
 * Live: `connector:changed` over SSE.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAgents } from "@polpo-ai/react";
import { toast } from "sonner";
import { BadgeCheck, KeyRound, Loader2, Plug, Plus, Search, Server, Sparkles, UserPlus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { StateBadge } from "@/components/connectors/connector-bits";
import { ConnectorCard, ConnectorListRow } from "@/components/connectors/connector-card";
import { ConnectDialog } from "@/components/connectors/connect-dialog";
import { ConnectorDetailSheet, type AgentOption } from "@/components/connectors/connector-detail-sheet";
import { CustomConnectorDialog } from "@/components/connectors/custom-connector-dialog";
import { OAuthAppsDialog } from "@/components/connectors/oauth-apps-dialog";
import { CreateServerDialog, HostedServersList } from "@/components/connectors/hosted-servers";
import { HostedServerSheet } from "@/components/connectors/hosted-server-sheet";
import { ReadyMadeConnectors } from "@/components/connectors/ready-made-connectors";
import { hostedLabel } from "@/lib/mcp-servers";
import { useConnectFlow } from "@/components/connectors/use-connect-flow";
import { useConnectors } from "@/hooks/use-connectors";
import {
  accountLabel, authLabel, catalogCardState, catalogCategories, connectorState, connectorsApi, filterCatalog, filterConnectors,
  groupConnectors, nextAccountName,
  type CatalogEntry, type Connector, type ConnectorCardState,
} from "@/lib/connectors-api";
import { cn } from "@/lib/utils";
import { productName, useInstanceBranding } from "@/lib/branding";
import { PageHeader } from "@/components/shared/page-header";

function accessSummary(connector: Connector, agentLabel: (name: string) => string, product: string): string {
  const parts: string[] = [];
  if (connector.access.polpo) parts.push(product);
  if (connector.access.agents === "*") parts.push("all agents");
  else if (connector.access.agents.length === 1) parts.push(agentLabel(connector.access.agents[0]!));
  else if (connector.access.agents.length > 1) parts.push(`${connector.access.agents.length} agents`);
  return parts.length ? `Used by ${parts.join(" and ")}` : "Nobody can use it yet";
}

/** The main button of a card / row for a given state. */
function actionLabel(state: ConnectorCardState): string {
  switch (state) {
    case "connect": return "Connect";
    case "needs_setup": return "Set up";
    case "needs_auth": return "Sign in";
    case "needs_reauth": return "Reconnect";
    case "error": return "Fix";
    default: return "Manage";
  }
}

function CatalogCard({
  entry, state, connector, accounts, onConnect, onManage, onAddAccount,
}: {
  entry: CatalogEntry; state: ConnectorCardState; connector?: Connector; accounts: number;
  onConnect: () => void; onManage: () => void;
  /** Connect another account of this app (a second inbox, one per agent…). */
  onAddAccount: () => void;
}) {
  const primary = state === "connect" || state === "needs_setup" || state === "needs_auth" || state === "needs_reauth";
  // an added connector waiting for sign-in (or setup) can also be managed: sign in, or remove it
  const manageToo = primary && !!connector;
  return (
    <ConnectorCard
      testId={`catalog-card-${entry.id}`}
      icon={<ConnectorIcon catalogId={entry.id} name={entry.name} color={entry.icon?.color} />}
      title={entry.name}
      subtitle={`${entry.category}${accounts > 1 ? ` · ${accounts} accounts` : ""}`}
      status={state !== "connect" ? <StateBadge state={state} /> : undefined}
      description={entry.description}
      footer={<>
        <Badge variant="outline" className="text-micro font-normal text-muted-foreground">{authLabel(entry)}</Badge>
        {entry.inClaudeDirectory && (
          <Badge variant="outline" className="gap-1 text-micro font-normal text-muted-foreground" title="Listed in Claude's connector directory">
            <BadgeCheck className="h-3 w-3" /> In Claude directory
          </Badge>
        )}
        {connector && (
          <Button
            size="sm" variant="ghost" className="ml-auto h-7 gap-1 px-2 text-xs"
            onClick={onAddAccount} aria-label={`Add another ${entry.name} account`} title={`Connect another ${entry.name} account`}
          >
            <UserPlus className="h-3.5 w-3.5" /> Account
          </Button>
        )}
        {manageToo && (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onManage} aria-label={`Manage ${entry.name}`}>
            Manage
          </Button>
        )}
        <Button
          size="sm"
          variant={primary ? "default" : "outline"}
          className={cn("h-7 px-3 text-xs", !connector && "ml-auto")}
          onClick={primary ? onConnect : onManage}
          aria-label={`${actionLabel(state)} ${entry.name}`}
        >
          {actionLabel(state)}
        </Button>
      </>}
    />
  );
}

function ConnectorRow({
  connector, account, agentLabel, onManage, onReconnect,
}: {
  connector: Connector;
  /** What tells it apart from the other accounts of the same app (signed-in account, or id). */
  account?: string;
  agentLabel: (name: string) => string; onManage: () => void; onReconnect: () => void;
}) {
  const product = productName(useInstanceBranding());
  const state = connectorState(connector);
  const needsSignIn = state === "needs_auth" || state === "needs_reauth";
  return (
    <ConnectorListRow
      testId={`connector-row-${connector.id}`}
      icon={<ConnectorIcon catalogId={connector.catalogId} name={connector.name} color={connector.icon?.color} iconUrl={connector.iconUrl} iconDarkUrl={connector.iconDarkUrl} />}
      title={connector.name}
      badges={<>
        {account && <span className="min-w-0 truncate text-xs text-muted-foreground" data-testid={`connector-account-${connector.id}`}>{account}</span>}
        {connector.transport.type === "hosted"
          ? <Badge variant="secondary" className="text-micro font-normal" data-testid={`hosted-badge-${connector.id}`}>{hostedLabel(product, connector.hostedVersion)}</Badge>
          : !connector.catalogId && <Badge variant="secondary" className="text-micro font-normal">Custom</Badge>}
      </>}
      summary={state === "needs_reauth" ? `${product} lost access to ${connector.name}. Sign in again to keep using it.`
        : state === "error" && connector.lastError ? connector.lastError
        : `${accessSummary(connector, agentLabel, product)}${connector.toolCount !== undefined && state === "connected" ? ` · ${connector.toolCount} tools` : ""}`}
      status={<StateBadge state={state} />}
      actions={needsSignIn ? <Button size="sm" className="h-8" onClick={onReconnect}>{actionLabel(state)}</Button> : undefined}
      onOpen={onManage}
      manageLabel={`Manage ${connector.name}`}
    />
  );
}

export function ConnectorsPage() {
  const [params, setParams] = useSearchParams();
  const connectedParam = params.get("connected");
  const serverParam = params.get("server");
  const { connectors, catalog, loading, error, refresh, refreshCatalog, upsert, drop } = useConnectors({ withCatalog: true });
  const { agents } = useAgents();
  const product = productName(useInstanceBranding());
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [tab, setTab] = useState<string | null>(connectedParam ? "connected" : serverParam || params.get("tab") === "servers" ? "servers" : null);
  const [serverId, setServerId] = useState<string | null>(serverParam);
  const [createServerOpen, setCreateServerOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(connectedParam);
  const [customOpen, setCustomOpen] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);

  const flow = useConnectFlow({ connectors, oauthApps: catalog?.oauthApps ?? [], onChanged: upsert });

  // Back from the OAuth callback page (?connected=<id>): say so once and drop the parameter.
  useEffect(() => {
    if (!connectedParam) return;
    toast.success("Connected");
    const next = new URLSearchParams(params);
    next.delete("connected");
    setParams(next, { replace: true });
  }, [connectedParam, params, setParams]);

  const agentOptions = useMemo<AgentOption[]>(
    () => agents.map((a) => ({ name: a.name, label: a.identity?.displayName?.trim() || a.name, avatar: a.identity?.avatar })).sort((a, b) => a.label.localeCompare(b.label)),
    [agents],
  );
  const agentLabel = (name: string) => agentOptions.find((a) => a.name === name)?.label ?? name;

  const entries = useMemo(() => catalog?.entries ?? [], [catalog]);
  const categories = useMemo(() => catalogCategories(entries), [entries]);
  const visibleEntries = useMemo(() => filterCatalog(entries, { query, category }), [entries, query, category]);
  const visibleConnectors = useMemo(() => filterConnectors(connectors, query), [connectors, query]);
  const selected = connectors.find((c) => c.id === selectedId) ?? null;
  const selectedEntry = selected?.catalogId ? entries.find((e) => e.id === selected.catalogId) : undefined;
  const activeTab = tab ?? (loading || connectors.length > 0 ? "connected" : "browse");
  const oauthApps = catalog?.oauthApps ?? [];

  const manage = (connector: Connector) => { flow.close(); setSelectedId(connector.id); };
  /** Another account of a catalog app (a click: may open the sign-in window after the name step). */
  const addAccount = (entry: CatalogEntry) => {
    setSelectedId(null);
    flow.open({ entry, another: true, name: nextAccountName(entry, connectors) });
  };
  /** Keep the tab the person is on (the default tab follows whether anything is connected). */
  const stay = () => setTab((t) => t ?? activeTab);

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-4 overflow-y-auto p-4 pb-bottom-nav sm:p-6 lg:pb-6">
      <PageHeader
        title="Connectors"
        icon={Plug}
        description={`Connect the apps your team uses. ${product} and the agents you choose get their tools.`}
        actions={<>
          <Button variant="outline" onClick={() => setAppsOpen(true)}>
            <KeyRound className="h-4 w-4" /> OAuth apps
          </Button>
          <Button variant="outline" onClick={() => setCreateServerOpen(true)}>
            <Sparkles className="h-4 w-4" /> Create server
          </Button>
          <Button onClick={() => setCustomOpen(true)}>
            <Plus className="h-4 w-4" /> Add custom connector
          </Button>
        </>}
      />

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search connectors"
          aria-label="Search connectors"
          className="pl-9 pr-9"
        />
        {query && (
          <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-xs p-1 text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
          {error}
          <Button size="sm" variant="outline" className="ml-auto h-7" onClick={() => { void refresh(); void refreshCatalog(); }}>Retry</Button>
        </div>
      )}

      <Tabs value={activeTab} onValueChange={setTab} className="gap-4">
        <TabsList>
          <TabsTrigger value="connected">Connected{connectors.length ? ` (${connectors.length})` : ""}</TabsTrigger>
          <TabsTrigger value="browse">Browse{entries.length ? ` (${entries.length})` : ""}</TabsTrigger>
          <TabsTrigger value="servers"><Server className="h-3.5 w-3.5" /> Hosted servers</TabsTrigger>
        </TabsList>

        <TabsContent value="servers" className="space-y-6">
          <ReadyMadeConnectors agents={agentOptions} onOpenServer={setServerId} />
          <section className="space-y-3" aria-labelledby="hosted-servers-title">
            <div>
              <h2 id="hosted-servers-title" className="text-sm font-medium">Your hosted servers</h2>
              <p className="text-sm text-muted-foreground">
                MCP servers {product} builds and hosts — from an API's docs, a description or a template. Each becomes a connector when published.
              </p>
            </div>
            <HostedServersList onOpen={setServerId} onCreate={() => setCreateServerOpen(true)} />
          </section>
        </TabsContent>

        <TabsContent value="connected" className="space-y-2">
          {loading ? (
            <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading connectors…</p>
          ) : connectors.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-12 text-center">
              <Plug className="h-8 w-8 text-muted-foreground" />
              <div>
                <p className="font-medium">No connectors yet</p>
                <p className="text-sm text-muted-foreground">Connect Linear, Notion, GitHub, Google and more, or any MCP server.</p>
              </div>
              <div className="flex gap-2">
                <Button onClick={() => setTab("browse")}>Browse connectors</Button>
                <Button variant="outline" onClick={() => setCustomOpen(true)}>Add custom</Button>
              </div>
            </div>
          ) : visibleConnectors.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No connected app matches “{query}”.</p>
          ) : (
            groupConnectors(visibleConnectors).map((group) => {
              const rows = group.connectors.map((c) => (
                <ConnectorRow
                  key={c.id} connector={c} account={accountLabel(c, connectors)} agentLabel={agentLabel}
                  onManage={() => manage(c)} onReconnect={() => flow.open({ connector: c, entry: entries.find((e) => e.id === c.catalogId) })}
                />
              ));
              const groupEntry = group.catalogId ? entries.find((e) => e.id === group.catalogId) : undefined;
              if (group.connectors.length < 2) return rows;
              // several accounts of one app: kept together under its name
              return (
                <section key={group.key} data-testid={`connector-group-${group.catalogId}`} className="space-y-2 rounded-card border border-dashed p-2">
                  <div className="flex items-center gap-2 px-1">
                    <p className="text-xs font-medium text-muted-foreground">
                      {groupEntry?.name ?? group.connectors[0]!.name} · {group.connectors.length} accounts
                    </p>
                    {groupEntry && (
                      <Button size="sm" variant="ghost" className="ml-auto h-7 gap-1 px-2 text-xs" onClick={() => addAccount(groupEntry)} aria-label={`Add another ${groupEntry.name} account`}>
                        <UserPlus className="h-3.5 w-3.5" /> Add account
                      </Button>
                    )}
                  </div>
                  {rows}
                </section>
              );
            })
          )}
        </TabsContent>

        <TabsContent value="browse" className="space-y-4">
          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 sm:flex-wrap" role="group" aria-label="Categories">
            <CategoryChip active={category === null} onClick={() => setCategory(null)} label="All" count={entries.length} />
            {categories.map((c) => (
              <CategoryChip key={c.name} active={category === c.name} onClick={() => setCategory(category === c.name ? null : c.name)} label={c.name} count={c.count} />
            ))}
          </div>
          {!catalog ? (
            <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading the catalog…</p>
          ) : visibleEntries.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <p className="text-sm text-muted-foreground">Nothing in the catalog matches{query ? ` “${query}”` : ""}.</p>
              <Button variant="outline" size="sm" onClick={() => setCustomOpen(true)}>Add it as a custom connector</Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visibleEntries.map((entry) => {
                const { state, connector, accounts } = catalogCardState(entry, connectors, oauthApps);
                return (
                  <CatalogCard
                    key={entry.id}
                    entry={entry}
                    state={state}
                    connector={connector}
                    accounts={accounts.length}
                    onAddAccount={() => { stay(); addAccount(entry); }}
                    onConnect={() => { stay(); flow.open({ entry, ...(connector ? { connector } : {}) }); }}
                    onManage={() => connector && manage(connector)}
                  />
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <ConnectDialog
        state={flow.state}
        redirectUri={catalog?.redirectUri ?? ""}
        onBegin={flow.begin}
        onSetup={flow.openSetup}
        onSetupSaved={async () => { await refreshCatalog(); flow.setupSaved(); }}
        onOpenFallback={flow.openFallback}
        onClose={flow.close}
        onManage={manage}
        onRetry={() => { if (flow.state.target) flow.open(flow.state.target); }}
        onRename={async (c, name) => {
          try {
            upsert(await connectorsApi.update(c.id, { name }));
            toast.success(`Renamed to ${name}`);
          } catch (reason) {
            toast.error(reason instanceof Error ? reason.message : String(reason));
            throw reason;
          }
        }}
        onRemove={async (c) => {
          flow.close();
          try {
            await connectorsApi.remove(c.id);
            drop(c.id);
            toast.success(`${c.name} removed`);
          } catch (reason) {
            toast.error(reason instanceof Error ? reason.message : String(reason));
          }
        }}
      />

      <CustomConnectorDialog
        open={customOpen}
        onOpenChange={setCustomOpen}
        redirectUri={catalog?.redirectUri}
        onSubmit={(input) => { setCustomOpen(false); setTab("connected"); flow.open({ create: input }); }}
      />

      <OAuthAppsDialog
        open={appsOpen}
        onOpenChange={setAppsOpen}
        apps={oauthApps}
        redirectUri={catalog?.redirectUri ?? ""}
        onChanged={refreshCatalog}
      />

      <CreateServerDialog open={createServerOpen} onOpenChange={setCreateServerOpen} onCreated={(id) => { setTab("servers"); setServerId(id); }} />
      <HostedServerSheet
        key={serverId ?? "none"} id={serverId} open={!!serverId} onOpenChange={(o) => { if (!o) setServerId(null); }}
        onOpenConnector={(id) => { setServerId(null); setSelectedId(id); }}
      />

      <ConnectorDetailSheet
        connector={selected}
        entry={selectedEntry}
        agents={agentOptions}
        open={!!selected}
        onOpenChange={(open) => { if (!open) setSelectedId(null); }}
        onChanged={upsert}
        onRemoved={(id) => { drop(id); setSelectedId(null); }}
        onReconnect={(c) => { setSelectedId(null); flow.open({ connector: c, entry: selectedEntry }); }}
        onSetupApp={(c, appId) => { setSelectedId(null); flow.open({ connector: c, entry: selectedEntry, oauthApp: appId }); }}
        accountCount={selectedEntry ? catalogCardState(selectedEntry, connectors, oauthApps).accounts.length : 0}
        onAddAccount={selectedEntry ? () => addAccount(selectedEntry) : undefined}
        onOpenHostedServer={(id) => { setSelectedId(null); setServerId(id); }}
      />
    </div>
  );
}

function CategoryChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "shrink-0 whitespace-nowrap rounded-pill border px-3 py-1 text-xs transition-colors",
        active ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:border-foreground/30 hover:text-foreground",
      )}
    >
      {label} <span className={cn("ml-0.5", active ? "opacity-80" : "opacity-60")}>{count}</span>
    </button>
  );
}
