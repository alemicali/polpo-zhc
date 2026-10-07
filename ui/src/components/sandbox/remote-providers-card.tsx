/**
 * Settings → Sandbox → Remote providers: Daytona and E2B, where tasks can run in a remote VM.
 * The API key stays in an agent's vault entry (shared if needed); the provider references it
 * (settings.sandbox.providers.<id>.credential) together with its non-secret options.
 */
import { useCallback, useEffect, useState } from "react";
import { Activity, Cloud, KeyRound, Loader2, Save, Trash2 } from "lucide-react";
import { VaultRefPicker } from "@/components/vault/vault-ref-picker";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { sandboxApi, type RemoteProviderId, type RemoteProviderSettings, type RemoteProviderStatus } from "@/lib/sandbox-api";
import { sameVaultRef, type VaultRef } from "@/lib/vault-ref";

type TextField = Exclude<keyof RemoteProviderSettings, "credential">;

const META: Record<RemoteProviderId, {
  name: string; tagline: string; mark: string; hue: { tile: string; ring: string; glow: string; line: string; text: string; hover: string };
  fields: Array<{ key: TextField; label: string; placeholder: string; hint?: string }>;
  keyUrl: string;
}> = {
  daytona: {
    name: "Daytona",
    tagline: "Remote VMs that start in seconds",
    mark: "D",
    hue: { tile: "from-violet-500 to-indigo-600", ring: "ring-violet-500/30", glow: "bg-violet-500/25", line: "via-violet-400/70", text: "text-violet-300", hover: "hover:border-violet-500/40" },
    fields: [
      { key: "apiUrl", label: "API URL", placeholder: "https://app.daytona.io/api" },
      { key: "target", label: "Region", placeholder: "eu", hint: "eu or us" },
    ],
    keyUrl: "https://app.daytona.io/dashboard/keys",
  },
  e2b: {
    name: "E2B",
    tagline: "Firecracker micro-VMs with domain allowlists",
    mark: "E2B",
    hue: { tile: "from-orange-500 to-amber-500", ring: "ring-orange-500/30", glow: "bg-orange-500/25", line: "via-orange-400/70", text: "text-orange-300", hover: "hover:border-orange-500/40" },
    fields: [
      { key: "template", label: "Template", placeholder: "base", hint: "Optional: your own image" },
      { key: "domain", label: "Domain", placeholder: "e2b.app", hint: "Only for self-hosted E2B" },
    ],
    keyUrl: "https://e2b.dev/dashboard?tab=keys",
  },
};

