/**
 * Accounts of a per-identity connector (scope "identity"): each identity (an agent, a person, or the
 * organization for the optional shared fallback) connects its own accounts, each with a label, its
 * own sign-in (or token) and a default per identity. Used by the connector's sheet (every identity)
 * and by the agent page (only that agent's accounts).
 *
 * Sign-in opens the window inside the click (popup blockers), then follows the account's state the
 * same way the connector flow does (callback postMessage + polling).
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, ArrowRightLeft, Building2, Check, ExternalLink, Loader2, Pencil, Plug, Plus, RotateCw, Star, Trash2, Unplug, User, UserPlus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import {
  ACCOUNT_LABEL_PATTERN, ORG_IDENTITY, accountIdentities, accountLabelFrom, accountState, accountsOf, accountsSummary, agentHasAccess, agentIdentity,
  connectorAccountsApi, connectorsApi, fallbackOn, identityName, importCandidates, importIdentity, openAuthWindow, parseIdentity, waitForOAuth,
  type Connector, type ConnectorAccount, type ConnectorIdentity,
} from "@/lib/connectors-api";
import { productName, useInstanceBranding } from "@/lib/branding";
import { cn } from "@/lib/utils";
import { FixItLink, StateBadge, Switch } from "./connector-bits";
import { SecretInput } from "./template-fields";
import type { AgentOption } from "./connector-detail-sheet";

const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

// ── Sign-in of one account ───────────────────────────────────────────────────

export interface AccountSignIn {
  /** The account waiting for its sign-in, and the link to open when the window was blocked. */
  pending: { account: string; fallbackUrl?: string } | null;
  /** From a click: `popup` was opened synchronously by the caller (openAuthWindow). */
  start: (connectorId: string, account: ConnectorAccount, popup: Window | null) => Promise<void>;
  cancel: () => void;
}

export function useAccountSignIn(onChanged: (connector: Connector) => void): AccountSignIn {
  const [pending, setPending] = useState<AccountSignIn["pending"]>(null);
  const abort = useRef<AbortController | null>(null);
  const changed = useRef(onChanged);
  useEffect(() => { changed.current = onChanged; });
  useEffect(() => () => abort.current?.abort(), []);

  const start = async (connectorId: string, account: ConnectorAccount, popup: Window | null) => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    const close = () => { try { popup?.close(); } catch { /* cross-origin */ } };
    setPending({ account: account.id });
    try {
      const startRes = await connectorAccountsApi.startOAuth(connectorId, account.id);
      if (ctrl.signal.aborted) return;
      if (startRes.authorized || !startRes.authorizationUrl) {
        close();
        changed.current(await connectorsApi.get(connectorId));
        setPending(null);
        toast.success(`${account.label}: already signed in`);
        return;
      }
      let opened = false;
      if (popup && !popup.closed) {
        try { popup.location.href = startRes.authorizationUrl; opened = true; } catch { opened = false; }
      }
      if (!opened) { close(); popup = null; setPending({ account: account.id, fallbackUrl: startRes.authorizationUrl }); }
      const outcome = await waitForOAuth(connectorId, popup, { signal: ctrl.signal, account: account.id });
      if (ctrl.signal.aborted) return;
      setPending(null);
      if (outcome.kind === "cancelled") { toast.message("Sign-in was cancelled before it finished."); return; }
      if (outcome.kind === "failed") { toast.error(outcome.error); return; }
      changed.current(outcome.connector);
      if (outcome.kind === "authorized_with_error") toast.error(`Signed in, but the first connection failed: ${outcome.error}`);
      else toast.success(`${account.label} is connected`);
    } catch (reason) {
      close();
      if (!ctrl.signal.aborted) { setPending(null); toast.error(message(reason)); }
    }
  };
  const cancel = () => { abort.current?.abort(); abort.current = null; setPending(null); };
  return { pending, start, cancel };
}

// ── One account ──────────────────────────────────────────────────────────────

