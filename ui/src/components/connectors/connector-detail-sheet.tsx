/**
 * A connector's settings: status and actions (Reconnect, Test, Disconnect, Remove), who can use
 * it (Polpo, every agent, or chosen agents) and its tools with a per-tool policy. A per-identity
 * connector has no sign-in of its own: its Accounts section lists every identity's accounts.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Building2, Check, ExternalLink, KeyRound, Image as ImageIcon, Link2, Loader2, Pencil, Plug, RefreshCw, RotateCw, Server, Terminal, Trash2, Undo2, Unplug, UserPlus, Users, Wrench, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SegmentedControl, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import {
  MAX_ICON_BYTES, accountsSummary, agentHasAccess, connectorOwner, connectorState, connectorsApi, iconSourceLabel, isIdentityConnector, oauthAppFor, registrationRefused, toggleAgentAccess, toolLabel,
  type CatalogEntry, type Connector, type ConnectorAccess, type ConnectorScope, type ConnectorTool, type ConnectorToolPolicy,
} from "@/lib/connectors-api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { ConnectorIcon } from "./connector-icon";
import { bundledHostedIconSrc } from "@/lib/hosted-server-icons";
import { FixItLink, StateBadge, Switch } from "./connector-bits";
import { productName, useInstanceBranding } from "@/lib/branding";
import { AccountsSection } from "./connector-accounts";

export interface AgentOption {
  name: string;
  label: string;
  /** identity.avatar: the picture; without it, the initials in the agent's colour. */
  avatar?: string;
}

const ORG_SCOPE = "__org__";
const IDENTITY_SCOPE = "__identity__";

/**
 * Who the connector belongs to: the organization, or one agent (its own: only that agent can ever
 * use it). Per identity is a type of its own: a connector cannot switch to or from it in place
 * (`identityHelp` says what to do instead: import this one into a per-identity connector).
 */
export function ScopeEditor({
  scope, agents, onChange, disabled, identityHelp,
}: {
  scope: ConnectorScope | undefined; agents: AgentOption[]; onChange: (scope: ConnectorScope) => void; disabled?: boolean;
  /** Shown when "Per identity" is picked on an org / personal connector. */
  identityHelp?: React.ReactNode;
}) {
  const [wantsIdentity, setWantsIdentity] = useState(false);
  if (scope?.kind === "identity") {
    return (
      <div className="space-y-1 rounded-md px-2 py-1.5" data-testid="connector-scope">
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground"><Users className="h-4 w-4" /></span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">Type</span>
            <span className="block text-xs text-muted-foreground">Per identity: each agent and person connects its own accounts</span>
          </span>
          <Badge variant="outline" className="border-primary/40 bg-primary/10 text-micro text-primary">Per identity</Badge>
        </div>
        <p className="pl-7 text-xs text-muted-foreground">
          It cannot become an organization or personal connector: its accounts would have nowhere to go. Add a separate connector for that instead.
        </p>
      </div>
    );
  }
  const owner = scope?.kind === "agent" ? scope.agent : undefined;
  const known = owner === undefined || agents.some((a) => a.name === owner);
  return (
    <div className="space-y-1" data-testid="connector-scope">
    <div className="flex items-center gap-3 rounded-md px-2 py-1.5">
      <span className="text-muted-foreground"><Building2 className="h-4 w-4" /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">Belongs to</span>
        <span className="block truncate text-xs text-muted-foreground">
          {owner ? "Personal: only this agent can ever use it" : "The organization: enable it for any agent"}
        </span>
      </span>
      <Select
        value={owner ?? ORG_SCOPE}
        disabled={disabled}
        onValueChange={(v) => {
          if (v === IDENTITY_SCOPE) { setWantsIdentity(true); return; }
          setWantsIdentity(false);
          onChange(v === ORG_SCOPE ? { kind: "org" } : { kind: "agent", agent: v });
        }}
      >
        <SelectTrigger size="sm" className="h-8 w-44 text-xs" aria-label="Belongs to">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-80">
          <SelectItem value={ORG_SCOPE} className="text-xs">Organization</SelectItem>
          {!known && owner && <SelectItem value={owner} className="text-xs">{owner} (personal)</SelectItem>}
          {agents.map((a) => <SelectItem key={a.name} value={a.name} className="text-xs">{a.label} (personal)</SelectItem>)}
          <SelectItem value={IDENTITY_SCOPE} className="text-xs">Per identity…</SelectItem>
        </SelectContent>
      </Select>
    </div>
      {wantsIdentity && (
        <div className="ml-7 space-y-2 rounded-md border bg-muted/30 p-3 text-xs" data-testid="scope-identity-help">
          <p>
            A connector cannot turn per identity in place. Add a per-identity connector of this app, then import this one as an account:
            its sign-in moves over, nobody signs in again.
          </p>
          {identityHelp}
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setWantsIdentity(false)}>Close</Button>
        </div>
      )}
    </div>
  );
}

