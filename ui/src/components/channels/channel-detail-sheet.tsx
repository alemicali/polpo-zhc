/**
 * A channel's sheet, like a connector's: the header (mark, name, status, inbound, agent), the
 * actions (Send test, Remove), then flat sections — overview, setup steps, settings, the Meta
 * connection (WhatsApp Business: secrets, callback URL, Funnel command, webhook events,
 * approvals, test at Meta), this browser's push, routing (inbound gateway, DM policy, allowlist,
 * pairing, sessions) — and Save at the bottom. A new channel opens here too, from the catalog,
 * with its name first.
 */
import { useState } from "react";
import { AlertTriangle, Activity, ArrowRightLeft, BookOpen, Building2, CheckCircle2, CircleDashed, Contact, Info, KeyRound, Loader2, PlugZap, Radio, Settings2, ShieldCheck, Trash2 } from "lucide-react";
import type { NotificationChannelConfig, NotificationChannelType } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { ChannelLogo } from "@/components/shared/channel-logo";
import { WaBusinessContacts, WaBusinessLive, WaBusinessManage } from "@/components/config/whatsapp-business-section";
import { SlackConnection } from "./slack-connection";
import { cn } from "@/lib/utils";
import {
  CHANNEL_NAME_RE, CHANNEL_STATE_LABEL, channelEntry, channelState, channelSupportsInbound, defaultChannelConfig, nextChannelName,
  type ChannelLive, type ChannelState,
} from "./channel-catalog";
import {
  ChannelAccess, ChannelFacts, ChannelSetupSteps, DeliveryFields, InboundGatewayForm, PushBrowserControls, SheetSection,
} from "./channel-forms";

const STATE_STYLE: Record<ChannelState, { className: string; icon: typeof CheckCircle2 }> = {
  connected: { className: "border-success/40 bg-success/10 text-success", icon: CheckCircle2 },
  receiving: { className: "border-success/40 bg-success/10 text-success", icon: Radio },
  configured: { className: "border-info/40 bg-info/10 text-info", icon: CircleDashed },
  needs_setup: { className: "border-warning/40 bg-warning/10 text-warning", icon: KeyRound },
  error: { className: "border-destructive/40 bg-destructive/10 text-destructive", icon: AlertTriangle },
};

export function ChannelStateBadge({ state, busy, className }: { state: ChannelState; busy?: boolean; className?: string }) {
  const style = STATE_STYLE[state];
  const Icon = busy ? Loader2 : style.icon;
  return (
    <Badge variant="outline" className={cn("gap-1 text-caption font-medium", style.className, className)} data-testid="channel-state">
      <Icon className={cn("h-3 w-3", busy && "animate-spin")} />
      {CHANNEL_STATE_LABEL[state]}
    </Badge>
  );
}

/** What the sheet shows: a saved channel, or a new one of a type. */
export type ChannelSheetTarget = { name: string } | { type: NotificationChannelType };

export interface ChannelTestResult { success: boolean; error?: string }

interface ChannelDetailSheetProps {
  target: ChannelSheetTarget | null;
  channels: Record<string, NotificationChannelConfig>;
  live: (name: string) => ChannelLive;
  onOpenChange: (open: boolean) => void;
  /** PUT the channel (create or replace). */
  onSave: (name: string, config: NotificationChannelConfig) => Promise<void>;
  /** A new channel was saved: the sheet now shows it. */
  onCreated: (name: string) => void;
  onRemove: (name: string) => Promise<void>;
  onTest: (name: string) => Promise<void>;
  testing?: string | null;
  testResults: Record<string, ChannelTestResult | null | undefined>;
}

export function ChannelDetailSheet(props: ChannelDetailSheetProps) {
  const { target, onOpenChange } = props;
  const key = !target ? "none" : "name" in target ? `edit:${target.name}` : `new:${target.type}`;
  return (
    <Sheet open={!!target} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-xl" data-testid="channel-sheet">
        {target && <SheetBody key={key} {...props} target={target} />}
      </SheetContent>
    </Sheet>
  );
}

