/**
 * A channel's settings, grouped the way the detail sheet shows them: setup steps, the delivery
 * fields of each type (Telegram bot, WhatsApp QR profile, WhatsApp Business ids, Slack, email,
 * webhook, push), the inbound gateway (routing: agent, DM policy, allowlist, sessions, reply pipe),
 * the overview facts and this browser's push subscription. Moved from the Configuration page:
 * same fields and calls, flat sections instead of boxes.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Bell, Copy, Loader2, LogIn, Monitor, RefreshCw, ToggleRight, Trash2, X } from "lucide-react";
import type { NotificationChannelConfig, NotificationChannelType } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChannelAccessPanel, TelegramChatFinder, TelegramConnect, TelegramTokenCheck } from "@/components/config/telegram-connect";
import { AgentSessionOverrides } from "@/components/config/agent-session-overrides";
import { WaBusinessFields } from "@/components/config/whatsapp-business-section";
import { useAgentNames } from "@/hooks/use-agent-names";
import { useTelegramChannelInfo } from "@/hooks/use-telegram-channel-info";
import { config as appConfig, apiFetch, apiUrl } from "@/lib/config";
import { getOrchestratorName } from "@/lib/orchestrator-name";
import { productName, useInstanceBranding } from "@/lib/branding";
import {
  disablePushNotifications, enablePushNotifications, getCurrentPushState, getPushSupportState, type PushSubscriptionState,
} from "@/lib/push-notifications";
import { cn } from "@/lib/utils";
import { channelLabel } from "./channel-catalog";
import { channelApi, isMaskedSecret } from "./channel-api";

const api = channelApi;


/** A section of the sheet: a heading and its content, no box around it. */
export function SheetSection({ title, description, icon: Icon, action, children, testId }: {
  title: string;
  description?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  action?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <section className="space-y-3" data-testid={testId}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-1.5 font-heading text-h3">{Icon && <Icon className="h-4 w-4 text-muted-foreground" />}{title}</h3>
          {description && <p className="mt-0.5 text-caption leading-relaxed text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Label left, value right. */
export function Fact({ label, value, mono }: { label: React.ReactNode; value: React.ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 break-words [overflow-wrap:anywhere]", mono && "font-mono")}>{value}</dd>
    </>
  );
}

/** Form field — label + input */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-foreground">{label}</label>
      {children}
      {hint && <p className="text-micro text-muted-foreground leading-tight">{hint}</p>}
    </div>
  );
}

type GatewayConfig = NonNullable<NotificationChannelConfig["gateway"]>;
type GatewayPolicy = NonNullable<GatewayConfig["dmPolicy"]>;
type WhatsAppLoginStatus = "starting" | "qr" | "connected" | "error" | "expired" | "cancelled";

interface WhatsAppProfileInfo {
  profileDir: string;
  authenticated: boolean;
  status: string;
  path: string;
}

interface WhatsAppLoginSessionInfo {
  id: string;
  profileDir: string;
  status: WhatsAppLoginStatus;
  qr?: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
}

/** "Continue web chat · never expires" / "Separate · 60 min" */
function describeSession(mode?: string, idleMinutes?: number): string {
  const conversation = mode === "shared" ? "Continue web chat" : "Separate";
  const idle = idleMinutes === 0 ? "never expires" : `${idleMinutes ?? 60} min`;
  return `${conversation} · ${idle}`;
}

/** Bot, interlocutor, conversation and menu of a saved Telegram channel. */
function TelegramFacts({ name, ch }: { name: string; ch: NotificationChannelConfig }) {
  const gateway = ch.gateway;
  const info = useTelegramChannelInfo(api, name, gateway?.enableInbound ? gateway.agent : undefined);
  const overrides = Object.entries(gateway?.agentSessions ?? {});
  return (
    <>
      <Fact label="Bot" value={info.botUsername ? `@${info.botUsername}` : "—"} mono />
      <Fact label="Bot token" value={ch.botToken ? "configured" : "not set"} />
      {gateway?.enableInbound && (
        <>
          {overrides.map(([agent, s]) => (
            <Fact key={agent} label={`↳ ${agent}`} value={describeSession(s.sessionMode ?? gateway.sessionMode, s.sessionIdleMinutes ?? gateway.sessionIdleMinutes)} />
          ))}
          <Fact
            label="Menu"
            value={gateway.agent
              ? `${info.suggestionCount ?? "…"} suggestion${info.suggestionCount === 1 ? "" : "s"} + /new /help`
              : "/agent /polpo /new /status … (9)"}
          />
          <Fact
            label="Groups"
            value={info.canReadAllGroupMessages === false
              ? "Privacy mode on: in groups only commands and replies reach the bot. BotFather → /setprivacy → Disable, then add the bot again."
              : "Add the bot to a group: enabled at once if you add it, or /enable"}
          />
        </>
      )}
    </>
  );
}

/** The overview of a saved channel: what it is, where it sends, who answers. */
export function ChannelFacts({ name, ch }: { name: string; ch: NotificationChannelConfig }) {
  const gateway = ch.gateway;
  const inbound = gateway?.enableInbound === true;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs" data-testid="channel-facts">
      <Fact label="Name" value={name} mono />
      <Fact label="Type" value={channelLabel(ch.type)} />
      <Fact label="Notifications" value="on (rules choose what is sent)" />
      <Fact label="Inbound" value={inbound ? "on" : "off"} />
      {inbound && <Fact label="Answered by" value={gateway?.agent ?? `${getOrchestratorName()} · /agent to switch`} />}
      {inbound && <Fact label="DM policy" value={gateway?.dmPolicy ?? "pairing"} />}
      {inbound && gateway?.replyTo && <Fact label="Replies" value={`→ ${gateway.replyTo.channel}`} mono />}
      {inbound && <Fact label="Conversation" value={describeSession(gateway?.sessionMode, gateway?.sessionIdleMinutes)} />}
      {ch.type === "telegram" && <TelegramFacts name={name} ch={ch} />}
      {(ch.type === "telegram" || ch.type === "whatsapp") && <Fact label="Chat" value={ch.chatId || "—"} mono />}
      {ch.type === "whatsapp" && <Fact label="Profile" value={ch.profileDir || "default"} mono />}
      {ch.type === "slack" && <Fact label="Webhook" value={ch.webhookUrl ? "configured" : "not set"} />}
      {ch.type === "slack" && <Fact label="Files" value={ch.apiKey ? "uploads on" : "off"} />}
      {ch.type === "email" && <Fact label="Provider" value={ch.provider ?? "resend"} />}
      {ch.type === "email" && <Fact label="Credentials" value={ch.apiKey ? "API key set" : ch.host ? "SMTP configured" : "none"} />}
      {ch.type === "email" && ch.from && <Fact label="From" value={ch.from} mono />}
      {ch.type === "email" && (ch.to?.length ?? 0) > 0 && <Fact label="To" value={ch.to!.join(", ")} mono />}
      {ch.type === "webhook" && <Fact label="Notification URL" value={ch.url || "off"} mono />}
      {ch.type === "webhook" && inbound && <Fact label="Endpoint" value={`/api/v1/channels/${name}/inbound${ch.inboundSecret ? "" : " · no secret"}`} mono />}
      {ch.type === "webhook" && ch.headers && Object.keys(ch.headers).length > 0 && <Fact label="Headers" value={`${Object.keys(ch.headers).length} custom`} />}
      {ch.type === "push" && <Fact label="Urgency · TTL" value={`${ch.urgency ?? "normal"} · ${ch.ttl ?? 3600}s`} />}
      {ch.type === "push" && <Fact label="VAPID" value={ch.vapidPublicKey || ch.vapidPrivateKey ? "custom keys" : "project generated"} />}
      {ch.type === "whatsapp-business" && (
        <>
          <Fact label="Number ID" value={ch.phoneNumberId || "—"} mono />
          <Fact label="Account" value={ch.wabaId || "—"} mono />
          <Fact label="Talks to" value={(ch.business?.audience ?? "customers") === "customers" ? `customers → ${gateway?.agent ?? "—"}` : "operators"} />
          <Fact label="Templates" value={`${(ch.business?.allowedCategories ?? ["UTILITY"]).join(", ").toLowerCase()} · ${ch.business?.approveTemplates === false ? "sent at once" : "need approval"}`} />
          <Fact label="Daily cap" value={String(ch.business?.limits?.businessInitiatedPerDay ?? 50)} />
          <Fact label="Retention" value={`${ch.business?.retentionDays ?? 90} days`} />
        </>
      )}
    </dl>
  );
}