function IdentityIcon({ identity, agents }: { identity: ConnectorIdentity; agents: AgentOption[] }) {
  const p = parseIdentity(identity);
  if (p?.kind === "agent") {
    const agent = agents.find((a) => a.name === p.agent);
    return <AgentAvatar avatar={agent?.avatar} name={p.agent} size="sm" fallbackVariant="circle" shape="circle" />;
  }
  return <span className="text-muted-foreground">{p?.kind === "org" ? <Building2 className="h-4 w-4" /> : <User className="h-4 w-4" />}</span>;
}

/** The token / header values of a token-based app: write-only, saved to the vault. */
function AccountSecrets({ connector, account, focus, onChanged }: {
  connector: Connector; account: ConnectorAccount; focus?: boolean; onChanged: (c: Connector) => void;
}) {
  const save = async (secrets: { bearerToken?: string; headers?: Record<string, string> }) => {
    try {
      const r = await connectorAccountsApi.update(connector.id, account.id, { secrets });
      onChanged(r.connector);
      toast.success(`${account.label}: saved in the vault`);
    } catch (reason) {
      toast.error(message(reason));
      throw reason;
    }
  };
  if (connector.auth.type === "bearer") {
    return <SecretInput name={`${account.id}-token`} label="Token" isSet={account.secrets.bearerToken} focus={focus} onSave={(v) => save({ bearerToken: v.trim() })} />;
  }
  return (
    <div className="space-y-2">
      {(connector.auth.headerNames ?? []).map((h, i) => (
        <SecretInput key={h} name={`${account.id}-header-${h}`} label={h} isSet={account.secrets.headers.includes(h)} focus={focus && i === 0}
          onSave={(v) => save({ headers: { [h]: v } })} />
      ))}
    </div>
  );
}

