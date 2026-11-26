import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useEvents } from "./use-events.js";
import type {
  WaBizFileInput, WaBizOutbound, WaBizTemplateInput, WaBusinessAccountEvent, WaBusinessAnalyticsQuery, WaBusinessBlockResult,
  WaBusinessContact, WaBusinessConversation, WaBusinessLiveEvent, WaBusinessMessage, WaBusinessPhoneAction, WaBusinessProfile,
  WaBusinessSendResult, WaBusinessStatus, WaBusinessTemplate, WaBusinessTemplateDefinition, WaBusinessWebhookOverride,
} from "@polpo-ai/sdk";

/** Live: a delivery recorded, a message's status changed, or structured content arrived (replies, orders, payments, account updates). */
const WABIZ_EVENTS = ["channel:webhook", "channel:message-status", "channel:wabiz-event"];

/** Refetch when one of the events arrives (after the first load); `match` narrows it further. */
function useRefetchOn(events: string[], refetch: () => void, channel?: string, match?: (data: Record<string, unknown>) => boolean) {
  const { events: seen } = useEvents(events, 1);
  const last = seen.at(-1);
  const handled = useRef(last?.id);
  const matchRef = useRef(match);
  matchRef.current = match;
  useEffect(() => {
    if (!last?.id || handled.current === last.id) return;
    handled.current = last.id;
    const data = (last.data ?? {}) as Record<string, unknown>;
    const ch = typeof data.channel === "string" ? data.channel : undefined;
    if (channel && ch && ch !== channel) return;
    if (matchRef.current && !matchRef.current(data)) return;
    refetch();
  }, [last, refetch, channel]);
}

