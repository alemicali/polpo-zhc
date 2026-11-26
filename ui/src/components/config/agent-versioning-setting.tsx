/**
 * Configuration → General → Agent versions: whether an API or MCP agent update that does not say
 * publish/deploy is published and deployed at once (the default, the immediate effect API clients
 * had) or only changes the agent's draft. The dashboard always goes draft → publish → deploy.
 */
import { useState } from "react";
import { GitBranch } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { saveAutoDeployApiUpdates } from "@/lib/agent-versions";

export function AgentVersioningSetting({ autoDeploy, onSaved }: { autoDeploy: boolean; onSaved: () => void }) {
  const [value, setValue] = useState(autoDeploy);
  const [saving, setSaving] = useState(false);
  const change = async (next: boolean) => {
    setValue(next);
    setSaving(true);
    try {
      await saveAutoDeployApiUpdates(next);
      onSaved();
    } catch (e) {
      setValue(!next);
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <section data-testid="agent-versioning-setting">
      <div className="mb-1.5 flex items-center gap-2 text-xs font-medium">
        <GitBranch className="h-3.5 w-3.5 text-muted-foreground" /> Agent versions
      </div>
      <div className="flex max-w-xl items-start gap-3">
        <Switch checked={value} onCheckedChange={(v) => void change(v)} disabled={saving} aria-label="Publish and deploy API and MCP agent updates at once" />
        <div className="min-w-0">
          <div className="text-xs font-medium">Publish and deploy API and MCP agent updates at once</div>
          <div className="text-caption text-muted-foreground">
            On (default): an update from the API, an MCP client or Polpo that does not ask for a draft becomes a new version deployed to production, as before.
            Off: it only changes the agent's draft, to publish and deploy from the agent's Versions tab. Changes made in this dashboard always go to the draft.
          </div>
        </div>
      </div>
    </section>
  );
}
