/**
 * Settings → Harnesses: the official agent runtimes (Claude Code, Codex) agents may run on, and how
 * they authenticate: an API key, Bedrock, Vertex, the Vercel AI Gateway or a model gateway
 * (presets: Cloudflare, OpenRouter, LiteLLM, Portkey, Kong, custom). Credentials are vault
 * references (the picker; the key itself is added in an agent's Credentials tab). A Claude
 * subscription is not offered (Anthropic's terms). "Test connection" (and every save) sends one
 * tiny model request from the Polpo server and shows the result. Below: the harness sessions.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, PlugZap, RefreshCw, Save, ShieldCheck, Square, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { VaultRefPicker } from "@/components/vault/vault-ref-picker";
import { BrandIcon } from "@/components/shared/brand-icon";
import { authBrand, computerBrand } from "@/lib/run-context";
import {
  CLAUDE_CODE_AUTH_LABELS, CODEX_AUTH_LABELS, HARNESS_NAMES, harnessesApi, settingsFromOverview, TEST_ERROR_LABELS,
  type ClaudeCodeAuth, type CodexAuth, type HarnessGateway, type HarnessesOverview, type HarnessesSettings, type HarnessId, type HarnessSession, type HarnessTestResult,
} from "@/lib/harnesses-api";
import { HarnessGatewayFields } from "./harness-gateway-fields";

const isGateway = (auth: string | undefined): auth is "ai-gateway" | "gateway" => auth === "ai-gateway" || auth === "gateway";

/** A gateway as the server takes it: empty headers and model slots dropped; the AI Gateway keeps its two fields. */
function cleanGateway(auth: "ai-gateway" | "gateway", g: HarnessGateway | undefined): HarnessGateway | undefined {
  if (!g) return undefined;
  if (auth === "ai-gateway") return { ...(g.baseUrl ? { baseUrl: g.baseUrl } : {}), ...(g.credentialRef ? { credentialRef: g.credentialRef } : {}) };
  const out: HarnessGateway = { ...g };
  const headers = (g.headers ?? []).filter((h) => h.name).map(({ credentialFound: _f, ...h }) => h);
  if (headers.length) out.headers = headers; else delete out.headers;
  if (g.models) {
    const m = Object.fromEntries(Object.entries(g.models).filter(([, v]) => !!v)) as NonNullable<HarnessGateway["models"]>;
    if (m.main) out.models = m; else delete out.models;
  }
  if (out.authScheme === "none") delete out.credentialRef;
  return out;
}

/** The form as the server takes it (incomplete harness settings left out). */
export function cleanHarnessSettings(form: HarnessesSettings): HarnessesSettings {
  const out: HarnessesSettings = { ...form };
  const cc = out["claude-code"] ? { ...out["claude-code"] } : undefined;
  if (cc) {
    if (isGateway(cc.auth)) { cc.gateway = cleanGateway(cc.auth, cc.gateway); delete cc.credentialRef; } else delete cc.gateway;
    if (cc.auth !== "bedrock") delete cc.bedrock;
    if (cc.auth !== "vertex") delete cc.vertex;
    if (isGateway(cc.auth) ? !cc.gateway : !cc.credentialRef) delete out["claude-code"]; else out["claude-code"] = cc;
  }
  const cx = out.codex ? { ...out.codex } : undefined;
  if (cx) {
    if (isGateway(cx.auth)) { cx.gateway = cleanGateway(cx.auth, cx.gateway); delete cx.credentialRef; } else delete cx.gateway;
    if (isGateway(cx.auth) ? !cx.gateway : !cx.credentialRef) delete out.codex; else out.codex = cx;
  }
  return out;
}

/** A connection test's result, in one line. */
export function HarnessTestLine({ result }: { result: HarnessTestResult | "running" | undefined }) {
  if (!result) return null;
  if (result === "running") return <p className="flex items-center gap-1.5 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Testing the connection from the Polpo server…</p>;
  return result.ok ? (
    <p className="flex items-start gap-1.5 text-success" data-testid={`harness-test-${result.harness}`}>
      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>Connected in {result.latencyMs} ms{result.model ? ` · ${result.model}` : ""}{result.endpoint ? ` · ${result.endpoint}` : ""}{result.note ? ` · ${result.note}` : ""}</span>
    </p>
  ) : (
    <p className="flex items-start gap-1.5 text-destructive" data-testid={`harness-test-${result.harness}`} role="alert">
      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{result.errorKind ? `${TEST_ERROR_LABELS[result.errorKind]}: ` : ""}{result.error ?? "The test failed"}</span>
    </p>
  );
}