/** Who may use the connector: Polpo, every agent, or the chosen ones (an agent's own connector: only its owner). */
export function AccessEditor({
  access, agents, onChange, disabled, owner, perIdentity,
}: {
  access: ConnectorAccess; agents: AgentOption[]; onChange: (access: ConnectorAccess) => void; disabled?: boolean; owner?: string;
  /** Per identity: who may connect accounts (and use their own). */
  perIdentity?: boolean;
}) {
  const product = productName(useInstanceBranding());
  const all = !owner && access.agents === "*";
  const names = agents.map((a) => a.name);
  const shown = owner ? agents.filter((a) => a.name === owner) : agents;
  return (
    <div className="space-y-1">
      {perIdentity && <p className="px-2 text-xs text-muted-foreground">Who may connect accounts. Each uses only its own (or the organization's, when the fallback is on).</p>}
      <Row icon={<Plug className="h-4 w-4" />} label={product} hint={perIdentity ? "People chatting with it connect their own accounts" : "The orchestrator chat"}>
        <Switch label={`${product} can use it`} checked={access.polpo} disabled={disabled} onChange={(polpo) => onChange({ ...access, polpo })} />
      </Row>
      {!owner && (
        <Row icon={<Users className="h-4 w-4" />} label="All agents" hint="Including agents added later">
          <Switch
            label="All agents can use it" checked={all} disabled={disabled}
            onChange={(on) => onChange({ ...access, agents: on ? "*" : [] })}
          />
        </Row>
      )}
      {shown.length > 0 && (
        <div className="mt-1 space-y-1 border-l pl-3">
          {shown.map((agent) => (
            <Row key={agent.name} icon={<AgentAvatar avatar={agent.avatar} name={agent.name} size="sm" fallbackVariant="circle" shape="circle" />} label={agent.label} hint={agent.label !== agent.name ? agent.name : undefined}>
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

/** The display name, renamed in place (PATCH name): how people and the agents tell accounts apart. */
function NameEditor({ connector, disabled, onRename }: { connector: Connector; disabled?: boolean; onRename: (name: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(connector.name);
  const [saving, setSaving] = useState(false);
  if (!editing) {
    return (
      <div className="flex min-w-0 items-center gap-1">
        <SheetTitle className="truncate">{connector.name}</SheetTitle>
        <Button
          size="icon" variant="ghost" className="h-7 w-7 shrink-0 text-muted-foreground" aria-label={`Rename ${connector.name}`} disabled={disabled}
          onClick={() => { setValue(connector.name); setEditing(true); }}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }
  const save = async () => {
    const name = value.trim();
    if (!name || name === connector.name) { setEditing(false); return; }
    setSaving(true);
    try { await onRename(name); setEditing(false); } finally { setSaving(false); }
  };
  return (
    <form className="flex min-w-0 items-center gap-1" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <SheetTitle className="sr-only">{connector.name}</SheetTitle>
      <Input
        value={value} onChange={(e) => setValue(e.target.value)} aria-label="Connector name" maxLength={80} autoFocus
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setEditing(false); } }}
        className="h-8 min-w-0 flex-1"
      />
      <Button type="submit" size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label="Save name" disabled={saving || !value.trim()}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
      </Button>
      <Button type="button" size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label="Cancel rename" onClick={() => setEditing(false)}>
        <X className="h-4 w-4" />
      </Button>
    </form>
  );
}

/** The tools list (loaded when the sheet opens; remounted per connector via `key`). */
function ToolsSection({ connector, onPolicyChange }: { connector: Connector; onPolicyChange: (tool: string, policy: ConnectorToolPolicy) => Promise<void> }) {
  const product = productName(useInstanceBranding());
  const state = connectorState(connector);
  // per identity: listed through a connected account
  const canList = isIdentityConnector(connector) ? state === "connected" : state === "connected" || state === "not_connected" || state === "error";
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
      {!canList && <p className="text-sm text-muted-foreground">{isIdentityConnector(connector) ? `Connect an account to ${connector.name} to see its tools.` : `Connect ${connector.name} to see its tools.`}</p>}
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

/**
 * A custom connector's icon: where it came from, look it up again, or the person's own (an uploaded
 * image or an image URL, fetched once by the server). Catalog connectors use their official icon.
 */
export function ConnectorIconEditor({ connector, onChanged, disabled }: { connector: Connector; onChanged: (c: Connector) => void; disabled?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [urlOpen, setUrlOpen] = useState(false);
  const [url, setUrl] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const run = async (what: string, fn: () => Promise<Connector>, success?: string) => {
    setBusy(what);
    try {
      onChanged(await fn());
      if (success) toast.success(success);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };
  const upload = (picked: File | undefined) => {
    if (!picked) return;
    if (picked.size > MAX_ICON_BYTES) { toast.error("That image is too large (512 KB at most)"); return; }
    const reader = new FileReader();
    reader.onload = () => void run("upload", () => connectorsApi.setIcon(connector.id, { dataUri: String(reader.result) }), "Icon updated");
    reader.readAsDataURL(picked);
  };
  const off = disabled || !!busy;
  const asset = connector.iconAsset;
  return (
    <section className="space-y-2" data-testid="connector-icon-editor">
      <h3 className="text-sm font-medium">Icon</h3>
      <div className="flex items-center gap-3">
        <ConnectorIcon catalogId={connector.catalogId} name={connector.name} color={connector.icon?.color} iconUrl={connector.iconUrl} iconDarkUrl={connector.iconDarkUrl} size="sm" />
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={asset?.src}>{iconSourceLabel(asset)}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" disabled={off || (asset?.pinned && asset.source === "upload")} onClick={() => void run("refresh", () => connectorsApi.refreshIcon(connector.id))}>
          {busy === "refresh" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh icon
        </Button>
        <Button size="sm" variant="outline" disabled={off} onClick={() => file.current?.click()}>
          {busy === "upload" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />} Upload…
        </Button>
        <Button size="sm" variant="outline" disabled={off} onClick={() => setUrlOpen((v) => !v)} aria-expanded={urlOpen}>
          <Link2 className="h-4 w-4" /> From URL…
        </Button>
        {asset?.pinned && (
          <Button size="sm" variant="ghost" disabled={off} onClick={() => void run("reset", () => connectorsApi.resetIcon(connector.id), "Back to the automatic icon")}>
            <Undo2 className="h-4 w-4" /> Automatic
          </Button>
        )}
        <input ref={file} type="file" accept="image/png,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,image/jpeg,image/gif,image/webp" className="hidden"
          aria-label="Upload an icon" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
      {urlOpen && (
        <form className="flex gap-1.5" onSubmit={(e) => {
          e.preventDefault();
          if (!url.trim()) return;
          void run("url", () => connectorsApi.setIcon(connector.id, { url: url.trim() }), "Icon updated").then(() => { setUrl(""); setUrlOpen(false); });
        }}>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/logo.svg" inputMode="url" spellCheck={false} aria-label="Icon URL" className="h-8" />
          <Button size="sm" type="submit" disabled={off || !url.trim()}>{busy === "url" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Use"}</Button>
        </form>
      )}
    </section>
  );
}

export function ConnectorDetailSheet({
  connector, entry, agents, open, onOpenChange, onChanged, onRemoved, onReconnect, onSetupApp, accountCount = 0, onAddAccount, onOpenHostedServer,
  connectors = [], focus, importFrom, onImported, identityHelp,
}: {
  /** Every connector (a per-identity connector's import candidates). */
  connectors?: Connector[];
  /** Per identity: an account to focus (setup link), or "add". */
  focus?: string;
  /** Per identity: open the import dialog with this connector picked. */
  importFrom?: string;
  onImported?: (sourceId: string, removed: boolean) => void;
  /** Org / personal: what to do when "Per identity" is picked (import into one, or add one). */
  identityHelp?: React.ReactNode;
  connector: Connector | null;
  entry?: CatalogEntry;
  agents: AgentOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: (connector: Connector) => void;
  onRemoved: (id: string) => void;
  /** Start sign-in again (a click: opens the sign-in window). */
  onReconnect: (connector: Connector) => void;
  /** The vendor refused the dynamic registration: set up its OAuth app (`appId`), then sign in (a click). */
  onSetupApp?: (connector: Connector, appId: string) => void;
  /** How many accounts of this catalog app are connected (this one included). */
  accountCount?: number;
  /** Connect another account of the same catalog app. */
  onAddAccount?: () => void;
  /** A hosted connector: open its server (tools, settings, test, versions, logs). */
  onOpenHostedServer?: (serverId: string) => void;
}) {
  const product = productName(useInstanceBranding());
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  if (!connector) return null;
  const state = connectorState(connector);
  const perIdentity = isIdentityConnector(connector);
  const oauth = connector.auth.type === "oauth" && !perIdentity;
  const hostedServerId = connector.transport.type === "hosted" ? connector.transport.serverId : undefined;

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
    : connector.transport.type === "hosted" ? `Hosted by ${product}${connector.hostedVersion ? ` · v${connector.hostedVersion}` : ""}`
    : connector.transport.url;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-lg">
        <SheetHeader className="border-b">
          <div className="flex items-center gap-3 pr-6">
            <ConnectorIcon catalogId={connector.catalogId} name={connector.name} color={connector.icon?.color} iconUrl={connector.iconUrl} iconDarkUrl={connector.iconDarkUrl} size="lg" />
            <div className="min-w-0 flex-1">
              <NameEditor
                key={connector.id} connector={connector} disabled={!!busy}
                onRename={async (name) => {
                  try {
                    onChanged(await connectorsApi.update(connector.id, { name }));
                    toast.success(`Renamed to ${name}`);
                  } catch (reason) {
                    toast.error(reason instanceof Error ? reason.message : String(reason));
                    throw reason;
                  }
                }}
              />
              <SheetDescription className="line-clamp-2">{connector.description ?? entry?.description ?? "Custom MCP server"}</SheetDescription>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StateBadge state={state} />
            {perIdentity && <Badge variant="outline" data-testid="connector-identity-chip" className="border-primary/40 bg-primary/10 text-micro text-primary">Identity</Badge>}
            {perIdentity && <span className="text-xs text-muted-foreground">{accountsSummary(connector)}</span>}
            {!perIdentity && connector.toolCount !== undefined && state === "connected" && <span className="text-xs text-muted-foreground">{connector.toolCount} tools</span>}
            {entry?.docs && (
              <a href={entry.docs} target="_blank" rel="noreferrer noopener" className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline">
                Docs <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </SheetHeader>

        <div className="space-y-6 p-4">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs" data-testid="connector-identity">
            {connector.account && (<>
              <dt className="text-muted-foreground">Signed in as</dt>
              <dd className="truncate font-medium">{connector.account}</dd>
            </>)}
            <dt className="text-muted-foreground">Id</dt>
            <dd className="truncate font-mono" title={`Agents see its tools as mcp__${connector.id}__…`}>{connector.id} <span className="text-muted-foreground">· tools mcp__{connector.id}__…{perIdentity ? " (optional account)" : ""}</span></dd>
            {entry && accountCount > 1 && (<>
              <dt className="text-muted-foreground">Accounts</dt>
              <dd>{accountCount} {entry.name} accounts connected; each has its own sign-in and access.</dd>
            </>)}
          </dl>
          {endpoint && (
            <p className="flex items-center gap-1.5 break-all font-mono text-caption text-muted-foreground">
              {connector.transport.type === "stdio" && <Terminal className="h-3 w-3 shrink-0" />} {endpoint}
            </p>
          )}
          {!connector.catalogId && !bundledHostedIconSrc(connector.iconUrl) && <ConnectorIconEditor connector={connector} onChanged={onChanged} disabled={!!busy} />}
          {connector.lastError && state !== "connected" && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alert">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <span className="min-w-0 space-y-1">
                <span className="block break-words">{connector.lastError}</span>
                <FixItLink message={connector.lastError} />
                {oauth && onSetupApp && registrationRefused(connector.lastError) && (
                  <Button size="sm" className="mt-1 h-7" onClick={() => onSetupApp(connector, oauthAppFor(connector, entry))} disabled={!!busy}>
                    <KeyRound className="h-3.5 w-3.5" /> Set up OAuth app
                  </Button>
                )}
              </span>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {hostedServerId && onOpenHostedServer && (
              <Button size="sm" onClick={() => onOpenHostedServer(hostedServerId)} data-testid="open-hosted-server">
                <Server className="h-4 w-4" /> Tools, versions &amp; logs
              </Button>
            )}
            {oauth && (
              <Button size="sm" variant={state === "connected" ? "outline" : "default"} onClick={() => onReconnect(connector)} disabled={!!busy || !connector.enabled}>
                <RotateCw className="h-4 w-4" /> {connector.secrets.oauth.authorized ? "Reconnect" : "Sign in"}
              </Button>
            )}
            {!perIdentity && <Button
              size="sm" variant="outline" disabled={!!busy || !connector.enabled}
              onClick={() => void act("test", async () => {
                const result = await connectorsApi.test(connector.id);
                onChanged(result.connector);
                if (result.ok) toast.success(`${connector.name}: connected, ${result.tools?.length ?? 0} tools`);
                else toast.error(result.error ?? "Could not connect");
              })}
            >
              {busy === "test" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />} Test
            </Button>}
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
            {entry && onAddAccount && !perIdentity && (
              <Button size="sm" variant="outline" disabled={!!busy} onClick={onAddAccount} aria-label={`Add another ${entry.name} account`}>
                <UserPlus className="h-4 w-4" /> Add another account
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

          {perIdentity && (
            <AccountsSection
              key={connector.id} connector={connector} connectors={connectors} agents={agents} onChanged={onChanged}
              focus={focus} importFrom={importFrom} onImported={onImported}
            />
          )}

          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 font-heading text-h3"><Users className="h-4 w-4" /> Who can use {accountCount > 1 && !perIdentity ? "this account" : "it"}</h3>
            <ScopeEditor
              scope={connector.scope}
              agents={agents}
              identityHelp={identityHelp}
              disabled={busy === "scope"}
              onChange={(scope) => void act("scope", async () => {
                const before = connector.access.agents;
                const next = await connectorsApi.update(connector.id, { scope });
                onChanged(next);
                if (scope.kind === "agent") {
                  // the other agents it was enabled for lose it
                  const dropped = before === "*" ? ["every other agent"] : before.filter((a) => a !== scope.agent);
                  const owner = agents.find((a) => a.name === scope.agent)?.label ?? scope.agent;
                  toast.success(`${connector.name} now belongs to ${owner}${dropped.length ? `: ${dropped.join(", ")} can no longer use it` : ""}`);
                } else toast.success(`${connector.name} now belongs to the organization`);
              })}
            />
            <AccessEditor access={connector.access} agents={agents} owner={connectorOwner(connector)} perIdentity={perIdentity} disabled={busy === "access"} onChange={(access) => void patch({ access }, "access")} />
            {agents.length === 0 && <p className="text-xs text-muted-foreground">No agents yet.</p>}
          </section>

          <ToolsSection key={`${connector.id}:${state}`} connector={connector} onPolicyChange={onPolicyChange} />
        </div>

        <ConfirmDialog
          open={confirmRemove}
          onOpenChange={setConfirmRemove}
          title={`Remove ${connector.name}?`}
          description={perIdentity
            ? `${product} signs out every account (revoking the access when the service allows it), deletes their credentials and every agent and person loses its tools.`
            : `${product} signs out (revoking the access when the service allows it), deletes the stored credentials and the agents lose its tools.`}
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
