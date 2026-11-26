import { useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useEvents } from "./use-events.js";
import type {
  CodingChatApproval, CodingChatCreateRequest, CodingChatEvent, CodingChatKind, CodingChatMessage, CodingChatSession, CodingChatSummary,
} from "@polpo-ai/sdk";

const CODING_EVENTS = ["coding:chat"];

export interface UseCodingChatsReturn {
  chats: CodingChatSummary[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  createChat: (req: CodingChatCreateRequest) => Promise<CodingChatSession>;
  deleteChat: (id: string) => Promise<void>;
}

/** Coding chat sessions (Claude Code / Codex in a worktree), live: created, changed and deleted ones refresh the list. */
export function useCodingChats(o: { cwd?: string; workspaceId?: string; kind?: CodingChatKind; enabled?: boolean } = {}): UseCodingChatsReturn {
  const { client } = usePolpoContext();
  const [chats, setChats] = useState<CodingChatSummary[]>([]);
  const [isLoading, setIsLoading] = useState(o.enabled !== false);
  const [error, setError] = useState<Error | null>(null);
  const enabled = o.enabled !== false;
  const { cwd, workspaceId, kind } = o;
  const refetch = useCallback(async () => {
    if (!enabled) return;
    try {
      setChats(await client.getCodingChats({ ...(cwd ? { cwd } : {}), ...(workspaceId ? { workspaceId } : {}), ...(kind ? { kind } : {}) }));
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [client, enabled, cwd, workspaceId, kind]);
  useEffect(() => {
    setIsLoading(true);
    refetch().finally(() => setIsLoading(false));
  }, [refetch]);
  const { events } = useEvents(CODING_EVENTS, 1);
  const last = events.at(-1);
  const handled = useRef(last?.id);
  useEffect(() => {
    if (!last?.id || handled.current === last.id) return;
    handled.current = last.id;
    void refetch();
  }, [last, refetch]);
  const createChat = useCallback(async (req: CodingChatCreateRequest) => {
    const s = await client.createCodingChat(req);
    await refetch();
    return s;
  }, [client, refetch]);
  const deleteChat = useCallback(async (id: string) => {
    await client.deleteCodingChat(id);
    await refetch();
  }, [client, refetch]);
  return { chats, isLoading, error, refetch, createChat, deleteChat };
}

export interface UseCodingChatReturn {
  session: CodingChatSession | null;
  isLoading: boolean;
  error: Error | null;
  /** Live stream connected. */
  live: boolean;
  /** A new turn, or a steer while one runs. */
  send: (text: string) => Promise<{ steered: boolean }>;
  stop: () => Promise<void>;
  approve: (approvalId: string) => Promise<CodingChatApproval>;
  deny: (approvalId: string) => Promise<CodingChatApproval>;
  refetch: () => Promise<void>;
}

function upsertMessage(messages: CodingChatMessage[], m: CodingChatMessage): CodingChatMessage[] {
  const i = messages.findIndex((x) => x.id === m.id);
  if (i < 0) return [...messages, m];
  const next = messages.slice();
  next[i] = m;
  return next;
}

/**
 * One coding chat, live: the transcript as it is written (the session's event stream), approvals,
 * and the actions. `onFilesChanged` is called when the program changed the worktree (refresh its
 * changes).
 */
export function useCodingChat(id: string | null | undefined, o: { onFilesChanged?: (tool: string) => void } = {}): UseCodingChatReturn {
  const { client } = usePolpoContext();
  const [session, setSession] = useState<CodingChatSession | null>(null);
  const [isLoading, setIsLoading] = useState(!!id);
  const [error, setError] = useState<Error | null>(null);
  const [live, setLive] = useState(false);
  const onFiles = useRef(o.onFilesChanged);
  useEffect(() => { onFiles.current = o.onFilesChanged; }, [o.onFilesChanged]);

  const refetch = useCallback(async () => {
    if (!id) return;
    try {
      setSession(await client.getCodingChat(id));
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [client, id]);

  useEffect(() => {
    if (!id) { setSession(null); setIsLoading(false); return; }
    let cancelled = false;
    const ctrl = new AbortController();
    setIsLoading(true);
    void refetch().finally(() => { if (!cancelled) setIsLoading(false); });
    const apply = (e: CodingChatEvent) => {
      if (cancelled) return;
      if (e.type === "files-changed") { onFiles.current?.(e.tool); return; }
      if (e.type === "deleted") { setSession(null); return; }
      setSession((cur) => {
        if (!cur) return cur;
        if (e.type === "session") {
          const { messageCount: _m, pendingApprovals: _p, preview: _v, ...rest } = e.session;
          return { ...cur, ...rest };
        }
        if (e.type === "message") return { ...cur, messages: upsertMessage(cur.messages, e.message) };
        const i = cur.approvals.findIndex((a) => a.id === e.approval.id);
        return { ...cur, approvals: i < 0 ? [...cur.approvals, e.approval] : cur.approvals.map((a) => (a.id === e.approval.id ? e.approval : a)) };
      });
    };
    // follow the stream; reconnect (with a fresh read) when it drops
    void (async () => {
      let delay = 1000;
      while (!cancelled) {
        try {
          setLive(true);
          await client.streamCodingChat(id, apply, ctrl.signal);
          delay = 1000;
        } catch {
          delay = Math.min(delay * 2, 15_000);
        }
        setLive(false);
        if (cancelled) return;
        await new Promise((r) => setTimeout(r, delay));
        if (!cancelled) await refetch();
      }
    })();
    return () => { cancelled = true; ctrl.abort(); setLive(false); };
  }, [client, id, refetch]);

  const send = useCallback(async (text: string) => {
    if (!id) throw new Error("No coding chat");
    const r = await client.sendCodingChatMessage(id, text);
    setSession((cur) => (cur && cur.messages.length >= r.session.messages.length ? { ...cur, status: r.session.status } : r.session));
    return { steered: r.steered };
  }, [client, id]);
  const stop = useCallback(async () => {
    if (!id) return;
    setSession(await client.stopCodingChat(id));
  }, [client, id]);
  const resolve = useCallback(async (approvalId: string, decision: "approve" | "deny") => {
    if (!id) throw new Error("No coding chat");
    const a = await client.resolveCodingChatApproval(id, approvalId, decision);
    setSession((cur) => (cur ? { ...cur, approvals: cur.approvals.map((x) => (x.id === a.id ? a : x)) } : cur));
    return a;
  }, [client, id]);
  const approve = useCallback((approvalId: string) => resolve(approvalId, "approve"), [resolve]);
  const deny = useCallback((approvalId: string) => resolve(approvalId, "deny"), [resolve]);
  return { session, isLoading, error, live, send, stop, approve, deny, refetch };
}