const selectClass = "h-8 rounded-md border bg-transparent px-2 text-xs";

export function HarnessesSection() {
  const [overview, setOverview] = useState<HarnessesOverview | null>(null);
  const [form, setForm] = useState<HarnessesSettings | null>(null);
  const [sessions, setSessions] = useState<HarnessSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState<string | null>(null);
  const [tests, setTests] = useState<Partial<Record<HarnessId, HarnessTestResult | "running">>>({});

  const runTest = useCallback(async (id: HarnessId, settings?: HarnessesSettings) => {
    setTests((t) => ({ ...t, [id]: "running" }));
    try {
      const r = await harnessesApi.test(id, settings ? { settings } : {});
      setTests((t) => ({ ...t, [id]: r }));
    } catch (e) {
      setTests((t) => ({ ...t, [id]: { ok: false, harness: id, latencyMs: 0, errorKind: "config", error: (e as Error).message } }));
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const o = await harnessesApi.overview();
      setOverview(o);
      setForm(settingsFromOverview(o));
      setSessions(await harnessesApi.sessions());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
        {error}
        <Button size="sm" variant="outline" className="ml-auto h-7" onClick={() => void load()}>Retry</Button>
      </div>
    );
  }
  if (!overview || !form) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>;

  const toggle = (id: HarnessId, on: boolean) => setForm({ ...form, enabled: on ? [...new Set([...form.enabled, id])] : form.enabled.filter((x) => x !== id) });
  const cc = form["claude-code"];
  const setCc = (patch: Partial<NonNullable<HarnessesSettings["claude-code"]>>) =>
    setForm({ ...form, "claude-code": { auth: "api-key", ...(cc ?? {}), ...patch } });
  const cx = form.codex;
  const setCx = (patch: Partial<NonNullable<HarnessesSettings["codex"]>>) =>
    setForm({ ...form, codex: { auth: "api-key", ...(cx ?? {}), ...patch } });

  const save = async () => {
    setSaving(true);
    try {
      const out = cleanHarnessSettings(form);
      await harnessesApi.save(out);
      toast.success("Harness settings saved");
      await load();
      // every save is checked: one tiny model request per enabled harness, from the Polpo server
      for (const id of out.enabled) if (out[id]) void runTest(id);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const testButton = (id: HarnessId) => (
    <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={tests[id] === "running" || !cleanHarnessSettings(form)[id]}
      onClick={() => void runTest(id, cleanHarnessSettings(form))} aria-label={`Test ${HARNESS_NAMES[id]} connection`}>
      <PlugZap className="h-3 w-3" /> Test connection
    </Button>
  );
  const brokeringNote = (id: HarnessId) => {
    const b = overview.harnesses.find((h) => h.id === id)?.brokering;
    if (!b) return null;
    return b === "relay"
      ? <p className="flex items-center gap-1.5 text-micro text-muted-foreground"><ShieldCheck className="h-3.5 w-3.5 text-success" /> The key stays on the Polpo server: the computer gets a placeholder, Polpo's model relay adds the key.</p>
      : b === "in-vm"
        ? <p className="flex items-center gap-1.5 text-micro text-warning"><AlertTriangle className="h-3.5 w-3.5" /> The key goes into the computer: set POLPO_PUBLIC_URL so Polpo's model relay can keep it on the server.</p>
        : <p className="text-micro text-muted-foreground">Bedrock and Vertex sign each request in the computer, so their credentials go there; put a gateway in front to keep them out.</p>;
  };

  const item = (id: HarnessId) => overview.harnesses.find((h) => h.id === id);

  return (
    <div className="space-y-4" data-testid="harnesses-section">
      <p className="text-sm text-muted-foreground">
        Agents can run on an official agent runtime instead of Polpo's engine: Claude Code or Codex, inside the agent's computer
        (a Daytona v2 VM), with Polpo's tools available to it. Choose it per agent in its Computer tab. Usage is billed by the
        provider of the credential you choose here.
      </p>
      {overview.relay && !overview.relay.available && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-warning" role="status" data-testid="harness-relay-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{overview.relay.warning}</span>
        </div>
      )}

      {/* Claude Code */}
      <Card className="gap-0 py-0"><CardContent className="space-y-3 px-4 py-3 text-xs">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={form.enabled.includes("claude-code")} onChange={(e) => toggle("claude-code", e.target.checked)} aria-label="Enable Claude Code" />
          <BrandIcon name="claude-code" size={18} /> Claude Code
          {item("claude-code")?.agents.length ? <Badge variant="secondary" className="text-micro">{item("claude-code")!.agents.join(", ")}</Badge> : null}
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              Authentication <BrandIcon name={authBrand(cc?.auth ?? "api-key", "claude-code")} size={14} />
            </span>
            <select className={`${selectClass} w-full`} aria-label="Claude Code authentication" value={cc?.auth ?? "api-key"}
              onChange={(e) => setCc({ auth: e.target.value as ClaudeCodeAuth, ...(e.target.value === "gateway" && !cc?.gateway?.format ? { gateway: { preset: "custom", format: "anthropic", authScheme: "bearer" } } : {}) })}>
              {(Object.keys(CLAUDE_CODE_AUTH_LABELS) as ClaudeCodeAuth[]).map((a) => <option key={a} value={a}>{CLAUDE_CODE_AUTH_LABELS[a]}</option>)}
            </select>
          </label>
          {!isGateway(cc?.auth) && (
            <label className="space-y-1">
              <span className="text-muted-foreground">Credential (vault entry)</span>
              <VaultRefPicker
                value={cc?.credentialRef}
                onChange={(ref) => setCc({ credentialRef: ref ?? undefined })}
                requiredKeys={cc?.auth === "vertex" ? [] : ["apiKey"]}
                aria-label="Claude Code credential"
                data-setup-field="claude-code-credential"
              />
            </label>
          )}
          {cc?.auth === "bedrock" && (
            <label className="space-y-1">
              <span className="text-muted-foreground">AWS region</span>
              <Input className="h-8 text-xs" placeholder="us-east-1" value={cc.bedrock?.region ?? ""} onChange={(e) => setCc({ bedrock: { region: e.target.value.trim() } })} aria-label="Bedrock region" />
            </label>
          )}
          {cc?.auth === "vertex" && (
            <>
              <label className="space-y-1">
                <span className="text-muted-foreground">Google Cloud project</span>
                <Input className="h-8 text-xs" value={cc.vertex?.projectId ?? ""} onChange={(e) => setCc({ vertex: { region: cc.vertex?.region ?? "", projectId: e.target.value.trim() } })} aria-label="Vertex project" />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground">Region</span>
                <Input className="h-8 text-xs" placeholder="us-east5" value={cc.vertex?.region ?? ""} onChange={(e) => setCc({ vertex: { projectId: cc.vertex?.projectId ?? "", region: e.target.value.trim() } })} aria-label="Vertex region" />
              </label>
            </>
          )}
          {cc?.auth !== "gateway" && (
            <label className="space-y-1">
              <span className="text-muted-foreground">Default model (optional)</span>
              <Input className="h-8 text-xs" placeholder={cc?.auth === "bedrock" ? "us.anthropic.claude-sonnet-4-5-20250929-v1:0" : cc?.auth === "ai-gateway" ? "anthropic/claude-sonnet-4.5" : "claude-sonnet-4-5"} value={cc?.model ?? ""}
                onChange={(e) => setCc({ model: e.target.value.trim() || undefined })} aria-label="Claude Code model" />
            </label>
          )}
        </div>
        {isGateway(cc?.auth) && <HarnessGatewayFields harness="claude-code" auth={cc!.auth as "ai-gateway" | "gateway"} value={cc!.gateway} onChange={(gateway) => setCc({ gateway })} />}
        {brokeringNote("claude-code")}
        <div className="flex flex-wrap items-center gap-2">{testButton("claude-code")}<HarnessTestLine result={tests["claude-code"]} /></div>
        {item("claude-code")?.credentialRef && item("claude-code")?.credentialFound === false && (
          <p className="flex items-center gap-1.5 text-warning"><AlertTriangle className="h-3.5 w-3.5" /> The vault entry does not exist yet: add it in that agent's Credentials tab.</p>
        )}
        <p className="text-micro text-muted-foreground">A Claude subscription (Pro/Max sign-in) cannot be used: Anthropic's terms do not allow it for agents that serve other people.</p>
      </CardContent></Card>

      {/* Codex */}
      <Card className="gap-0 py-0"><CardContent className="space-y-3 px-4 py-3 text-xs">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={form.enabled.includes("codex")} onChange={(e) => toggle("codex", e.target.checked)} aria-label="Enable Codex" />
          <BrandIcon name="codex" size={18} /> Codex
          {item("codex")?.agents.length ? <Badge variant="secondary" className="text-micro">{item("codex")!.agents.join(", ")}</Badge> : null}
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-muted-foreground">Authentication</span>
            <select className={`${selectClass} w-full`} aria-label="Codex authentication" value={cx?.auth ?? "api-key"}
              onChange={(e) => setCx({ auth: e.target.value as CodexAuth, ...(e.target.value === "gateway" && !cx?.gateway?.format ? { gateway: { preset: "custom", format: "openai-responses", authScheme: "bearer" } } : {}) })}>
              {(Object.keys(CODEX_AUTH_LABELS) as CodexAuth[]).map((a) => <option key={a} value={a}>{CODEX_AUTH_LABELS[a]}</option>)}
            </select>
          </label>
          {!isGateway(cx?.auth) && (
            <label className="space-y-1">
              <span className="flex items-center gap-1.5 text-muted-foreground">OpenAI API key (vault entry) <BrandIcon name="openai" size={14} /></span>
              <VaultRefPicker value={cx?.credentialRef} onChange={(ref) => setCx({ credentialRef: ref ?? undefined })}
                requiredKeys={["apiKey"]} aria-label="Codex credential" />
            </label>
          )}
          {cx?.auth !== "gateway" && (
            <label className="space-y-1">
              <span className="text-muted-foreground">Default model (optional)</span>
              <Input className="h-8 text-xs" placeholder={cx?.auth === "ai-gateway" ? "openai/gpt-5" : "gpt-5"} value={cx?.model ?? ""} onChange={(e) => setCx({ model: e.target.value.trim() || undefined })} aria-label="Codex model" />
            </label>
          )}
        </div>
        {isGateway(cx?.auth) && <HarnessGatewayFields harness="codex" auth={cx!.auth as "ai-gateway" | "gateway"} value={cx!.gateway} onChange={(gateway) => setCx({ gateway })} />}
        {brokeringNote("codex")}
        <div className="flex flex-wrap items-center gap-2">{testButton("codex")}<HarnessTestLine result={tests.codex} /></div>
        <p className="text-micro text-muted-foreground">Signing in with ChatGPT is not supported yet.</p>
      </CardContent></Card>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={!!form.allowHost} onChange={(e) => setForm({ ...form, allowHost: e.target.checked || undefined })} aria-label="Allow harnesses on this server" />
        Allow agents on this server (no remote computer) to use a harness, with an isolated home directory
      </label>

      <Button size="sm" onClick={() => void save()} disabled={saving}>
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save
      </Button>

      {/* Sessions */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-label text-muted-foreground">
          Harness sessions
          <Button size="icon" variant="ghost" className="ml-auto h-6 w-6" onClick={() => void load()} aria-label="Refresh sessions"><RefreshCw className="h-3 w-3" /></Button>
        </div>
        {sessions.length === 0 ? <p className="text-xs text-muted-foreground">No harness sessions yet.</p> : sessions.map((s) => (
          <div key={s.key} className="flex flex-wrap items-center gap-2 rounded-lg border p-2 text-xs" data-testid={`harness-session-${s.key}`}>
            <BrandIcon name={s.harness} size={16} />
            <code>{s.key}</code>
            <span className="inline-flex items-center gap-1">
              {s.agent} · {HARNESS_NAMES[s.harness]} on
              <BrandIcon name={s.computerId === "host" ? "host" : computerBrand({ kind: "daytona", provider: "daytona" })} size={12} />
              {s.computerId}
            </span>
            <Badge variant={s.state === "error" ? "destructive" : "secondary"} className="text-micro">{s.state}{s.live ? " · live" : ""}</Badge>
            <span className="text-muted-foreground">{s.turns} turn(s) · ${s.costUsd.toFixed(4)}{s.lastResumeAt ? ` · resumed ${new Date(s.lastResumeAt).toLocaleString()}` : ""}</span>
            <div className="ml-auto flex gap-1">
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={async () => {
                try { toast.success((await harnessesApi.control(s.key, "stop")).message); await load(); } catch (e) { toast.error((e as Error).message); }
              }}><Square className="h-3 w-3" /> Stop</Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive" onClick={() => setResetting(s.key)}><Trash2 className="h-3 w-3" /> Reset</Button>
            </div>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={!!resetting}
        onOpenChange={(open) => { if (!open) setResetting(null); }}
        title="Reset this harness session?"
        description="Its conversation is forgotten: the next run starts a new one."
        confirmLabel="Reset"
        destructive
        onConfirm={async () => {
          if (!resetting) return;
          try { toast.success((await harnessesApi.control(resetting, "reset")).message); await load(); } catch (e) { toast.error((e as Error).message); }
          setResetting(null);
        }}
      />
    </div>
  );
}
