/**
 * A hosted MCP server's editor: Tools (HTTP / code tools, with a schema preview), Settings (auth from
 * vault references, allowed domains, npm dependencies, limits, visibility and kill switch), Test (one
 * tool or the saved cases: request with secrets masked, response, timing), Versions (the draft's
 * diff, publish, deploy, roll back, history) and Logs (calls, and calls waiting for approval).
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, FlaskConical, FlaskRound, Globe, History, Loader2, Play, Plus, Rocket, RotateCcw, Save, ScrollText, Settings2, ShieldAlert, ShieldCheck, Trash2, Users, Wrench } from "lucide-react";
import { TargetSuitesPanel } from "@/components/suites/target-suites-panel";
import {
  useMcpServer,
  type McpHostedServer, type McpServerAuth, type McpServerCallLog, type McpServerDiff, type McpServerSpec, type McpServerTool, type McpPendingCall, type McpToolTestResult,
} from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { AgentVersionDiffView, OverrideDialog } from "@/components/agents/agent-versions-tab";
import { HostedStatusPill, Switch } from "./connector-bits";
import { ConnectorIcon } from "./connector-icon";
import { hostedServerIconFor } from "@/lib/hosted-server-icons";
import { blankTool, hostedLabel, isSensitive, parseJson, pretty, sampleInput, schemaParams, serverPill, settingsPayload } from "@/lib/mcp-servers";
import { productName, useInstanceBranding } from "@/lib/branding";
import { SecretHelp, SecretInput, SettingInput, type SettingValue } from "./template-fields";
import { cn } from "@/lib/utils";

const selectClass = "h-9 w-full rounded-md border bg-transparent px-2 text-sm";
const label = "block space-y-1 text-sm";
const errorText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

function Field({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className={label}>
      <span className="font-medium">{title}{hint && <span className="ml-1 font-normal text-muted-foreground">{hint}</span>}</span>
      {children}
    </label>
  );
}

/** A JSON field that keeps its text while invalid. */
function JsonField({ title, hint, value, onChange, rows = 4 }: { title: string; hint?: string; value: unknown; onChange: (v: unknown) => void; rows?: number }) {
  const [text, setText] = useState(pretty(value));
  const [error, setError] = useState<string | null>(null);
  // the value this field last showed or emitted: a different one comes from outside (undo, reload)
  const [last, setLast] = useState(value);
  if (value !== last) {
    setLast(value);
    setText(pretty(value));
    setError(null);
  }
  return (
    <Field title={title} hint={hint}>
      <Textarea
        rows={rows} value={text} aria-label={title} className="font-mono text-xs"
        onChange={(e) => {
          setText(e.target.value);
          const p = parseJson(e.target.value);
          if (p.ok) { setError(null); setLast(p.value); onChange(p.value); } else setError(p.error);
        }}
      />
      {error && <span className="text-xs text-destructive">{error}</span>}
    </Field>
  );
}

function SchemaPreview({ schema }: { schema: Record<string, unknown> }) {
  const params = schemaParams(schema);
  if (!params.length) return <p className="text-xs text-muted-foreground">No parameters.</p>;
  return (
    <ul className="space-y-0.5 text-xs" aria-label="Parameters">
      {params.map((p) => (
        <li key={p.name}><code>{p.name}</code>{p.required && <span className="text-destructive">*</span>} <span className="text-muted-foreground">{p.type}{p.description ? ` — ${p.description}` : ""}</span></li>
      ))}
    </ul>
  );
}

