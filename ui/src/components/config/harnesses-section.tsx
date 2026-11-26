/**
 * Settings → Harnesses: the official agent runtimes (Claude Code, Codex, OpenCode) agents may run
 * on, and how they authenticate: an API key, Bedrock, Vertex, the Vercel AI Gateway or a model
 * gateway (presets: Cloudflare, OpenRouter, LiteLLM, Portkey, Kong, custom). OpenCode runs any
 * model: a provider's API key (provider picker), a Bedrock API key (open-weight models on Bedrock),
 * a gateway; its logins and subscriptions are not offered. Credentials are vault
 * references (the picker; the key itself is added in an agent's Credentials tab). A Claude
 * subscription is not offered (Anthropic's terms). "Test connection" (and every save) sends one
 * tiny model request from the Polpo server and shows the result. Below: the CLI engine's accounts
 * (personal Claude Code / Codex sign-ins, cli-accounts-section.tsx) and the harness sessions.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, PlugZap, RefreshCw, Save, ShieldCheck, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { VaultRefPicker } from "@/components/vault/vault-ref-picker";
import { BrandIcon } from "@/components/shared/brand-icon";
import { EngineMark } from "@/components/shared/model-with-engine";
import { ProviderIcon } from "@/components/shared/provider-icon";
import { authBrand, computerBrand } from "@/lib/run-context";
import {
  CLAUDE_CODE_AUTH_LABELS, CODEX_AUTH_LABELS, HARNESS_NAMES, OPENCODE_AUTH_LABELS, OPENCODE_PROVIDERS, cleanHarnessSettings, harnessesApi, isGatewayAuth as isGateway,
  openCodeModelExample, settingsFromOverview,
  type ClaudeCodeAuth, type CodexAuth, type HarnessesOverview, type HarnessesSettings, type HarnessId, type HarnessSession, type HarnessTestResult,
  type OpenCodeAuth, type OpenCodeProviderId,
} from "@/lib/harnesses-api";
import { HarnessGatewayFields } from "./harness-gateway-fields";
import { HarnessTestLine } from "./harness-test-line";
import { CliAccountsSection } from "./cli-accounts-section";

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
  const oc = form.opencode;
  const setOc = (patch: Partial<NonNullable<HarnessesSettings["opencode"]>>) =>
    setForm({ ...form, opencode: { auth: "api-key", provider: "anthropic", ...(oc ?? {}), ...patch } });
  const ocAuth: OpenCodeAuth = oc?.auth ?? "api-key";
  const ocProviderMark = ocAuth === "bedrock" ? "amazon-bedrock" : ocAuth === "ai-gateway" ? "vercel" : ocAuth === "api-key" ? (oc?.provider ?? "anthropic") : undefined;

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
        : <p className="text-micro text-muted-foreground">Claude Code on Bedrock and Vertex signs each request in the computer, so their credentials go there; put a gateway in front to keep them out.</p>;
  };

  const item = (id: HarnessId) => overview.harnesses.find((h) => h.id === id);

  return (
    <div className="space-y-4" data-testid="harnesses-section">
      <p className="text-sm text-muted-foreground">
        Agents can run on an official agent runtime instead of Polpo's engine: Claude Code, Codex or OpenCode (any model, open-weight ones included), inside the agent's computer
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

      {/* OpenCode */}
      <Card className="gap-0 py-0" data-testid="harness-opencode"><CardContent className="space-y-3 px-4 py-3 text-xs">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={form.enabled.includes("opencode")} onChange={(e) => toggle("opencode", e.target.checked)} aria-label="Enable OpenCode" />
          <BrandIcon name="opencode" size={18} /> OpenCode
          {item("opencode")?.agents.length ? <Badge variant="secondary" className="text-micro">{item("opencode")!.agents.join(", ")}</Badge> : null}
        </label>
        <p className="text-micro text-muted-foreground">
          Any model OpenCode supports, open-weight ones included (Kimi, GLM, Qwen, DeepSeek on Bedrock or a gateway). Polpo writes OpenCode's
          provider settings itself: only the provider and credential chosen here.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              Authentication {ocProviderMark && <ProviderIcon name={ocProviderMark} size={14} />}
            </span>
            <select className={`${selectClass} w-full`} aria-label="OpenCode authentication" value={ocAuth}
              onChange={(e) => setOc({ auth: e.target.value as OpenCodeAuth, ...(e.target.value === "gateway" && !oc?.gateway?.format ? { gateway: { preset: "custom", format: "openai-chat", authScheme: "bearer" } } : {}) })}>
              {(Object.keys(OPENCODE_AUTH_LABELS) as OpenCodeAuth[]).map((a) => <option key={a} value={a}>{OPENCODE_AUTH_LABELS[a]}</option>)}
            </select>
          </label>
          {ocAuth === "api-key" && (
            <label className="space-y-1">
              <span className="text-muted-foreground">Provider</span>
              <select className={`${selectClass} w-full`} aria-label="OpenCode provider" value={oc?.provider ?? "anthropic"}
                onChange={(e) => setOc({ provider: e.target.value as OpenCodeProviderId })}>
                {OPENCODE_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          )}
          {!isGateway(ocAuth) && (
            <label className="space-y-1">
              <span className="text-muted-foreground">{ocAuth === "bedrock" ? "Bedrock API key (vault entry)" : "API key (vault entry)"}</span>
              <VaultRefPicker value={oc?.credentialRef} onChange={(ref) => setOc({ credentialRef: ref ?? undefined })}
                requiredKeys={["apiKey"]} aria-label="OpenCode credential" data-setup-field="opencode-credential" />
            </label>
          )}
          {ocAuth === "bedrock" && (
            <label className="space-y-1">
              <span className="text-muted-foreground">AWS region</span>
              <Input className="h-8 text-xs" placeholder="us-east-1" value={oc?.bedrock?.region ?? ""} onChange={(e) => setOc({ bedrock: { region: e.target.value.trim() } })} aria-label="OpenCode Bedrock region" />
            </label>
          )}
          {ocAuth !== "gateway" && (
            <label className="space-y-1">
              <span className="text-muted-foreground">Model</span>
              <Input className="h-8 text-xs" placeholder={openCodeModelExample(oc)} value={oc?.model ?? ""} onChange={(e) => setOc({ model: e.target.value.trim() || undefined })} aria-label="OpenCode model" />
            </label>
          )}
        </div>
        {isGateway(ocAuth) && <HarnessGatewayFields harness="opencode" auth={ocAuth as "ai-gateway" | "gateway"} value={oc?.gateway} onChange={(gateway) => setOc({ gateway })} />}
        {ocAuth === "ai-gateway" && (
          <label className="block max-w-sm space-y-1">
            <span className="text-muted-foreground">Model</span>
            <Input className="h-8 text-xs" placeholder={openCodeModelExample(oc)} value={oc?.model ?? ""} onChange={(e) => setOc({ model: e.target.value.trim() || undefined })} aria-label="OpenCode gateway model" />
          </label>
        )}
        {brokeringNote("opencode")}
        <div className="flex flex-wrap items-center gap-2">{testButton("opencode")}<HarnessTestLine result={tests.opencode} /></div>
        {item("opencode")?.credentialRef && item("opencode")?.credentialFound === false && (
          <p className="flex items-center gap-1.5 text-warning"><AlertTriangle className="h-3.5 w-3.5" /> The vault entry does not exist yet: add it in that agent's Credentials tab.</p>
        )}
        <p className="text-micro text-muted-foreground">
          {ocAuth === "bedrock" ? "Bedrock takes a Bedrock API key (bearer token): AWS access keys sign every request and would have to go into the computer. " : ""}
          Signing in with a subscription (ChatGPT, GitHub Copilot, OpenCode Zen, a Claude plan…) is not offered: only explicit credentials.
        </p>
      </CardContent></Card>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={!!form.allowHost} onChange={(e) => setForm({ ...form, allowHost: e.target.checked || undefined })} aria-label="Allow harnesses on this server" />
        Allow agents on this server (no remote computer) to use a harness, with an isolated home directory
      </label>

      <Button size="sm" onClick={() => void save()} disabled={saving}>
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save
      </Button>

      {/* The CLI engine: personal Claude Code / Codex sign-ins */}
      <CliAccountsSection />

      {/* Sessions */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-label text-muted-foreground">
          Harness sessions
          <Button size="icon" variant="ghost" className="ml-auto h-6 w-6" onClick={() => void load()} aria-label="Refresh sessions"><RefreshCw className="h-3 w-3" /></Button>
        </div>
        {sessions.length === 0 ? <p className="text-xs text-muted-foreground">No harness sessions yet.</p> : sessions.map((s) => (
          <div key={s.key} className="flex flex-wrap items-center gap-2 rounded-lg border p-2 text-xs" data-testid={`harness-session-${s.key}`}>
            <EngineMark engine={s.harness} size={16} className="font-medium" />
            <code>{s.key}</code>
            <span className="inline-flex items-center gap-1">
              {s.agent} on
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