/** A read that loads when its key changes, with an error and a refetch. */
function useLoad<T>(enabled: boolean, load: () => Promise<T>, initial: T) {
  const [data, setData] = useState<T>(initial);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const refetch = useCallback(async () => {
    if (!enabled) return;
    try {
      setData(await load());
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [enabled, load]);
  useEffect(() => {
    if (!enabled) { setIsLoading(false); return; }
    setIsLoading(true);
    refetch().finally(() => setIsLoading(false));
  }, [refetch, enabled]);
  return { data, setData, isLoading, error, refetch };
}

export interface UseWaBusinessStatusReturn {
  /** Every WhatsApp Business channel (or only `channel`). */
  channels: WaBusinessStatus[];
  status: WaBusinessStatus | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/** WhatsApp Business channels' status, live (webhook deliveries, message statuses and account updates refresh it). */
export function useWaBusinessStatus(channel?: string): UseWaBusinessStatusReturn {
  const { client } = usePolpoContext();
  const [channels, setChannels] = useState<WaBusinessStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const refetch = useCallback(async () => {
    try {
      setChannels(channel ? [await client.getWaBusinessStatus(channel)] : await client.getWaBusinessChannels());
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [client, channel]);
  useEffect(() => {
    setIsLoading(true);
    refetch().finally(() => setIsLoading(false));
  }, [refetch]);
  useRefetchOn(WABIZ_EVENTS, () => { void refetch(); }, channel);
  return { channels, status: channels[0], isLoading, error, refetch };
}

export interface UseWaTemplatesReturn {
  templates: WaBusinessTemplate[];
  syncedAt?: string;
  isLoading: boolean;
  error: Error | null;
  /** Sync from Meta. */
  sync: () => Promise<void>;
  /** Create a template (Meta reviews it); the list is synced after. */
  create: (definition: WaBusinessTemplateDefinition) => Promise<{ id: string; status: string; category: string }>;
  /** Edit a template by id (back to review). */
  edit: (id: string, patch: { components?: Array<Record<string, unknown>>; category?: WaBusinessTemplateDefinition["category"] }) => Promise<void>;
  /** Delete a template (every language, or one by id). */
  remove: (name: string, id?: string) => Promise<void>;
}

/** The account's message templates (synced from Meta), with create / edit / delete; live on template status updates. */
export function useWaTemplates(channel: string | undefined): UseWaTemplatesReturn {
  const { client } = usePolpoContext();
  const [data, setData] = useState<{ templates: WaBusinessTemplate[]; syncedAt?: string }>({ templates: [] });
  const [isLoading, setIsLoading] = useState(!!channel);
  const [error, setError] = useState<Error | null>(null);
  const load = useCallback(async (refresh: boolean) => {
    if (!channel) return;
    try {
      setData(refresh ? await client.syncWaBusinessTemplates(channel) : await client.getWaBusinessTemplates(channel));
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [client, channel]);
  useEffect(() => {
    if (!channel) return;
    setIsLoading(true);
    load(false).finally(() => setIsLoading(false));
  }, [load, channel]);
  // a template's status, quality or category changed at Meta
  useRefetchOn(["channel:wabiz-event"], () => { void load(true); }, channel,
    (d) => d.kind === "account" && String((d.data as { field?: unknown } | undefined)?.field ?? "").startsWith("message_template"));
  const create = useCallback(async (definition: WaBusinessTemplateDefinition) => {
    if (!channel) throw new Error("Say which WhatsApp Business channel");
    const r = await client.createWaBusinessTemplate(channel, definition);
    await load(true);
    return r;
  }, [client, channel, load]);
  const edit = useCallback(async (id: string, patch: { components?: Array<Record<string, unknown>>; category?: WaBusinessTemplateDefinition["category"] }) => {
    if (!channel) throw new Error("Say which WhatsApp Business channel");
    await client.editWaBusinessTemplate(channel, id, patch);
    await load(true);
  }, [client, channel, load]);
  const remove = useCallback(async (name: string, id?: string) => {
    if (!channel) throw new Error("Say which WhatsApp Business channel");
    await client.deleteWaBusinessTemplate(channel, name, id);
    await load(true);
  }, [client, channel, load]);
  return { templates: data.templates, ...(data.syncedAt ? { syncedAt: data.syncedAt } : {}), isLoading, error, sync: () => load(true), create, edit, remove };
}

export interface UseWaConversationReturn {
  conversation: WaBusinessConversation | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  /** Any message type inside the window (with a base64 file for media); refreshes the conversation. */
  send: (message: WaBizOutbound, file?: WaBizFileInput) => Promise<{ status: "sent"; ids: string[] }>;
  /** A template (business-initiated), with every component's values. */
  sendTemplate: (input: { template: string; language?: string; params?: string[]; components?: WaBizTemplateInput; queue?: boolean; reason?: string }) => Promise<WaBusinessSendResult>;
  /** React to a message ("" removes the reaction). */
  react: (messageId: string, emoji: string) => Promise<void>;
  /** Mark the contact's message read, optionally with the typing indicator. */
  markRead: (messageId: string, typing?: boolean) => Promise<void>;
}

/** A contact's conversation: messages (media, interactive, templates, replies, reactions), the 24-hour window, opt-in and opt-out (live), with the send actions. */
export function useWaConversation(channel: string | undefined, waId: string | undefined, limit = 50): UseWaConversationReturn {
  const { client } = usePolpoContext();
  const [conversation, setConversation] = useState<WaBusinessConversation>();
  const [isLoading, setIsLoading] = useState(!!(channel && waId));
  const [error, setError] = useState<Error | null>(null);
  const refetch = useCallback(async () => {
    if (!channel || !waId) return;
    try {
      setConversation(await client.getWaBusinessConversation(channel, waId, limit));
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [client, channel, waId, limit]);
  useEffect(() => {
    setIsLoading(true);
    refetch().finally(() => setIsLoading(false));
  }, [refetch]);
  useRefetchOn(["channel:message-status", "channel:wabiz-event"], () => { void refetch(); }, channel);
  const need = useCallback(() => {
    if (!channel || !waId) throw new Error("Say which channel and contact");
    return { channel, waId };
  }, [channel, waId]);
  const send = useCallback(async (message: WaBizOutbound, file?: WaBizFileInput) => {
    const t = need();
    const r = await client.sendWaBusinessMessage(t.channel, { to: t.waId, message, ...(file ? { file } : {}) });
    await refetch();
    return r;
  }, [client, need, refetch]);
  const sendTemplate = useCallback(async (input: { template: string; language?: string; params?: string[]; components?: WaBizTemplateInput; queue?: boolean; reason?: string }) => {
    const t = need();
    const r = await client.sendWaBusinessTemplate(t.channel, { to: t.waId, ...input });
    await refetch();
    return r;
  }, [client, need, refetch]);
  const react = useCallback(async (messageId: string, emoji: string) => {
    const t = need();
    await client.reactWaBusiness(t.channel, { to: t.waId, messageId, emoji });
    await refetch();
  }, [client, need, refetch]);
  const markRead = useCallback(async (messageId: string, typing?: boolean) => {
    const t = need();
    await client.markWaBusinessRead(t.channel, messageId, typing ? { typing: true } : {});
  }, [client, need]);
  return { conversation, isLoading, error, refetch, send, sendTemplate, react, markRead };
}

export interface UseWaContactsReturn {
  contacts: WaBusinessContact[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  /** Record the contact's opt-in (true) or opt-out (false). */
  setOptIn: (waId: string, optIn: boolean, source?: string) => Promise<void>;
  /** Erase the contact and its messages (GDPR). */
  erase: (waId: string) => Promise<void>;
  /** Block (true) or unblock (false) the contact at Meta. */
  setBlocked: (waId: string, blocked: boolean) => Promise<WaBusinessBlockResult>;
}

/** A WhatsApp Business channel's contacts (window, opt-in, opt-out, blocked), with the opt-in / opt-out, block and erasure actions. */
export function useWaContacts(channel: string | undefined, limit = 100): UseWaContactsReturn {
  const { client } = usePolpoContext();
  const [contacts, setContacts] = useState<WaBusinessContact[]>([]);
  const [isLoading, setIsLoading] = useState(!!channel);
  const [error, setError] = useState<Error | null>(null);
  const refetch = useCallback(async () => {
    if (!channel) return;
    try {
      setContacts(await client.getWaBusinessContacts(channel, limit));
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [client, channel, limit]);
  useEffect(() => {
    setIsLoading(true);
    refetch().finally(() => setIsLoading(false));
  }, [refetch]);
  useRefetchOn(WABIZ_EVENTS, () => { void refetch(); }, channel);
  const setOptIn = useCallback(async (waId: string, optIn: boolean, source?: string) => {
    if (!channel) return;
    await client.setWaBusinessOptIn(channel, waId, optIn, source);
    await refetch();
  }, [client, channel, refetch]);
  const erase = useCallback(async (waId: string) => {
    if (!channel) return;
    await client.deleteWaBusinessContact(channel, waId);
    await refetch();
  }, [client, channel, refetch]);
  const setBlocked = useCallback(async (waId: string, blocked: boolean) => {
    if (!channel) throw new Error("Say which WhatsApp Business channel");
    const r = await client.blockWaBusinessUsers(channel, [waId], blocked);
    await refetch();
    return r;
  }, [client, channel, refetch]);
  return { contacts, isLoading, error, refetch, setOptIn, erase, setBlocked };
}

export interface UseWaPendingReturn {
  pending: WaBusinessMessage[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  approve: (id: string, by?: string) => Promise<{ id: string; sentAs: string }>;
  reject: (id: string, reason?: string, by?: string) => Promise<void>;
}

/** Templates queued by agents and Polpo, waiting for an operator's approval (live). */
export function useWaPending(channel: string | undefined): UseWaPendingReturn {
  const { client } = usePolpoContext();
  const load = useCallback(() => client.getWaBusinessPending(channel!), [client, channel]);
  const { data, isLoading, error, refetch } = useLoad<WaBusinessMessage[]>(!!channel, load, []);
  useRefetchOn(["channel:message-status"], () => { void refetch(); }, channel);
  const approve = useCallback(async (id: string, by?: string) => {
    const r = await client.approveWaBusinessSend(channel!, id, by);
    await refetch();
    return r;
  }, [client, channel, refetch]);
  const reject = useCallback(async (id: string, reason?: string, by?: string) => {
    await client.rejectWaBusinessSend(channel!, id, reason, by);
    await refetch();
  }, [client, channel, refetch]);
  return { pending: data, isLoading, error, refetch, approve, reject };
}

export interface UseWaBusinessProfileReturn {
  profile: WaBusinessProfile | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  /** Save the profile (and its photo, base64: needs business.appId). */
  update: (profile: Omit<WaBusinessProfile, "profilePictureUrl"> & { photo?: WaBizFileInput }) => Promise<WaBusinessProfile>;
}

/** The business profile shown in WhatsApp (about, description, address, email, websites, vertical, photo). */
export function useWaBusinessProfile(channel: string | undefined): UseWaBusinessProfileReturn {
  const { client } = usePolpoContext();
  const load = useCallback(() => client.getWaBusinessProfile(channel!), [client, channel]);
  const { data, setData, isLoading, error, refetch } = useLoad<WaBusinessProfile | undefined>(!!channel, load, undefined);
  const update = useCallback(async (profile: Omit<WaBusinessProfile, "profilePictureUrl"> & { photo?: WaBizFileInput }) => {
    if (!channel) throw new Error("Say which WhatsApp Business channel");
    const saved = await client.updateWaBusinessProfile(channel, profile);
    setData(saved);
    return saved;
  }, [client, channel, setData]);
  return { profile: data, isLoading, error, refetch, update };
}

export interface UseWaBlockedReturn {
  blocked: string[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  block: (users: string[]) => Promise<WaBusinessBlockResult>;
  unblock: (users: string[]) => Promise<WaBusinessBlockResult>;
}

/** The contacts blocked at Meta, with block / unblock. */
export function useWaBlocked(channel: string | undefined): UseWaBlockedReturn {
  const { client } = usePolpoContext();
  const load = useCallback(() => client.getWaBusinessBlocked(channel!), [client, channel]);
  const { data, isLoading, error, refetch } = useLoad<string[]>(!!channel, load, []);
  const run = useCallback(async (users: string[], block: boolean) => {
    if (!channel) throw new Error("Say which WhatsApp Business channel");
    const r = await client.blockWaBusinessUsers(channel, users, block);
    await refetch();
    return r;
  }, [client, channel, refetch]);
  return { blocked: data, isLoading, error, refetch, block: (u) => run(u, true), unblock: (u) => run(u, false) };
}

export interface UseWaAnalyticsReturn {
  /** Meta's data points as returned (data_points per kind). */
  data: unknown;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/** Meta's analytics for the number: messages, pricing or templates, over [start, end] (Unix seconds). Pass undefined to wait. */
export function useWaAnalytics(channel: string | undefined, query: WaBusinessAnalyticsQuery | undefined): UseWaAnalyticsReturn {
  const { client } = usePolpoContext();
  const key = query ? JSON.stringify(query) : "";
  const load = useCallback(() => client.getWaBusinessAnalytics(channel!, JSON.parse(key) as WaBusinessAnalyticsQuery), [client, channel, key]);
  const { data, isLoading, error, refetch } = useLoad<unknown>(!!channel && !!key, load, undefined);
  return { data, isLoading, error, refetch };
}

export interface UseWaAccountEventsReturn {
  events: WaBusinessAccountEvent[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/** Account updates from Meta (quality, tier, display name review, templates, capabilities, alerts), newest first, live. */
export function useWaAccountEvents(channel: string | undefined, limit = 50): UseWaAccountEventsReturn {
  const { client } = usePolpoContext();
  const load = useCallback(() => client.getWaBusinessAccountEvents(channel!, limit), [client, channel, limit]);
  const { data, isLoading, error, refetch } = useLoad<WaBusinessAccountEvent[]>(!!channel, load, []);
  useRefetchOn(["channel:wabiz-event"], () => { void refetch(); }, channel, (d) => d.kind === "account");
  return { events: data, isLoading, error, refetch };
}

export interface UseWaPhoneReturn {
  /** This number's callback at Meta (undefined until loaded, or when it cannot be read). */
  webhook: WaBusinessWebhookOverride | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  /** Point this number's deliveries at this instance (true) or back to the app's callback (false). */
  setOverride: (set: boolean) => Promise<WaBusinessWebhookOverride>;
  /** Register, deregister, two-step PIN, request / verify the code, subscribe the app. */
  action: (a: WaBusinessPhoneAction) => Promise<void>;
}

/** The phone number at Meta: the webhook override (one app shared by several instances) and the number's actions. */
export function useWaPhone(channel: string | undefined, o: { loadWebhook?: boolean } = {}): UseWaPhoneReturn {
  const { client } = usePolpoContext();
  const enabled = !!channel && o.loadWebhook !== false;
  const load = useCallback(() => client.getWaBusinessWebhookOverride(channel!), [client, channel]);
  const { data, setData, isLoading, error, refetch } = useLoad<WaBusinessWebhookOverride | undefined>(enabled, load, undefined);
  const setOverride = useCallback(async (set: boolean) => {
    if (!channel) throw new Error("Say which WhatsApp Business channel");
    const r = await client.setWaBusinessWebhookOverride(channel, set);
    setData(r);
    return r;
  }, [client, channel, setData]);
  const action = useCallback(async (a: WaBusinessPhoneAction) => {
    if (!channel) throw new Error("Say which WhatsApp Business channel");
    await client.waBusinessPhoneAction(channel, a);
  }, [client, channel]);
  return { webhook: data, isLoading, error, refetch, setOverride, action };
}

export interface UseWaBusinessEventsReturn {
  /** The structured events seen since the page loaded, newest first (flow completions, orders, payments, replies, reactions, account updates). */
  events: Array<WaBusinessLiveEvent & { id: string; at: string }>;
}

/** Live "channel:wabiz-event" events (only this channel's, when given). */
export function useWaBusinessEvents(channel?: string, max = 50): UseWaBusinessEventsReturn {
  const { events } = useEvents(["channel:wabiz-event"], max);
  const out = useMemo(() => events
    .map((e) => ({ ...(e.data as WaBusinessLiveEvent), id: e.id, at: e.timestamp }))
    .filter((e) => !channel || e.channel === channel)
    .reverse(), [events, channel]);
  return { events: out };
}

export interface UseWaMediaReturn {
  /** An object URL for <img>, <audio>, <video> or a download link (revoked when the component goes away). */
  url: string | undefined;
  contentType: string | undefined;
  filename: string | undefined;
  isLoading: boolean;
  error: Error | null;
}

/** A message's file, fetched with the client's credentials, as an object URL. Pass enabled: false to wait (lazy thumbnails). */
export function useWaMedia(channel: string | undefined, messageId: string | undefined, enabled = true): UseWaMediaReturn {
  const { client } = usePolpoContext();
  const [state, setState] = useState<{ url?: string; contentType?: string; filename?: string; error: Error | null; isLoading: boolean }>({ error: null, isLoading: false });
  useEffect(() => {
    if (!channel || !messageId || !enabled) return;
    let alive = true;
    let url: string | undefined;
    setState({ error: null, isLoading: true });
    client.getWaBusinessMedia(channel, messageId).then((f) => {
      if (!alive) return;
      const make = (globalThis.URL as { createObjectURL?: (b: Blob) => string } | undefined)?.createObjectURL;
      url = make ? make(new Blob([f.bytes], { type: f.contentType })) : undefined;
      setState({ url, contentType: f.contentType, ...(f.filename ? { filename: f.filename } : {}), error: null, isLoading: false });
    }).catch((err: Error) => { if (alive) setState({ error: err, isLoading: false }); });
    return () => {
      alive = false;
      if (url) (globalThis.URL as { revokeObjectURL?: (u: string) => void }).revokeObjectURL?.(url);
    };
  }, [client, channel, messageId, enabled]);
  return { url: state.url, contentType: state.contentType, filename: state.filename, isLoading: state.isLoading, error: state.error };
}
