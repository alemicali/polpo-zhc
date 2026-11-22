/**
 * "Add custom connector": any remote MCP server by URL (Streamable HTTP, or SSE when the path ends
 * in /sse), with OAuth (automatic registration or your own client), a bearer token, secret headers
 * or no auth. Advanced: a local command (stdio), which runs on the Polpo server.
 */
import { useState } from "react";
import { AlertTriangle, ChevronDown, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  EMPTY_CUSTOM_FORM, customConnectorInput, validateCustomConnector,
  type ConnectorInput, type CustomAuthChoice, type CustomConnectorForm,
} from "@/lib/connectors-api";
import { cn } from "@/lib/utils";
import { CopyField, Field } from "./connect-dialog";
import { productName, useInstanceBranding } from "@/lib/branding";

const AUTH_CHOICES: Array<{ value: CustomAuthChoice; label: string; hint: string }> = [
  { value: "oauth", label: "OAuth", hint: "Sign in with the service (most hosted servers)" },
  { value: "bearer", label: "Bearer token", hint: "An API key sent as Authorization: Bearer" },
  { value: "headers", label: "Custom headers", hint: "Secret headers such as X-Api-Key" },
  { value: "none", label: "None", hint: "Public server" },
];

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
  const errors = validateCustomConnector(form);
  const visible = showErrors ? errors : {};
  const set = <K extends keyof CustomConnectorForm>(key: K, value: CustomConnectorForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const reset = () => { setForm(EMPTY_CUSTOM_FORM); setShowErrors(false); setAdvanced(false); };

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
              <Field label="Remote MCP server URL" error={visible.url} hint="Exactly as the provider documents it, including the path. URLs ending in /sse use SSE.">
                <Input value={form.url} onChange={(e) => set("url", e.target.value)} placeholder="https://mcp.example.com/mcp" inputMode="url" spellCheck={false} aria-invalid={!!visible.url} />
              </Field>

              <fieldset className="space-y-1.5">
                <legend className="mb-1 text-xs font-medium">Authentication</legend>
                <div className="grid grid-cols-2 gap-1.5">
                  {AUTH_CHOICES.map((choice) => (
                    <label key={choice.value} className={cn("cursor-pointer rounded-md border px-2.5 py-2 text-sm", form.auth === choice.value ? "border-primary bg-primary/5" : "hover:bg-muted/40")}>
                      <input type="radio" name="auth" className="sr-only" value={choice.value} checked={form.auth === choice.value} onChange={() => set("auth", choice.value)} />
                      <span className="block font-medium">{choice.label}</span>
                      <span className="block text-caption leading-tight text-muted-foreground">{choice.hint}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

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

              {form.auth === "oauth" && (
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
                    <Field label="Scopes" hint="Space or comma separated; default: what the server advertises.">
                      <Input value={form.scopes} onChange={(e) => set("scopes", e.target.value)} spellCheck={false} />
                    </Field>
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
