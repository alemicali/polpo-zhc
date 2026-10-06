/**
 * AgentSandboxTab — where this agent's tools run: overrides on top of the instance defaults,
 * and the sandbox its tasks and chats end up with.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SandboxEditor } from "@/components/sandbox/sandbox-editor";
import { useSandboxOverview } from "@/components/sandbox/sandbox-settings";
import { compactSandbox, describeSandbox, sandboxApi, type SandboxSettings } from "@/lib/sandbox-api";
import { useAgentDetail } from "./agent-detail-context";

/** Same list as the server (EXTERNAL_CONTENT_TOOLS in @polpo-ai/core/sandbox). */
const EXTERNAL_CONTENT_TOOLS = ["browser_*", "http_fetch", "http_download", "search_*", "email_*", "whatsapp_*", "web_*"];

function readsExternal(tools: string[] | undefined): boolean {
  // no list means every core tool, http_fetch included
  if (tools === undefined) return true;
  return tools.some((tool) => EXTERNAL_CONTENT_TOOLS.some((pattern) =>
    pattern.endsWith("*") ? tool.startsWith(pattern.slice(0, -1)) || tool === pattern : tool === pattern));
}

export function AgentSandboxTab() {
  const { state: { agent }, actions: { refetch }, meta: { agentName } } = useAgentDetail();
  const { overview, error, reload } = useSandboxOverview();
  const stored = useMemo(
    () => ((agent as { sandbox?: SandboxSettings }).sandbox ?? {}),
    [agent],
  );
  const [draft, setDraft] = useState<SandboxSettings>(stored);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(stored); }, [stored]);

  const dirty = JSON.stringify(compactSandbox(draft)) !== JSON.stringify(compactSandbox(stored));
  const effective = overview?.agents.find((a) => a.name === agentName);
  const external = readsExternal(agent.allowedTools);

  const save = async () => {
    setSaving(true);
    try {
      await sandboxApi.saveAgent(agentName, compactSandbox(draft));
      await Promise.all([refetch(), reload()]);
      toast.success("Sandbox saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollArea className="h-full">
      <div className="pr-4 pb-bottom-nav lg:pb-4 space-y-4">
        <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0">
          <CardContent className="py-3 px-4 space-y-1.5 text-xs">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Effective sandbox</div>
            {error && <p className="text-destructive">{error}</p>}
            {!overview && !error && <p className="text-muted-foreground flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</p>}
            {effective && (
              <>
                <p><span className="text-muted-foreground mr-1.5">Tasks</span>{describeSandbox(effective.task)}</p>
                <p><span className="text-muted-foreground mr-1.5">Chat</span>{describeSandbox(effective.chat)}</p>
                <p className="text-[10px] text-muted-foreground">
                  Missions and tasks can only make this stricter. Instance defaults are in{" "}
                  <Link to="/config?section=sandbox" className="underline">Settings → Sandbox</Link>.
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {overview && (
          <Card className="bg-card/80 backdrop-blur-sm border-border/40 py-0 gap-0">
            <CardContent className="py-4 px-4">
              <SandboxEditor
                level="agent"
                value={draft}
                onChange={setDraft}
                available={overview.available}
                readsExternalContent={external}
                confineExternal={!!overview.settings?.confineExternalContent}
              />
              <div className="flex items-center gap-2 mt-5">
                <Button size="sm" className="h-8 text-xs" disabled={!dirty || saving} onClick={() => void save()}>
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Save className="h-3.5 w-3.5 mr-1" />}
                  Save
                </Button>
                <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={!dirty || saving} onClick={() => setDraft(stored)}>
                  <RotateCcw className="h-3.5 w-3.5 mr-1" /> Discard
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </ScrollArea>
  );
}
