/**
 * "Add custom connector": any remote MCP server by URL (Streamable HTTP, or SSE when the path ends
 * in /sse), with OAuth (automatic registration or your own client), a bearer token, secret headers
 * or no auth. Advanced: a local command (stdio), which runs on the Polpo server.
 *
 * As soon as a URL is entered (debounced) the server probes it (POST /connectors/discover): the
 * transport, whether and how it signs in, its scopes, name and icon. The detected ways to sign in are
 * listed with the recommended one preselected; everything stays editable.
 */
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, Loader2, Plus, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  DETECTED_AUTH_LABELS, EMPTY_CUSTOM_FORM, applyDiscovery, authForDetected, connectorsApi, customConnectorInput, validateCustomConnector,
  type ConnectorDiscovery, type ConnectorInput, type CustomAuthChoice, type CustomConnectorForm,
} from "@/lib/connectors-api";
import { ConnectorIcon } from "./connector-icon";
import { cn } from "@/lib/utils";
import { CopyField, Field } from "./connect-dialog";
import { productName, useInstanceBranding } from "@/lib/branding";

const AUTH_CHOICES: Array<{ value: CustomAuthChoice; label: string; hint: string }> = [
  { value: "oauth", label: "OAuth", hint: "Sign in with the service (most hosted servers)" },
  { value: "bearer", label: "Bearer token", hint: "An API key sent as Authorization: Bearer" },
  { value: "headers", label: "Custom headers", hint: "Secret headers such as X-Api-Key" },
  { value: "none", label: "None", hint: "Public server" },
];

const DETECT_DELAY_MS = 600;

/** A URL worth probing (the server applies its own rules: https, no private addresses). */
function probeable(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

type Detection =
  | { state: "idle" }
  | { state: "loading"; url: string }
  | { state: "done"; url: string; result: ConnectorDiscovery };

/** Probe the URL a short while after the person stops typing. */
function useDetection(url: string | undefined, onResult: (result: ConnectorDiscovery) => void): Detection {
  const [detection, setDetection] = useState<Detection>({ state: "idle" });
  const callback = useRef(onResult);
  useEffect(() => { callback.current = onResult; });
  useEffect(() => {
    if (!url) return;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      setDetection({ state: "loading", url });
      connectorsApi.discover(url, { signal: ac.signal }).then(
        (result) => { if (!ac.signal.aborted) { setDetection({ state: "done", url, result }); callback.current(result); } },
        (reason: unknown) => {
          if (!ac.signal.aborted) setDetection({ state: "done", url, result: { url, reachable: false, error: reason instanceof Error ? reason.message : String(reason), options: [] } });
        },
      );
    }, DETECT_DELAY_MS);
    return () => { clearTimeout(timer); ac.abort(); };
  }, [url]);
  // a detection of another (or no) URL is not shown
  return url && detection.state !== "idle" && detection.url === url ? detection : { state: "idle" };
}

