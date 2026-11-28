/**
 * The dialog that walks a connect flow (see use-connect-flow): OAuth app setup, URL / region /
 * token, waiting for the sign-in window, and the result.
 */
import { useState } from "react";
import { AlertTriangle, Check, CheckCircle2, Copy, ExternalLink, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  connectorsApi, fillTemplate, isIdentityConnector, setupManifest, setupSteps, suggestedAccountName, templateFields,
  type CatalogEntry, type Connector, type ConnectorScope,
} from "@/lib/connectors-api";
import { ConnectorTypePicker } from "./connector-type-picker";
import type { AgentOption } from "./connector-detail-sheet";
import { cn } from "@/lib/utils";
import { ConnectorIcon } from "./connector-icon";
import { FixItLink } from "./connector-bits";
import type { ConnectDetails, ConnectState } from "./use-connect-flow";
import { productName, useInstanceBranding } from "@/lib/branding";

export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs" title={value}>{value}</code>
        <Button
          type="button" size="icon" variant="outline" className="h-8 w-8 shrink-0" aria-label={`Copy ${label}`}
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }, () => toast.error("Could not copy"));
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}

/** A multi-line value to copy (an app manifest). */
function CopyBlock({ value, label, hint }: { value: string; label: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <Button
          type="button" size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" aria-label={`Copy ${label}`}
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }, () => toast.error("Could not copy"));
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="max-h-48 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs leading-relaxed">{value}</pre>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: React.ReactNode; error?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium">{label}</span>
      {children}
      {error ? <span className="block text-xs text-destructive" role="alert">{error}</span> : hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

/** Steps to register the vendor's OAuth app, the redirect URI to copy, and the client id / secret. */
function SetupStep({ appId, name, entry, redirectUri, onSaved }: {
  appId: string; name: string; entry?: CatalogEntry; redirectUri: string; onSaved: () => Promise<void> | void;
}) {
  const requireSecret = appId === "google";
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const steps = entry ? setupSteps(entry, redirectUri) : [];
  const manifest = entry ? setupManifest(entry, redirectUri) : undefined;
  const intro = steps[0] && !/^\d+\./.test(steps[0]) ? steps[0] : undefined;
  const list = intro ? steps.slice(1) : steps;
  const save = async () => {
    if (!clientId.trim() || (requireSecret && !clientSecret.trim())) {
      setError(requireSecret ? "Enter both the client id and the client secret" : "Enter the client id");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await connectorsApi.saveOAuthApp(appId, { clientId: clientId.trim(), clientSecret: clientSecret.trim(), name: requireSecret ? "Google" : name });
      await onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm">
        <p className="flex items-center gap-1.5 font-medium"><KeyRound className="h-4 w-4 text-warning" /> One-time setup</p>
        <p className="mt-1 break-words text-muted-foreground">
          {intro ?? `Use an OAuth app registered with ${name} and approved for this MCP server.`}{" "}
          {requireSecret ? "Every Google connector reuses it." : null}
        </p>
      </div>
      {list.length > 0 && (
        <ol className="space-y-1.5 text-sm">
          {list.map((step, i) => <li key={i} className="break-words text-muted-foreground">{step}</li>)}
        </ol>
      )}
      <CopyField label="Redirect URI to register" value={redirectUri} />
      {manifest && <CopyBlock label="App manifest" value={manifest} hint="Paste it when creating the app from a manifest: scopes and redirect URL included." />}
      {entry?.docs && (
        <a href={entry.docs} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
          {entry.name} documentation <ExternalLink className="h-3 w-3" />
        </a>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Client ID"><Input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} /></Field>
        <Field label={requireSecret ? "Client secret" : "Client secret (if issued)"}><Input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="new-password" /></Field>
      </div>
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      <DialogFooter sticky>
        <Button onClick={() => void save()} disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save and continue
        </Button>
      </DialogFooter>
    </div>
  );
}

/** URL template fields, region variants, API key. */
function DetailsStep({ entry, connector, accountName, choose, initialScope, agents = [], onSubmit }: {
  entry?: CatalogEntry; connector?: Connector;
  /** Another account of `entry`: ask its display name, prefilled with this. */
  accountName?: string;
  /** A new connector whose type is picked here (its name is asked as "Name"). */
  choose?: boolean;
  initialScope?: ConnectorScope;
  agents?: AgentOption[];
  onSubmit: (details: ConnectDetails) => void;
}) {
  const askName = accountName !== undefined;
  const [scope, setScope] = useState<ConnectorScope>(initialScope ?? { kind: "org" });
  const perIdentity = askName && scope.kind === "identity";
  const fields = !connector && entry?.urlTemplate ? templateFields(entry.urlTemplate) : [];
  const variants = !connector && entry?.variants && entry.variants.length > 1 ? entry.variants : [];
  const needsToken = !perIdentity && (connector ? connector.auth.type === "bearer" && !connector.secrets.bearerToken : entry?.auth === "bearer");
  const [values, setValues] = useState<Record<string, string>>({});
  const [variant, setVariant] = useState(variants[0]?.url ?? "");
  const [token, setToken] = useState("");
  const [name, setName] = useState(accountName ?? "");
  const [error, setError] = useState<string | null>(null);
  const oauth = !!entry && (entry.auth === "oauth" || entry.auth === "oauth_preregistered");
  const submit = () => {
    if (askName && !name.trim()) { setError(choose ? "Give the connector a name" : "Give this account a name"); return; }
    if (askName && scope.kind === "agent" && !scope.agent) { setError("Pick the agent it belongs to"); return; }
    if (fields.some((f) => !values[f]?.trim())) { setError("Fill in every field"); return; }
    if (needsToken && !token.trim()) { setError("Paste the key"); return; }
    onSubmit({
      ...(fields.length ? { url: fillTemplate(entry!.urlTemplate!, values) } : variants.length ? { url: variant } : {}),
      ...(needsToken ? { bearerToken: token.trim() } : {}),
      ...(askName ? { name: name.trim() } : {}),
      ...(askName && scope.kind !== "org" ? { scope } : {}),
    });
  };
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {askName && (
        <Field
          label={choose ? "Name" : "Account name"}
          hint={choose ? "How you and the agents call it. You can rename it later." : `How you and the agents tell it apart, e.g. ${entry?.name ?? "Gmail"} – info@lumea.dev. You can rename it later.`}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={choose ? entry?.name ?? "Gmail" : `${entry?.name ?? "Gmail"} – info@lumea.dev`} autoFocus spellCheck={false} maxLength={80} />
        </Field>
      )}
      {askName && <ConnectorTypePicker scope={scope} agents={agents} onChange={setScope} />}
      {fields.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{entry!.name} runs a server per account: enter yours.</p>
          {fields.map((f) => (
            <Field key={f} label={f.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase())}>
              <Input value={values[f] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))} placeholder={f} spellCheck={false} />
            </Field>
          ))}
          <p className="break-all font-mono text-caption text-muted-foreground">{fillTemplate(entry!.urlTemplate!, Object.fromEntries(fields.map((f) => [f, values[f] || `{${f}}`]))).replace(/%7B|%7D/g, (m) => (m === "%7B" ? "{" : "}"))}</p>
        </div>
      )}
      {variants.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm text-muted-foreground">Where is your {entry!.name} account hosted?</legend>
          {variants.map((v) => (
            <label key={v.url} className={cn("flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm", variant === v.url && "border-primary bg-primary/5")}>
              <input type="radio" name="variant" value={v.url} checked={variant === v.url} onChange={() => setVariant(v.url)} className="accent-primary" />
              <span className="font-medium">{v.label}</span>
              <span className="ml-auto min-w-0 truncate font-mono text-caption text-muted-foreground">{v.url}</span>
            </label>
          ))}
        </fieldset>
      )}
      {needsToken && (
        <Field label={entry?.authHeader ? `API key (sent as ${entry.authHeader})` : "API key or token"} hint="Stored in the vault, never shown again.">
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" />
        </Field>
      )}
      {entry?.authNotes && (needsToken || fields.length > 0) && <p className="text-xs text-muted-foreground">{entry.authNotes}</p>}
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      <DialogFooter sticky>
        <Button type="submit">{perIdentity ? "Add" : askName && oauth ? "Continue to sign-in" : "Connect"}</Button>
      </DialogFooter>
    </form>
  );
}


