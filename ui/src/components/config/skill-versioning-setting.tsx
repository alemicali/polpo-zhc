/**
 * Configuration → General → Skill versions: whether a skill change from the API, an MCP client or
 * Polpo's chat that does not say publish is published at once (the default) or only changes the
 * skill's draft. The dashboard always goes draft → publish.
 */
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { saveAutoPublishSkillUpdates } from "@/lib/skill-versions";

export function SkillVersioningSetting({ autoPublish, onSaved }: { autoPublish: boolean; onSaved: () => void }) {
  const [value, setValue] = useState(autoPublish);
  const [saving, setSaving] = useState(false);
  const change = async (next: boolean) => {
    setValue(next);
    setSaving(true);
    try {
      await saveAutoPublishSkillUpdates(next);
      onSaved();
    } catch (e) {
      setValue(!next);
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <section data-testid="skill-versioning-setting">
      <div className="mb-1.5 flex items-center gap-2 text-xs font-medium">
        <Sparkles className="h-3.5 w-3.5 text-muted-foreground" /> Skill versions
      </div>
      <div className="flex max-w-xl items-start gap-3">
        <Switch checked={value} onCheckedChange={(v) => void change(v)} disabled={saving} aria-label="Publish API, MCP and chat changes to skills at once" />
        <div className="min-w-0">
          <div className="text-xs font-medium">API, MCP and chat changes to skills are published at once</div>
          <div className="text-caption text-muted-foreground">
            On (default): a skill change from the API, an MCP client or Polpo's chat that does not ask for a draft becomes a new version in production, as before.
            Off: it only changes the skill's draft, to publish from the skill's Versions tab. Changes made in this dashboard and files edited on disk always go to the draft.
          </div>
        </div>
      </div>
    </section>
  );
}
