/**
 * Settings → Media: the image model the media primitive uses (a gateway with images — Vercel AI
 * Gateway — and its model, e.g. openai/gpt-image-2), an optional fallback model, where the gateway's
 * key is (a vault entry chosen with the picker, else the gateway's env var, AI_GATEWAY_API_KEY),
 * the images a request may ask for, the media log's retention. Never shows a key.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { usePolpo } from "@polpo-ai/react";
import type { MediaStatus } from "@polpo-ai/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VaultRefPicker } from "@/components/vault/vault-ref-picker";
import { mediaFormFrom, mediaPatchFrom, type MediaForm } from "@/lib/media";

const selectClass = "h-8 rounded-md border bg-transparent px-2 text-xs";

export function MediaSection() {
  const { client } = usePolpo();
  const [status, setStatus] = useState<MediaStatus | null>(null);
  const [form, setForm] = useState<MediaForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const [config, s] = await Promise.all([client.getConfig(), client.getMediaStatus()]);
      setStatus(s);
      setForm(mediaFormFrom(config.settings.imageModel, config.settings.media));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once
  useEffect(() => { void load(); }, [client]);

  if (error) return <p className="text-sm text-destructive" role="alert">{error}</p>;
  if (!form || !status) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>;
  const set = (patch: Partial<MediaForm>) => setForm({ ...form, ...patch });
  const gateway = status.gateways.find((g) => g.id === form.gateway) ?? status.gateways[0];

  return (
    <div className="space-y-6" data-testid="media-settings">
      <section className="space-y-3">
        <div>
          <h2 className="text-h3 font-heading">Image model</h2>
          <p className="text-caption text-muted-foreground">
            Image generation and editing go through a gateway: agents (image_generate, image_edit), missions and playbooks (image nodes), MCP and Polpo&apos;s chat use it.
            Every image is kept with its prompt, model and cost. <Link className="underline" to="/media">Try it</Link>.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1"><span className="text-xs font-medium">Gateway</span>
            <select className={`${selectClass} w-full`} value={form.gateway} onChange={(e) => set({ gateway: e.target.value })} aria-label="Gateway">
              {status.gateways.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
            </select></label>
          <label className="space-y-1"><span className="text-xs font-medium">Model</span>
            <Input className="h-8 font-mono" value={form.model} onChange={(e) => set({ model: e.target.value })} placeholder="openai/gpt-image-2" aria-label="Image model" /></label>
          <label className="space-y-1"><span className="text-xs font-medium">Fallback model (optional)</span>
            <Input className="h-8 font-mono" value={form.fallbackModel} onChange={(e) => set({ fallbackModel: e.target.value })} placeholder="bfl/flux-2-pro (tried once when the model fails)" aria-label="Fallback model" /></label>
          <label className="space-y-1"><span className="text-xs font-medium">Images per request (at most)</span>
            <Input className="h-8" value={form.maxImages} onChange={(e) => set({ maxImages: e.target.value })} placeholder="4" aria-label="Images per request" inputMode="numeric" /></label>
          <div className="space-y-1">
            <span className="text-xs font-medium">Key (vault entry)</span>
            <VaultRefPicker value={form.credentialRef} onChange={(v) => set({ credentialRef: v })} requiredKeys={["apiKey"]} aria-label="Gateway key vault entry"
              placeholder={gateway ? `Choose a vault entry (else ${gateway.envVar})` : "Choose a vault entry"} />
          </div>
          <label className="space-y-1"><span className="text-xs font-medium">Field in the entry</span>
            <Input className="h-8 font-mono" value={form.credentialField} disabled={!form.credentialRef} onChange={(e) => set({ credentialField: e.target.value })} placeholder="apiKey, key or token" aria-label="Vault field" /></label>
        </div>
        <p className="flex items-start gap-1.5 text-caption" data-testid="media-key-status">
          {!status.configured ? <span className="text-muted-foreground">No image model is configured{status.error ? `: ${status.error}` : "."}</span>
            : status.key?.ok ? <><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" /><span>{status.model} · key from {status.key.detail}</span></>
            : <><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" /><span className="text-warning">{status.key?.detail ?? status.error}</span></>}
        </p>
        <p className="text-caption text-muted-foreground">Image analysis (image_analyze) is not a model of its own: it is a chat turn with the image, with the agent&apos;s (or Polpo&apos;s) model, which must see images.</p>
      </section>

      <section className="space-y-3 border-t pt-4">
        <h2 className="text-h3 font-heading">Media log</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1"><span className="text-xs font-medium">Requests kept (with their images)</span>
            <Input className="h-8" value={form.retention} onChange={(e) => set({ retention: e.target.value })} placeholder="1000" aria-label="Requests kept" inputMode="numeric" /></label>
          <label className="space-y-1"><span className="text-xs font-medium">Days kept (0: no limit)</span>
            <Input className="h-8" value={form.retentionDays} onChange={(e) => set({ retentionDays: e.target.value })} placeholder="90" aria-label="Days kept" inputMode="numeric" /></label>
        </div>
        <p className="text-caption text-muted-foreground">Copies an agent saved in its own workspace are not removed.</p>
      </section>

      <Button size="sm" disabled={saving} onClick={() => {
        setSaving(true);
        void client.updateSettings(mediaPatchFrom(form))
          .then(async () => { toast.success("Media settings saved"); await load(); }, (e: Error) => toast.error(e.message))
          .finally(() => setSaving(false));
      }}>{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save</Button>
    </div>
  );
}
