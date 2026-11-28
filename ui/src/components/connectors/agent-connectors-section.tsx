/**
 * Agent page → Tools: the connectors at this agent's disposal, with a switch to enable or disable
 * each one for it (PATCH the connector's access). Two tabs: Enabled (this agent can use them) and
 * Available (every organization connector not enabled for it, plus its own personal ones not
 * enabled). Another agent's personal connector (scope agent) never shows here. Each row says
 * whether it is the organization's ("Org") or this agent's own ("Personal"). Connectors open to
 * every agent show as enabled; turning one off keeps every other agent. An enabled connector
 * expands to choose which of its tools the agent gets (all, or only selected ones: agent.connectorTools).
 *
 * A per-identity connector ("Identity" chip) is enabled like an organization one; once enabled, its
 * row lists this agent's own accounts (never another agent's) with sign-in, default and remove, and
 * adds new ones for this agent.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useAgents } from "@polpo-ai/react";
import { toast } from "sonner";
import { AlertTriangle, ChevronDown, Plug, Plus } from "lucide-react";
import { SectionHeader } from "@/components/shared/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useConnectors } from "@/hooks/use-connectors";
import {
  ORG_IDENTITY, accountLabel, accountsOf, agentHasAccess, agentIdentity, allowedToolsCoverConnector, connectorOwner, connectorState, connectorToolsEntry,
  connectorVisibleTo, connectorsApi, fallbackOn, isIdentityConnector, toggleAgentAccess,
  type AgentConnectorTools as Selection, type Connector,
} from "@/lib/connectors-api";
import { AccountRow, AddAccountForm, useAccountSignIn } from "./connector-accounts";
import { cn } from "@/lib/utils";
import { AgentConnectorTools } from "./agent-connector-tools";
import { ConnectorIcon } from "./connector-icon";
import { StateBadge, Switch } from "./connector-bits";

/** This agent's accounts on a per-identity connector: list, sign in, default, remove, add. */
function AgentAccounts({ connector, agentName, agentLabel, onChanged }: {
  connector: Connector; agentName: string; agentLabel: string; onChanged: (c: Connector) => void;
}) {
  const identity = agentIdentity(agentName);
  const signIn = useAccountSignIn(onChanged);
  const [adding, setAdding] = useState(false);
  const mine = accountsOf(connector, identity);
  const shared = fallbackOn(connector) && accountsOf(connector, ORG_IDENTITY).length > 0;
  return (
    <div className="space-y-2 border-t border-border/40 px-3 py-2" data-testid={`agent-accounts-${connector.id}`}>
      {mine.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="agent-no-account">
          No account yet{shared ? ": uses the organization's shared account" : ""}.
        </p>
      ) : (
        <ul className="divide-y rounded-md border border-border/40">
          {mine.map((account) => (
            <AccountRow key={account.id} connector={connector} account={account} signIn={signIn} onChanged={onChanged} compact />
          ))}
        </ul>
      )}
      {adding ? (
        <AddAccountForm connector={connector} options={[{ value: identity, label: agentLabel }]} signIn={signIn} onChanged={onChanged} onDone={() => setAdding(false)} />
      ) : (
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!connector.enabled} onClick={() => setAdding(true)}
          aria-label={`Add a ${connector.name} account for ${agentLabel}`}>
          <Plus className="h-3.5 w-3.5" /> Add account
        </Button>
      )}
    </div>
  );
}