export function AccountRow({
  connector, account, signIn, onChanged, focus, compact,
}: {
  connector: Connector;
  account: ConnectorAccount;
  signIn: AccountSignIn;
  onChanged: (c: Connector) => void;
  /** Opened from a setup link: scrolled into view, its token input focused. */
  focus?: boolean;
  /** The agent page: fewer actions (sign in, default, remove). */
  compact?: boolean;
}) {
  const product = productName(useInstanceBranding());
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(account.label);
  const [confirm, setConfirm] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => { if (focus) ref.current?.scrollIntoView?.({ block: "center" }); }, [focus]);
  const state = accountState(account, connector);
  const oauth = connector.auth.type === "oauth";
  const tokenApp = connector.auth.type === "bearer" || connector.auth.type === "headers";
  const tokenSet = connector.auth.type === "bearer" ? account.secrets.bearerToken : account.secrets.headers.length > 0;
  const waiting = signIn.pending?.account === account.id ? signIn.pending : null;
  const off = !!busy || !!waiting;

  const act = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try { await fn(); } catch (reason) { toast.error(message(reason)); } finally { setBusy(null); }
  };
  const rename = () => act("rename", async () => {
    const next = label.trim();
    if (!next || next === account.label) { setRenaming(false); return; }
    if (!ACCOUNT_LABEL_PATTERN.test(next)) throw new Error("Letters, digits, spaces and . _ @ + - only (64 at most)");
    const r = await connectorAccountsApi.update(connector.id, account.id, { label: next });
    onChanged(r.connector);
    setRenaming(false);
    toast.success(`Renamed to ${next}`);
  });

  return (
    <li ref={ref} data-testid={`account-${account.id}`} data-focused={focus ? "true" : undefined}
      className={cn("space-y-2 px-3 py-2", focus && "rounded-md ring-2 ring-primary/50")}>
      <div className="flex flex-wrap items-center gap-2">
        {renaming ? (
          <form className="flex min-w-0 flex-1 items-center gap-1" onSubmit={(e) => { e.preventDefault(); void rename(); }}>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Account label" autoFocus maxLength={64} className="h-7 min-w-0 flex-1 text-sm"
              onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setRenaming(false); } }} />
            <Button type="submit" size="icon" variant="ghost" className="h-7 w-7" aria-label="Save label" disabled={off}>
              {busy === "rename" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            </Button>
            <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label="Cancel rename" onClick={() => setRenaming(false)}><X className="h-3.5 w-3.5" /></Button>
          </form>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="truncate text-sm font-medium" data-testid="account-label">{account.label}</span>
            {account.default && (
              <Badge variant="outline" data-testid="account-default" className="shrink-0 border-primary/40 bg-primary/10 px-1.5 py-0 text-micro text-primary">Default</Badge>
            )}
            {!compact && (
              <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0 text-muted-foreground" aria-label={`Rename ${account.label}`} disabled={off}
                onClick={() => { setLabel(account.label); setRenaming(true); }}>
                <Pencil className="h-3 w-3" />
              </Button>
            )}
          </span>
        )}
        <StateBadge state={state} busy={!!waiting} />
      </div>
      {(account.account || account.importedFrom) && (
        <p className="truncate text-xs text-muted-foreground">
          {account.account && <>Signed in as <span className="font-medium text-foreground">{account.account}</span></>}
          {account.account && account.importedFrom && " · "}
          {account.importedFrom && <>imported from {account.importedFrom}</>}
        </p>
      )}
      {account.lastError && state !== "connected" && (
        <p className="flex items-start gap-1.5 text-xs text-destructive" role="alert">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="min-w-0 break-words">{account.lastError} <FixItLink message={account.lastError} /></span>
        </p>
      )}
      {waiting && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          {waiting.fallbackUrl ? "Your browser blocked the sign-in window." : "Waiting for the sign-in in the window that opened…"}
          {waiting.fallbackUrl && (
            <a href={waiting.fallbackUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
              Open sign-in page <ExternalLink className="h-3 w-3" />
            </a>
          )}
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={signIn.cancel}>Cancel</Button>
        </div>
      )}
      {tokenApp && (!tokenSet || focus || showToken) && (
        <AccountSecrets connector={connector} account={account} focus={focus} onChanged={onChanged} />
      )}
      <div className="flex flex-wrap gap-1.5">
        {oauth && (
          <Button size="sm" variant={state === "connected" ? "outline" : "default"} className="h-7 text-xs" disabled={off || !connector.enabled}
            onClick={() => { const popup = openAuthWindow(); void signIn.start(connector.id, account, popup); }}>
            <RotateCw className="h-3.5 w-3.5" /> {account.secrets.oauth.authorized ? "Reconnect" : "Sign in"}
          </Button>
        )}
        {tokenApp && tokenSet && !showToken && !focus && (
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={off} onClick={() => setShowToken(true)}>Change token</Button>
        )}
        {!compact && (
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={off || !connector.enabled}
            onClick={() => void act("test", async () => {
              const r = await connectorAccountsApi.test(connector.id, account.id);
              onChanged(r.connector);
              if (r.ok) toast.success(`${account.label}: connected, ${r.tools?.length ?? 0} tools`);
              else toast.error(r.error ?? "Could not connect");
            })}>
            {busy === "test" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />} Test
          </Button>
        )}
        {!account.default && (
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={off} aria-label={`Make ${account.label} the default`}
            onClick={() => void act("default", async () => {
              const r = await connectorAccountsApi.update(connector.id, account.id, { default: true });
              onChanged(r.connector);
              toast.success(`${account.label} is now the default`);
            })}>
            {busy === "default" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Star className="h-3.5 w-3.5" />} Make default
          </Button>
        )}
        {!compact && oauth && account.secrets.oauth.authorized && (
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={off}
            onClick={() => void act("disconnect", async () => {
              onChanged(await connectorAccountsApi.disconnect(connector.id, account.id));
              toast.success(`${account.label}: signed out`);
            })}>
            {busy === "disconnect" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unplug className="h-3.5 w-3.5" />} Sign out
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive hover:text-destructive" disabled={off} aria-label={`Remove ${account.label}`}
          onClick={() => setConfirm(true)}>
          <Trash2 className="h-3.5 w-3.5" /> Remove
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Remove the account ${account.label}?`}
        description={`${product} signs it out (revoking the access when the service allows it) and deletes its credentials. ${identityName(account.identity)} keeps its other accounts on ${connector.name}.`}
        confirmLabel="Remove"
        destructive
        loading={busy === "remove"}
        onConfirm={() => void act("remove", async () => {
          const r = await connectorAccountsApi.remove(connector.id, account.id);
          setConfirm(false);
          onChanged(r.connector);
          toast.success(`${account.label} removed`);
        })}
      />
    </li>
  );
}

// ── Add an account ───────────────────────────────────────────────────────────

export interface IdentityOption { value: ConnectorIdentity | "me"; label: string }

/** Who may connect an account here: agents with access, the signed-in person (when Polpo may use it), the organization. */
export function identityOptions(connector: Connector, agents: AgentOption[], product: string): IdentityOption[] {
  return [
    ...agents.filter((a) => agentHasAccess(connector.access, a.name)).map((a) => ({ value: agentIdentity(a.name), label: a.label })),
    ...(connector.access.polpo ? [{ value: "me" as const, label: `Me (chatting with ${product})` }] : []),
    { value: ORG_IDENTITY, label: "Organization (fallback)" },
  ];
}

export function AddAccountForm({
  connector, options, initialIdentity, signIn, onChanged, onDone,
}: {
  connector: Connector;
  /** Whose account it can be; one option: no picker. */
  options: IdentityOption[];
  initialIdentity?: ConnectorIdentity | "me";
  signIn: AccountSignIn;
  onChanged: (c: Connector) => void;
  onDone: () => void;
}) {
  const [identity, setIdentity] = useState<string>(initialIdentity ?? options[0]?.value ?? ORG_IDENTITY);
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const oauth = connector.auth.type === "oauth";
  const headerNames = connector.auth.type === "headers" ? connector.auth.headerNames ?? [] : [];

  const submit = () => {
    const clean = label.trim();
    if (!ACCOUNT_LABEL_PATTERN.test(clean)) { setError("Give it a name: letters, digits, spaces and . _ @ + - (e.g. sitoinchat)"); return; }
    if (connector.auth.type === "bearer" && !token.trim()) { setError("Paste the account's token"); return; }
    if (headerNames.some((h) => !headers[h])) { setError("Fill in every header"); return; }
    // the sign-in window opens inside the click
    const popup = oauth ? openAuthWindow() : null;
    setSaving(true);
    setError(null);
    void (async () => {
      try {
        const secrets = connector.auth.type === "bearer" ? { bearerToken: token.trim() } : headerNames.length ? { headers } : undefined;
        const r = await connectorAccountsApi.add(connector.id, { identity, label: clean, ...(secrets ? { secrets } : {}) });
        onChanged(r.connector);
        onDone();
        if (oauth) {
          await signIn.start(connector.id, r.account, popup);
        } else {
          const t = await connectorAccountsApi.test(connector.id, r.account.id);
          onChanged(t.connector);
          if (t.ok) toast.success(`${clean} is connected`);
          else toast.error(t.error ?? "Could not connect");
        }
      } catch (reason) {
        try { popup?.close(); } catch { /* cross-origin */ }
        setError(message(reason));
      } finally {
        setSaving(false);
      }
    })();
  };

  return (
    <form className="space-y-3 rounded-lg border bg-muted/20 p-3" data-testid="add-account-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {options.length > 1 && (
        <label className="block space-y-1">
          <span className="text-xs font-medium">Whose account</span>
          <Select value={identity} onValueChange={setIdentity}>
            <SelectTrigger size="sm" className="h-8 w-full text-xs" aria-label="Whose account"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-80">
              {options.map((o) => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
      )}
      <label className="block space-y-1">
        <span className="text-xs font-medium">Account name</span>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="sitoinchat" aria-label="Account name" maxLength={64} spellCheck={false} autoFocus />
        <span className="block text-xs text-muted-foreground">What its owner picks it by: <code className="font-mono">account: "{label.trim() || "sitoinchat"}"</code>.</span>
      </label>
      {connector.auth.type === "bearer" && (
        <label className="block space-y-1">
          <span className="text-xs font-medium">Token</span>
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" aria-label="Account token" />
          <span className="block text-xs text-muted-foreground">Stored in the vault, never shown again.</span>
        </label>
      )}
      {headerNames.map((h) => (
        <label key={h} className="block space-y-1">
          <span className="text-xs font-medium">{h}</span>
          <Input type="password" value={headers[h] ?? ""} onChange={(e) => setHeaders((v) => ({ ...v, [h]: e.target.value }))} autoComplete="new-password" aria-label={`Account header ${h}`} />
        </label>
      ))}
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
        <Button type="submit" size="sm" disabled={saving}>
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {oauth ? "Add and sign in" : "Add account"}
        </Button>
      </div>
    </form>
  );
}

// ── Import a separate connector of the same app ──────────────────────────────

function ImportDialog({
  connector, candidates, options, initialSource, agentLabel, open, onOpenChange, onChanged, onImported,
}: {
  connector: Connector;
  candidates: Connector[];
  options: IdentityOption[];
  initialSource?: string;
  agentLabel: (name: string) => string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: (c: Connector) => void;
  onImported?: (sourceId: string, removed: boolean) => void;
}) {
  const defaults = (id: string | undefined) => {
    const source = candidates.find((c) => c.id === id) ?? candidates[0];
    const wanted = source ? importIdentity(source) : ORG_IDENTITY;
    return {
      source: source?.id ?? "",
      identity: options.some((o) => o.value === wanted) ? wanted : options[0]?.value ?? ORG_IDENTITY,
      label: source ? accountLabelFrom(source.account ?? source.name) : "",
    };
  };
  const [form, setForm] = useState(() => defaults(initialSource));
  const [removeSource, setRemoveSource] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = candidates.find((c) => c.id === form.source);

  const submit = async () => {
    if (!source) return;
    if (!ACCOUNT_LABEL_PATTERN.test(form.label.trim())) { setError("Give the account a name: letters, digits, spaces and . _ @ + -"); return; }
    setSaving(true);
    setError(null);
    try {
      const r = await connectorAccountsApi.import(connector.id, { from: source.id, identity: form.identity, label: form.label.trim(), removeSource });
      onChanged(r.connector);
      onImported?.(source.id, r.source.removed);
      onOpenChange(false);
      toast.success(`${source.name} is now the account "${r.account.label}" of ${identityName(r.account.identity, agentLabel)}`);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="shrink-0 border-b px-6 pb-4 pt-6 pr-12">
          <DialogTitle>Import into {connector.name}</DialogTitle>
          <DialogDescription>A separate connector of the same app becomes an account here. Its sign-in moves over: nobody signs in again.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form className="space-y-4" data-testid="import-account-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <label className="block space-y-1">
              <span className="text-xs font-medium">Connector to import</span>
              <Select value={form.source} onValueChange={(id) => setForm(defaults(id))}>
                <SelectTrigger size="sm" className="h-8 w-full text-xs" aria-label="Connector to import"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-80">
                  {candidates.map((c) => <SelectItem key={c.id} value={c.id} className="text-xs">{c.name} ({c.id}){c.account ? ` · ${c.account}` : ""}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium">Whose account it becomes</span>
              <Select value={form.identity} onValueChange={(identity) => setForm((f) => ({ ...f, identity }))}>
                <SelectTrigger size="sm" className="h-8 w-full text-xs" aria-label="Whose account it becomes"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-80">
                  {options.map((o) => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium">Account name</span>
              <Input value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} aria-label="Imported account name" maxLength={64} spellCheck={false} />
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1 accent-primary" checked={removeSource} onChange={(e) => setRemoveSource(e.target.checked)} aria-label="Remove the source connector" />
              <span>
                Remove {source?.name ?? "the source"}
                <span className="block text-xs text-muted-foreground">
                  {removeSource ? "Deleted without signing out: its access moves to the account." : "Kept, turned off."}
                </span>
              </span>
            </label>
            {source && (
              <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs" role="note" data-testid="import-rename-warning">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <span>
                  Tool names change: <code className="font-mono">mcp__{source.id}__…</code> becomes <code className="font-mono">mcp__{connector.id}__…</code> with
                  {" "}<code className="font-mono">account: "{form.label.trim() || "…"}"</code> (its default when it is the only one). Update skills, playbooks
                  and allowed tools that name the old ones.
                </span>
              </div>
            )}
            {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
            <DialogFooter sticky>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={saving || !source}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Import</Button>
            </DialogFooter>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

// ── The sheet's Accounts section ─────────────────────────────────────────────

export function AccountsSection({
  connector, connectors, agents, onChanged, focus, importFrom, onImported,
}: {
  connector: Connector;
  /** Every connector (the import candidates). */
  connectors: Connector[];
  agents: AgentOption[];
  onChanged: (c: Connector) => void;
  /** An account to focus (a setup link: ?focus=account:<id>), or "add" to open the add form. */
  focus?: string;
  /** Open the import dialog with this source picked. */
  importFrom?: string;
  onImported?: (sourceId: string, removed: boolean) => void;
}) {
  const product = productName(useInstanceBranding());
  const signIn = useAccountSignIn(onChanged);
  const [adding, setAdding] = useState(focus === "add");
  const candidates = importCandidates(connector, connectors);
  const [importing, setImporting] = useState(!!importFrom && candidates.some((c) => c.id === importFrom));
  const [busy, setBusy] = useState(false);
  const agentLabel = (name: string) => agents.find((a) => a.name === name)?.label ?? name;
  const options = identityOptions(connector, agents, product);
  const identities = accountIdentities(connector);
  const fallback = fallbackOn(connector);
  const orgAccounts = accountsOf(connector, ORG_IDENTITY);

  const setFallback = async (on: boolean) => {
    setBusy(true);
    try {
      onChanged(await connectorsApi.update(connector.id, { scope: { kind: "identity", fallback: on } }));
      toast.success(on ? "Identities without an account now use the organization's" : "The organization's account is no longer shared");
    } catch (reason) {
      toast.error(message(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3" data-testid="connector-accounts">
      <div className="flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 font-heading text-h3"><UserPlus className="h-4 w-4" /> Accounts</h3>
        <span className="text-xs text-muted-foreground">{accountsSummary(connector)}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Each agent and person uses only its own accounts: its default one, or another with <code className="font-mono">account: "&lt;name&gt;"</code> on any
        {" "}<code className="font-mono">mcp__{connector.id}__…</code> tool. Nobody sees or uses someone else's.
      </p>

      <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
        <span className="min-w-0 text-sm">
          Organization's shared account
          <span className="block text-xs text-muted-foreground">
            {fallback
              ? `On: identities without an account of their own use the organization's${orgAccounts.length ? "" : " (add one below: none yet)"}.`
              : "Off (default): an identity without its own account has no access."}
          </span>
        </span>
        <Switch label="Use the organization's account as fallback" checked={fallback} disabled={busy} onChange={(on) => void setFallback(on)} />
      </div>

      {identities.length === 0 && !adding && (
        <p className="text-sm text-muted-foreground">No accounts yet. Add one for an agent, for you, or for the organization.</p>
      )}
      {identities.map((identity) => (
        <div key={identity} className="rounded-lg border" data-testid={`identity-${identity}`}>
          <div className="flex items-center gap-2 border-b px-3 py-1.5">
            <IdentityIcon identity={identity} agents={agents} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium" data-testid="identity-name">{identityName(identity, agentLabel)}</span>
            {identity === ORG_IDENTITY && <span className="text-caption text-muted-foreground">{fallback ? "shared with identities without one" : "not shared (fallback off)"}</span>}
          </div>
          <ul className="divide-y">
            {accountsOf(connector, identity).map((account) => (
              <AccountRow key={account.id} connector={connector} account={account} signIn={signIn} onChanged={onChanged} focus={focus === account.id} />
            ))}
          </ul>
        </div>
      ))}

      {adding ? (
        <AddAccountForm connector={connector} options={options} signIn={signIn} onChanged={onChanged} onDone={() => setAdding(false)} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setAdding(true)} disabled={!connector.enabled}><Plus className="h-4 w-4" /> Add account</Button>
          {candidates.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => setImporting(true)}><ArrowRightLeft className="h-4 w-4" /> Import an existing connector</Button>
          )}
        </div>
      )}
      {candidates.length > 0 && importing && (
        <ImportDialog
          connector={connector} candidates={candidates} options={options} initialSource={importFrom} agentLabel={agentLabel}
          open={importing} onOpenChange={setImporting} onChanged={onChanged} onImported={onImported}
        />
      )}
    </section>
  );
}
