/**
 * The dialog that walks a connect flow (see use-connect-flow): OAuth app setup, URL / region /
 * token, waiting for the sign-in window, and the result.
 */
import { useState } from "react";
import { AlertTriangle, Check, CheckCircle2, Copy, ExternalLink, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  connectorsApi, fillTemplate, setupSteps, templateFields,
  type CatalogEntry, type Connector,
} from "@/lib/connectors-api";
import { cn } from "@/lib/utils";
import { ConnectorIcon } from "./connector-icon";
import type { ConnectDetails, ConnectState } from "./use-connect-flow";

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
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
        <p className="flex items-center gap-1.5 font-medium"><KeyRound className="h-4 w-4 text-amber-500" /> One-time setup</p>
        <p className="mt-1 text-muted-foreground">
          {intro ?? `Use an OAuth app registered with ${name} and approved for this MCP server.`}{" "}
          {requireSecret ? "Every Google connector reuses it." : null}
        </p>
      </div>
      {list.length > 0 && (
        <ol className="space-y-1.5 text-sm">
          {list.map((step, i) => <li key={i} className="text-muted-foreground">{step}</li>)}
        </ol>
      )}
      <CopyField label="Redirect URI to register" value={redirectUri} />
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
      <DialogFooter>
        <Button onClick={() => void save()} disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save and continue
        </Button>
      </DialogFooter>
    </div>
  );
}

/** URL template fields, region variants, API key. */
function DetailsStep({ entry, connector, onSubmit }: { entry?: CatalogEntry; connector?: Connector; onSubmit: (details: ConnectDetails) => void }) {
  const fields = !connector && entry?.urlTemplate ? templateFields(entry.urlTemplate) : [];
  const variants = !connector && entry?.variants && entry.variants.length > 1 ? entry.variants : [];
  const needsToken = connector ? connector.auth.type === "bearer" && !connector.secrets.bearerToken : entry?.auth === "bearer";
  const [values, setValues] = useState<Record<string, string>>({});
  const [variant, setVariant] = useState(variants[0]?.url ?? "");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (fields.some((f) => !values[f]?.trim())) { setError("Fill in every field"); return; }
    if (needsToken && !token.trim()) { setError("Paste the key"); return; }
    onSubmit({
      ...(fields.length ? { url: fillTemplate(entry!.urlTemplate!, values) } : variants.length ? { url: variant } : {}),
      ...(needsToken ? { bearerToken: token.trim() } : {}),
    });
  };
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {fields.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{entry!.name} runs a server per account: enter yours.</p>
          {fields.map((f) => (
            <Field key={f} label={f.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase())}>
              <Input value={values[f] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))} placeholder={f} spellCheck={false} />
            </Field>
          ))}
          <p className="break-all font-mono text-[11px] text-muted-foreground">{fillTemplate(entry!.urlTemplate!, Object.fromEntries(fields.map((f) => [f, values[f] || `{${f}}`]))).replace(/%7B|%7D/g, (m) => (m === "%7B" ? "{" : "}"))}</p>
        </div>
      )}
      {variants.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm text-muted-foreground">Where is your {entry!.name} account hosted?</legend>
          {variants.map((v) => (
            <label key={v.url} className={cn("flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm", variant === v.url && "border-primary bg-primary/5")}>
              <input type="radio" name="variant" value={v.url} checked={variant === v.url} onChange={() => setVariant(v.url)} className="accent-primary" />
              <span className="font-medium">{v.label}</span>
              <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">{v.url}</span>
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
      <DialogFooter>
        <Button type="submit">Connect</Button>
      </DialogFooter>
    </form>
  );
}

export function ConnectDialog({
  state, redirectUri, onBegin, onSetup, onSetupSaved, onOpenFallback, onClose, onManage, onRetry,
}: {
  state: ConnectState;
  redirectUri: string;
  onBegin: (details: ConnectDetails) => void;
  onSetup: () => void;
  onSetupSaved: () => Promise<void> | void;
  onOpenFallback: () => void;
  onClose: () => void;
  onManage: (connector: Connector) => void;
  onRetry: () => void;
}) {
  const { phase, target } = state;
  const entry = target?.entry;
  const connector = state.connector ?? target?.connector;
  const name = connector?.name ?? entry?.name ?? target?.create?.name ?? "Connector";
  const open = phase !== "idle";
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <ConnectorIcon catalogId={entry?.id ?? connector?.catalogId} name={name} color={entry?.icon?.color ?? connector?.icon?.color} size="lg" />
            <div className="min-w-0">
              <DialogTitle>Connect {name}</DialogTitle>
              <DialogDescription className="line-clamp-2">{entry?.description ?? connector?.description ?? "Custom MCP server"}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {phase === "setup" && target?.oauthApp && (
          <SetupStep appId={target.oauthApp} name={name} entry={entry} redirectUri={redirectUri} onSaved={onSetupSaved} />
        )}

        {phase === "details" && (
          <DetailsStep entry={entry} connector={connector} onSubmit={onBegin} />
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
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
            </DialogFooter>
          </div>
        )}

        {phase === "done" && connector && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm" role="status">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />
              <span>
                <span className="font-medium">{name} is connected.</span>{" "}
                {state.toolCount !== undefined ? `${state.toolCount} tool${state.toolCount === 1 ? "" : "s"} available.` : null}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {connector.access.polpo ? "Polpo can use it. " : ""}
              {connector.access.agents === "*" ? "Every agent can use it." : connector.access.agents.length ? `Agents: ${connector.access.agents.join(", ")}.` : "No agent has access yet: grant it in the connector's settings."}
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>Done</Button>
              <Button onClick={() => onManage(connector)}>Manage access and tools</Button>
            </DialogFooter>
          </div>
        )}

        {phase === "error" && (
          <div className="space-y-4 py-2">
            <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alert">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <span className="break-words">{state.error ?? "Something went wrong"}</span>
            </div>
            <DialogFooter>
              {connector && <Button variant="outline" onClick={() => onManage(connector)}>Open settings</Button>}
              <Button variant={state.oauthApp ? "outline" : "default"} onClick={onRetry}>Try again</Button>
              {state.oauthApp && <Button onClick={onSetup}>Set up OAuth app</Button>}
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