function ProviderCard({ status, onChanged }: { status: RemoteProviderStatus; onChanged: () => void }) {
  const meta = META[status.id];
  // undefined = unchanged; credential null = cleared in the draft
  const [draft, setDraft] = useState<Partial<Record<TextField, string>> & { credential?: VaultRef | null }>({});
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const test = status.lastTest;
  const credential = draft.credential !== undefined ? draft.credential : status.credential ?? null;
  const dirty = (draft.credential !== undefined && !sameVaultRef(draft.credential, status.credential) && !(draft.credential === null && !status.credential))
    || meta.fields.some((f) => draft[f.key] !== undefined && draft[f.key]!.trim() !== (status[f.key] ?? ""));

  const save = async () => {
    setBusy("save");
    try {
      const next: RemoteProviderSettings = { ...(credential ? { credential } : {}) };
      for (const f of meta.fields) {
        const value = (draft[f.key] ?? status[f.key] ?? "").trim();
        if (value) next[f.key] = value;
      }
      await sandboxApi.saveProvider(status.id, Object.keys(next).length ? next : null);
      setDraft({});
      toast.success(`${meta.name} saved`);
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
        ? { label: `Ready · ${((test.durationMs ?? 0) / 1000).toFixed(1)}s`, cls: "border-emerald-500/25 bg-emerald-500/10 text-emerald-400", dot: "bg-emerald-400", ping: true }
        : !status.keyFound
          ? { label: "Key not found", cls: "border-amber-500/30 bg-amber-500/10 text-amber-400", dot: "bg-amber-400", ping: false }
          : { label: "Key found", cls: "border-emerald-500/25 bg-emerald-500/10 text-emerald-400", dot: "bg-emerald-400", ping: false };

  return (
    <Card className={cn(
      "group relative overflow-hidden border border-border/40 bg-card py-0 gap-0",
      "transition-all duration-300 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/20",
      meta.hue.hover,
    )}>
      <div className={cn("absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent to-transparent", meta.hue.line)} aria-hidden />
      <div className={cn("absolute -top-16 -left-10 h-40 w-40 rounded-full blur-3xl opacity-60 transition-opacity duration-300 group-hover:opacity-100", meta.hue.glow)} aria-hidden />

      <CardContent className="relative p-0">
        <div className="flex items-start gap-3.5 px-4 pt-4">
          <div className={cn(
            "h-12 w-12 shrink-0 rounded-2xl bg-gradient-to-br ring-1 flex items-center justify-center shadow-lg",
            meta.hue.tile, meta.hue.ring,
          )}>
            <span className={cn("font-bold text-white tracking-tight", meta.mark.length > 1 ? "text-[13px]" : "text-lg")}>{meta.mark}</span>
          </div>
          <div className="flex-1 min-w-0 pt-0.5">
            <div className="text-[15px] font-semibold tracking-tight">{meta.name}</div>
            <p className={cn("text-[11px] mt-0.5 font-medium", meta.hue.text)}>{meta.tagline}</p>
          </div>
          <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium", pill.cls)}>
            <span className="relative flex h-1.5 w-1.5">
              {pill.ping && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
              <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", pill.dot)} />
            </span>
            {pill.label}
          </span>
        </div>

        <div className="space-y-2.5 px-4 pt-4">
          <div className="block">
            <span className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
              <KeyRound className="h-3 w-3" /> API key (vault entry)
            </span>
            <VaultRefPicker
              value={credential}
              onChange={(ref) => setDraft((d) => ({ ...d, credential: ref }))}
              requiredKeys={["apiKey"]}
              placeholder={`Choose the vault entry with the ${meta.name} key`}
              aria-label={`${meta.name} API key vault entry`}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            {meta.fields.map((f) => (
              <label key={f.key} className="block min-w-0">
                <span className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground/70">{f.label}</span>
                <Input
                  className="h-8 text-xs"
                  value={draft[f.key] ?? status[f.key] ?? ""}
                  placeholder={f.placeholder}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                />
                {f.hint && <span className="mt-0.5 block text-[9.5px] text-muted-foreground/60">{f.hint}</span>}
              </label>
            ))}
          </div>
          {!status.configured && (
            <p className="text-[10.5px] text-muted-foreground">
              Create a key in the <a href={meta.keyUrl} target="_blank" rel="noreferrer" className={cn("underline", meta.hue.text)}>{meta.name} dashboard</a>,
              save it in an agent's vault (Credentials tab, shared with others if needed), then choose that entry here. Polpo can do it for you.
            </p>
          )}
          {test && !test.ok && test.error && (
            <div className="rounded-lg border border-destructive/25 bg-destructive/10 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-destructive">{test.error}</div>
          )}
        </div>

        <div className="mt-3 flex items-center gap-1.5 border-t border-border/30 bg-muted/10 px-3 py-2">
          <Button size="sm" className="h-7 rounded-full text-[11px] gap-1 px-3" disabled={!dirty || busy !== null} onClick={() => void save()}>
            {busy === "save" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />} Save
          </Button>
          <Button
            variant="ghost" size="sm"
            className={cn("h-7 rounded-full text-[11px] gap-1 px-3", test?.ok && "text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/15")}
            disabled={!status.configured || busy !== null}
            onClick={() => void runTest()}
          >
            {busy === "test" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Activity className="h-3 w-3" />}
            {busy === "test" ? "Starting a VM…" : "Test"}
          </Button>
          {status.configured && (
            <Button
              variant="ghost" size="icon"
              className="ml-auto h-7 w-7 rounded-full text-muted-foreground/60 hover:text-destructive"
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
  const load = useCallback(async () => {
    try {
      setProviders(await sandboxApi.providers());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <section>
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
        <Cloud className="h-3.5 w-3.5" /> Remote providers
      </h3>
      <p className="text-[11px] text-muted-foreground/80 mb-3 max-w-2xl">
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
