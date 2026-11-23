/**
 * Settings → Sandbox → Remote providers: Daytona and E2B, where tasks can run in a remote VM.
 * The API key stays in an agent's vault entry (shared if needed); the provider references it
 * (settings.sandbox.providers.<id>.credential) together with its non-secret options.
 */
import { useCallback, useEffect, useState } from "react";
import { Activity, Cloud, KeyRound, Loader2, Save, Trash2 } from "lucide-react";
import { VaultRefPicker } from "@/components/vault/vault-ref-picker";
import { notifySetupSaved } from "@/lib/setup-link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { sandboxApi, type DaytonaApiVersion, type RemoteProviderId, type RemoteProviderSettings, type RemoteProviderStatus } from "@/lib/sandbox-api";
import { sameVaultRef, type VaultRef } from "@/lib/vault-ref";
import { productName, useInstanceBranding } from "@/lib/branding";
import { BrandIcon } from "@/components/shared/brand-icon";

type TextField = Exclude<keyof RemoteProviderSettings, "credential" | "api">;
type FieldMeta = { key: TextField; label: string; placeholder: string; hint?: string };

/** Daytona v2 (the new service): its own fields, key page and what it creates. */
const DAYTONA_V2 = {
  fields: [
    { key: "image", label: "Image", placeholder: "polpo-runner-vm-3", hint: "Empty: the Polpo runner image" },
    { key: "region", label: "Region", placeholder: "project default", hint: "Optional" },
  ] as FieldMeta[],
  keyUrl: "https://app.daytona.io/dashboard",
};

/** The providers: their official mark (BrandIcon) on a tile of the look; the accents are the look's primary. */
const META: Record<RemoteProviderId, {
  name: string; tagline: string;
  fields: FieldMeta[];
  keyUrl: string;
}> = {
  daytona: {
    name: "Daytona",
    tagline: "Remote VMs that start in seconds",
    fields: [
      { key: "apiUrl", label: "API URL", placeholder: "https://app.daytona.io/api" },
      { key: "target", label: "Region", placeholder: "eu", hint: "eu or us" },
      { key: "snapshot", label: "Snapshot", placeholder: "polpo-runner-…", hint: "Container or linux-vm, as built" },
    ],
    keyUrl: "https://app.daytona.io/dashboard/keys",
  },
  e2b: {
    name: "E2B",
    tagline: "Firecracker micro-VMs with domain allowlists",
    fields: [
      { key: "template", label: "Template", placeholder: "base", hint: "Optional: your own image" },
      { key: "domain", label: "Domain", placeholder: "e2b.app", hint: "Only for self-hosted E2B" },
    ],
    keyUrl: "https://e2b.dev/dashboard?tab=keys",
  },
};