function SheetBody({ target, channels, live, onOpenChange, onSave, onCreated, onRemove, onTest, testing, testResults }: ChannelDetailSheetProps & { target: ChannelSheetTarget }) {
  const isNew = !("name" in target);
  const savedName = "name" in target ? target.name : undefined;
  const saved = savedName ? channels[savedName] : undefined;
  const [name, setName] = useState(() => savedName ?? nextChannelName((target as { type: string }).type, Object.keys(channels)));
  const [draft, setDraft] = useState<NotificationChannelConfig>(() => (saved ? { ...saved } : defaultChannelConfig((target as { type: NotificationChannelType }).type)));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  if (savedName && !saved) {
    return (
      <SheetHeader>
        <SheetTitle>{savedName}</SheetTitle>
        <SheetDescription>This channel no longer exists.</SheetDescription>
      </SheetHeader>
    );
  }

  const entry = channelEntry(draft.type);
  const known = entry.kind !== "Other";
  const testResult = savedName ? testResults[savedName] : undefined;
  const state = saved && savedName ? channelState(saved, live(savedName)) : null;
  const gateway = saved?.gateway;
  const otherChannels = Object.entries(channels).filter(([n]) => n !== savedName).map(([n, c]) => ({ name: n, type: c.type }));
  // a webhook's inbound part stays only where it is already on (new webhooks are outbound only)
  const inbound = channelSupportsInbound(draft.type, saved);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setSaveError("Channel name is required"); return; }
    if (!CHANNEL_NAME_RE.test(trimmed)) { setSaveError("Name: only letters, numbers, dashes, underscores"); return; }
    if (isNew && channels[trimmed]) { setSaveError(`There is already a channel named "${trimmed}"`); return; }
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(trimmed, draft);
      if (isNew) onCreated(trimmed);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col" data-setup-item={savedName}>
      <SheetHeader className="border-b">
        <div className="flex items-center gap-3 pr-6">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control border bg-background">
            <ChannelLogo type={draft.type} size={24} />
          </div>
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate">{isNew ? `Add ${entry.label}` : savedName}</SheetTitle>
            <SheetDescription className="line-clamp-2">{isNew ? entry.description : `${entry.label} · ${entry.kind}`}</SheetDescription>
          </div>
        </div>
        {saved && state && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ChannelStateBadge state={state} busy={testing === savedName} />
            {inbound && (
              <Badge variant="outline" className="text-caption font-normal text-muted-foreground">Inbound {gateway?.enableInbound ? "on" : "off"}</Badge>
            )}
            {gateway?.enableInbound && gateway.agent && (
              <Badge variant="outline" className="gap-1 text-caption font-normal text-muted-foreground"><ArrowRightLeft className="h-3 w-3" /> {gateway.agent}</Badge>
            )}
          </div>
        )}
      </SheetHeader>

      <div className="flex-1 space-y-6 p-4">
        {saved && savedName && (
          <>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void onTest(savedName)} disabled={testing === savedName}>
                {testing === savedName ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
                {testing === savedName ? "Testing…" : testResult?.success === true ? "Reachable · test again" : testResult?.success === false ? "Retry test" : "Send test"}
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmRemove(true)} disabled={removing}>
                {removing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Remove
              </Button>
            </div>
            {testResult?.success === false && testResult.error && (
              <div className="flex items-start gap-2 rounded-card border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alert">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <span className="min-w-0 break-words">{testResult.error}</span>
              </div>
            )}
            <SheetSection title="Overview" icon={Info}>
              <ChannelFacts name={savedName} ch={saved} />
            </SheetSection>
          </>
        )}

        {isNew && (
          <div className="space-y-1">
            <label htmlFor="channel-name" className="text-xs font-medium">Channel name</label>
            <Input
              id="channel-name" data-setup-field="channelName" className="h-8 font-mono text-xs" placeholder="my-channel"
              value={name} onChange={(e) => setName(e.target.value)} autoFocus
            />
            <p className="text-micro leading-tight text-muted-foreground">Unique identifier (e.g. slack-team, ops-email): rules and agents refer to it.</p>
          </div>
        )}

        {known && (
          <SheetSection title="Setup" icon={BookOpen} testId="section-setup">
            <ChannelSetupSteps type={draft.type} />
          </SheetSection>
        )}

        <SheetSection title="Settings" icon={Settings2} description={known ? "Where notifications go and how." : "This channel type is set up in polpo.json; the dashboard shows it, tests it and removes it."} testId="section-settings">
          {known && (
            <DeliveryFields
              config={draft}
              onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
              gatewayRunning={saved?.gateway?.enableInbound === true}
              channelName={savedName}
              savedBotToken={saved?.botToken}
              isSavedChannel={!!saved}
            />
          )}
        </SheetSection>

        {draft.type === "whatsapp-business" && saved && savedName && (
          <SheetSection title="Meta Cloud API" icon={ShieldCheck} description="The connection to Meta: secrets (stored in the vault), the callback URL, the Funnel command, webhook events and templates waiting for approval." testId="section-meta">
            <WaBusinessLive channel={savedName} />
          </SheetSection>
        )}

        {draft.type === "whatsapp-business" && saved && savedName && (
          <SheetSection title="Contacts" icon={Contact} description="People who wrote to the number: the 24-hour window, opt-in and opt-out, blocks. Open one for the conversation (media, buttons, lists, templates, replies, reactions) and to write to them; record what they told you, block them, or erase a contact with its messages (GDPR)." testId="section-contacts">
            <WaBusinessContacts channel={savedName} />
          </SheetSection>
        )}

        {draft.type === "whatsapp-business" && saved && savedName && (
          <SheetSection title="WhatsApp Business account" icon={Building2} description="Templates (create, edit, delete, status and quality), the business profile, the phone number (quality, tier, registration, webhook override), analytics, Meta's account updates and blocked contacts." testId="section-wabiz-manage">
            <WaBusinessManage channel={savedName} />
          </SheetSection>
        )}

        {draft.type === "slack" && saved && savedName && (
          <SheetSection title="Slack app" icon={PlugZap} description="The Socket Mode connection (no public URL needed) and the app's tokens, stored in the vault." testId="section-slack">
            <SlackConnection channel={savedName} />
          </SheetSection>
        )}

        {draft.type === "push" && (
          <SheetSection title="This browser" icon={Radio} testId="section-push">
            <PushBrowserControls hasPushChannel={!!saved} />
            {!saved && <p className="text-caption text-muted-foreground">Add the channel first, then enable notifications for this browser.</p>}
          </SheetSection>
        )}

        {inbound && (
          <SheetSection title="Routing" icon={ArrowRightLeft} testId="section-routing">
            <InboundGatewayForm config={draft} onChange={setDraft} channelName={savedName} otherChannels={otherChannels} />
            {saved && gateway?.enableInbound && (saved.type === "telegram" || saved.type === "whatsapp" || saved.type === "slack") && <ChannelAccess type={saved.type} />}
          </SheetSection>
        )}
      </div>

      <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t bg-background p-4">
        {saveError && <p className="mr-auto text-xs text-destructive" role="alert">{saveError}</p>}
        <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          {isNew ? "Add channel" : "Save changes"}
        </Button>
      </div>

      {savedName && (
        <ConfirmDialog
          open={confirmRemove}
          onOpenChange={setConfirmRemove}
          title={`Remove "${savedName}"?`}
          description="This removes the channel; rules that send to it stop delivering there."
          confirmLabel="Remove"
          destructive
          loading={removing}
          onConfirm={() => {
            setRemoving(true);
            void onRemove(savedName).then(() => { setConfirmRemove(false); onOpenChange(false); }).finally(() => setRemoving(false));
          }}
        />
      )}
    </div>
  );
}
