import { useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useEvents } from "./use-events.js";
import type { ComputerDesktopView, ComputerTakeoverRequest } from "@polpo-ai/sdk";

/** Live: control changed hands, an agent asked for a person, the live view started or stopped, the machine's status. */
const DESKTOP_EVENTS = ["computer:takeover", "computer:changed"];

function useRefetchOn(refetch: () => void, match: (data: unknown) => boolean) {
  const { events } = useEvents(DESKTOP_EVENTS, 5);
  const last = events.at(-1);
  const handled = useRef(last?.id);
  useEffect(() => {
    if (!last?.id || handled.current === last.id) return;
    handled.current = last.id;
    if (match(last.data)) refetch();
  }, [last, refetch, match]);
}

export interface UseComputerDesktopReturn {
  /** The live view, who holds the desktop, its agents' requests; with viewer, this person's VNC access while it runs. */
  view: ComputerDesktopView | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  /** Start the live view (starts or wakes the computer). */
  start: () => Promise<ComputerDesktopView>;
  stop: () => Promise<ComputerDesktopView>;
  /** Take control (the agent's browser waits); force: from another person. */
  takeover: (o?: { force?: boolean }) => Promise<ComputerDesktopView>;
  /** Give control back to the agent, with an optional note. */
  release: (o?: { note?: string; force?: boolean }) => Promise<ComputerDesktopView>;
}

/**
 * A remote computer's live view and take control, live (`computer:takeover`, `computer:changed`).
 * `viewer: true` also fetches this person's VNC password (full control only while they hold it)
 * for a noVNC client on `view.viewer.path`.
 */
export function useComputerDesktop(id: string | undefined, o: { viewer?: boolean } = {}): UseComputerDesktopReturn {
  const { client } = usePolpoContext();
  const [view, setView] = useState<ComputerDesktopView>();
  const [isLoading, setLoading] = useState(!!id);
  const [error, setError] = useState<Error | null>(null);
  const viewer = !!o.viewer;
  const refetch = useCallback(async () => {
    if (!id) return;
    try {
      setView(await client.getComputerDesktop(id, { viewer }));
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [client, id, viewer]);
  useEffect(() => { void refetch(); }, [refetch]);
  const mine = useCallback((data: unknown) => (data as { id?: string } | undefined)?.id === id, [id]);
  useRefetchOn(() => { void refetch(); }, mine);
  const apply = useCallback(async (p: Promise<ComputerDesktopView>) => {
    const v = await p;
    setView(v);
    setError(null);
    return v;
  }, []);
  const need = () => { if (!id) throw new Error("No computer"); return id; };
  return {
    view, isLoading, error, refetch,
    start: () => apply(client.startComputerDesktop(need())),
    stop: () => apply(client.stopComputerDesktop(need())),
    takeover: (x = {}) => apply(client.takeoverComputer(need(), x)),
    release: (x = {}) => apply(client.releaseComputer(need(), x)),
  };
}

export interface UseComputerTakeoversReturn {
  /** Agents waiting for a person (open takeover requests of all computers), oldest first. */
  requests: ComputerTakeoverRequest[];
  refetch: () => Promise<void>;
}

/** Every agent waiting for a person to take control of its computer, live. */
export function useComputerTakeovers(): UseComputerTakeoversReturn {
  const { client } = usePolpoContext();
  const [requests, setRequests] = useState<ComputerTakeoverRequest[]>([]);
  const refetch = useCallback(async () => {
    try { setRequests(await client.getComputerTakeovers()); } catch { /* keeps the last list */ }
  }, [client]);
  useEffect(() => { void refetch(); }, [refetch]);
  const any = useCallback((data: unknown) => typeof (data as { action?: unknown } | undefined)?.action === "string", []);
  useRefetchOn(() => { void refetch(); }, any);
  return { requests, refetch };
}
