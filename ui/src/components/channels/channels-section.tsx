/**
 * Configuration → Channels, laid out like the Connectors page: "Configured" lists the channels
 * as rows (brand mark, name, what it does, status, inbound, routed agent, last activity), "Add
 * channel" is the catalog of channel types (mark, one line, badges) with search. A row opens the
 * channel's sheet (overview, setup, settings, Meta connection, routing, test, remove); a catalog
 * card opens the same sheet for a new channel.
 *
 * Deep links: ?section=channels&channel=<name> opens that channel's sheet (MCP setup_url and
 * polpo_channel_save's links, with &focus=<field> to focus the field to fill); the parameter
 * follows the sheet while it is open.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { ArrowRightLeft, Loader2, Plus, Search, Send, Settings2, X } from "lucide-react";
import { useWaBusinessStatus, type NotificationChannelConfig, type NotificationChannelType } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChannelLogo } from "@/components/shared/channel-logo";
import { config as appConfig, apiFetch } from "@/lib/config";
import { getOrchestratorName } from "@/lib/orchestrator-name";
import { productName, useInstanceBranding } from "@/lib/branding";
import { cn } from "@/lib/utils";
import { notifySetupSaved, readSetupParams } from "@/lib/setup-link";
import {
  CHANNEL_CATALOG, channelEntry, channelState, channelSummary, channelSupportsInbound, filterChannelCatalog, filterChannels, timeAgo,
  type ChannelCatalogEntry, type ChannelLive,
} from "./channel-catalog";
import { channelApi } from "./channel-api";
import { ChannelDetailSheet, ChannelStateBadge, type ChannelSheetTarget, type ChannelTestResult } from "./channel-detail-sheet";

export interface ChannelApiAction {
  path: string;
  method: string;
  body?: unknown;
}

function ChannelRow({ name, ch, live, onManage }: { name: string; ch: NotificationChannelConfig; live: ChannelLive; onManage: () => void }) {
  const entry = channelEntry(ch.type);
  const state = channelState(ch, live);
  const gateway = ch.gateway;
  return (
    <div data-testid={`channel-row-${name}`} className="flex items-center gap-3 rounded-card border bg-card px-3 py-3 sm:px-4">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control border bg-background">
        <ChannelLogo type={ch.type} size={20} />
      </div>
      <button type="button" onClick={onManage} className="min-w-0 flex-1 text-left">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{entry.label}</span>
        </span>
        <span className={cn("block truncate text-xs", state === "error" ? "text-destructive" : "text-muted-foreground")}>
          {channelSummary(ch, getOrchestratorName(), live)}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          <ChannelStateBadge state={state} className="text-micro sm:hidden" />
          {channelSupportsInbound(ch.type) && (
            <Badge variant="outline" className="text-micro font-normal text-muted-foreground">Inbound {gateway?.enableInbound ? "on" : "off"}</Badge>
          )}
          {gateway?.enableInbound && gateway.agent && (
            <Badge variant="outline" className="gap-1 text-micro font-normal text-muted-foreground"><ArrowRightLeft className="h-2.5 w-2.5" /> {gateway.agent}</Badge>
          )}
          {live.lastEventAt && <span className="text-micro text-muted-foreground" title={new Date(live.lastEventAt).toLocaleString()}>Last activity {timeAgo(live.lastEventAt)}</span>}
        </span>
      </button>
      <ChannelStateBadge state={state} className="hidden sm:inline-flex" />
      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onManage} aria-label={`Manage ${name}`}>
        <Settings2 className="h-4 w-4" />
      </Button>
    </div>
  );
}


function CatalogCard({ entry, configured, onAdd }: { entry: ChannelCatalogEntry; configured: number; onAdd: () => void }) {
  return (
    <div data-testid={`channel-catalog-${entry.type}`} className="flex flex-col gap-3 rounded-card border bg-card p-4 transition-colors hover:border-foreground/20">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control border bg-background">
          <ChannelLogo type={entry.type} size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium leading-tight">{entry.label}</p>
          <p className="truncate text-xs text-muted-foreground">{configured > 0 ? `${configured} configured` : entry.inbound ? "Notifications and chat" : "Notifications"}</p>
        </div>
      </div>
      <p className="line-clamp-2 min-h-[2.5rem] text-sm text-muted-foreground">{entry.description}</p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="text-micro font-normal text-muted-foreground">{entry.kind}</Badge>
        <Badge variant="outline" className="text-micro font-normal text-muted-foreground">{entry.inbound ? "Two-way" : "Outbound"}</Badge>
        <Button size="sm" variant={configured > 0 ? "outline" : "default"} className="ml-auto h-7 px-3 text-xs" onClick={onAdd} aria-label={`Add ${entry.label}`}>
          {configured > 0 ? "Add another" : "Add"}
        </Button>
      </div>
    </div>
  );
}

/** WhatsApp (QR) profiles: which are linked. Empty until loaded, or when nothing uses WhatsApp. */
function useWhatsAppProfiles(enabled: boolean): Record<string, boolean> | null {
  const [profiles, setProfiles] = useState<Record<string, boolean> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void channelApi("/whatsapp/profiles").then((res) => {
      if (!alive || !res.ok) return;
      const list = ((res.data as { profiles?: Array<{ profileDir: string; authenticated: boolean }> })?.profiles ?? []);
      setProfiles(Object.fromEntries(list.map((p) => [p.profileDir, p.authenticated])));
    });
    return () => { alive = false; };
  }, [enabled]);
  return profiles;
}