function ProviderCard({ status, onChanged }: { status: RemoteProviderStatus; onChanged: () => void }) {
  const product = productName(useInstanceBranding());
  const meta = META[status.id];
  // undefined = unchanged; credential null = cleared in the draft
  const [draft, setDraft] = useState<Partial<Record<TextField, string>> & { credential?: VaultRef | null; api?: DaytonaApiVersion }>({});
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const test = status.lastTest;
  const credential = draft.credential !== undefined ? draft.credential : status.credential ?? null;
  const isDaytona = status.id === "daytona";
  const api: DaytonaApiVersion = draft.api ?? status.api ?? "v0";
  const v2 = isDaytona && api === "v2";
  const fields = v2 ? DAYTONA_V2.fields : meta.fields;
  const allFields = isDaytona ? [...meta.fields, ...DAYTONA_V2.fields] : meta.fields;
  const dirty = (draft.credential !== undefined && !sameVaultRef(draft.credential, status.credential) && !(draft.credential === null && !status.credential))
    || (isDaytona && api !== (status.api ?? "v0"))
    || fields.some((f) => draft[f.key] !== undefined && draft[f.key]!.trim() !== (status[f.key] ?? ""));

  const save = async () => {
    setBusy("save");
    try {
      const next: RemoteProviderSettings = { ...(credential ? { credential } : {}), ...(v2 ? { api: "v2" as const } : {}) };
      // the other version's options are kept for switching back, except v0's API URL (v2 refuses it)
      for (const f of allFields) {
        if (v2 && f.key === "apiUrl") continue;
        const value = (draft[f.key] ?? status[f.key] ?? "").trim();
        if (value) next[f.key] = value;
      }
      await sandboxApi.saveProvider(status.id, Object.keys(next).length ? next : null);
      setDraft({});
      toast.success(`${meta.name} saved`);
      notifySetupSaved();
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const runTest = async () => {
    setBusy("test");
    try {
      const r = await sandboxApi.testProvider(status.id);
      if (r.ok) toast.success(`${meta.name}: VM started and answered in ${((r.durationMs ?? 0) / 1000).toFixed(1)}s`);
      else toast.error(`${meta.name}: ${r.error}`);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("remove");
    try {
      await sandboxApi.saveProvider(status.id, null);
      setDraft({});
      toast.success(`${meta.name} disconnected`);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const pill = !status.configured
    ? { label: "Not connected", cls: "border-border/40 bg-muted/30 text-muted-foreground", dot: "bg-muted-foreground/60", ping: false }
    : test && !test.ok
      ? { label: "Test failed", cls: "border-destructive/30 bg-destructive/10 text-destructive", dot: "bg-destructive", ping: false }
      : test?.ok
        ? { label: `Ready · ${((test.durationMs ?? 0) / 1000).toFixed(1)}s`, cls: "border-success/25 bg-success/10 text-success", dot: "bg-success", ping: true }
        : !status.keyFound
          ? { label: "Key not found", cls: "border-warning/30 bg-warning/10 text-warning", dot: "bg-warning", ping: false }
          : { label: "Key found", cls: "border-success/25 bg-success/10 text-success", dot: "bg-success", ping: false };

  return (
    <Card className={cn(
      "group relative overflow-hidden border border-border/40 bg-card py-0 gap-0",
      "transition-all duration-300 hover:-translate-y-0.5 hover:shadow-raised hover:border-primary/40",
    )}>
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/70 to-transparent" aria-hidden />
      <div className="absolute -top-16 -left-10 h-40 w-40 rounded-pill bg-primary/15 blur-glow opacity-60 transition-opacity duration-300 group-hover:opacity-100" aria-hidden />

      <CardContent className="relative p-0">
        <div className="flex items-start gap-3.5 px-4 pt-4">
          <div className="h-12 w-12 shrink-0 rounded-2xl bg-card ring-1 ring-border flex items-center justify-center shadow-card">
            <BrandIcon name={status.id} size={28} />
          </div>
          <div className="flex-1 min-w-0 pt-0.5">
            <div className="text-h3 font-semibold tracking-tight">{meta.name}</div>
            <p className="text-caption mt-0.5 font-medium text-primary">{meta.tagline}</p>
          </div>
          <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-pill border px-2 py-0.5 text-caption font-medium", pill.cls)}>
            <span className="relative flex h-1.5 w-1.5">
              {pill.ping && <span className="absolute inline-flex h-full w-full animate-ping rounded-pill bg-success opacity-60" />}
              <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-pill", pill.dot)} />
            </span>
            {pill.label}
          </span>
        </div>

        <div className="space-y-2.5 px-4 pt-4">
          <div className="block" data-setup-item={status.id}>
            <span className="mb-1 flex items-center gap-1 text-label text-muted-foreground/70">
              <KeyRound className="h-3 w-3" /> API key (vault entry)
            </span>
            <VaultRefPicker
              data-setup-field="credential"
              value={credential}
              onChange={(ref) => setDraft((d) => ({ ...d, credential: ref }))}
              requiredKeys={["apiKey"]}
              placeholder={`Choose the vault entry with the ${meta.name} key`}
              aria-label={`${meta.name} API key vault entry`}
            />
          </div>
          {isDaytona && (
            <div className="grid grid-cols-2 gap-2">
              <label className="block min-w-0">
                <span className="mb-1 block text-label text-muted-foreground/70">API</span>
                <select
                  className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs"
                  value={api}
                  onChange={(e) => setDraft((d) => ({ ...d, api: e.target.value as DaytonaApiVersion }))}
                  aria-label="Daytona API version"
                >
                  <option value="v0">v0 · app.daytona.io</option>
                  <option value="v2">v2 · new service (Linux VMs)</option>
                </select>
                <span className="mt-0.5 block text-micro text-muted-foreground/60">{v2 ? "Needs a project API key" : "Organization API key"}</span>
              </label>
              <div className="block min-w-0">
                <span className="mb-1 block text-label text-muted-foreground/70">VM class</span>
                <div className="flex h-8 items-center rounded-md border border-border/40 bg-muted/20 px-2 text-xs" data-testid="daytona-vm-class">
                  {v2 ? "Linux VM (linux-vm)" : "From the snapshot"}
                </div>
                <span className="mt-0.5 block text-micro text-muted-foreground/60">{v2 ? "Computers hibernate (snapshot); pooled VMs deleted when idle" : "Container stops, linux-vm pauses"}</span>
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            {fields.map((f) => (
              <label key={f.key} className="block min-w-0">
                <span className="mb-1 block text-label text-muted-foreground/70">{f.label}</span>
                <Input
                  className="h-8 text-xs"
                  value={draft[f.key] ?? status[f.key] ?? ""}
                  placeholder={f.placeholder}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                />
                {f.hint && <span className="mt-0.5 block text-micro text-muted-foreground/60">{f.hint}</span>}
              </label>
            ))}
          </div>
          {!status.configured && (
            <p className="text-caption text-muted-foreground">
              Create {v2 ? "a project API key" : "a key"} in the <a href={v2 ? DAYTONA_V2.keyUrl : meta.keyUrl} target="_blank" rel="noreferrer" className="underline text-primary">{meta.name} dashboard</a>,
              save it in an agent's vault (Credentials tab, shared with others if needed), then choose that entry here. {product} can do it for you.
            </p>
          )}
          {test && !test.ok && test.error && (
            <div className="rounded-lg border border-destructive/25 bg-destructive/10 px-2.5 py-1.5 text-caption leading-relaxed text-destructive">{test.error}</div>
          )}
        </div>

        <div className="mt-3 flex items-center gap-1.5 border-t border-border/30 bg-muted/10 px-3 py-2">
          <Button size="sm" className="h-7 rounded-pill text-caption gap-1 px-3" disabled={!dirty || busy !== null} onClick={() => void save()}>
            {busy === "save" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />} Save
          </Button>
          <Button
            variant="ghost" size="sm"
            className={cn("h-7 rounded-pill text-caption gap-1 px-3", test?.ok && "text-success bg-success/10 hover:bg-success/15")}
            disabled={!status.configured || busy !== null}
            onClick={() => void runTest()}
          >
            {busy === "test" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Activity className="h-3 w-3" />}
            {busy === "test" ? "Starting a VM…" : "Test"}
          </Button>
          {status.configured && (
            <Button
              variant="ghost" size="icon"
              className="ml-auto h-7 w-7 rounded-pill text-muted-foreground/60 hover:text-destructive"
              disabled={busy !== null}
              onClick={() => void remove()}
              aria-label={`Disconnect ${meta.name}`}
              title="Disconnect (the vault entry stays)"
            >
              {busy === "remove" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function RemoteProvidersCard({ onChanged }: { onChanged?: () => void }) {
  const [providers, setProviders] = useState<RemoteProviderStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // state is only updated in the promise callbacks (never synchronously), so the effect can load
  const load = useCallback(() => sandboxApi.providers().then(
    (next) => { setProviders(next); setError(null); },
    (e: Error) => setError(e.message),
  ), []);
  useEffect(() => { void load(); }, [load]);

  return (
    <section>
      <h3 className="text-label text-muted-foreground mb-1.5 flex items-center gap-1.5">
        <Cloud className="h-3.5 w-3.5" /> Remote providers
      </h3>
      <p className="text-caption text-muted-foreground/80 mb-3 max-w-2xl">
        Tasks can run in a VM elsewhere: the working directory is copied there (without node_modules, .polpo and files .gitignore excludes,
        so .env secrets stay here) and the changed files come back at the end. Chats always stay on this machine.
        Once a provider is connected, choose it above, on an agent, or in a mission.
      </p>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {!providers && !error && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</div>}
      {providers && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 items-start">
          {providers.map((p) => (
            <ProviderCard key={p.id} status={p} onChanged={() => { void load(); onChanged?.(); }} />
          ))}
        </div>
      )}
    </section>
  );
}
