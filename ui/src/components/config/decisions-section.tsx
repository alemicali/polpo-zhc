/**
 * Settings → Decisions: the decision model decide() uses (a gateway with decisions — Vercel AI
 * Gateway — and its model, e.g. typesafe-ai/jev), where the gateway's key is (a vault entry chosen
 * with the picker, else the gateway's env var, AI_GATEWAY_API_KEY), an optional fallback model for
 * low confidence, zero data retention; what happens without a decision model (refuse, or Polpo's
 * own model, uncalibrated); the decision log's retention. Never shows a key.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { usePolpo } from "@polpo-ai/react";
import type { DecisionStatus } from "@polpo-ai/react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { VaultRefPicker } from "@/components/vault/vault-ref-picker";
import { decisionFormFrom, decisionPatchFrom, type DecisionForm } from "@/lib/decisions";

const selectClass = "h-8 rounded-md border bg-transparent px-2 text-xs";

export function DecisionsSection() {
  const { client } = usePolpo();
  const [status, setStatus] = useState<DecisionStatus | null>(null);
  const [form, setForm] = useState<DecisionForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const [config, s] = await Promise.all([client.getConfig(), client.getDecisionStatus()]);
      setStatus(s);
      setForm(decisionFormFrom(config.settings.decisionModel, config.settings.decisions));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once
  useEffect(() => { void load(); }, [client]);

  if (error) return <p className="text-sm text-destructive" role="alert">{error}</p>;
  if (!form || !status) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>;
  const set = (patch: Partial<DecisionForm>) => setForm({ ...form, ...patch });
  const gateway = status.gateways.find((g) => g.id === form.gateway) ?? status.gateways[0];

  return (
    <div className="space-y-6" data-testid="decisions-settings">
      <section className="space-y-3">
        <div>
          <h2 className="text-h3 font-heading">Decision model</h2>
          <p className="text-caption text-muted-foreground">
            decide() asks a decision model (a &quot;System One&quot; model such as TypeSafe&apos;s Jev) typed questions and gets probabilities: agents (the decide tool), missions and playbooks (decision nodes), suites (the decision scorer), MCP and Polpo&apos;s chat use it. <Link className="underline" to="/decisions">Try it</Link>.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1"><span className="text-xs font-medium">Gateway</span>
            <select className={`${selectClass} w-full`} value={form.gateway} onChange={(e) => set({ gateway: e.target.value })} aria-label="Gateway">
              {status.gateways.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
            </select></label>
          <label className="space-y-1"><span className="text-xs font-medium">Model</span>
            <Input className="h-8 font-mono" value={form.model} onChange={(e) => set({ model: e.target.value })} placeholder="typesafe-ai/jev" aria-label="Decision model" /></label>
          <div className="space-y-1">
            <span className="text-xs font-medium">Key (vault entry)</span>
            <VaultRefPicker value={form.credentialRef} onChange={(v) => set({ credentialRef: v })} requiredKeys={["apiKey"]} aria-label="Gateway key vault entry"
              placeholder={gateway ? `Choose a vault entry (else ${gateway.envVar})` : "Choose a vault entry"} />
          </div>
          <label className="space-y-1"><span className="text-xs font-medium">Field in the entry</span>
            <Input className="h-8 font-mono" value={form.credentialField} disabled={!form.credentialRef} onChange={(e) => set({ credentialField: e.target.value })} placeholder="apiKey, key or token" aria-label="Vault field" /></label>
          <label className="space-y-1"><span className="text-xs font-medium">Fallback model (optional)</span>
            <Input className="h-8 font-mono" value={form.fallbackModel} onChange={(e) => set({ fallbackModel: e.target.value })} placeholder="another decision model" aria-label="Fallback model" /></label>
          <label className="space-y-1"><span className="text-xs font-medium">Rerun when confidence is below</span>
            <Input className="h-8" value={form.fallbackBelow} disabled={!form.fallbackModel.trim()} onChange={(e) => set({ fallbackBelow: e.target.value })} placeholder="e.g. 0.6 (empty: only on errors)" aria-label="Fallback confidence" inputMode="decimal" /></label>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <Checkbox checked={form.zeroDataRetention} onCheckedChange={(v) => set({ zeroDataRetention: !!v })} aria-label="Zero data retention" /> Only providers that keep no data (zero data retention)
        </label>
        <p className="flex items-start gap-1.5 text-caption" data-testid="decision-key-status">
          {!status.configured ? <span className="text-muted-foreground">No decision model is configured.</span>
            : status.key?.ok ? <><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" /><span>{status.model} · key from {status.key.detail}</span></>
            : <><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" /><span className="text-warning">{status.key?.detail ?? status.error}</span></>}
        </p>
      </section>

      <section className="space-y-3 border-t pt-4">
        <h2 className="text-h3 font-heading">Without a decision model</h2>
        <select className={selectClass} value={form.unconfigured} onChange={(e) => set({ unconfigured: e.target.value as DecisionForm["unconfigured"] })} aria-label="Without a decision model">
          <option value="error">Refuse, with a link to this page (default)</option>
          <option value="orchestrator">Let Polpo&apos;s own model answer (uncalibrated)</option>
        </select>
        <p className="text-caption text-muted-foreground">Polpo&apos;s model answers through its chat, without tools; its answers are marked uncalibrated: their probabilities are estimates, not a decision model&apos;s.</p>
      </section>

      <section className="space-y-3 border-t pt-4">
        <h2 className="text-h3 font-heading">Decision log</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1"><span className="text-xs font-medium">Decisions kept</span>
            <Input className="h-8" value={form.retention} onChange={(e) => set({ retention: e.target.value })} placeholder="1000" aria-label="Decisions kept" inputMode="numeric" /></label>
          <label className="space-y-1"><span className="text-xs font-medium">Days kept (0: no limit)</span>
            <Input className="h-8" value={form.retentionDays} onChange={(e) => set({ retentionDays: e.target.value })} placeholder="30" aria-label="Days kept" inputMode="numeric" /></label>
          <label className="space-y-1"><span className="text-xs font-medium">State</span>
            <select className={`${selectClass} w-full`} value={form.storeInputs} onChange={(e) => set({ storeInputs: e.target.value as DecisionForm["storeInputs"] })} aria-label="State kept">
              <option value="capped">Kept, capped</option>
              <option value="hash">Hash only</option>
            </select></label>
        </div>
      </section>

      <Button size="sm" disabled={saving} onClick={() => {
        setSaving(true);
        void client.updateSettings(decisionPatchFrom(form))
          .then(async () => { toast.success("Decision settings saved"); await load(); }, (e: Error) => toast.error(e.message))
          .finally(() => setSaving(false));
      }}>{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save</Button>
    </div>
  );
}