function ToolEditor({ tool, onChange, onRemove }: { tool: McpServerTool; onChange: (t: McpServerTool) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<McpServerTool>) => onChange({ ...tool, ...patch });
  const annotate = (k: "readOnlyHint" | "destructiveHint", v: boolean) => set({ annotations: { ...(tool.annotations ?? {}), [k]: v } });
  return (
    <section className="border-b py-3 last:border-b-0" data-testid={`tool-${tool.name}`}>
      <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <code className="text-sm font-medium">{tool.name}</code>
        <Badge variant="outline" className="text-micro font-normal">{tool.kind === "http" ? `${tool.http?.method ?? "GET"} ${tool.http?.url ?? ""}` : "code"}</Badge>
        {tool.requiresApproval && <Badge variant="secondary" className="text-micro font-normal">approval</Badge>}
        {tool.annotations?.readOnlyHint && <Badge variant="secondary" className="text-micro font-normal">read-only</Badge>}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{tool.description}</span>
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field title="Name"><Input value={tool.name} onChange={(e) => set({ name: e.target.value })} aria-label="Tool name" /></Field>
            <Field title="Title"><Input value={tool.title ?? ""} onChange={(e) => set({ title: e.target.value || undefined })} aria-label="Tool title" /></Field>
          </div>
          <Field title="Description" hint="(what the model reads: when to use it, what it returns)">
            <Textarea rows={3} value={tool.description} onChange={(e) => set({ description: e.target.value })} aria-label="Tool description" />
          </Field>
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
            <label className="flex items-center gap-2"><Checkbox checked={!!tool.annotations?.readOnlyHint} onCheckedChange={(v) => annotate("readOnlyHint", v === true)} /> Read-only</label>
            <label className="flex items-center gap-2"><Checkbox checked={!!tool.annotations?.destructiveHint} onCheckedChange={(v) => annotate("destructiveHint", v === true)} /> Destructive</label>
            <label className="flex items-center gap-2"><Checkbox checked={!!tool.requiresApproval} onCheckedChange={(v) => set({ requiresApproval: v === true || undefined })} /> Needs approval</label>
            <label className="flex items-center gap-2"><Checkbox checked={!!tool.publicCallable} onCheckedChange={(v) => set({ publicCallable: v === true || undefined })} /> Callable on the public URL</label>
          </div>
          {tool.kind === "http" && tool.http && (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
                <Field title="Method">
                  <select className={selectClass} value={tool.http.method} aria-label="Method" onChange={(e) => set({ http: { ...tool.http!, method: e.target.value as "GET" } })}>
                    {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => <option key={m}>{m}</option>)}
                  </select>
                </Field>
                <Field title="URL" hint="({{input.x}} placeholders)"><Input value={tool.http.url} onChange={(e) => set({ http: { ...tool.http!, url: e.target.value } })} aria-label="URL" className="font-mono text-xs" /></Field>
              </div>
              <JsonField title="Query" hint="(name → template)" value={tool.http.query} onChange={(v) => set({ http: { ...tool.http!, query: v as Record<string, string> } })} rows={2} />
              <JsonField title="Headers" hint="({{secrets.NAME}} allowed here)" value={tool.http.headers} onChange={(v) => set({ http: { ...tool.http!, headers: v as Record<string, string> } })} rows={2} />
              {tool.http.method !== "GET" && <JsonField title="Body" hint="(JSON template)" value={tool.http.body} onChange={(v) => set({ http: { ...tool.http!, body: v } })} />}
              <JsonField title="Response mapping" hint="({ pick, fields, maxChars })" value={tool.http.response} onChange={(v) => set({ http: { ...tool.http!, response: v as never } })} rows={2} />
              <JsonField title="Error mapping" hint="([{ status, match?, message }])" value={tool.http.errors} onChange={(v) => set({ http: { ...tool.http!, errors: v as never } })} rows={2} />
            </div>
          )}
          {tool.kind === "code" && (
            <Field title="Code" hint="(export async function handler(input, ctx))">
              <Textarea rows={10} value={tool.code?.source ?? ""} onChange={(e) => set({ code: { source: e.target.value } })} aria-label="Code" className="font-mono text-xs" />
            </Field>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <JsonField title="Input schema" value={tool.inputSchema} onChange={(v) => set({ inputSchema: (v ?? { type: "object", properties: {} }) as Record<string, unknown> })} rows={8} />
            <div className="space-y-1 text-sm"><span className="font-medium">Preview</span><SchemaPreview schema={tool.inputSchema} /></div>
          </div>
          <Button size="sm" variant="ghost" className="text-destructive" onClick={onRemove}><Trash2 className="h-3.5 w-3.5" /> Remove tool</Button>
        </div>
      )}
    </section>
  );
}

function authSecrets(auth: McpServerAuth): string[] {
  if (auth.type === "bearer" || auth.type === "header" || auth.type === "query") return [auth.secret];
  return [];
}

