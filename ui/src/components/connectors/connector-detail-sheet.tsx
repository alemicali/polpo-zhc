/**
 * A connector's settings: status and actions (Reconnect, Test, Disconnect, Remove), who can use
 * it (Polpo, every agent, or chosen agents) and its tools with a per-tool policy.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Bot, ExternalLink, Loader2, Plug, RefreshCw, RotateCw, Terminal, Trash2, Unplug, Users, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SegmentedControl, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import {
  agentHasAccess, connectorState, connectorsApi, toggleAgentAccess, toolLabel,
  type CatalogEntry, type Connector, type ConnectorAccess, type ConnectorTool, type ConnectorToolPolicy,
} from "@/lib/connectors-api";
import { cn } from "@/lib/utils";
import { ConnectorIcon } from "./connector-icon";
import { StateBadge, Switch } from "./connector-bits";
import { productName, useInstanceBranding } from "@/lib/branding";

export interface AgentOption {
  name: string;
  label: string;
}

/** Who may use the connector: Polpo, every agent, or the chosen ones. */
export function AccessEditor({
  access, agents, onChange, disabled,
}: { access: ConnectorAccess; agents: AgentOption[]; onChange: (access: ConnectorAccess) => void; disabled?: boolean }) {
  const product = productName(useInstanceBranding());
  const all = access.agents === "*";
  const names = agents.map((a) => a.name);
  return (
    <div className="space-y-1">
      <Row icon={<Plug className="h-4 w-4" />} label={product} hint="The orchestrator chat">
        <Switch label={`${product} can use it`} checked={access.polpo} disabled={disabled} onChange={(polpo) => onChange({ ...access, polpo })} />
      </Row>
      <Row icon={<Users className="h-4 w-4" />} label="All agents" hint="Including agents added later">
        <Switch
          label="All agents can use it" checked={all} disabled={disabled}
          onChange={(on) => onChange({ ...access, agents: on ? "*" : [] })}
        />
      </Row>
      {agents.length > 0 && (
        <div className="mt-1 space-y-1 border-l pl-3">
          {agents.map((agent) => (
            <Row key={agent.name} icon={<Bot className="h-4 w-4" />} label={agent.label} hint={agent.label !== agent.name ? agent.name : undefined}>
              <Switch
                label={`${agent.label} can use it`}
                checked={agentHasAccess(access, agent.name)}
                disabled={disabled || all}
                onChange={(on) => onChange(toggleAgentAccess(access, agent.name, on, names))}
              />
            </Row>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ icon, label, hint, children }: { icon: React.ReactNode; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/40">
      <span className="text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{label}</span>
        {hint && <span className="block truncate text-xs text-muted-foreground">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

const policies = (product: string): Array<{ value: ConnectorToolPolicy; label: string; title: string; soon?: boolean }> => [
  { value: "allow", label: "Allow", title: "Always allow: the tool runs without asking" },
  { value: "ask", label: "Ask", title: `Needs approval (coming soon): ${product} cannot pause a tool call for approval yet, so today "Ask" would run like Allow. Not selectable until the approval step exists.`, soon: true },
  { value: "off", label: "Off", title: `Blocked: hidden from ${product} and every agent` },
];

export function PolicyControl({ tool, value, onChange, disabled }: { tool: string; value: ConnectorToolPolicy; onChange: (p: ConnectorToolPolicy) => void; disabled?: boolean }) {
  const product = productName(useInstanceBranding());
  return (
    <SegmentedControl size="sm" aria-label={`Policy for ${tool}`} value={value} onValueChange={onChange} disabled={disabled}>
      {policies(product).map((p) => {
        const active = value === p.value;
        return (
          <Tooltip key={p.value}>
            <TooltipTrigger asChild>
              <span className="inline-flex h-full">
                <ToggleGroupItem
                  value={p.value}
                  aria-label={`${p.label}${p.soon ? " (coming soon)" : ""}`}
                  disabled={disabled || (p.soon && !active)}
                  className={cn(
                    "disabled:pointer-events-auto disabled:cursor-not-allowed disabled:hover:text-muted-foreground",
                    p.value === "off" && "data-[state=on]:bg-destructive/15 data-[state=on]:text-destructive",
                    p.value === "ask" && "data-[state=on]:bg-warning/15 data-[state=on]:text-warning",
                  )}
                >
                  {p.label}{p.soon ? <sup className="ml-0.5 text-micro uppercase">soon</sup> : null}
                </ToggleGroupItem>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{p.title}</TooltipContent>
          </Tooltip>
        );
      })}
    </SegmentedControl>
  );
}

/** The tools list (loaded when the sheet opens; remounted per connector via `key`). */
function ToolsSection({ connector, onPolicyChange }: { connector: Connector; onPolicyChange: (tool: string, policy: ConnectorToolPolicy) => Promise<void> }) {
  const product = productName(useInstanceBranding());
  const state = connectorState(connector);
  const canList = state === "connected" || state === "not_connected" || state === "error";
  const [tools, setTools] = useState<ConnectorTool[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(canList);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!canList) return;
    let cancelled = false;
    connectorsApi.tools(connector.id, reload > 0).then(
      (list) => { if (!cancelled) { setTools(list); setError(null); setLoading(false); } },
      (reason: unknown) => { if (!cancelled) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); } },
    );
    return () => { cancelled = true; };
  }, [connector.id, canList, reload]);

  const policyOf = (tool: ConnectorTool) => connector.toolPolicy?.[tool.name] ?? tool.policy ?? "allow";

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 font-heading text-h3"><Wrench className="h-4 w-4" /> Tools {tools ? <span className="font-normal text-muted-foreground">({tools.length})</span> : null}</h3>
        {canList && (
          <Button variant="ghost" size="sm" className="ml-auto h-7 gap-1 text-xs" disabled={loading} onClick={() => { setLoading(true); setReload((n) => n + 1); }}>
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
          </Button>
        )}
      </div>
      {!canList && <p className="text-sm text-muted-foreground">Connect {connector.name} to see its tools.</p>}
      {canList && loading && !tools && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading tools…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {tools && tools.length === 0 && <p className="text-sm text-muted-foreground">This server has no tools.</p>}
      {tools && tools.length > 0 && (
        <>
          <p className="text-xs text-muted-foreground">Off hides a tool from {product} and every agent.</p>
          <ul className="divide-y rounded-lg border">
            {tools.map((tool) => (
              <li key={tool.name} className="flex items-start gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className={cn("truncate text-sm font-medium", policyOf(tool) === "off" && "text-muted-foreground line-through")}>{toolLabel(tool)}</p>
                  {toolLabel(tool) !== tool.name && <p className="truncate font-mono text-caption text-muted-foreground">{tool.name}</p>}
                  {tool.description && <p className="line-clamp-2 text-xs text-muted-foreground">{tool.description}</p>}
                </div>
                <PolicyControl tool={tool.name} value={policyOf(tool)} onChange={(p) => void onPolicyChange(tool.name, p)} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function ConnectorDetailSheet({
  connector, entry, agents, open, onOpenChange, onChanged, onRemoved, onReconnect,
}: {
  connector: Connector | null;
  entry?: CatalogEntry;
  agents: AgentOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: (connector: Connector) => void;
  onRemoved: (id: string) => void;
  /** Start sign-in again (a click: opens the sign-in window). */
  onReconnect: (connector: Connector) => void;
}) {
  const product = productName(useInstanceBranding());
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  if (!connector) return null;
  const state = connectorState(connector);
  const oauth = connector.auth.type === "oauth";

  const act = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try { await fn(); } catch (reason) { toast.error(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(null); }
  };
  const patch = (input: Parameters<typeof connectorsApi.update>[1], what = "save") =>
    act(what, async () => { onChanged(await connectorsApi.update(connector.id, input)); });

  const onPolicyChange = async (tool: string, policy: ConnectorToolPolicy) => {
    const next = { ...(connector.toolPolicy ?? {}) };
    if (policy === "allow") delete next[tool];
    else next[tool] = policy;
    onChanged({ ...connector, toolPolicy: next }); // optimistic
    try {
      onChanged(await connectorsApi.update(connector.id, { toolPolicy: next }));
    } catch (reason) {
      onChanged(connector);
      toast.error(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const endpoint = connector.transport.type === "stdio"
    ? [connector.transport.command, ...(connector.transport.args ?? [])].join(" ")
    : connector.transport.url;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-lg">
        <SheetHeader className="border-b">
          <div className="flex items-center gap-3 pr-6">
            <ConnectorIcon catalogId={connector.catalogId} name={connector.name} color={connector.icon?.color} size="lg" />
            <div className="min-w-0">
              <SheetTitle className="truncate">{connector.name}</SheetTitle>
              <SheetDescription className="line-clamp-2">{connector.description ?? entry?.description ?? "Custom MCP server"}</SheetDescription>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StateBadge state={state} />
            {connector.toolCount !== undefined && state === "connected" && <span className="text-xs text-muted-foreground">{connector.toolCount} tools</span>}
            {entry?.docs && (
              <a href={entry.docs} target="_blank" rel="noreferrer noopener" className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline">
                Docs <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </SheetHeader>

        <div className="space-y-6 p-4">
          {endpoint && (
            <p className="flex items-center gap-1.5 break-all font-mono text-caption text-muted-foreground">
              {connector.transport.type === "stdio" && <Terminal className="h-3 w-3 shrink-0" />} {endpoint}
            </p>
          )}
          {connector.lastError && state !== "connected" && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alert">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <span className="break-words">{connector.lastError}</span>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {oauth && (
              <Button size="sm" variant={state === "connected" ? "outline" : "default"} onClick={() => onReconnect(connector)} disabled={!!busy || !connector.enabled}>
                <RotateCw className="h-4 w-4" /> {connector.secrets.oauth.authorized ? "Reconnect" : "Sign in"}
              </Button>
            )}
            <Button
              size="sm" variant="outline" disabled={!!busy || !connector.enabled}
              onClick={() => void act("test", async () => {
                const result = await connectorsApi.test(connector.id);
                onChanged(result.connector);
                if (result.ok) toast.success(`${connector.name}: connected, ${result.tools?.length ?? 0} tools`);
                else toast.error(result.error ?? "Could not connect");
              })}
            >
              {busy === "test" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />} Test
            </Button>
            {oauth && connector.secrets.oauth.authorized && (
              <Button
                size="sm" variant="outline" disabled={!!busy}
                onClick={() => void act("disconnect", async () => {
                  onChanged(await connectorsApi.disconnect(connector.id));
                  toast.success(`${connector.name} disconnected`);
                })}
              >
                {busy === "disconnect" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />} Disconnect
              </Button>
            )}
            <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={!!busy} onClick={() => setConfirmRemove(true)}>
              <Trash2 className="h-4 w-4" /> Remove
            </Button>
          </div>

          <div className="flex items-center justify-between rounded-lg border px-3 py-2">
            <span className="text-sm">
              Enabled
              <span className="block text-xs text-muted-foreground">Off: nobody gets its tools, nothing is deleted</span>
            </span>
            <Switch label="Enabled" checked={connector.enabled} disabled={!!busy} onChange={(enabled) => void patch({ enabled }, "enabled")} />
          </div>

          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 font-heading text-h3"><Users className="h-4 w-4" /> Who can use it</h3>
            <AccessEditor access={connector.access} agents={agents} disabled={busy === "access"} onChange={(access) => void patch({ access }, "access")} />
            {agents.length === 0 && <p className="text-xs text-muted-foreground">No agents yet.</p>}
          </section>

          <ToolsSection key={`${connector.id}:${state}`} connector={connector} onPolicyChange={onPolicyChange} />
        </div>

        <ConfirmDialog
          open={confirmRemove}
          onOpenChange={setConfirmRemove}
          title={`Remove ${connector.name}?`}
          description={`${product} signs out (revoking the access when the service allows it), deletes the stored credentials and the agents lose its tools.`}
          confirmLabel="Remove"
          destructive
          loading={busy === "remove"}
          onConfirm={() => void act("remove", async () => {
            await connectorsApi.remove(connector.id);
            setConfirmRemove(false);
            onRemoved(connector.id);
            toast.success(`${connector.name} removed`);
          })}
        />
      </SheetContent>
    </Sheet>
  );
}
