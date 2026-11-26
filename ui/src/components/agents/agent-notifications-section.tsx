/**
 * AgentNotificationsSection — the notification channels this agent may post to with its
 * send_notification tool (a Slack channel as the Polpo bot, a Telegram chat, an email address,
 * a webhook, push…) and the tool's toggle. The owner picks the channels (Settings → Notifications)
 * and, per channel, the targets the agent may choose (`to`: Slack channel ids, chat ids, emails;
 * none = the channel's default target only), and a per-minute limit. Saving goes through the
 * agent's normal update (draft → publish → deploy), with send_notification added to or removed
 * from allowedTools.
 */

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, BellRing, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useAgents, usePolpo } from "@polpo-ai/react";
import type { AgentNotifyChannel, AgentNotifyChannels } from "@polpo-ai/react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SectionHeader } from "@/components/shared/section-header";
import { useAgentDetail } from "./agent-detail-context";

export const NOTIFY_TOOL = "send_notification";
/** The core tools an agent has when its allowedTools is not set: kept when the tool is turned on. */
const DEFAULT_CORE_TOOLS = ["read", "write", "edit", "bash", "glob", "grep", "ls"];

type ChannelRow = { id: string; type?: string; configured: boolean };
type Draft = { all: boolean; picked: Record<string, string>; toolOn: boolean; rate: string };

/** "C0LEADS, C0OPS" → ["C0LEADS", "C0OPS"] */
const parseTargets = (s: string) => [...new Set(s.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean))];

function draftOf(notifyChannels: AgentNotifyChannels | undefined, allowedTools: string[] | undefined, rate: number | undefined): Draft {
  const picked: Record<string, string> = {};
  if (Array.isArray(notifyChannels)) for (const e of notifyChannels) picked[e.channel] = (e.targets ?? []).join(", ");
  return {
    all: notifyChannels === "*",
    picked,
    toolOn: (allowedTools ?? []).some((t) => t.toLowerCase() === NOTIFY_TOOL),
    rate: rate ? String(rate) : "",
  };
}