function SettingsTab({ spec, onChange, secretsSet }: { spec: McpServerSpec; onChange: (s: McpServerSpec) => void; secretsSet: Record<string, boolean> }) {
  const set = (patch: Partial<McpServerSpec>) => onChange({ ...spec, ...patch });
  const secretNames = Object.keys(spec.secrets);
  const firstSecret = secretNames[0] ?? "token";
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field title="Name"><Input value={spec.name} onChange={(e) => set({ name: e.target.value })} aria-label="Server name" /></Field>
        <Field title="Icon" hint="(emoji or simple-icons slug)"><Input value={spec.icon ?? ""} onChange={(e) => set({ icon: e.target.value || undefined })} aria-label="Icon" /></Field>
      </div>
      <Field title="Description"><Textarea rows={2} value={spec.description ?? ""} onChange={(e) => set({ description: e.target.value || undefined })} aria-label="Server description" /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field title="Base URL"><Input value={spec.baseUrl ?? ""} onChange={(e) => set({ baseUrl: e.target.value || undefined })} placeholder="https://api.example.com" aria-label="Base URL" /></Field>
        <Field title="Allowed domains" hint="(comma separated; secrets only go there)">
          <Input value={spec.allowedDomains.join(", ")} onChange={(e) => set({ allowedDomains: e.target.value.split(",").map((d) => d.trim()).filter(Boolean) })} aria-label="Allowed domains" />
        </Field>
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium">Credentials <span className="font-normal text-muted-foreground">(vault references — never the value itself)</span></p>
        {secretNames.map((name) => (
          <div key={name} className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] items-center gap-2" data-testid={`secret-${name}`}>
            <code className="truncate text-xs">{name}</code>
            {(["owner", "service", "key"] as const).map((k) => (
              <Input key={k} value={spec.secrets[name]![k]} aria-label={`${name} ${k}`} placeholder={k}
                onChange={(e) => set({ secrets: { ...spec.secrets, [name]: { ...spec.secrets[name]!, [k]: e.target.value } } })} />
            ))}
            {secretsSet[name] ? <Badge variant="secondary" className="text-micro font-normal">set</Badge> : <Badge variant="destructive" className="text-micro font-normal">not set</Badge>}
          </div>
        ))}
        <Button size="sm" variant="outline" onClick={() => {
          const name = secretNames.length ? `token_${secretNames.length + 1}` : "token";
          set({ secrets: { ...spec.secrets, [name]: { owner: "polpo-infra", service: spec.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), key: "token" } } });
        }}><Plus className="h-3.5 w-3.5" /> Add credential</Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field title="Auth">
          <select className={selectClass} value={spec.auth.type} aria-label="Auth type" onChange={(e) => {
            const t = e.target.value;
            set({ auth: t === "none" ? { type: "none" } : t === "bearer" ? { type: "bearer", secret: firstSecret } : t === "header" ? { type: "header", header: "X-API-Key", secret: firstSecret } : { type: "query", param: "api_key", secret: firstSecret } });
          }}>
            <option value="none">None</option><option value="bearer">Bearer token</option><option value="header">API key header</option><option value="query">API key query parameter</option>
          </select>
        </Field>
        {authSecrets(spec.auth).length > 0 && (
          <Field title="Credential">
            <select className={selectClass} value={authSecrets(spec.auth)[0]} aria-label="Auth credential" onChange={(e) => set({ auth: { ...(spec.auth as { type: "bearer"; secret: string }), secret: e.target.value } })}>
              {secretNames.map((n) => <option key={n}>{n}</option>)}
            </select>
          </Field>
        )}
        {spec.auth.type === "header" && <Field title="Header"><Input value={spec.auth.header} aria-label="Auth header" onChange={(e) => set({ auth: { ...(spec.auth as Extract<McpServerAuth, { type: "header" }>), header: e.target.value } })} /></Field>}
        {spec.auth.type === "query" && <Field title="Query parameter"><Input value={spec.auth.param} aria-label="Auth parameter" onChange={(e) => set({ auth: { ...(spec.auth as Extract<McpServerAuth, { type: "query" }>), param: e.target.value } })} /></Field>}
      </div>
      <JsonField title="npm dependencies" hint="(code tools; installed at publish with --ignore-scripts, 100 MB cap)" value={spec.dependencies} onChange={(v) => set({ dependencies: v as Record<string, string> })} rows={2} />
      <JsonField title="Limits" hint="(timeoutMs, maxResponseBytes, maxResultChars, retries, memoryMb, concurrency, idleMs, depsMaxMb)" value={spec.limits} onChange={(v) => set({ limits: v as never })} rows={2} />
    </div>
  );
}