export function CustomConnectorDialog({
  open, onOpenChange, redirectUri, onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  redirectUri?: string;
  /** Create the connector and connect it. Called from the submit click (may open a sign-in window). */
  onSubmit: (input: ConnectorInput) => void;
}) {
  const product = productName(useInstanceBranding());
  const [form, setForm] = useState<CustomConnectorForm>(EMPTY_CUSTOM_FORM);
  const [showErrors, setShowErrors] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [otherMethods, setOtherMethods] = useState(false);
  /** The name the last detection filled in (replaced by the next one unless the person typed their own). */
  const autoName = useRef<string | undefined>(undefined);
  const errors = validateCustomConnector(form);
  const visible = showErrors ? errors : {};
  const set = <K extends keyof CustomConnectorForm>(key: K, value: CustomConnectorForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const reset = () => { setForm(EMPTY_CUSTOM_FORM); setShowErrors(false); setAdvanced(false); setOtherMethods(false); autoName.current = undefined; };
  const detection = useDetection(open && form.kind === "remote" ? probeable(form.url) : undefined, (result) => {
    setForm((f) => applyDiscovery(f, result, autoName.current));
    if (result.recommendation?.name) autoName.current = result.recommendation.name;
    setOtherMethods(false);
  });
  const found = detection.state === "done" && detection.result.recommendation ? detection.result : undefined;
  const detectedScopes = found?.resource?.scopes ?? [];
  const pickedScopes = form.scopes.split(/[\s,]+/).filter(Boolean);
  const toggleScope = (scope: string, on: boolean) => set("scopes", (on ? [...new Set([...pickedScopes, scope])] : pickedScopes.filter((x) => x !== scope)).join(" "));
  const pickManual = (value: CustomAuthChoice) => setForm((f) => ({ ...f, auth: value, detected: undefined }));

  const submit = () => {
    if (Object.keys(errors).length) { setShowErrors(true); return; }
    onSubmit(customConnectorInput(form));
    reset();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next); }}>
      <DialogContent className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="shrink-0 border-b px-6 pb-4 pt-6 pr-12">
          <DialogTitle>Add custom connector</DialogTitle>
          <DialogDescription>Connect any MCP server. Credentials are stored in the vault and never shown again.</DialogDescription>
        </DialogHeader>
        <DialogBody>
        <form className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <Field label="Name" error={visible.name}>
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Internal tools" aria-invalid={!!visible.name} />
          </Field>

          {form.kind === "remote" ? (
            <>
              <Field label="Remote MCP server URL" error={visible.url} hint="Exactly as the provider documents it, including the path. We detect how to connect.">
                <Input value={form.url} onChange={(e) => { const url = e.target.value; setForm((f) => ({ ...f, url, transport: undefined, detected: undefined })); }} placeholder="https://mcp.example.com/mcp" inputMode="url" spellCheck={false} aria-invalid={!!visible.url} />
              </Field>

              {detection.state === "loading" && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="connector-detecting">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Detecting how to connect…
                </p>
              )}
              {detection.state === "done" && !found && (
                <p className="text-xs text-muted-foreground" data-testid="connector-detect-failed">
                  Could not detect how to connect{detection.result.error ? `: ${detection.result.error}` : ""}. Pick the sign-in below.
                </p>
              )}

              {found?.recommendation && (
                <div className="space-y-3 rounded-md border bg-muted/20 p-3" data-testid="connector-detected">
                  <div className="flex items-center gap-2.5">
                    <ConnectorIcon name={form.name || found.recommendation.name || "?"} previewSrc={found.recommendation.icon?.dataUri} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1 truncate text-sm font-medium"><Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" /> Detected</p>
                      <p className="truncate text-caption text-muted-foreground">
                        {found.recommendation.transport === "sse" ? "Legacy SSE" : "Streamable HTTP"}
                        {found.server?.version ? ` · ${found.server.title ?? found.server.name ?? ""} ${found.server.version}` : ""}
                        {found.authRequired ? " · needs sign-in" : " · no sign-in"}
                      </p>
                    </div>
                  </div>
                  <fieldset className="space-y-1.5">
                    <legend className="mb-1 text-xs font-medium">How to sign in</legend>
                    {found.options.map((option) => (
                      <label key={option.auth} className={cn("flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-sm", form.detected === option.auth ? "border-primary bg-primary/5" : "bg-background hover:bg-muted/40")}>
                        <input type="radio" name="detected-auth" className="mt-1 accent-primary" value={option.auth} checked={form.detected === option.auth}
                          onChange={() => setForm((f) => ({ ...f, auth: authForDetected(option.auth), detected: option.auth }))} />
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-1.5 font-medium">
                            {DETECTED_AUTH_LABELS[option.auth]}
                            {option.recommended && <span className="rounded-xs bg-primary/10 px-1.5 py-0.5 text-caption font-medium text-primary">Recommended</span>}
                          </span>
                          <span className="block text-caption leading-tight text-muted-foreground">{option.description}</span>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                  {form.auth === "oauth" && detectedScopes.length > 0 && (
                    <fieldset className="space-y-1">
                      <legend className="mb-1 text-xs font-medium">Scopes</legend>
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {detectedScopes.map((scope) => (
                          <label key={scope} className="flex items-center gap-1.5 font-mono text-xs">
                            <input type="checkbox" className="accent-primary" checked={pickedScopes.includes(scope)} onChange={(e) => toggleScope(scope, e.target.checked)} />
                            {scope}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  )}
                  {found.recommendation.notes.length > 0 && (
                    <ul className="space-y-0.5 text-caption text-muted-foreground">
                      {found.recommendation.notes.map((note) => <li key={note}>{note}</li>)}
                    </ul>
                  )}
                  <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" aria-expanded={otherMethods} onClick={() => setOtherMethods((v) => !v)}>
                    <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", otherMethods && "rotate-180")} /> Other sign-in methods
                  </button>
                </div>
              )}

              {(!found || otherMethods) && (
                <fieldset className="space-y-1.5">
                  <legend className="mb-1 text-xs font-medium">Authentication</legend>
                  <div className="grid grid-cols-2 gap-1.5">
                    {AUTH_CHOICES.map((choice) => (
                      <label key={choice.value} className={cn("cursor-pointer rounded-md border px-2.5 py-2 text-sm", form.auth === choice.value && !form.detected ? "border-primary bg-primary/5" : "hover:bg-muted/40")}>
                        <input type="radio" name="auth" className="sr-only" value={choice.value} checked={form.auth === choice.value && !form.detected} onChange={() => pickManual(choice.value)} />
                        <span className="block font-medium">{choice.label}</span>
                        <span className="block text-caption leading-tight text-muted-foreground">{choice.hint}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}

              {form.auth === "bearer" && (
                <Field label="Token" error={visible.bearerToken}>
                  <Input type="password" value={form.bearerToken} onChange={(e) => set("bearerToken", e.target.value)} autoComplete="new-password" aria-invalid={!!visible.bearerToken} />
                </Field>
              )}

              {form.auth === "headers" && (
                <div className="space-y-1.5">
                  <span className="text-xs font-medium">Headers</span>
                  {form.headers.map((h, i) => (
                    <div key={i} className="flex gap-1.5">
                      <Input aria-label={`Header ${i + 1} name`} value={h.name} placeholder="X-Api-Key" className="w-2/5" spellCheck={false}
                        onChange={(e) => set("headers", form.headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                      <Input aria-label={`Header ${i + 1} value`} type="password" value={h.value} placeholder="value" autoComplete="new-password"
                        onChange={(e) => set("headers", form.headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                      <Button type="button" size="icon" variant="ghost" aria-label="Remove header" disabled={form.headers.length === 1}
                        onClick={() => set("headers", form.headers.filter((_, j) => j !== i))}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                  <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => set("headers", [...form.headers, { name: "", value: "" }])}>
                    <Plus className="h-3.5 w-3.5" /> Add header
                  </Button>
                  {visible.headers && <p className="text-xs text-destructive" role="alert">{visible.headers}</p>}
                </div>
              )}

              {form.auth === "oauth" && form.detected === "oauth-preregistered" && (
                <div className="space-y-3 rounded-md border px-3 py-3" data-testid="connector-own-client">
                  <p className="text-xs text-muted-foreground">Create an OAuth client in the service's developer console with this redirect URI, then enter its client id (and secret, if it has one).</p>
                  {redirectUri && <CopyField label="Redirect URI to register" value={redirectUri} />}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Client ID" error={visible.clientId}>
                      <Input value={form.clientId} onChange={(e) => set("clientId", e.target.value)} autoComplete="off" spellCheck={false} aria-invalid={!!visible.clientId} />
                    </Field>
                    <Field label="Client secret">
                      <Input type="password" value={form.clientSecret} onChange={(e) => set("clientSecret", e.target.value)} autoComplete="new-password" />
                    </Field>
                  </div>
                </div>
              )}

              {form.auth === "oauth" && form.detected !== "oauth-preregistered" && (
                <details className="group rounded-md border px-3 py-2">
                  <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium">
                    <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" /> Use your own OAuth client (optional)
                  </summary>
                  <div className="mt-3 space-y-3">
                    <p className="text-xs text-muted-foreground">Leave empty to let {product} register itself with the server (dynamic registration or its client metadata document).</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Client ID" error={visible.clientId}>
                        <Input value={form.clientId} onChange={(e) => set("clientId", e.target.value)} autoComplete="off" spellCheck={false} />
                      </Field>
                      <Field label="Client secret">
                        <Input type="password" value={form.clientSecret} onChange={(e) => set("clientSecret", e.target.value)} autoComplete="new-password" />
                      </Field>
                    </div>
                    {detectedScopes.length === 0 && (
                      <Field label="Scopes" hint="Space or comma separated; default: what the server advertises.">
                        <Input value={form.scopes} onChange={(e) => set("scopes", e.target.value)} spellCheck={false} />
                      </Field>
                    )}
                    {redirectUri && <CopyField label="Redirect URI to register" value={redirectUri} />}
                  </div>
                </details>
              )}
            </>
          ) : (
            <>
              <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs" role="note">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <span>A local connector <strong>runs a command on the {product} server</strong> as the server's user. Only add servers you trust as much as the code you run on that machine.</span>
              </div>
              <Field label="Command" error={visible.command} hint='E.g. npx -y @modelcontextprotocol/server-filesystem /data'>
                <Input value={form.command} onChange={(e) => set("command", e.target.value)} placeholder="npx" spellCheck={false} className="font-mono" aria-invalid={!!visible.command} />
              </Field>
              <Field label="Arguments" hint="Optional; quote arguments with spaces.">
                <Input value={form.args} onChange={(e) => set("args", e.target.value)} spellCheck={false} className="font-mono" />
              </Field>
            </>
          )}

          <div>
            <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", advanced && "rotate-180")} /> Advanced
            </button>
            {advanced && (
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input type="checkbox" className="accent-primary" checked={form.kind === "stdio"} onChange={(e) => set("kind", e.target.checked ? "stdio" : "remote")} />
                Run a local command instead (stdio, admins only)
              </label>
            )}
          </div>

          <DialogFooter sticky>
            <Button type="button" variant="outline" onClick={() => { reset(); onOpenChange(false); }}>Cancel</Button>
            <Button type="submit">{form.kind === "remote" && form.auth === "oauth" ? "Add and sign in" : "Add"}</Button>
          </DialogFooter>
        </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