/** Sign-in revealed which account it is: offer to put it in the name ("Gmail – info@acme.com"). */
function AccountNameSuggestion({ connector, entryName, onRename }: {
  connector: Connector; entryName?: string; onRename: (connector: Connector, name: string) => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const suggestion = suggestedAccountName(connector, entryName);
  if (!suggestion || done) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
      <span className="min-w-0 flex-1 break-words">
        Signed in as <span className="font-medium">{connector.account}</span>. Name it “{suggestion}”?
      </span>
      <Button
        size="sm" variant="outline" disabled={busy}
        onClick={() => {
          setBusy(true);
          void Promise.resolve(onRename(connector, suggestion)).then(() => setDone(true), () => undefined).finally(() => setBusy(false));
        }}
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />} Use this name
      </Button>
    </div>
  );
}

export function ConnectDialog({
  state, redirectUri, onBegin, onSetup, onSetupSaved, onOpenFallback, onClose, onManage, onRetry, onRemove, onRename, agents = [],
}: {
  state: ConnectState;
  /** The agents a personal connector can belong to (type picker). */
  agents?: AgentOption[];
  redirectUri: string;
  onBegin: (details: ConnectDetails) => void;
  onSetup: () => void;
  onSetupSaved: () => Promise<void> | void;
  onOpenFallback: () => void;
  onClose: () => void;
  onManage: (connector: Connector) => void;
  onRetry: () => void;
  /** Stop and delete a connector whose sign-in never completed. */
  onRemove?: (connector: Connector) => void;
  /** Rename the connector (after sign-in revealed its account). */
  onRename?: (connector: Connector, name: string) => Promise<void> | void;
}) {
  const product = productName(useInstanceBranding());
  const { phase, target } = state;
  const entry = target?.entry;
  const connector = state.connector ?? target?.connector;
  // added, but never signed in: offer to drop it instead of leaving a "Sign-in needed" connector behind
  const removeButton = onRemove && connector && connector.auth.type === "oauth" && !connector.secrets.oauth.authorized ? (
    <Button variant="ghost" className="text-destructive hover:text-destructive sm:mr-auto" onClick={() => onRemove(connector)}>
      Cancel and remove
    </Button>
  ) : null;
  const name = connector?.name ?? entry?.name ?? target?.create?.name ?? "Connector";
  const another = !!target?.another && !!entry;
  const choose = !!target?.choose && !!entry;
  const open = phase !== "idle";
  const perIdentity = !!connector && isIdentityConnector(connector);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="shrink-0 border-b px-6 pb-4 pt-6 pr-12">
          <div className="flex items-center gap-3">
            <ConnectorIcon catalogId={entry?.id ?? connector?.catalogId} name={name} color={entry?.icon?.color ?? connector?.icon?.color} iconUrl={connector?.iconUrl} iconDarkUrl={connector?.iconDarkUrl} size="lg" />
            <div className="min-w-0">
              <DialogTitle className="leading-tight">{another && !choose && !state.connector ? `Add another ${entry!.name} account` : choose && !state.connector ? `Add ${entry!.name}` : `Connect ${name}`}</DialogTitle>
              <DialogDescription className="line-clamp-2">
                {another && !choose && !state.connector
                  ? `A separate ${entry!.name} connection with its own sign-in, name and access: e.g. a second inbox, or one per agent.`
                  : entry?.description ?? connector?.description ?? "Custom MCP server"}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogBody>

        {phase === "setup" && target?.oauthApp && (
          <SetupStep appId={target.oauthApp} name={name} entry={entry} redirectUri={redirectUri} onSaved={onSetupSaved} />
        )}

        {phase === "details" && (
          <DetailsStep
            entry={entry} connector={connector} accountName={(another || choose) && !connector ? target?.name ?? "" : undefined}
            choose={choose} initialScope={target?.scope} agents={agents} onSubmit={onBegin}
          />
        )}

        {phase === "working" && (
          <div className="flex items-center gap-3 py-6 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-5 w-5 animate-spin" /> Connecting to {name}…
          </div>
        )}

        {phase === "authorizing" && (
          <div className="space-y-4 py-2" role="status">
            <div className="flex items-center gap-3 text-sm">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <span>{state.fallbackUrl ? "Your browser blocked the sign-in window." : `Waiting for you to sign in to ${name} in the window that opened…`}</span>
            </div>
            {state.fallbackUrl && (
              <Button onClick={onOpenFallback} className="w-full">
                Open sign-in page <ExternalLink className="h-4 w-4" />
              </Button>
            )}
            <p className="text-xs text-muted-foreground">This page updates by itself once you approve access.</p>
            <DialogFooter sticky>
              {removeButton}
              <Button variant="outline" onClick={onClose}>Cancel</Button>
            </DialogFooter>
          </div>
        )}

        {phase === "done" && connector && perIdentity && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-3 rounded-lg border border-success/30 bg-success/5 p-3 text-sm" role="status">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
              <span><span className="font-medium">{name} is added, per identity.</span> Nobody is signed in yet.</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Each agent with access (and each person, when {product} can use it) connects its own accounts in its Accounts section.
              Agents call the tools mcp__{connector.id}__… with their default account, or another of their own with <code className="font-mono">account</code>.
            </p>
            <DialogFooter sticky>
              <Button variant="outline" onClick={onClose}>Done</Button>
              <Button onClick={() => onManage(connector)}>Add accounts</Button>
            </DialogFooter>
          </div>
        )}

        {phase === "done" && connector && !perIdentity && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-3 rounded-lg border border-success/30 bg-success/5 p-3 text-sm" role="status">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
              <span>
                <span className="font-medium">{name} is connected.</span>{" "}
                {state.toolCount !== undefined ? `${state.toolCount} tool${state.toolCount === 1 ? "" : "s"} available.` : null}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {connector.access.polpo ? `${product} can use it. ` : ""}
              {connector.access.agents === "*" ? "Every agent can use it." : connector.access.agents.length ? `Agents: ${connector.access.agents.join(", ")}.` : "No agent has access yet: grant it in the connector's settings."}
            </p>
            {onRename && <AccountNameSuggestion connector={connector} entryName={entry?.name} onRename={onRename} />}
            <DialogFooter sticky>
              <Button variant="outline" onClick={onClose}>Done</Button>
              <Button onClick={() => onManage(connector)}>Manage access and tools</Button>
            </DialogFooter>
          </div>
        )}

        {phase === "error" && (
          <div className="space-y-4 py-2">
            <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alert">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <span className="min-w-0 space-y-1">
                <span className="block break-words">{state.error ?? "Something went wrong"}</span>
                <FixItLink message={state.error} />
              </span>
            </div>
            <DialogFooter sticky>
              {removeButton}
              {connector && <Button variant="outline" onClick={() => onManage(connector)}>Open settings</Button>}
              <Button variant={state.oauthApp ? "outline" : "default"} onClick={onRetry}>Try again</Button>
              {state.oauthApp && <Button onClick={onSetup}>Set up OAuth app</Button>}
            </DialogFooter>
          </div>
        )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
