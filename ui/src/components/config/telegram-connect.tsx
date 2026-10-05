/**
 * Telegram channel setup that works entirely from the UI:
 *
 * - TelegramTokenCheck: verifies a bot token with Telegram (getMe).
 * - TelegramConnect: creates a one-time invite link (t.me/<bot>?start=<token>),
 *   shows it as link + QR, and polls until someone opens it. The paired chat id
 *   is handed back so it can become the notification chat.
 * - TelegramChatFinder: for a bot that is not active yet, waits for any message
 *   to it and offers the sender's chat as the notification chat (with confirm).
 * - ChannelAccessPanel: pending pairing requests (approve / reject) and
 *   authorized peers (revoke), backed by /api/v1/peers.
 */

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check, Copy, ExternalLink, Link2, Loader2, MessageCircle, RefreshCw, ShieldCheck, UserCheck, UserX, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ApiResult { ok: boolean; data?: unknown; error?: string }
export type PolpoApi = (path: string, init?: RequestInit) => Promise<ApiResult>;

const POLL_MS = 2000;

// ── Token check ─────────────────────────────────────────

/** `?channel=NAME` for a named channel; the server falls back to the primary bot. */
const channelQuery = (channel?: string) => (channel ? `?channel=${encodeURIComponent(channel)}` : "");

