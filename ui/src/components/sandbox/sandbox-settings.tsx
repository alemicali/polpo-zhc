/**
 * Config → Sandbox: instance defaults and the sandbox every agent ends up with.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Box, Loader2, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SandboxEditor } from "./sandbox-editor";
import { NetworkDeniedCard } from "./network-denied-card";
import { RemoteProvidersCard } from "./remote-providers-card";
import { useSandboxOverview } from "@/hooks/use-sandbox-overview";
import {
  compactSandbox,
  describeSandbox,
  providerLabel,
  sandboxApi,
  SANDBOX_PROVIDERS,
  type SandboxSettings,
} from "@/lib/sandbox-api";

export function SandboxSettingsSection({ onSaved }: { onSaved?: () => void }) {
  const { overview, error, reload } = useSandboxOverview();
  const [draft, setDraft] = useState<SandboxSettings>({});
  const [saving, setSaving] = useState(false);
  const saved = JSON.stringify(compactSandbox(overview?.settings ?? {}));
  const dirty = overview !== null && JSON.stringify(compactSandbox(draft)) !== saved;

  useEffect(() => { if (overview) setDraft(overview.settings ?? {}); }, [overview]);

  const save = async () => {
    setSaving(true);
    try {
      const next = compactSandbox(draft);
      await sandboxApi.saveInstance(Object.keys(next).length ? next : null);
      await reload();
      onSaved?.();
      toast.success("Sandbox settings saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (!overview) return <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading sandbox…</div>;

  return (
    <div className="space-y-8">
      <NetworkDeniedCard overview={overview} onChanged={() => { void reload(); onSaved?.(); }} />
      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5" /> Isolation
        </h3>
        <p className="text-[11px] text-muted-foreground/80 mb-3 max-w-2xl">
          Agents think on this server; their commands (shell, search, scripts) run in the sandbox chosen here.
          The cascade is instance → agent → mission → task: agents can change the defaults, missions and tasks can only make them stricter.
        </p>
        <div className="flex flex-wrap items-center gap-1.5 mb-4">
          <span className="text-[11px] text-muted-foreground mr-1">Available on this server:</span>
          {SANDBOX_PROVIDERS.map((p) => (
            <Badge
              key={p.id}
              variant={overview.available.includes(p.id) ? "secondary" : "outline"}
              className={overview.available.includes(p.id) ? "text-[10px]" : "text-[10px] text-muted-foreground/60"}
            >
              {p.label}
            </Badge>
          ))}
        </div>

        <SandboxEditor level="instance" value={draft} onChange={setDraft} available={overview.available} />

        <div className="flex items-center gap-2 mt-5">
          <Button size="sm" className="h-8 text-xs" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Save className="h-3.5 w-3.5 mr-1" />}
            Save
          </Button>
          <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={!dirty || saving} onClick={() => setDraft(overview.settings ?? {})}>
            <RotateCcw className="h-3.5 w-3.5 mr-1" /> Discard
          </Button>
        </div>
      </section>

      <RemoteProvidersCard onChanged={() => void reload()} />

      <section>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
          <Box className="h-3.5 w-3.5" /> Effective sandbox
        </h3>
        <p className="text-[11px] text-muted-foreground/80 mb-3">
          What each one gets with the saved settings, before mission or task restrictions.
        </p>
        <div className="rounded-lg border border-border/30 divide-y divide-border/20 overflow-hidden">
          <div className="grid grid-cols-1 gap-1 px-3 py-2 text-xs sm:grid-cols-[minmax(8rem,1fr)_2fr_2fr]">
            <span className="font-medium">Polpo</span>
            <span className="text-muted-foreground"><span className="text-[10px] uppercase tracking-wider mr-1.5">chat</span>{describeSandbox(overview.polpo)}</span>
            <span />
          </div>
          {overview.agents.map((agent) => (
            <div key={agent.name} className="grid grid-cols-1 gap-1 px-3 py-2 text-xs sm:grid-cols-[minmax(8rem,1fr)_2fr_2fr]">
              <Link to={`/agents/${encodeURIComponent(agent.name)}`} className="font-medium hover:underline truncate">
                {agent.name}
                {agent.settings && <Badge variant="outline" className="ml-1.5 text-[9px] align-middle">override</Badge>}
              </Link>
              <span className="text-muted-foreground"><span className="text-[10px] uppercase tracking-wider mr-1.5">tasks</span>{describeSandbox(agent.task)}</span>
              <span className="text-muted-foreground">
                <span className="text-[10px] uppercase tracking-wider mr-1.5">chat</span>
                {agent.chat.provider === agent.task.provider ? "same" : providerLabel(agent.chat.provider)}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
