/**
 * Settings → Harnesses: the official agent runtimes (Claude Code, Codex) agents may run on, and how
 * they authenticate. Credentials are vault references (the picker; the key itself is added in an
 * agent's Credentials tab). A Claude subscription is not offered (Anthropic's terms); Codex takes
 * an OpenAI API key. Below: the harness sessions agents run, with stop / reset.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw, Save, Square, Trash2 } from "lucide-react";
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
  CLAUDE_CODE_AUTH_LABELS, HARNESS_NAMES, harnessesApi, settingsFromOverview,
  type ClaudeCodeAuth, type HarnessesOverview, type HarnessesSettings, type HarnessId, type HarnessSession,
} from "@/lib/harnesses-api";

const selectClass = "h-8 rounded-md border bg-transparent px-2 text-xs";

export function HarnessesSection() {
  const [overview, setOverview] = useState<HarnessesOverview | null>(null);
  const [form, setForm] = useState<HarnessesSettings | null>(null);
  const [sessions, setSessions] = useState<HarnessSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState<string | null>(null);

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
    setForm({ ...form, "claude-code": { auth: "api-key", credentialRef: undefined as never, ...(cc ?? {}), ...patch } });
  const cx = form.codex;

  const save = async () => {
    setSaving(true);
    try {
      const out: HarnessesSettings = { ...form };
      if (out["claude-code"] && !out["claude-code"].credentialRef) delete out["claude-code"];
      if (out.codex && !out.codex.credentialRef) delete out.codex;
      if (out["claude-code"]?.auth !== "bedrock" && out["claude-code"]) delete out["claude-code"].bedrock;
      if (out["claude-code"]?.auth !== "vertex" && out["claude-code"]) delete out["claude-code"].vertex;
      await harnessesApi.save(out);
      toast.success("Harness settings saved");
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const item = (id: HarnessId) => overview.harnesses.find((h) => h.id === id);

  return (
    <div className="space-y-4" data-testid="harnesses-section">
      <p className="text-sm text-muted-foreground">
        Agents can run on an official agent runtime instead of Polpo's engine: Claude Code or Codex, inside the agent's computer
        (a Daytona v2 VM), with Polpo's tools available to it. Choose it per agent in its Computer tab. Usage is billed by the
        provider of the credential you choose here.
      </p>

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
            <select className={`${selectClass} w-full`} aria-label="Claude Code authentication" value={cc?.auth ?? "api-key"} onChange={(e) => setCc({ auth: e.target.value as ClaudeCodeAuth })}>
              {(Object.keys(CLAUDE_CODE_AUTH_LABELS) as ClaudeCodeAuth[]).map((a) => <option key={a} value={a}>{CLAUDE_CODE_AUTH_LABELS[a]}</option>)}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">Credential (vault entry)</span>
            <VaultRefPicker
              value={cc?.credentialRef}
              onChange={(ref) => setCc({ credentialRef: ref ?? (undefined as never) })}
              requiredKeys={cc?.auth === "vertex" ? [] : ["apiKey"]}
              aria-label="Claude Code credential"
              data-setup-field="claude-code-credential"
            />
          </label>
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
          <label className="space-y-1">
            <span className="text-muted-foreground">Default model (optional)</span>
            <Input className="h-8 text-xs" placeholder={cc?.auth === "bedrock" ? "us.anthropic.claude-sonnet-4-5-20250929-v1:0" : "claude-sonnet-4-5"} value={cc?.model ?? ""}
              onChange={(e) => setCc({ model: e.target.value.trim() || undefined })} aria-label="Claude Code model" />
          </label>
        </div>
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
            <span className="flex items-center gap-1.5 text-muted-foreground">OpenAI API key (vault entry) <BrandIcon name="openai" size={14} /></span>
            <VaultRefPicker value={cx?.credentialRef} onChange={(ref) => setForm({ ...form, codex: { ...(cx ?? {}), auth: "api-key", credentialRef: ref ?? (undefined as never) } })}
              requiredKeys={["apiKey"]} aria-label="Codex credential" />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">Default model (optional)</span>
            <Input className="h-8 text-xs" value={cx?.model ?? ""} onChange={(e) => setForm({ ...form, codex: { ...(cx ?? { credentialRef: undefined as never }), auth: "api-key", model: e.target.value.trim() || undefined } })} aria-label="Codex model" />
          </label>
        </div>
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