export function AgentNotificationsSection() {
  const { state: { agent }, actions: { refetch }, meta: { agentName } } = useAgentDetail();
  const { updateAgent } = useAgents();
  const { client } = usePolpo();
  const [configured, setConfigured] = useState<Array<{ id: string; type?: string }>>([]);
  const stored = useMemo(() => draftOf(agent.notifyChannels, agent.allowedTools, agent.notifyRateLimit),
    [agent.notifyChannels, agent.allowedTools, agent.notifyRateLimit]);
  const [draft, setDraft] = useState<Draft>(stored);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setDraft(stored); }, [stored]);
  useEffect(() => {
    void client.getConfig().then((c) => {
      const chs = ((c as { settings?: { notifications?: { channels?: Record<string, { type?: string }> } } }).settings?.notifications?.channels) ?? {};
      setConfigured(Object.entries(chs).map(([id, ch]) => ({ id, ...(ch?.type ? { type: ch.type } : {}) })));
    }, () => setConfigured([]));
  }, [client]);

  // configured channels, then the ones the allowlist names that do not exist (yet)
  const rows: ChannelRow[] = useMemo(() => {
    const known = new Set(configured.map((c) => c.id));
    return [
      ...configured.map((c) => ({ ...c, configured: true })),
      ...Object.keys(draft.picked).filter((id) => !known.has(id)).map((id) => ({ id, configured: false })),
    ];
  }, [configured, draft.picked]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);
  const hasChannels = draft.all || Object.keys(draft.picked).length > 0;

  const togglePick = (id: string, on: boolean) => setDraft((d) => {
    const picked = { ...d.picked };
    if (on) picked[id] = picked[id] ?? ""; else delete picked[id];
    return { ...d, picked };
  });

  const save = async () => {
    const list: AgentNotifyChannel[] = Object.entries(draft.picked).map(([channel, targets]) => {
      const t = parseTargets(targets);
      return t.length ? { channel, targets: t } : { channel };
    });
    const notifyChannels: AgentNotifyChannels | null = draft.all ? "*" : list.length ? list : null;
    const tools = agent.allowedTools;
    const hadTool = (tools ?? []).some((t) => t.toLowerCase() === NOTIFY_TOOL);
    const allowedTools = draft.toolOn === hadTool ? undefined
      : draft.toolOn ? [...(tools ?? DEFAULT_CORE_TOOLS), NOTIFY_TOOL]
      : (tools ?? []).filter((t) => t.toLowerCase() !== NOTIFY_TOOL);
    const rate = Number.parseInt(draft.rate, 10);
    setSaving(true);
    try {
      await updateAgent(agentName, {
        notifyChannels,
        notifyRateLimit: Number.isFinite(rate) && rate >= 1 ? Math.min(60, rate) : null,
        ...(allowedTools ? { allowedTools } : {}),
      });
      await refetch();
      toast.success("Notification settings saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="agent-notifications">
      <SectionHeader title="Notifications" icon={BellRing} count={draft.all ? undefined : Object.keys(draft.picked).length || undefined} />
      <Card className="py-0 gap-0">
        <CardContent className="pt-3 pb-3 space-y-4">
          <label className="flex items-start gap-2 text-xs">
            <Switch checked={draft.toolOn} onCheckedChange={(v) => setDraft((d) => ({ ...d, toolOn: !!v }))} aria-label="send_notification tool" />
            <span className="space-y-0.5">
              <span className="block">Let this agent post with <code className="font-mono">send_notification</code></span>
              <span className="block text-caption text-muted-foreground">
                Only to the channels and targets below, as the instance's bot or sender, in chats and tasks on every engine.
              </span>
            </span>
          </label>

          {draft.toolOn && !hasChannels && (
            <p className="flex items-center gap-1.5 text-caption text-warning" data-testid="notify-no-channels">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              Pick at least one channel: without one the tool is not offered.
            </p>
          )}
          {!draft.toolOn && hasChannels && (
            <p className="flex items-center gap-1.5 text-caption text-muted-foreground" data-testid="notify-tool-off">
              The channels are kept, but the agent cannot post until the tool is on.
            </p>
          )}

          <label className="flex items-center gap-2 text-xs">
            <Switch checked={draft.all} onCheckedChange={(v) => setDraft((d) => ({ ...d, all: !!v }))} aria-label="All channels" />
            <span>Every configured channel, its default target only</span>
          </label>

          {!draft.all && (
            <div className="space-y-1.5">
              <p className="text-label text-muted-foreground">Channels</p>
              {rows.length === 0 ? (
                <p className="text-xs text-muted-foreground">No notification channel yet: add one in Settings → Notifications.</p>
              ) : (
                <div className="divide-y divide-border/30 rounded-control border border-border/40" data-testid="notify-channels">
                  {rows.map((row) => {
                    const on = row.id in draft.picked;
                    return (
                      <div key={row.id} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center" data-channel={row.id}>
                        <label className="flex min-w-0 items-center gap-2 text-xs sm:w-56">
                          <Switch checked={on} onCheckedChange={(v) => togglePick(row.id, !!v)} aria-label={`Channel ${row.id}`} />
                          <span className="truncate font-mono">{row.id}</span>
                          {row.type && <Badge variant="outline" className="text-micro">{row.type}</Badge>}
                          {!row.configured && (
                            <Badge variant="outline" className="text-micro border-warning/40 text-warning">not configured</Badge>
                          )}
                        </label>
                        {on && (
                          <Input
                            value={draft.picked[row.id] ?? ""}
                            onChange={(e) => setDraft((d) => ({ ...d, picked: { ...d.picked, [row.id]: e.target.value } }))}
                            placeholder={row.type === "slack" ? "Slack channel ids, e.g. C0LEADS (empty: its default)" : "Targets: chat ids or emails, * for any (empty: its default)"}
                            aria-label={`Targets for ${row.id}`}
                            className="h-8 flex-1 font-mono text-xs"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="text-caption text-muted-foreground">
                With targets, the agent must pick one of them (<code className="font-mono">to</code>); without, it posts only where the channel is set to post.
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-label text-muted-foreground">At most</span>
            <Input
              type="number" min={1} max={60} inputMode="numeric"
              value={draft.rate}
              onChange={(e) => setDraft((d) => ({ ...d, rate: e.target.value }))}
              placeholder="5"
              aria-label="Messages per minute"
              className="h-8 w-20 text-xs"
            />
            <span className="text-xs text-muted-foreground">messages per minute</span>
          </div>

          {dirty && (
            <div className="flex items-center justify-end gap-2">
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setDraft(stored)} disabled={saving}>Cancel</Button>
              <Button size="sm" className="h-7 text-xs" onClick={() => void save()} disabled={saving}>
                {saving && <Loader2 className="h-3 w-3 animate-spin" />}
                Save
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