export function AgentConnectorsSection({
  agentName, allowedTools, connectorTools, onConnectorToolsSaved,
}: {
  agentName: string;
  allowedTools?: string[];
  /** The agent's per-connector tool selection (agent.connectorTools). */
  connectorTools?: Selection;
  /** After a selection is saved (e.g. reload the agent). */
  onConnectorToolsSaved?: () => void | Promise<void>;
}) {
  const { connectors, loading, error, upsert } = useConnectors();
  const { agents } = useAgents();
  const agent = agents.find((a) => a.name === agentName);
  const agentLabel = agent?.identity?.displayName?.trim() || agentName;
  const [saving, setSaving] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // the last saved selection, ahead of the agent reload
  const [selection, setSelection] = useState<{ value: Selection | undefined; base: Selection | undefined } | null>(null);
  const current = selection && selection.base === connectorTools ? selection.value : connectorTools;
  // another agent's personal connectors are never at this agent's disposal
  const mine = connectors.filter((c) => connectorVisibleTo(c, agentName));
  const enabled = mine.filter((c) => agentHasAccess(c.access, agentName));
  const available = mine.filter((c) => !agentHasAccess(c.access, agentName));
  const granted = enabled.length;
  // Enabled first; with none enabled yet, open on Available. A toggle keeps the tab where it is.
  const [chosenTab, setTab] = useState<"enabled" | "available" | null>(null);
  const tab = chosenTab ?? (granted > 0 ? "enabled" : "available");

  const toggle = async (connector: Connector, on: boolean) => {
    const access = toggleAgentAccess(connector.access, agentName, on, agents.map((a) => a.name));
    setSaving(connector.id);
    upsert({ ...connector, access }); // optimistic
    try {
      upsert(await connectorsApi.update(connector.id, { access }));
    } catch (reason) {
      upsert(connector);
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(null);
    }
  };

  return (
    <div>
      <SectionHeader title="Connectors" icon={Plug} count={granted} />
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading connectors…</p>
      ) : error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : mine.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No connectors yet. <Link to="/connectors" className="text-primary hover:underline">Connect an app</Link> (Linear, Notion, GitHub…) and give this agent its tools.
        </p>
      ) : (
        <div className="space-y-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as "enabled" | "available")} className="gap-2">
          <TabsList>
            <TabsTrigger value="enabled" data-testid="agent-connectors-tab-enabled">Enabled ({enabled.length})</TabsTrigger>
            <TabsTrigger value="available" data-testid="agent-connectors-tab-available">Available ({available.length})</TabsTrigger>
          </TabsList>
          {(["enabled", "available"] as const).map((key) => {
            const list = key === "enabled" ? enabled : available;
            return (
              <TabsContent key={key} value={key} forceMount className="space-y-1.5 data-[state=inactive]:hidden" data-testid={`agent-connectors-${key}`}>
                {list.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    {key === "enabled" ? "No connector enabled for this agent yet: turn one on in Available." : "Every connector is enabled for this agent."}
                  </p>
                )}
          {list.map((connector) => {
            const on = agentHasAccess(connector.access, agentName);
            const blockedByAllowlist = on && !allowedToolsCoverConnector(allowedTools, connector.id);
            const entry = connectorToolsEntry(current, connector.id);
            const open = on && expanded === connector.id;
            const account = accountLabel(connector, connectors);
            const perIdentity = isIdentityConnector(connector);
            const myAccounts = perIdentity ? accountsOf(connector, agentIdentity(agentName)) : [];
            return (
              <div key={connector.id} className="rounded-lg border border-border/40 bg-card/60">
                <div data-testid={`agent-connector-${connector.id}`} className="flex items-center gap-3 px-3 py-2">
                  <ConnectorIcon catalogId={connector.catalogId} name={connector.name} color={connector.icon?.color} iconUrl={connector.iconUrl} iconDarkUrl={connector.iconDarkUrl} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 items-baseline gap-1.5">
                      <span className="truncate text-sm font-medium">{connector.name}</span>
                      {/* several accounts of one app: which one this is */}
                      {account && <span className="min-w-0 truncate text-caption text-muted-foreground">{account}</span>}
                      {/* the organization's, or this agent's own */}
                      {perIdentity ? (
                        <Badge variant="outline" data-testid="connector-scope-chip" className="shrink-0 self-center border-primary/40 bg-primary/10 px-1.5 py-0 text-micro text-primary">Identity</Badge>
                      ) : connectorOwner(connector) ? (
                        <Badge variant="outline" data-testid="connector-scope-chip" className="shrink-0 self-center border-primary/40 bg-primary/10 px-1.5 py-0 text-micro text-primary">Personal</Badge>
                      ) : (
                        <Badge variant="outline" data-testid="connector-scope-chip" className="shrink-0 self-center px-1.5 py-0 text-micro text-muted-foreground">Org</Badge>
                      )}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {perIdentity ? (on ? (myAccounts.length ? `${myAccounts.length} account${myAccounts.length === 1 ? "" : "s"} of its own` : "No account yet") : "Not granted: enable it to connect its accounts")
                        : connectorOwner(connector) ? (on ? "Its own: only this agent can use it" : "Its own: not enabled yet")
                        : connector.access.agents === "*" ? "Open to every agent" : on ? "This agent can use its tools" : "Not granted"}
                      {on && entry !== "*" ? ` · ${entry.length} selected tool${entry.length === 1 ? "" : "s"}` : connector.toolCount !== undefined ? ` · ${connector.toolCount} tools` : ""}
                    </p>
                    {blockedByAllowlist && (
                      <p className="mt-0.5 flex items-center gap-1 text-caption text-warning">
                        <AlertTriangle className="h-3 w-3 shrink-0" />
                        Its allowed tools list has no <code className="font-mono">mcp__{connector.id}__*</code>: add it to use these tools.
                      </p>
                    )}
                  </div>
                  {/* per identity: the state of this agent's accounts, below (never the others') */}
                  {!perIdentity && <StateBadge state={connectorState(connector)} className="hidden sm:inline-flex" />}
                  {on && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 px-2 text-xs"
                      aria-expanded={open}
                      aria-label={`${open ? "Hide" : "Choose"} ${connector.name} tools for ${agentName}`}
                      onClick={() => setExpanded(open ? null : connector.id)}
                    >
                      Tools <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
                    </Button>
                  )}
                  <Switch
                    label={`${agentName} can use ${connector.name}`}
                    checked={on}
                    disabled={saving === connector.id}
                    onChange={(next) => void toggle(connector, next)}
                  />
                </div>
                {perIdentity && on && <AgentAccounts connector={connector} agentName={agentName} agentLabel={agentLabel} onChanged={upsert} />}
                {open && (
                  <AgentConnectorTools
                    agentName={agentName}
                    connector={connector}
                    selection={current}
                    onSaved={async (value) => {
                      setSelection({ value, base: connectorTools });
                      await onConnectorToolsSaved?.();
                    }}
                  />
                )}
              </div>
            );
          })}
              </TabsContent>
            );
          })}
        </Tabs>
          <Link to="/connectors" className="inline-block pt-1 text-xs text-primary hover:underline">Manage connectors</Link>
        </div>
      )}
    </div>
  );
}