export function TelegramTokenCheck({ api, botToken, channel }: { api: PolpoApi; botToken?: string; channel?: string }) {
  const [result, setResult] = useState<{ token?: string; status: "idle" | "checking" | "ok" | "error"; text?: string }>({ status: "idle" });
  // A result only applies to the token it was computed for; editing the token resets the badge.
  const state = result.token === botToken ? result : { status: "idle" as const };

  const check = async () => {
    setResult({ token: botToken, status: "checking" });
    const res = await api(`/peers/telegram/verify${channelQuery(channel)}`, { method: "POST", body: JSON.stringify({ botToken }) });
    setResult(res.ok
      ? { token: botToken, status: "ok", text: `@${(res.data as { username: string }).username}` }
      : { token: botToken, status: "error", text: res.error ?? "Verification failed" });
  };

  return (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" size="sm" className="h-7 text-[11px] gap-1.5" onClick={check}
        disabled={!botToken?.trim() || state.status === "checking"}>
        {state.status === "checking" ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
        Verify token
      </Button>
      {state.status === "ok" && (
        <span className="flex items-center gap-1 text-[11px] text-emerald-600"><Check className="h-3 w-3" /> {state.text}</span>
      )}
      {state.status === "error" && <span className="text-[11px] text-destructive">{state.text}</span>}
    </div>
  );
}

// ── Chat finder (bot not active yet) ────────────────────

interface DetectedChat { chatId: string; type: string; name: string; username?: string; fromId?: string; text?: string }

const FINDER_TIMEOUT_MS = 3 * 60 * 1000;

export function TelegramChatFinder({ api, botToken, currentChatId, onConfirm }: {
  api: PolpoApi;
  botToken?: string;
  currentChatId?: string;
  /** Called after the user confirms a chat; `authorized` is true when the sender was allowed to chat. */
  onConfirm: (chat: DetectedChat, authorized: boolean) => void;
}) {
  const [state, setState] = useState<"idle" | "waiting" | "found" | "done">("idle");
  const [chats, setChats] = useState<DetectedChat[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [authorize, setAuthorize] = useState(true);
  const [botName, setBotName] = useState<string | null>(null);
  const runRef = useRef(0);

  // Stop waiting when the token changes or the component unmounts.
  useEffect(() => () => { runRef.current++; }, [botToken]);

  const start = async () => {
    const run = ++runRef.current;
    setState("waiting");
    setError(null);
    setChats([]);
    const me = await api("/peers/telegram/verify", { method: "POST", body: JSON.stringify({ botToken }) });
    if (run !== runRef.current) return;
    if (!me.ok) { setError(me.error ?? "Invalid bot token"); setState("idle"); return; }
    setBotName((me.data as { username: string }).username);

    const deadline = Date.now() + FINDER_TIMEOUT_MS;
    let offset: number | undefined;
    while (run === runRef.current && Date.now() < deadline) {
      const res = await api("/peers/telegram/detect-chat", { method: "POST", body: JSON.stringify({ botToken, offset, timeout: 20 }) });
      if (run !== runRef.current) return;
      if (!res.ok) { setError(res.error ?? "Could not read messages"); setState("idle"); return; }
      const data = res.data as { chats: DetectedChat[]; nextOffset?: number };
      offset = data.nextOffset;
      if (data.chats.length > 0) { setChats(data.chats); setState("found"); return; }
    }
    if (run === runRef.current) { setError("No message received. Try again."); setState("idle"); }
  };

  const cancel = () => { runRef.current++; setState("idle"); };

  const confirm = async (chat: DetectedChat) => {
    let authorized = false;
    if (authorize && chat.fromId) {
      const res = await api("/peers/allowlist", { method: "POST", body: JSON.stringify({ peerId: `telegram:${chat.fromId}` }) });
      authorized = res.ok;
    }
    onConfirm(chat, authorized);
    setState("done");
  };

  return (
    <div className="rounded-md border border-sky-500/25 bg-sky-500/5 px-2.5 py-2.5 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium flex items-center gap-1.5"><MessageCircle className="h-3 w-3" /> Find your chat</span>
        {state === "waiting" ? (
          <Button type="button" size="sm" variant="ghost" className="h-7 text-[11px] gap-1" onClick={cancel}><X className="h-3 w-3" /> Stop</Button>
        ) : (
          <Button type="button" size="sm" variant="secondary" className="h-7 text-[11px] gap-1.5" onClick={start} disabled={!botToken?.trim()}>
            <MessageCircle className="h-3 w-3" /> {state === "idle" ? "Find my chat" : "Search again"}
          </Button>
        )}
      </div>

      {state === "idle" && !error && (
        <p className="text-[10.5px] leading-relaxed text-muted-foreground">
          {currentChatId ? "Chat ID already set. " : ""}Press the button, then send any message to your bot on Telegram: the chat is detected automatically.
        </p>
      )}
      {error && <p className="text-[11px] text-destructive">{error}</p>}

      {state === "waiting" && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Waiting… open
          {botName
            ? <a href={`https://t.me/${botName}`} target="_blank" rel="noreferrer" className="text-sky-600 hover:underline">@{botName}</a>
            : " your bot"}
          and send any message (or press Start).
        </p>
      )}

      {state === "found" && (
        <div className="space-y-1.5">
          {chats.map((chat) => (
            <div key={chat.chatId} className="flex items-center gap-2 text-[11px]">
              <span className="flex-1 min-w-0 truncate">
                <span className="font-medium">{chat.name}</span>
                <span className="text-muted-foreground"> · {chat.type} · </span>
                <code className="font-mono text-[10px]">{chat.chatId}</code>
                {chat.text && <span className="text-muted-foreground"> · “{chat.text}”</span>}
              </span>
              <Button type="button" size="sm" className="h-6 px-2 text-[10.5px] gap-1" onClick={() => confirm(chat)}>
                <Check className="h-3 w-3" /> Use this chat
              </Button>
            </div>
          ))}
          <label className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
            <input type="checkbox" checked={authorize} onChange={(e) => setAuthorize(e.target.checked)} />
            Also allow this person to chat with Polpo (no pairing code)
          </label>
        </div>
      )}

      {state === "done" && (
        <p className="flex items-center gap-1.5 text-[11px] text-emerald-600"><Check className="h-3.5 w-3.5" /> Chat ID filled in. Save the channel to apply.</p>
      )}
    </div>
  );
}

// ── Invite link ─────────────────────────────────────────

interface Invite {
  token: string;
  expiresAt: string;
  status: "pending" | "paired" | "expired";
  link?: string;
  command: string;
  botUsername?: string;
  chatId?: string;
  displayName?: string;
}

export function TelegramConnect({ api, channel, gatewayRunning, currentChatId, onPaired }: {
  api: PolpoApi;
  /** Saved channel name, so invites are created for this bot. */
  channel?: string;
  /** Inbound is enabled in the saved config, so the gateway can receive /start. */
  gatewayRunning: boolean;
  currentChatId?: string;
  onPaired: (chatId: string) => void;
}) {
  const [invite, setInvite] = useState<Invite | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const onPairedRef = useRef(onPaired);
  useEffect(() => { onPairedRef.current = onPaired; });

  const create = async () => {
    setCreating(true);
    setError(null);
    const res = await api(`/peers/invites${channelQuery(channel)}`, { method: "POST" });
    setCreating(false);
    if (!res.ok) { setError(res.error ?? "Could not create the link"); return; }
    const created = res.data as Invite;
    setInvite(created);
    setQr(created.link ? await QRCode.toDataURL(created.link, { margin: 1, width: 160 }).catch(() => null) : null);
  };

  // Poll until the invite is redeemed or expires.
  useEffect(() => {
    if (!invite || invite.status !== "pending") return;
    const timer = setInterval(async () => {
      const res = await api(`/peers/invites/${invite.token}${channelQuery(channel)}`);
      if (!res.ok) return;
      const next = { ...invite, ...(res.data as Partial<Invite>) };
      if (next.status === "pending" && Date.now() > new Date(next.expiresAt).getTime()) next.status = "expired";
      if (next.status !== "pending") {
        setInvite(next);
        if (next.status === "paired" && next.chatId) onPairedRef.current(next.chatId);
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [api, channel, invite]);

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (!gatewayRunning) {
    return (
      <p className="rounded-md border border-border/30 bg-muted/15 px-2.5 py-2 text-[10.5px] leading-relaxed text-muted-foreground">
        To connect your Telegram account, enable the inbound gateway below and save the channel, then open it again.
      </p>
    );
  }

  return (
    <div className="rounded-md border border-sky-500/25 bg-sky-500/5 px-2.5 py-2.5 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium flex items-center gap-1.5"><Link2 className="h-3 w-3" /> Connect Telegram</span>
        {invite?.status !== "pending" && (
          <Button type="button" size="sm" variant="secondary" className="h-7 text-[11px] gap-1.5" onClick={create} disabled={creating}>
            {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : invite ? <RefreshCw className="h-3 w-3" /> : <Link2 className="h-3 w-3" />}
            {invite ? "New link" : "Connect my Telegram"}
          </Button>
        )}
      </div>

      {!invite && !error && (
        <p className="text-[10.5px] leading-relaxed text-muted-foreground">
          Creates a one-time link. Open it on your phone and press Start: the account is approved automatically
          {currentChatId ? "." : " and its chat becomes the notification chat."}
        </p>
      )}
      {error && <p className="text-[11px] text-destructive">{error}</p>}

      {invite?.status === "pending" && (
        <div className="flex gap-3">
          {qr && <img src={qr} alt="Telegram invite QR code" className="h-28 w-28 rounded bg-white p-1 shrink-0" />}
          <div className="min-w-0 space-y-1.5 text-[11px]">
            {invite.link ? (
              <a href={invite.link} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-sky-600 hover:underline break-all">
                <ExternalLink className="h-3 w-3 shrink-0" /> Open @{invite.botUsername}
              </a>
            ) : (
              <p className="text-muted-foreground">Send this to the bot:</p>
            )}
            <div className="flex items-center gap-1">
              <code className="font-mono text-[10px] bg-muted/40 rounded px-1.5 py-0.5 truncate">{invite.command}</code>
              <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={() => copy(invite.link ?? invite.command)} aria-label="Copy">
                {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
              </Button>
            </div>
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Waiting for Start… expires {new Date(invite.expiresAt).toLocaleTimeString()}
            </p>
            <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-[10.5px] gap-1" onClick={() => setInvite(null)}>
              <X className="h-3 w-3" /> Cancel
            </Button>
          </div>
        </div>
      )}

      {invite?.status === "paired" && (
        <p className="flex items-center gap-1.5 text-[11px] text-emerald-600">
          <Check className="h-3.5 w-3.5" /> Connected{invite.displayName ? `: ${invite.displayName}` : ""} (chat {invite.chatId}). Save the channel to keep this chat for notifications.
        </p>
      )}
      {invite?.status === "expired" && <p className="text-[11px] text-muted-foreground">The link expired. Create a new one.</p>}
    </div>
  );
}

// ── Access management ───────────────────────────────────

interface PairingRequest { code: string; peerId: string; displayName?: string; externalId: string; createdAt: string }
interface Peer { id: string; displayName?: string; channel: string; lastSeenAt?: string }

export function ChannelAccessPanel({ api, channel }: { api: PolpoApi; channel: "telegram" | "whatsapp" }) {
  const [pending, setPending] = useState<PairingRequest[]>([]);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [peers, setPeers] = useState<Record<string, Peer>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [p, a, known] = await Promise.all([api("/peers/pairings"), api("/peers/allowlist"), api(`/peers?channel=${channel}`)]);
      if (cancelled) return;
      setUnavailable(!p.ok);
      if (!p.ok) return;
      setPending(((p.data ?? []) as PairingRequest[]).filter((r) => r.peerId.startsWith(`${channel}:`)));
      setAllowed(((a.data ?? []) as string[]).filter((id) => id.startsWith(`${channel}:`)));
      setPeers(Object.fromEntries(((known.data ?? []) as Peer[]).map((peer) => [peer.id, peer])));
    };
    void load();
    const timer = setInterval(load, 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [api, channel, version]);

  const act = async (key: string, path: string, method: string, body?: unknown) => {
    setBusy(key);
    await api(path, { method, body: body ? JSON.stringify(body) : undefined });
    setBusy(null);
    setVersion((v) => v + 1);
  };

  if (unavailable) return null;

  return (
    <div className="pt-1.5 mt-1.5 border-t border-border/20 space-y-1.5">
      {pending.length > 0 && (
        <div className="space-y-1">
          <span className="text-[10.5px] font-medium text-amber-600">Waiting for approval</span>
          {pending.map((req) => (
            <div key={req.code} className="flex items-center gap-1.5 text-[11px]">
              <span className="truncate flex-1">{req.displayName ?? req.externalId} <code className="font-mono text-[10px] text-muted-foreground">{req.code}</code></span>
              <Button size="sm" variant="secondary" className="h-6 px-1.5 text-[10.5px] gap-1" disabled={busy === req.code}
                onClick={() => act(req.code, "/peers/pair", "POST", { code: req.code })}>
                <UserCheck className="h-3 w-3" /> Approve
              </Button>
              <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10.5px] gap-1 text-muted-foreground" disabled={busy === req.code}
                onClick={() => act(req.code, `/peers/pairings/${req.code}/reject`, "POST")}>
                <UserX className="h-3 w-3" /> Reject
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[10.5px] text-muted-foreground mr-1">Authorized</span>
        {allowed.length === 0 && <span className="text-[10.5px] text-muted-foreground/70">nobody yet</span>}
        {allowed.map((id) => (
          <Badge key={id} variant="secondary" className={cn("text-[10px] gap-1 pr-0.5 h-5")}>
            {peers[id]?.displayName ?? id.split(":")[1]}
            <button type="button" className="rounded hover:bg-destructive/15 p-0.5" aria-label={`Revoke ${id}`} disabled={busy === id}
              onClick={() => act(id, `/peers/allowlist/${encodeURIComponent(id)}`, "DELETE")}>
              <X className="h-2.5 w-2.5" />
            </button>
          </Badge>
        ))}
      </div>
    </div>
  );
}
