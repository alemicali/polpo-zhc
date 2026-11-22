/**
 * Agent page → Tools: which connectors this agent can use, with a switch to grant or revoke each
 * one (PATCH the connector's access). Connectors open to every agent show as granted; turning one
 * off keeps every other agent. A granted connector expands to choose which of its tools the agent
 * gets (all, or only selected ones: agent.connectorTools).
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useAgents } from "@polpo-ai/react";
import { toast } from "sonner";
import { AlertTriangle, ChevronDown, Plug } from "lucide-react";
import { SectionHeader } from "@/components/shared/section-header";
import { Button } from "@/components/ui/button";
import { useConnectors } from "@/hooks/use-connectors";
import {
  accountLabel, agentHasAccess, allowedToolsCoverConnector, connectorState, connectorToolsEntry, connectorsApi, toggleAgentAccess,
  type AgentConnectorTools as Selection, type Connector,
} from "@/lib/connectors-api";
import { cn } from "@/lib/utils";
import { AgentConnectorTools } from "./agent-connector-tools";
import { ConnectorIcon } from "./connector-icon";
import { StateBadge, Switch } from "./connector-bits";

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
  const [saving, setSaving] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // the last saved selection, ahead of the agent reload
  const [selection, setSelection] = useState<{ value: Selection | undefined; base: Selection | undefined } | null>(null);
  const current = selection && selection.base === connectorTools ? selection.value : connectorTools;
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
            const entry = connectorToolsEntry(current, connector.id);
            const open = on && expanded === connector.id;
            const account = accountLabel(connector, connectors);
            return (
              <div key={connector.id} className="rounded-lg border border-border/40 bg-card/60">
                <div data-testid={`agent-connector-${connector.id}`} className="flex items-center gap-3 px-3 py-2">
                  <ConnectorIcon catalogId={connector.catalogId} name={connector.name} color={connector.icon?.color} iconUrl={connector.iconUrl} iconDarkUrl={connector.iconDarkUrl} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 items-baseline gap-1.5">
                      <span className="truncate text-sm font-medium">{connector.name}</span>
                      {/* several accounts of one app: which one this is */}
                      {account && <span className="min-w-0 truncate text-caption text-muted-foreground">{account}</span>}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {connector.access.agents === "*" ? "Open to every agent" : on ? "This agent can use its tools" : "Not granted"}
                      {on && entry !== "*" ? ` · ${entry.length} selected tool${entry.length === 1 ? "" : "s"}` : connector.toolCount !== undefined ? ` · ${connector.toolCount} tools` : ""}
                    </p>
                    {blockedByAllowlist && (
                      <p className="mt-0.5 flex items-center gap-1 text-caption text-warning">
                        <AlertTriangle className="h-3 w-3 shrink-0" />
                        Its allowed tools list has no <code className="font-mono">mcp__{connector.id}__*</code>: add it to use these tools.
                      </p>
                    )}
                  </div>
                  <StateBadge state={connectorState(connector)} className="hidden sm:inline-flex" />
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
          <Link to="/connectors" className="inline-block pt-1 text-xs text-primary hover:underline">Manage connectors</Link>
        </div>
      )}
    </div>
  );
}