/** The values this server runs with: its settings (no new version needed) and its secrets, written to the vault. */
function ServerValues({ server, saveSecret, saveSettings, focus, busy }: {
  server: McpHostedServer; focus?: string; busy: boolean;
  saveSecret: (name: string, value: string) => Promise<void>;
  saveSettings: (values: Record<string, string | number | boolean | null>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, SettingValue>>(() => ({ ...(server.settings ?? {}) }));
  const spec = server.draft?.spec ?? server.productionSpec;
  const secretNames = Object.keys(spec?.secrets ?? {});
  if (!server.settingsSchema?.length && !secretNames.length) return null;
  return (
    <div className="space-y-4" data-testid="server-values">
      {server.settingsSchema?.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm font-medium">Settings <span className="font-normal text-muted-foreground">(used at once, no new version)</span></p>
          {server.settingsSchema.map((f) => (
            <SettingInput key={f.key} field={f} value={values[f.key]} disabled={busy} onChange={(v) => setValues((x) => ({ ...x, [f.key]: v }))} />
          ))}
          <Button size="sm" disabled={busy} onClick={() => void saveSettings(settingsPayload(values, server.settings ?? {}))}><Save className="h-3.5 w-3.5" /> Save settings</Button>
        </div>
      )}
      {secretNames.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm font-medium">Secrets <span className="font-normal text-muted-foreground">(written to the vault; never shown)</span></p>
          {secretNames.map((name) => {
            const info = server.templateInfo?.secrets[name];
            return (
              <div key={name} className="space-y-1.5">
                <SecretInput name={name} label={info?.label ?? name} isSet={!!server.secrets[name]} focus={focus === `secret:${name}`} disabled={busy}
                  onSave={(v) => saveSecret(name, v)} />
                {info && <SecretHelp info={info} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TestTab({ spec, test, runTests, saveTest }: {
  spec: McpServerSpec;
  test: (req: { tool: string; input?: Record<string, unknown>; confirm?: boolean }) => Promise<McpToolTestResult>;
  runTests: () => Promise<{ results: McpToolTestResult[]; passed: number; failed: number; skipped: number }>;
  saveTest: (tool: string, input: Record<string, unknown>) => Promise<void>;
}) {
  const [toolName, setToolName] = useState(spec.tools[0]?.name ?? "");
  const tool = spec.tools.find((t) => t.name === toolName);
  const [input, setInput] = useState(() => pretty(spec.tools[0] ? sampleInput(spec.tools[0].inputSchema) : {}));
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<McpToolTestResult | null>(null);
  const [suite, setSuite] = useState<{ results: McpToolTestResult[]; passed: number; failed: number; skipped: number } | null>(null);
  const pick = (name: string) => {
    const next = spec.tools.find((t) => t.name === name);
    setToolName(name);
    setInput(pretty(next ? sampleInput(next.inputSchema) : {}));
    setResult(null);
    setConfirm(false);
  };
  const parsed = parseJson<Record<string, unknown>>(input);
  return (
    <div className="space-y-4">
      <Field title="Tool">
        <select className={selectClass} value={toolName} onChange={(e) => pick(e.target.value)} aria-label="Tool to test">
          {spec.tools.map((t) => <option key={t.name}>{t.name}</option>)}
        </select>
      </Field>
      {tool && <SchemaPreview schema={tool.inputSchema} />}
      <Field title="Input"><Textarea rows={6} value={input} onChange={(e) => setInput(e.target.value)} className="font-mono text-xs" aria-label="Test input" /></Field>
      {tool && isSensitive(tool) && (
        <label className="flex items-start gap-2 text-sm">
          <Checkbox checked={confirm} onCheckedChange={(v) => setConfirm(v === true)} aria-label="Really run it" />
          <span><AlertTriangle className="mr-1 inline h-3.5 w-3.5 text-destructive" />This tool changes things (or needs approval): without this box it is a dry run that only shows the request.</span>
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !tool || !parsed.ok} onClick={async () => {
          setBusy(true);
          try { setResult(await test({ tool: toolName, input: (parsed.ok ? parsed.value : {}) ?? {}, confirm })); } catch (reason) { toast.error(errorText(reason)); } finally { setBusy(false); }
        }}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Run</Button>
        <Button variant="outline" disabled={!tool || !parsed.ok} onClick={() => void saveTest(toolName, (parsed.ok ? parsed.value : {}) ?? {}).then(() => toast.success("Saved as a test case")).catch((r) => toast.error(errorText(r)))}>
          <Save className="h-4 w-4" /> Save as test case
        </Button>
        <Button variant="outline" disabled={busy} onClick={async () => {
          setBusy(true);
          try { setSuite(await runTests()); } catch (reason) { toast.error(errorText(reason)); } finally { setBusy(false); }
        }}><FlaskConical className="h-4 w-4" /> Run saved tests</Button>
      </div>
      {result && (
        <div className="space-y-2 text-sm" data-testid="test-result">
          <p className={cn("font-medium", result.ok ? "text-foreground" : "text-destructive")}>
            {result.skipped ? `Not sent: ${result.skipped}` : result.ok ? `OK in ${result.ms} ms${result.status ? ` · HTTP ${result.status}` : ""}` : `Failed in ${result.ms} ms: ${result.error}`}
          </p>
          {result.request && (
            <pre className="max-h-48 overflow-auto rounded-md border p-2 font-mono text-xs" aria-label="Request">{`${result.request.method} ${result.request.url}\n${Object.entries(result.request.headers).map(([k, v]) => `${k}: ${v}`).join("\n")}${result.request.body ? `\n\n${result.request.body}` : ""}`}</pre>
          )}
          {(result.response || result.text) && <pre className="max-h-72 overflow-auto rounded-md border p-2 font-mono text-xs" aria-label="Response">{result.ok ? result.text : result.response ?? result.text}</pre>}
        </div>
      )}
      {suite && (
        <div className="space-y-1 text-sm" data-testid="test-suite">
          <p className="font-medium">{suite.passed} passed · {suite.failed} failed · {suite.skipped} skipped</p>
          {suite.results.map((r, i) => (
            <p key={i} className={cn("text-xs", r.passed === false && !r.skipped ? "text-destructive" : "text-muted-foreground")}>
              {r.tool}: {r.skipped ? `skipped (${r.skipped})` : r.passed ? `ok (${r.ms} ms)` : `failed: ${r.error ?? "unexpected result"}`}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export function HostedServerSheet({ id, open, onOpenChange, onOpenConnector }: {
  id: string | null; open: boolean; onOpenChange: (open: boolean) => void;
  /** Open the connector it became (who can use it, per-tool policy): the connector sheet. */
  onOpenConnector?: (connectorId: string) => void;
}) {
  const s = useMcpServer(id ?? undefined);
  const product = productName(useInstanceBranding());
  // ?focus=secret:<name> (a setup link from MCP / Polpo's chat): open on the secret's input
  const [focus] = useState(() => (typeof window === "undefined" ? undefined : new URLSearchParams(window.location.search).get("focus") ?? undefined));
  const server = s.server;
  // edits in progress (null: the saved draft)
  const [edited, setEdited] = useState<McpServerSpec | null>(null);
  const spec = edited ?? server?.draft?.spec ?? null;
  const dirty = edited !== null;
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState<McpServerDiff | null>(null);
  const [note, setNote] = useState("");
  const [bump, setBump] = useState<"" | "major" | "minor" | "patch">("");
  const [deployNow, setDeployNow] = useState(true);
  const [logs, setLogs] = useState<McpServerCallLog[]>([]);
  const [pending, setPending] = useState<McpPendingCall[]>([]);
  const [confirm, setConfirm] = useState<null | "public" | "delete" | { rollback: true } | { deploy: string }>(null);
  // a deploy the required suite (the saved tests' gate) blocked: why, and "Deploy anyway…" (admins)
  const [blocked, setBlocked] = useState<{ version: string; reason: string; failures: string[]; runId?: string } | null>(null);
  const [overrideFor, setOverrideFor] = useState<{ version: string; failed: string[] } | null>(null);
  const [tab, setTab] = useState<string | undefined>(undefined);
  const deploy = async (version: string) => {
    setBusy(true);
    try {
      const d = await s.deploy(version);
      setBlocked(null);
      toast.success(`Deployed ${version}${d.gate?.decision === "pass" ? ": the suite passed" : ""}`);
    } catch (reason) {
      const e = reason as { code?: string; details?: { runId?: string; failures?: string[] }; message?: string };
      if (e.code === "GATE_BLOCKED") {
        setBlocked({ version, reason: e.message ?? "Blocked by the suite", failures: e.details?.failures ?? [], ...(e.details?.runId ? { runId: e.details.runId } : {}) });
        toast.error(`${version} was not deployed: the suite failed`);
      } else toast.error(errorText(reason));
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!id || !server) return;
    void s.diff({ to: "draft" }).then(setDiff).catch(() => setDiff(null));
  }, [id, server?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (next: McpServerSpec) => setEdited(next);
  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); toast.success(what); } catch (reason) { toast.error(errorText(reason)); } finally { setBusy(false); }
  };
  const saveDraft = () => act("Draft saved", async () => {
    if (!spec) return;
    const r = await s.saveDraft(spec);
    setEdited(null);
    if (r.problems.length) toast.warning(`Before publishing: ${r.problems.join("; ")}`);
  });
  const toolNames = useMemo(() => spec?.tools.map((t) => t.name) ?? [], [spec]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-3xl">
        {/* the connector sheet's header: icon, name, what it is, then the status pill and its actions */}
        <SheetHeader className="border-b">
          <div className="flex items-center gap-3 pr-6">
            <ConnectorIcon name={server?.name ?? "Server"} {...(server ? hostedServerIconFor(server) : {})} size="lg" />
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate">{server?.name ?? "Server"}</SheetTitle>
              <SheetDescription className="line-clamp-2">
                {server ? (
                  <>
                    {server.production ? hostedLabel(product, server.production) : "Draft, not published yet"}
                    {server.connectorId ? ` · connector ${server.connectorId}` : ""}
                    {server.publicUrl ? <> · <span className="font-mono">{server.publicUrl}</span></> : ""}
                  </>
                ) : "Loading…"}
              </SheetDescription>
            </div>
          </div>
          {server && (
            <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="hosted-server-status">
              <HostedStatusPill pill={serverPill(server)} />
              <span className="text-xs text-muted-foreground">{server.toolCount} tools</span>
              {server.connectorId && onOpenConnector && (
                <Button size="sm" variant="ghost" className="ml-auto h-7 gap-1 px-2 text-xs" onClick={() => onOpenConnector(server.connectorId!)}>
                  <Users className="h-3.5 w-3.5" /> Who can use it
                </Button>
              )}
            </div>
          )}
        </SheetHeader>
        {!server || !spec ? (
          <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
        ) : (
          <div className="space-y-4 p-4">
            {(server.draft?.problems.length ?? 0) > 0 && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert" data-testid="draft-problems">
                <p className="font-medium">Before publishing</p>
                <ul className="list-disc pl-5">{server.draft!.problems.map((p) => <li key={p}>{p}</li>)}</ul>
              </div>
            )}
            <Tabs value={tab ?? (focus?.startsWith("secret:") ? "settings" : "tools")} onValueChange={setTab} className="gap-4">
              <TabsList>
                <TabsTrigger value="tools"><Wrench className="h-3.5 w-3.5" /> Tools</TabsTrigger>
                <TabsTrigger value="settings"><Settings2 className="h-3.5 w-3.5" /> Settings</TabsTrigger>
                <TabsTrigger value="test"><FlaskConical className="h-3.5 w-3.5" /> Test</TabsTrigger>
                <TabsTrigger value="suite" data-testid="hosted-suite-tab"><FlaskRound className="h-3.5 w-3.5" /> Suite</TabsTrigger>
                <TabsTrigger value="versions"><History className="h-3.5 w-3.5" /> Versions</TabsTrigger>
                <TabsTrigger value="logs" onClick={() => { void s.logs(100).then(setLogs); void s.pending().then(setPending); }}><ScrollText className="h-3.5 w-3.5" /> Logs</TabsTrigger>
              </TabsList>

              <TabsContent value="tools">
                <div>
                  {spec.tools.map((t, i) => (
                    <ToolEditor key={i} tool={t}
                      onChange={(next) => edit({ ...spec, tools: spec.tools.map((x, j) => (j === i ? next : x)) })}
                      onRemove={() => edit({ ...spec, tools: spec.tools.filter((_, j) => j !== i) })} />
                  ))}
                </div>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => edit({ ...spec, tools: [...spec.tools, blankTool("http", toolNames)] })}><Plus className="h-3.5 w-3.5" /> HTTP tool</Button>
                  <Button size="sm" variant="outline" onClick={() => edit({ ...spec, tools: [...spec.tools, blankTool("code", toolNames)] })}><Plus className="h-3.5 w-3.5" /> Code tool</Button>
                </div>
              </TabsContent>

              <TabsContent value="settings" className="space-y-6">
                <ServerValues server={server} busy={busy} focus={focus}
                  saveSecret={(name, value) => act("Saved to the vault", () => s.saveSecret(name, value))}
                  saveSettings={(values) => act("Settings saved", () => s.updateSettings({ settings: values }))} />
                <SettingsTab spec={spec} onChange={edit} secretsSet={server.secrets} />
                <div className="space-y-3 border-t pt-4">
                  <p className="text-sm font-medium">Visibility</p>
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <Button size="sm" variant={server.visibility === "private" ? "default" : "outline"} disabled={busy}
                      onClick={() => void act("Private", () => s.updateSettings({ visibility: "private" }))}>Private (this instance)</Button>
                    <Button size="sm" variant={server.visibility === "public" ? "default" : "outline"} disabled={busy || server.visibility === "public"}
                      onClick={() => setConfirm("public")}><Globe className="h-3.5 w-3.5" /> Public</Button>
                  </div>
                  {server.visibility === "public" && (
                    <p className="flex gap-2 text-xs text-destructive" role="note">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      Anyone with {server.publicUrl ?? "the URL"} can call its tools with this instance's credentials ({server.rateLimits.perIpPerMinute}/min per address, {server.rateLimits.globalPerMinute}/min in all). Destructive and approval tools stay off unless a tool allows it.
                    </p>
                  )}
                  <Switch checked={!!server.disabled} label="Kill switch: refuse every call" disabled={busy}
                    onChange={(v) => void act(v ? "Switched off" : "Switched on", () => s.updateSettings({ disabled: v }))} />
                  <Switch checked={server.onTestFailure === "block"} label="Block publishing when a saved test fails" disabled={busy}
                    onChange={(v) => void act("Saved", () => s.updateSettings({ onTestFailure: v ? "block" : "warn" }))} />
                </div>
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirm("delete")}><Trash2 className="h-3.5 w-3.5" /> Delete server</Button>
              </TabsContent>

              <TabsContent value="test">
                <TestTab spec={spec} test={s.test} runTests={() => s.runTests()}
                  saveTest={(tool, input) => s.saveTests([...server.tests, { tool, input }])} />
              </TabsContent>

              <TabsContent value="suite">
                {id && <TargetSuitesPanel kind="mcp-server" id={id} />}
              </TabsContent>

              <TabsContent value="versions" className="space-y-4">
                {diff && <AgentVersionDiffView diff={diff} />}
                <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
                  <Field title="Bump">
                    <select className={selectClass} value={bump} onChange={(e) => setBump(e.target.value as typeof bump)} aria-label="Bump">
                      <option value="">Suggested{diff?.suggestedBump ? ` (${diff.suggestedBump})` : ""}</option><option value="major">Major</option><option value="minor">Minor</option><option value="patch">Patch</option>
                    </select>
                  </Field>
                  <Field title="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed" aria-label="Publish note" /></Field>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-sm"><Checkbox checked={deployNow} onCheckedChange={(v) => setDeployNow(v === true)} /> Deploy it too</label>
                  <Button disabled={busy || dirty || (server.draft?.problems.length ?? 0) > 0} onClick={() => void act("Published", async () => {
                    const r = await s.publish({ ...(bump ? { bump } : {}), ...(note ? { note } : {}), deploy: deployNow });
                    setNote("");
                    if (r.deployBlocked) {
                      setBlocked({ version: r.version, ...r.deployBlocked });
                      toast.warning(`Published ${r.version}, not deployed: the suite failed`);
                    } else setBlocked(null);
                    return r;
                  })}><Rocket className="h-4 w-4" /> Publish</Button>
                  {dirty && <span className="text-xs text-muted-foreground">Save the draft first</span>}
                  {server.production && <Button variant="outline" disabled={busy} onClick={() => setConfirm({ rollback: true })}><RotateCcw className="h-4 w-4" /> Roll back</Button>}
                </div>
                {blocked && (
                  <div className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm" data-testid="hosted-gate-blocked">
                    <p className="flex items-center gap-1.5 font-medium text-destructive"><ShieldAlert className="h-4 w-4" /> {blocked.version} was not deployed: blocked by the suite</p>
                    {blocked.failures.length > 0
                      ? <ul className="space-y-0.5 text-xs text-destructive">{blocked.failures.map((f, i) => <li key={i}>✗ {f}</li>)}</ul>
                      : <p className="text-xs text-destructive">{blocked.reason}</p>}
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button size="sm" variant="outline" className="h-7" onClick={() => setTab("suite")}>Open the suite</Button>
                      <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => setOverrideFor({ version: blocked.version, failed: blocked.failures })} data-testid="hosted-gate-override">
                        <ShieldAlert className="mr-1 h-3.5 w-3.5" /> Deploy anyway…
                      </Button>
                    </div>
                  </div>
                )}
                <div className="space-y-1" aria-label="Versions">
                  {s.versions.map((v) => (
                    <div key={v.version} className="flex items-center gap-2 border-b py-2 text-sm last:border-b-0">
                      <code className="font-medium">{v.version}</code>
                      {v.production && <Badge className="text-micro">production</Badge>}
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{v.note ?? v.changes.map((c) => `${c.kind} ${c.field}`).join(", ")} · {v.author}</span>
                      {!v.production && <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => setConfirm({ deploy: v.version })}>Deploy</Button>}
                    </div>
                  ))}
                </div>
                {s.deploys.length > 0 && (
                  <div className="space-y-1 text-xs text-muted-foreground" aria-label="Deploy history">
                    {s.deploys.map((d) => (
                      <p key={d.id} data-testid="hosted-deploy-entry">
                        {new Date(d.at).toLocaleString()} · {d.action} {d.from ?? "∅"} → {d.to} · {d.actor}
                        {d.gate?.decision === "pass" && <span className="text-success"> · <ShieldCheck className="inline h-3 w-3" /> suite passed</span>}
                        {d.gate?.decision === "override" && <span className="text-warning"> · <ShieldAlert className="inline h-3 w-3" /> override by {d.gate.by ?? d.actor}{d.gate.reason ? `: ${d.gate.reason}` : ""}</span>}
                      </p>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="logs" className="space-y-3">
                {pending.length > 0 && (
                  <div className="space-y-1 text-sm">
                    <p className="font-medium">Calls needing approval</p>
                    {pending.map((p) => <p key={p.id} className="text-xs text-muted-foreground">{new Date(p.requestedAt).toLocaleString()} · {p.tool} · {p.status}{p.result?.error ? ` — ${p.result.error}` : ""}</p>)}
                  </div>
                )}
                {logs.length === 0 ? <p className="text-sm text-muted-foreground">No calls yet.</p> : logs.map((l, i) => (
                  <p key={i} className={cn("text-xs", l.ok ? "text-muted-foreground" : "text-destructive")}>
                    {new Date(l.at).toLocaleString()} · {l.tool} · {l.source}{l.version ? ` v${l.version}` : ""} · {l.ok ? "ok" : l.error} · {l.ms} ms{l.ip ? ` · ${l.ip}` : ""}
                  </p>
                ))}
              </TabsContent>
            </Tabs>
            {dirty && (
              <div className="sticky bottom-0 flex items-center gap-2 border-t bg-background py-3">
                <span className="text-sm text-muted-foreground">Unsaved changes to the draft</span>
                <Button variant="outline" className="ml-auto" onClick={() => setEdited(null)}>Undo</Button>
                <Button disabled={busy} onClick={() => void saveDraft()}><Save className="h-4 w-4" /> Save draft</Button>
              </div>
            )}
          </div>
        )}
        <ConfirmDialog
          open={confirm !== null}
          onOpenChange={(o) => { if (!o) setConfirm(null); }}
          title={confirm === "public" ? "Make it public?" : confirm === "delete" ? "Delete this server?" : confirm && typeof confirm === "object" && "rollback" in confirm ? "Roll back?" : "Deploy this version?"}
          description={confirm === "public"
            ? `Anyone with the URL will be able to call its tools with this instance's credentials, within the rate limits. Destructive and approval tools stay off.`
            : confirm === "delete" ? "Its versions, logs and the connector it became are removed; agents lose its tools."
            : confirm && typeof confirm === "object" && "rollback" in confirm ? "Production goes back to the version deployed before."
            : "Its connector serves this version from now on."}
          destructive={confirm === "public" || confirm === "delete"}
          confirmLabel={confirm === "public" ? "Make public" : confirm === "delete" ? "Delete" : "Confirm"}
          onConfirm={() => {
            const c = confirm;
            setConfirm(null);
            if (c === "public") void act("Public", () => s.updateSettings({ visibility: "public" }));
            else if (c === "delete") void act("Deleted", async () => { await s.remove(); onOpenChange(false); });
            else if (c && "rollback" in c) void act("Rolled back", () => s.rollback());
            else if (c && "deploy" in c) void deploy(c.deploy);
          }}
        />
        <OverrideDialog target={overrideFor} onOpenChange={(o) => { if (!o) setOverrideFor(null); }}
          onConfirm={async (reason) => {
            const version = overrideFor!.version;
            await s.deploy(version, undefined, { override: { reason } });
            setBlocked(null);
            toast.success(`Deployed ${version} with an override`);
          }} />
      </SheetContent>
    </Sheet>
  );
}
