/**
 * Agent page → Tools: which connectors this agent can use, with a switch to grant or revoke each
 * one (PATCH the connector's access). Connectors open to every agent show as granted; turning one
 * off keeps every other agent.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useAgents } from "@polpo-ai/react";
import { toast } from "sonner";
import { AlertTriangle, Plug } from "lucide-react";
import { SectionHeader } from "@/components/shared/section-header";
import { useConnectors } from "@/hooks/use-connectors";
import {
  agentHasAccess, allowedToolsCoverConnector, connectorState, connectorsApi, toggleAgentAccess,
  type Connector,
} from "@/lib/connectors-api";
import { ConnectorIcon } from "./connector-icon";
import { StateBadge, Switch } from "./connector-bits";

export function AgentConnectorsSection({ agentName, allowedTools }: { agentName: string; allowedTools?: string[] }) {
  const { connectors, loading, error, upsert } = useConnectors();
  const { agents } = useAgents();
  const [saving, setSaving] = useState<string | null>(null);
  const granted = connectors.filter((c) => agentHasAccess(c.access, agentName)).length;

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
      ) : connectors.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No connectors yet. <Link to="/connectors" className="text-primary hover:underline">Connect an app</Link> (Linear, Notion, GitHub…) and give this agent its tools.
        </p>
      ) : (
        <div className="space-y-1.5">
          {connectors.map((connector) => {
            const on = agentHasAccess(connector.access, agentName);
            const blockedByAllowlist = on && !allowedToolsCoverConnector(allowedTools, connector.id);
            return (
              <div key={connector.id} data-testid={`agent-connector-${connector.id}`} className="flex items-center gap-3 rounded-lg border border-border/40 bg-card/60 px-3 py-2">
                <ConnectorIcon catalogId={connector.catalogId} name={connector.name} color={connector.icon?.color} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{connector.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {connector.access.agents === "*" ? "Open to every agent" : on ? "This agent can use its tools" : "Not granted"}
                    {connector.toolCount !== undefined ? ` · ${connector.toolCount} tools` : ""}
                  </p>
                  {blockedByAllowlist && (
                    <p className="mt-0.5 flex items-center gap-1 text-caption text-warning">
                      <AlertTriangle className="h-3 w-3 shrink-0" />
                      Its allowed tools list has no <code className="font-mono">mcp__{connector.id}__*</code>: add it to use these tools.
                    </p>
                  )}
                </div>
                <StateBadge state={connectorState(connector)} className="hidden sm:inline-flex" />
                <Switch
                  label={`${agentName} can use ${connector.name}`}
                  checked={on}
                  disabled={saving === connector.id}
                  onChange={(next) => void toggle(connector, next)}
                />
              </div>
            );
          })}
          <Link to="/connectors" className="inline-block pt-1 text-xs text-primary hover:underline">Manage connectors</Link>
        </div>
      )}
    </div>
  );
}
