import { useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useEvents } from "./use-events.js";
import type { Trigger, TriggerActionRun, TriggerActionsStatus, TriggerDelivery, TriggerDeliveryPage, TriggerDeliveryStatus, TriggerInput } from "@polpo-ai/sdk";

/** Live: a trigger changed, recorded a delivery, or a delivery's actions moved on. */
const TRIGGER_EVENTS = ["trigger:changed", "trigger:delivery", "trigger:actions"];

/** Refetch when one of the events arrives (after the first load); with `id`, only that trigger's. */
function useRefetchOn(refetch: () => void, id?: string) {
  const { events } = useEvents(TRIGGER_EVENTS, 1);
  const last = events.at(-1);
  const handled = useRef(last?.id);
  useEffect(() => {
    if (!last?.id || handled.current === last.id) return;
    handled.current = last.id;
    const d = last.data as { id?: string; triggerId?: string } | undefined;
    const of = d?.triggerId ?? d?.id;
    if (!id || !of || of === id) refetch();
  }, [last, refetch, id]);
}

export interface UseTriggersReturn {
  triggers: Trigger[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  /** Create one: `secret` (the generated one) is returned this once. */
  createTrigger: (input: TriggerInput & { name: string }) => Promise<{ trigger: Trigger; secret?: string }>;
  updateTrigger: (id: string, input: TriggerInput) => Promise<{ trigger: Trigger; secret?: string }>;
  deleteTrigger: (id: string) => Promise<void>;
}

/** The triggers (POST /hooks/{id}), live: changes and deliveries refresh them. */
export function useTriggers(): UseTriggersReturn {
  const { client } = usePolpoContext();
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const refetch = useCallback(async () => {
    try {
      setTriggers(await client.getTriggers());
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [client]);
  useEffect(() => {
    setIsLoading(true);
    refetch().finally(() => setIsLoading(false));
  }, [refetch]);
  useRefetchOn(() => { void refetch(); });
  const createTrigger = useCallback(async (input: TriggerInput & { name: string }) => {
    const r = await client.createTrigger(input);
    await refetch();
    return r;
  }, [client, refetch]);
  const updateTrigger = useCallback(async (id: string, input: TriggerInput) => {
    const r = await client.updateTrigger(id, input);
    await refetch();
    return r;
  }, [client, refetch]);
  const deleteTrigger = useCallback(async (id: string) => {
    await client.deleteTrigger(id);
    await refetch();
  }, [client, refetch]);
  return { triggers, isLoading, error, refetch, createTrigger, updateTrigger, deleteTrigger };
}

export interface UseTriggerDeliveriesReturn {
  page: TriggerDeliveryPage | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/** A trigger's deliveries (newest first, optionally by status), live: new deliveries refresh them. */
export function useTriggerDeliveries(id: string | undefined, o: { status?: TriggerDeliveryStatus[]; limit?: number; test?: boolean } = {}): UseTriggerDeliveriesReturn {
  const { client } = usePolpoContext();
  const [page, setPage] = useState<TriggerDeliveryPage | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(!!id);
  const [error, setError] = useState<Error | null>(null);
  const statusKey = (o.status ?? []).join(",");
  const refetch = useCallback(async () => {
    if (!id) return;
    try {
      setPage(await client.getTriggerDeliveries(id, {
        ...(statusKey ? { status: statusKey.split(",") as TriggerDeliveryStatus[] } : {}),
        ...(o.limit ? { limit: o.limit } : {}), ...(o.test !== undefined ? { test: o.test } : {}),
      }));
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [client, id, statusKey, o.limit, o.test]);
  useEffect(() => {
    if (!id) { setPage(undefined); return; }
    setIsLoading(true);
    refetch().finally(() => setIsLoading(false));
  }, [refetch, id]);
  useRefetchOn(() => { void refetch(); }, id);
  return { page, isLoading, error, refetch };
}

export interface UseTriggerDeliveryReturn {
  delivery: TriggerDelivery | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  /** Run the trigger's current actions again on this delivery (they run after the answer; the delivery refreshes live). */
  rerunActions: () => Promise<{ deliveryId: string; actionsStatus?: TriggerActionsStatus; actions: TriggerActionRun[] }>;
}

/** One delivery with its payload and each action's run, live: its actions' progress refreshes it. */
export function useTriggerDelivery(id: string | undefined, deliveryId: string | undefined): UseTriggerDeliveryReturn {
  const { client } = usePolpoContext();
  const [delivery, setDelivery] = useState<TriggerDelivery | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(!!(id && deliveryId));
  const [error, setError] = useState<Error | null>(null);
  const refetch = useCallback(async () => {
    if (!id || !deliveryId) return;
    try {
      setDelivery(await client.getTriggerDelivery(id, deliveryId));
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [client, id, deliveryId]);
  useEffect(() => {
    if (!id || !deliveryId) { setDelivery(undefined); return; }
    setIsLoading(true);
    refetch().finally(() => setIsLoading(false));
  }, [refetch, id, deliveryId]);
  useRefetchOn(() => { void refetch(); }, id);
  const rerunActions = useCallback(async () => {
    if (!id || !deliveryId) throw new Error("No delivery");
    const r = await client.rerunTriggerActions(id, deliveryId);
    await refetch();
    return r;
  }, [client, id, deliveryId, refetch]);
  return { delivery, isLoading, error, refetch, rerunActions };
}