export function ChannelsSection({ channels, onUpdateConfig }: {
  channels: Record<string, NotificationChannelConfig>;
  onUpdateConfig: (action: ChannelApiAction) => Promise<void>;
}) {
  const product = productName(useInstanceBranding());
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const entries = useMemo(() => Object.entries(channels), [channels]);
  const [tab, setTab] = useState<string | null>(null);
  const activeTab = tab ?? (entries.length > 0 ? "configured" : "add");

  // the sheet: ?channel=<name> (a link from an assistant) opens it
  const [target, setTarget] = useState<ChannelSheetTarget | null>(() => {
    const name = readSetupParams().channel;
    return name && channels[name] ? { name } : null;
  });
  const setChannelParam = useCallback((name: string | null) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (name) next.set("channel", name); else next.delete("channel");
      return next;
    }, { replace: true });
  }, [setParams]);
  const open = (t: ChannelSheetTarget | null) => {
    setTarget(t);
    setChannelParam(t && "name" in t ? t.name : null);
  };
  // a link followed while the page is open (?channel= changes)
  const channelParam = params.get("channel");
  useEffect(() => {
    if (channelParam && channels[channelParam] && !(target && "name" in target && target.name === channelParam)) setTarget({ name: channelParam });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelParam, channels]);

  // live state: tests, WhatsApp Business connection, WhatsApp profiles
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ChannelTestResult | null>>({});
  const { channels: waBiz } = useWaBusinessStatus();
  const waProfiles = useWhatsAppProfiles(entries.some(([, c]) => c.type === "whatsapp"));
  const live = useCallback((name: string): ChannelLive => {
    const ch = channels[name];
    const result = testResults[name];
    const biz = ch?.type === "whatsapp-business" ? waBiz.find((s) => s.channel === name) : undefined;
    return {
      ...(result ? { testOk: result.success, testError: result.error } : {}),
      ...(biz ? { waBizState: biz.state, lastEventAt: biz.lastEventAt, lastError: biz.lastError } : {}),
      ...(ch?.type === "whatsapp" && waProfiles ? { waLinked: !!waProfiles[ch.profileDir || "default"] } : {}),
    };
  }, [channels, testResults, waBiz, waProfiles]);

  const save = async (name: string, config: NotificationChannelConfig) => {
    await onUpdateConfig({ path: `/${encodeURIComponent(name)}`, method: "PUT", body: config });
    if (!notifySetupSaved()) toast.success(`${name} saved`);
  };
  const remove = async (name: string) => {
    try {
      await onUpdateConfig({ path: `/${encodeURIComponent(name)}`, method: "DELETE" });
      toast.success(`${name} removed`);
    } catch (e) {
      toast.error((e as Error).message);
      throw e;
    }
  };
  const test = async (name: string) => {
    setTesting(name);
    setTestResults((prev) => ({ ...prev, [name]: null }));
    try {
      const res = await apiFetch(`${appConfig.baseUrl}/api/v1/config/channels/${encodeURIComponent(name)}/test`, { method: "POST" });
      const data = await res.json();
      const result: ChannelTestResult = data.ok
        ? { success: !!data.data?.success, error: data.data?.error }
        : { success: false, error: data.error ?? "Channel test failed" };
      setTestResults((prev) => ({ ...prev, [name]: result }));
      if (result.success) toast.success(`Test sent on ${name}`);
    } catch {
      setTestResults((prev) => ({ ...prev, [name]: { success: false, error: "Could not connect to server" } }));
    } finally {
      setTesting(null);
    }
  };

  const visible = useMemo(() => filterChannels(entries, query), [entries, query]);
  const catalog = useMemo(() => filterChannelCatalog(CHANNEL_CATALOG, query), [query]);
  const countByType = (type: string) => entries.filter(([, c]) => c.type === type).length;
  const addNew = (type: NotificationChannelType) => { setTab((t) => t ?? activeTab); open({ type }); };

  return (
    <div className="space-y-4" data-testid="channels-section">
      <div className="flex flex-wrap items-start gap-3">
        <p className="min-w-0 flex-1 text-caption leading-relaxed text-muted-foreground">
          Where {product} reaches people and where people reach it: notifications go out through every channel; Telegram, WhatsApp,
          WhatsApp Business and webhooks can also take messages in and route them to an agent.
        </p>
        <Button size="sm" onClick={() => setTab("add")}>
          <Plus className="h-4 w-4" /> Add channel
        </Button>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search channels" aria-label="Search channels" className="pl-9 pr-9" />
        {query && (
          <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-xs p-1 text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <Tabs value={activeTab} onValueChange={setTab} className="gap-4">
        <TabsList>
          <TabsTrigger value="configured">Configured{entries.length ? ` (${entries.length})` : ""}</TabsTrigger>
          <TabsTrigger value="add">Add channel ({CHANNEL_CATALOG.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="configured" className="space-y-2">
          {entries.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-card border border-dashed py-12 text-center">
              <Send className="h-8 w-8 text-muted-foreground" />
              <div>
                <p className="font-medium">No channels yet</p>
                <p className="text-sm text-muted-foreground">Add Telegram, WhatsApp, Slack, email, a webhook or browser push.</p>
              </div>
              <Button onClick={() => setTab("add")}>Browse channels</Button>
            </div>
          ) : visible.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No channel matches “{query}”.</p>
          ) : (
            visible.map(([name, ch]) => (
              <ChannelRow key={name} name={name} ch={ch} live={live(name)} onManage={() => open({ name })} />
            ))
          )}
        </TabsContent>

        <TabsContent value="add">
          {catalog.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No channel type matches “{query}”.</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {catalog.map((entry) => (
                <CatalogCard key={entry.type} entry={entry} configured={countByType(entry.type)} onAdd={() => addNew(entry.type)} />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {testing && !target && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Testing {testing}…</p>
      )}

      <ChannelDetailSheet
        target={target}
        channels={channels}
        live={live}
        onOpenChange={(o) => { if (!o) open(null); }}
        onSave={save}
        onCreated={(name) => { setTab("configured"); open({ name }); }}
        onRemove={remove}
        onTest={test}
        testing={testing}
        testResults={testResults}
      />
    </div>
  );
}