/** Who may talk to a two-way Telegram / WhatsApp channel: pairing requests, invites, allowlist. */
export function ChannelAccess({ type }: { type: "telegram" | "whatsapp" }) {
  return <ChannelAccessPanel api={api} channel={type} />;
}

/** Random secret for inbound webhooks (64 hex chars). */
function generateInboundSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function webhookInboundUrl(channelName: string): string {
  return new URL(apiUrl(`/api/v1/channels/${encodeURIComponent(channelName)}/inbound`), window.location.origin).toString();
}

/** Endpoint, secret and a ready-to-copy example for an inbound webhook channel. */
function WebhookInboundSetup({ config, onChange, channelName }: {
  config: NotificationChannelConfig;
  onChange: (config: NotificationChannelConfig) => void;
  channelName?: string;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (label: string, value: string) => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  };
  const url = channelName ? webhookInboundUrl(channelName) : "";
  const secret = config.inboundSecret ?? "";
  // The server never returns stored secrets ("••••1234"); only a freshly generated one can be copied.
  const secretHidden = isMaskedSecret(secret);
  const example = `curl -X POST '${url || "<url>"}' \\\n  -H 'Authorization: Bearer ${secret ? "<secret>" : "<generate a secret>"}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"sender":"my-iphone","text":"Hi!"}'`;

  return (
    <div className="space-y-2 rounded-md border border-chart-5/20 bg-chart-5/5 px-2.5 py-2.5">
      <Field label="Endpoint" hint={channelName ? "POST messages here. The reply comes back in the response." : "Save the channel to get its URL."}>
        <div className="flex gap-1.5">
          <Input readOnly className="h-8 text-xs font-mono" value={url || "available after saving"} />
          {url && (
            <Button type="button" variant="outline" size="sm" className="h-8 shrink-0 gap-1 text-caption" onClick={() => copy("url", url)}>
              <Copy className="h-3 w-3" /> {copied === "url" ? "Copied" : "Copy"}
            </Button>
          )}
        </div>
      </Field>
      <Field label="Secret" hint={secretHidden
        ? "Stored secret is hidden. Click New to generate (and copy) a replacement, then save."
        : "Sent as Authorization: Bearer <secret>. Anyone with it can talk to this channel."}>
        <div className="flex gap-1.5">
          <Input className="h-8 text-xs font-mono" placeholder="Generate one" value={secret}
            onChange={(e) => onChange({ ...config, inboundSecret: e.target.value || undefined })} />
          {secret && !secretHidden && (
            <Button type="button" variant="outline" size="sm" className="h-8 shrink-0 gap-1 text-caption" onClick={() => copy("secret", secret)}>
              <Copy className="h-3 w-3" /> {copied === "secret" ? "Copied" : "Copy"}
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" className="h-8 shrink-0 gap-1 text-caption"
            onClick={() => onChange({ ...config, inboundSecret: generateInboundSecret() })}>
            <RefreshCw className="h-3 w-3" /> {secret ? "New" : "Generate"}
          </Button>
        </div>
      </Field>
      <div className="grid gap-1 text-caption leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">iOS Shortcuts</span>
        <span>1. Ask for Input (text or dictation).</span>
        <span>2. Get Contents of URL: the endpoint above with <code>?format=text</code>, method POST, header <code>Authorization</code> = <code>Bearer &lt;secret&gt;</code>, request body JSON with <code>text</code> = the input and <code>sender</code> = a name for your device. Use Form with a file field to send photos or documents.</span>
        <span>3. Show Result or Speak Text — or set <b>Replies go to</b> below (or <code>replyTo</code> in the body) to get the answer on Telegram instead: the request returns at once and the reply arrives there.</span>
        <span>Commands work as on Telegram: /agent NAME, /polpo, /new, /help and the agent's suggestions. Without <code>?format=text</code> the response is JSON with messages, buttons and files (base64).</span>
      </div>
      <pre className="overflow-x-auto rounded-xs bg-muted/40 px-2 py-1.5 text-micro font-mono leading-relaxed">{example}</pre>
    </div>
  );
}

function splitList(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

/** The setup steps of a channel type, numbered (the sheet's "Setup" section). */
export function ChannelSetupSteps({ type }: { type: string }) {
  const product = productName(useInstanceBranding());
  const steps: React.ReactNode[] = (() => {
    switch (type) {
      case "telegram": return [
        <>In Telegram, open <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-primary hover:underline">@BotFather</a>, send /newbot and paste the token below.</>,
        <>Press <b>Find my chat</b> and send any message to your bot — the chat ID fills in after you confirm.</>,
        <>To talk to {product} from Telegram, turn on the inbound gateway under Routing. Save.</>,
      ];
      case "whatsapp-business": return [
        <>In Meta for Developers create a Business app with the WhatsApp product; register and verify the number (with its two-step PIN).</>,
        <>Copy the phone number ID and the WhatsApp Business Account ID below, choose who it talks to and save.</>,
        <>Paste a system user's access token and the app secret, generate the verify token, then give Meta the callback URL and the token and subscribe to <code>messages</code>.</>,
        <>Expose the callback with the Funnel command shown, add a payment method and approved templates, and switch the app to Live. Guide: docs/whatsapp-business.md.</>,
      ];
      case "whatsapp": return [
        <>Pair this server as a linked device with the <b>Connect WhatsApp</b> button below.</>,
        <>Use the same profile directory here, then set the destination phone/chat ID.</>,
        <>Enable inbound only for a dedicated or trusted number. This uses WhatsApp Web connectivity.</>,
      ];
      case "slack": return [
        <>In Slack, create an app with an <b>Incoming Webhook</b> for the channel to post to.</>,
        <>Paste the webhook URL below; add a bot token (xoxb-…) to upload files too. Save, then Send test.</>,
      ];
      case "email": return [
        <>Choose the provider: Resend or SendGrid with an API key, or your SMTP server.</>,
        <>Set the sender (a verified address) and the recipients. Save, then Send test.</>,
      ];
      case "webhook": return [
        <>Outbound: set a URL and {product} POSTs every notification there as JSON.</>,
        <>Inbound: turn on the gateway under Routing to get an endpoint and a secret for Shortcuts or scripts.</>,
      ];
      case "push": return [
        <>Save the channel, then <b>Enable</b> push in this browser below (HTTPS or localhost).</>,
        <>Every browser that subscribes gets the notifications the rules send here.</>,
      ];
      default: return [];
    }
  })();
  if (steps.length === 0) return null;
  return (
    <ol className="space-y-1.5" data-testid="channel-setup-steps">
      {steps.map((step, i) => (
        <li key={i} className="flex gap-2.5 text-caption leading-relaxed text-muted-foreground">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-pill border text-micro font-medium text-foreground">{i + 1}</span>
          <span className="min-w-0 pt-0.5">{step}</span>
        </li>
      ))}
    </ol>
  );
}

function WhatsAppProfileSetup({ config, onChange }: {
  config: NotificationChannelConfig;
  onChange: (patch: Partial<NotificationChannelConfig>) => void;
}) {
  const profileDir = config.profileDir || "default";
  const [profiles, setProfiles] = useState<WhatsAppProfileInfo[]>([]);
  const [session, setSession] = useState<WhatsAppLoginSessionInfo | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeProfile = profiles.find((p) => p.profileDir === profileDir);
  const authenticated = !!activeProfile?.authenticated || session?.status === "connected";

  const loadProfiles = useCallback(async () => {
    try {
      const res = await apiFetch(`${appConfig.baseUrl}/api/v1/whatsapp/profiles`, { credentials: "include" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "Could not load WhatsApp profiles");
      setProfiles(data.data?.profiles ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load WhatsApp profiles");
    }
  }, []);

  useEffect(() => {
    if (config.type !== "whatsapp") return;
    void loadProfiles();
  }, [config.type, loadProfiles]);

  useEffect(() => {
    let cancelled = false;
    if (!session?.qr) {
      setQrDataUrl(null);
      return;
    }
    import("qrcode")
      .then((QRCode) => QRCode.toDataURL(session.qr!, { margin: 1, width: 260 }))
      .then((url) => { if (!cancelled) setQrDataUrl(url); })
      .catch(() => { if (!cancelled) setQrDataUrl(null); });
    return () => { cancelled = true; };
  }, [session?.qr]);

  useEffect(() => {
    if (!session || !["starting", "qr"].includes(session.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const res = await apiFetch(`${appConfig.baseUrl}/api/v1/whatsapp/login/${session.id}`, { credentials: "include" });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error ?? "Could not read WhatsApp login status");
        const next = data.data?.session as WhatsAppLoginSessionInfo;
        setSession(next);
        if (["connected", "error", "expired", "cancelled"].includes(next.status)) {
          window.clearInterval(timer);
          void loadProfiles();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not read WhatsApp login status");
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [session, loadProfiles]);

  const startLogin = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`${appConfig.baseUrl}/api/v1/whatsapp/login/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ profileDir }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "Could not start WhatsApp login");
      setSession(data.data?.session ?? null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not start WhatsApp login";
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const cancelLogin = async () => {
    if (!session || !["starting", "qr"].includes(session.status)) return;
    try {
      await apiFetch(`${appConfig.baseUrl}/api/v1/whatsapp/login/${session.id}/cancel`, {
        method: "POST",
        credentials: "include",
      });
    } finally {
      setSession(null);
      setQrDataUrl(null);
      void loadProfiles();
    }
  };

  const logout = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`${appConfig.baseUrl}/api/v1/whatsapp/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ profileDir }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "Could not remove WhatsApp profile");
      setSession(null);
      setQrDataUrl(null);
      setProfiles(data.data?.profiles ?? []);
      toast.success(`WhatsApp profile "${profileDir}" removed`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not remove WhatsApp profile";
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="whatsapp-profile">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <LogIn className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold">WhatsApp profile</span>
            <Badge variant={authenticated ? "secondary" : "outline"} className={cn("h-4 text-micro px-1.5", authenticated && "text-success")}>
              {authenticated ? "Connected" : session?.status === "qr" ? "Scan QR" : "Not linked"}
            </Badge>
          </div>
          <p className="mt-1 text-caption leading-relaxed text-muted-foreground">
            Pair this server as a WhatsApp linked device. The profile powers tool access; notifications and inbound stay optional.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 text-caption gap-1.5" onClick={() => void loadProfiles()}>
          <RefreshCw className="h-3 w-3" /> Refresh
        </Button>
      </div>

      <Field label="Profile Directory" hint="Stored under .polpo/whatsapp-profiles/<profileDir>.">
        <Input
          className="h-8 text-xs font-mono"
          placeholder="default"
          value={profileDir}
          onChange={(e) => onChange({ profileDir: e.target.value || "default" })}
        />
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          className="h-8 text-xs gap-1.5"
          onClick={startLogin}
          disabled={busy || ["starting", "qr"].includes(session?.status ?? "")}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <LogIn className="h-3 w-3" />}
          {authenticated ? "Reconnect" : "Connect WhatsApp"}
        </Button>
        {session && ["starting", "qr"].includes(session.status) && (
          <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={cancelLogin}>
            Cancel
          </Button>
        )}
        {authenticated && (
          <Button type="button" variant="ghost" size="sm" className="h-8 text-xs text-destructive hover:text-destructive" onClick={logout} disabled={busy}>
            <Trash2 className="h-3 w-3" /> Logout
          </Button>
        )}
      </div>

      {session?.status === "starting" && (
        <div className="rounded-md border border-border/30 bg-muted/15 px-2.5 py-2 text-caption text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for WhatsApp QR code...
        </div>
      )}

      {session?.status === "qr" && (
        <div className="rounded-lg border border-success/20 bg-success/5 p-3 space-y-2">
          <p className="text-xs font-medium">Scan with WhatsApp</p>
          <p className="text-caption leading-relaxed text-muted-foreground">
            Open WhatsApp, go to Linked Devices, then scan this QR code.
          </p>
          {qrDataUrl ? (
            <img src={qrDataUrl} alt="WhatsApp login QR code" className="h-[260px] w-[260px] rounded-md border border-border/40 bg-canvas p-2" />
          ) : (
            <div className="flex h-[260px] w-[260px] items-center justify-center rounded-md border border-border/40 bg-muted/20">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
      )}

      {session && ["connected", "error", "expired", "cancelled"].includes(session.status) && (
        <div className={cn(
          "rounded-md border px-2.5 py-2 text-caption leading-relaxed",
          session.status === "connected"
            ? "border-success/25 bg-success/10 text-success"
            : "border-destructive/25 bg-destructive/10 text-destructive",
        )}>
          {session.status === "connected"
            ? "WhatsApp linked. The server will reconnect the bridge when this profile is configured."
            : session.error ?? `WhatsApp login ${session.status}.`}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/25 bg-destructive/10 px-2.5 py-2 text-caption leading-relaxed text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}

export function DeliveryFields({ config, onChange, gatewayRunning, channelName, savedBotToken, isSavedChannel }: {
  config: NotificationChannelConfig;
  onChange: (patch: Partial<NotificationChannelConfig>) => void;
  gatewayRunning: boolean;
  channelName?: string;
  /** The channel exists on the server (its secrets can be set). */
  isSavedChannel?: boolean;
  /** Bot token of the saved channel; while it is unchanged the bot is already polled by the server. */
  savedBotToken?: string;
}) {
  const product = productName(useInstanceBranding());
  const botActive = !!savedBotToken && savedBotToken.trim() === (config.botToken ?? "").trim();
  const set = onChange;

  return (
    <div className="space-y-3" data-testid="channel-settings">

      {config.type === "telegram" && (
        <>
          <Field label="Bot Token" hint="From @BotFather on Telegram">
            <Input data-setup-field="botToken" className="h-8 text-xs font-mono" placeholder="123456:ABC-DEF..." value={config.botToken ?? ""} onChange={(e) => set({ botToken: e.target.value })} />
          </Field>
          <TelegramTokenCheck api={api} botToken={config.botToken} channel={gatewayRunning || isMaskedSecret(config.botToken) ? channelName : undefined} />
          <Field label="Chat ID" hint="Where notifications are sent. Use Find my chat (new bot) or Connect my Telegram (saved bot) to fill it in.">
            <Input className="h-8 text-xs font-mono" placeholder="-1001234567890" value={config.chatId ?? ""} onChange={(e) => set({ chatId: e.target.value })} />
          </Field>
          {botActive ? (
            <TelegramConnect
              api={api}
              channel={channelName}
              gatewayRunning={gatewayRunning}
              currentChatId={config.chatId}
              onPaired={(chatId) => { if (!config.chatId) set({ chatId }); }}
            />
          ) : (
            <TelegramChatFinder
              api={api}
              botToken={config.botToken}
              currentChatId={config.chatId}
              onConfirm={(chat) => set({ chatId: chat.chatId })}
            />
          )}
        </>
      )}

      {config.type === "whatsapp-business" && (
        <>
          <WaBusinessFields config={config} onChange={set} />
          {!(channelName && isSavedChannel) && (
            <p className="text-caption text-muted-foreground">Save the channel, then enter its access token, app secret and verify token under Meta Cloud API: they go to the vault and are never shown again.</p>
          )}
        </>
      )}

      {config.type === "whatsapp" && (
        <>
          <WhatsAppProfileSetup config={config} onChange={set} />
          <Field label="Notification Chat ID" hint="Optional. Only needed if notification rules should send outbound WhatsApp alerts. Leave empty for tool-only access.">
            <Input className="h-8 text-xs font-mono" placeholder="Optional: +393331234567 or 393331234567@s.whatsapp.net" value={config.chatId ?? ""} onChange={(e) => set({ chatId: e.target.value })} />
          </Field>
        </>
      )}

      {config.type === "slack" && (
        <>
          <Field label="Webhook URL" hint="Slack Incoming Webhook URL">
            <Input data-setup-field="webhookUrl" className="h-8 text-xs font-mono" placeholder="https://hooks.slack.com/services/..." value={config.webhookUrl ?? ""} onChange={(e) => set({ webhookUrl: e.target.value })} />
          </Field>
          <Field label="API Key" hint="Optional - enables file uploads">
            <Input data-setup-field="apiKey" className="h-8 text-xs font-mono" placeholder="xoxb-..." value={config.apiKey ?? ""} onChange={(e) => set({ apiKey: e.target.value || undefined })} />
          </Field>
        </>
      )}

      {config.type === "email" && (
        <>
          <Field label="Provider">
            <Select value={config.provider ?? "resend"} onValueChange={(v) => set({ provider: v })}>
              <SelectTrigger className="h-8 text-xs w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="resend" className="text-xs">Resend</SelectItem>
                <SelectItem value="sendgrid" className="text-xs">SendGrid</SelectItem>
                <SelectItem value="smtp" className="text-xs">SMTP</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {config.provider !== "smtp" && (
            <Field label="API Key">
              <Input data-setup-field="apiKey" className="h-8 text-xs font-mono" placeholder="re_..." value={config.apiKey ?? ""} onChange={(e) => set({ apiKey: e.target.value })} />
            </Field>
          )}
          {config.provider === "smtp" && (
            <>
              <Field label="SMTP Host">
                <Input className="h-8 text-xs font-mono" placeholder="smtp.example.com" value={config.host ?? ""} onChange={(e) => set({ host: e.target.value })} />
              </Field>
              <Field label="SMTP Port">
                <Input className="h-8 text-xs font-mono" type="number" placeholder="587" value={config.port ?? ""} onChange={(e) => set({ port: e.target.value ? Number(e.target.value) : undefined })} />
              </Field>
            </>
          )}
          <Field label="From Address">
            <Input className="h-8 text-xs font-mono" placeholder="noreply@example.com" value={config.from ?? ""} onChange={(e) => set({ from: e.target.value })} />
          </Field>
          <Field label="Recipients" hint="Comma-separated email addresses">
            <Input className="h-8 text-xs font-mono" placeholder="alice@example.com, bob@example.com"
              value={(config.to ?? []).join(", ")}
              onChange={(e) => set({ to: splitList(e.target.value) })}
            />
          </Field>
        </>
      )}

      {config.type === "webhook" && (
        <>
          <Field label="Notification URL" hint={`Optional: ${product} POSTs notifications here as JSON. Leave empty for an inbound-only webhook.`}>
            <Input data-setup-field="url" className="h-8 text-xs font-mono" placeholder="https://example.com/webhook" value={config.url ?? ""} onChange={(e) => set({ url: e.target.value || undefined })} />
          </Field>
          <Field label="Headers" hint="key:value pairs, one per line">
            <textarea
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs font-mono min-h-[56px] resize-y focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder={"Authorization: Bearer xxx\nX-Custom: value"}
              value={Object.entries(config.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n")}
              onChange={(e) => {
                const headers: Record<string, string> = {};
                for (const line of e.target.value.split("\n")) {
                  const idx = line.indexOf(":");
                  if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
                }
                set({ headers: Object.keys(headers).length > 0 ? headers : undefined });
              }}
            />
          </Field>
        </>
      )}

      {config.type === "push" && (
        <>
          <Field label="VAPID Subject" hint="Contact URI sent to push services. Use mailto: or https:.">
            <Input className="h-8 text-xs font-mono" placeholder="mailto:ops@example.com" value={config.vapidSubject ?? ""} onChange={(e) => set({ vapidSubject: e.target.value || undefined })} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="TTL Seconds" hint="How long push services may retain the notification.">
              <Input className="h-8 text-xs font-mono" type="number" min={0} value={config.ttl ?? 3600} onChange={(e) => set({ ttl: e.target.value ? Number(e.target.value) : undefined })} />
            </Field>
            <Field label="Urgency">
              <Select value={config.urgency ?? "normal"} onValueChange={(v) => set({ urgency: v as NotificationChannelConfig["urgency"] })}>
                <SelectTrigger className="h-8 text-xs w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="very-low" className="text-xs">Very low</SelectItem>
                  <SelectItem value="low" className="text-xs">Low</SelectItem>
                  <SelectItem value="normal" className="text-xs">Normal</SelectItem>
                  <SelectItem value="high" className="text-xs">High</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <p className="text-micro text-muted-foreground leading-tight">
            VAPID keys are generated once and stored in .polpo/push.json. Override them with config values or env references only when you need stable keys across deployments.
          </p>
        </>
      )}
    </div>
  );
}

export function InboundGatewayForm({ config, onChange, channelName, otherChannels = [] }: {
  config: NotificationChannelConfig;
  onChange: (config: NotificationChannelConfig) => void;
  channelName?: string;
  otherChannels?: { name: string; type: NotificationChannelType }[];
}) {
  const product = productName(useInstanceBranding());
  const agentNames = useAgentNames(api);
  const gateway = config.gateway ?? {};
  const enabled = gateway.enableInbound === true;
  const isWebhook = config.type === "webhook";
  const isWaBusiness = config.type === "whatsapp-business";
  const forCustomers = isWaBusiness && (config.business?.audience ?? "customers") === "customers";
  // A webhook is authenticated by its secret, and a business number is meant for anyone: both default to open.
  const defaultPolicy: GatewayPolicy = isWebhook || isWaBusiness ? "open" : "pairing";
  const policy = gateway.dmPolicy ?? defaultPolicy;
  const updateGateway = (patch: Partial<GatewayConfig>) => {
    const next: NotificationChannelConfig = {
      ...config,
      gateway: {
        dmPolicy: defaultPolicy,
        ...gateway,
        ...patch,
      },
    };
    if (isWebhook && patch.enableInbound && !next.inboundSecret) next.inboundSecret = generateInboundSecret();
    onChange(next);
  };

  return (
    <div className="space-y-3" data-testid="channel-routing">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-caption leading-relaxed text-muted-foreground">
          Inbound gateway: let people send messages to {product} from {channelLabel(config.type)}. This is separate from outbound notifications.
        </p>
        <Button
          type="button"
          variant={enabled ? "secondary" : "outline"}
          size="sm"
          className="h-7 shrink-0 text-caption gap-1.5"
          onClick={() => updateGateway({ enableInbound: !enabled })}
          aria-label={enabled ? "Inbound on: turn it off" : "Inbound off: turn it on"}
        >
          <ToggleRight className={cn("h-3.5 w-3.5", enabled && "text-success")} />
          {enabled ? "Enabled" : "Off"}
        </Button>
      </div>

      {enabled ? (
        <>
          {isWebhook && <WebhookInboundSetup config={config} onChange={onChange} channelName={channelName} />}
          <div className="grid grid-cols-2 gap-2">
            <Field label="DM Policy" hint={`Controls who can start a ${product} session.`}>
              <Select value={policy} onValueChange={(v) => updateGateway({ dmPolicy: v as GatewayPolicy })}>
                <SelectTrigger className="h-8 text-xs w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pairing" className="text-xs">Pairing</SelectItem>
                  <SelectItem value="allowlist" className="text-xs">Allowlist</SelectItem>
                  <SelectItem value="open" className="text-xs">Open</SelectItem>
                  <SelectItem value="disabled" className="text-xs">Disabled</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Idle Timeout" hint="Minutes of inactivity before a new conversation starts. 0 = never.">
              <Input
                className="h-8 text-xs font-mono"
                type="number"
                min={0}
                placeholder="60"
                value={gateway.sessionIdleMinutes ?? ""}
                onChange={(e) => updateGateway({ sessionIdleMinutes: e.target.value ? Number(e.target.value) : undefined })}
              />
            </Field>
          </div>
          {(config.type === "telegram" || isWebhook || isWaBusiness) && (
            <Field label={forCustomers ? "Agent that answers customers (required)" : "Dedicated agent"} hint={forCustomers
              ? "Customers talk only with this agent, never with Polpo, and cannot use commands. Give it few tools: what customers write is untrusted."
              : isWebhook
              ? "Send every message to one agent, without /agent. Leave on Polpo to talk to the orchestrator and switch with /agent."
              : "Give an important agent its own bot: every message goes to it, without /agent. Leave on Polpo for the main bot."}>
              <Select value={gateway.agent ?? "__polpo__"} onValueChange={(v) => updateGateway({ agent: v === "__polpo__" ? undefined : v })}>
                <SelectTrigger className="h-8 text-xs w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__polpo__" className="text-xs">Polpo (orchestrator, /agent to switch)</SelectItem>
                  {agentNames.map((name) => <SelectItem key={name} value={name} className="text-xs">{name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          )}
          {!forCustomers && <Field label="Replies go to" hint="Conversation pipe: answer here, or deliver replies through another channel (e.g. in from Shortcuts, out on Telegram).">
            <Select
              value={gateway.replyTo?.channel ?? "__origin__"}
              onValueChange={(v) => updateGateway({ replyTo: v === "__origin__" ? undefined : { ...gateway.replyTo, channel: v } })}
            >
              <SelectTrigger className="h-8 text-xs w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__origin__" className="text-xs">This channel</SelectItem>
                {otherChannels.map((c) => (
                  <SelectItem key={c.name} value={c.name} className="text-xs">{c.name} ({channelLabel(c.type)})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>}
          {gateway.replyTo && !forCustomers && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Chat ID" hint="Optional. Default: the target's chat ID, or its only paired person.">
                <Input
                  className="h-8 text-xs font-mono"
                  placeholder="auto"
                  value={gateway.replyTo.chatId ?? ""}
                  onChange={(e) => updateGateway({ replyTo: { ...gateway.replyTo!, chatId: e.target.value.trim() || undefined } })}
                />
              </Field>
              <Field label="Show the message" hint="Echo the incoming message on the target before the reply.">
                <Select
                  value={gateway.replyTo.echoInbound === false ? "no" : "yes"}
                  onValueChange={(v) => updateGateway({ replyTo: { ...gateway.replyTo!, echoInbound: v === "no" ? false : undefined } })}
                >
                  <SelectTrigger className="h-8 text-xs w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="yes" className="text-xs">Yes</SelectItem>
                    <SelectItem value="no" className="text-xs">No, only the reply</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
          )}
          <Field label="Conversation" hint="How chats from this channel relate to the web chat.">
            <Select value={gateway.sessionMode ?? "per-peer"} onValueChange={(v) => updateGateway({ sessionMode: v as GatewayConfig["sessionMode"] })}>
              <SelectTrigger className="h-8 text-xs w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="per-peer" className="text-xs">Separate from web chat</SelectItem>
                <SelectItem value="shared" className="text-xs">Continue the web chat</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <p className="-mt-1.5 text-micro leading-relaxed text-muted-foreground">
            {(gateway.sessionMode ?? "per-peer") === "shared"
              ? "Messages continue the latest conversation with the same interlocutor (Polpo or the agent chosen with /agent), the one the web chat resumes."
              : "Each person gets their own conversations here, one per interlocutor. They appear in the web chat list but are not resumed automatically."}
          </p>
          <AgentSessionOverrides
            api={api}
            value={gateway.agentSessions}
            onChange={(agentSessions) => updateGateway({ agentSessions })}
          />
          <Field
            label="Allow From"
            hint={policy === "allowlist"
              ? "Comma-separated external IDs allowed to message Polpo."
              : policy === "open"
                ? "Optional. Leave empty for open access, or document expected IDs."
                : "Optional. With pairing, connect people with an invite link or approve their requests on the channel card."}
          >
            <Input
              className="h-8 text-xs font-mono"
              placeholder={config.type === "whatsapp" ? "+393331234567, 393331234567" : isWebhook ? "my-iphone, office-script" : "123456789, -1001234567890"}
              value={(gateway.allowFrom ?? []).join(", ")}
              onChange={(e) => {
                const allowFrom = splitList(e.target.value);
                updateGateway({ allowFrom: allowFrom.length > 0 ? allowFrom : undefined });
              }}
            />
          </Field>
          <div className="rounded-md border border-border/30 bg-muted/15 px-2.5 py-2 text-caption leading-relaxed text-muted-foreground">
            {policy === "pairing" && "Unknown people receive a pairing code. Approve them from the channel card, or send them an invite link that pairs them automatically."}
            {policy === "allowlist" && "Allowlist accepts only configured IDs. Use this for production channels with known operators."}
            {policy === "open" && (isWebhook
              ? "Open accepts any caller that knows the secret. Use Allowlist to also restrict the sender names."
              : "Open allows any direct message that reaches the channel. Use only for controlled or disposable endpoints.")}
            {policy === "disabled" && "Disabled keeps the gateway block configured but rejects inbound messages."}
          </div>
        </>
      ) : (
        <p className="rounded-md border border-border/30 bg-muted/15 px-2.5 py-2 text-caption leading-relaxed text-muted-foreground">
          Inbound is off. This channel can still send notifications; messages from users will not become {product} conversations.
        </p>
      )}
    </div>
  );
}

/** This browser's push subscription (the Push channel's sheet). */
export function PushBrowserControls({ hasPushChannel }: { hasPushChannel: boolean }) {
  const [state, setState] = useState<PushSubscriptionState>(() => getPushSupportState());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getCurrentPushState()
      .then((next) => {
        if (!alive) return;
        setState(next);
        setError(null);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : "Could not load push state");
      });
    return () => { alive = false; };
  }, []);

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await enablePushNotifications();
      setState(next);
      toast.success("Push notifications enabled for this browser");
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await disablePushNotifications();
      setState(next);
      toast.success("Push notifications disabled for this browser");
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="push-browser">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <Monitor className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-sm font-semibold">This browser</span>
              <Badge variant={state.subscribed ? "default" : "outline"} className="text-micro">
                {state.subscribed ? "Subscribed" : state.permission === "denied" ? "Blocked" : "Not subscribed"}
              </Badge>
            </div>
            <p className="text-caption text-muted-foreground">
              {state.supported
                ? `${state.subscriptionCount} saved browser subscription${state.subscriptionCount === 1 ? "" : "s"}`
                : "Requires HTTPS or localhost, Service Worker, Notification API, and PushManager"}
            </p>
          </div>
          <div className="flex gap-2">
            {state.subscribed ? (
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={disable} disabled={busy}>
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />} Disable
              </Button>
            ) : (
              <Button size="sm" className="h-8 text-xs" onClick={enable} disabled={busy || !state.supported || !hasPushChannel || state.permission === "denied"}>
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Bell className="h-3 w-3" />} Enable
              </Button>
            )}
          </div>
        </div>
        {error && (
          <div className="rounded-md border border-destructive/25 bg-destructive/10 px-2 py-1.5 text-micro leading-relaxed text-destructive">
            {error}
          </div>
        )}
    </div>
  );
}

