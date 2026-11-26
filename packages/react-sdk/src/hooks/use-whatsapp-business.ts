import { useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useEvents } from "./use-events.js";
import type { WaBusinessContact, WaBusinessConversation, WaBusinessStatus, WaBusinessTemplate } from "@polpo-ai/sdk";

/** Live: a delivery recorded or a message's status changed. */
const WABIZ_EVENTS = ["channel:webhook", "channel:message-status"];

/** Refetch when one of the events arrives (after the first load). */
function useRefetchOn(events: string[], refetch: () => void, channel?: string) {
  const { events: seen } = useEvents(events, 1);
  const last = seen.at(-1);
  const handled = useRef(last?.id);
  useEffect(() => {
    if (!last?.id || handled.current === last.id) return;
    handled.current = last.id;
    const ch = (last.data as { channel?: string } | undefined)?.channel;
    if (!channel || !ch || ch === channel) refetch();
  }, [last, refetch, channel]);
}

export interface UseWaBusinessStatusReturn {
  /** Every WhatsApp Business channel (or only `channel`). */
  channels: WaBusinessStatus[];
  status: WaBusinessStatus | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/** WhatsApp Business channels' status, live (webhook deliveries and message statuses refresh it). */
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
}

/** The account's message templates (synced from Meta). */
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
  return { templates: data.templates, ...(data.syncedAt ? { syncedAt: data.syncedAt } : {}), isLoading, error, sync: () => load(true) };
}

export interface UseWaConversationReturn {
  conversation: WaBusinessConversation | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/** A contact's conversation: messages, the 24-hour window, opt-in and opt-out (live). */
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
  useRefetchOn(["channel:message-status"], () => { void refetch(); }, channel);
  return { conversation, isLoading, error, refetch };
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
}

/** A WhatsApp Business channel's contacts (window, opt-in, opt-out), with the opt-in / opt-out and erasure actions. */
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
  return { contacts, isLoading, error, refetch, setOptIn, erase };
}
