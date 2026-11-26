/**
 * Agent conversations — how agents talked to each other (ask_agent / message_agent).
 *
 * Thin client for GET /api/v1/agent-talk plus the pair transcripts (chat sessions of the
 * receiving agent). Same envelope ({ ok, data } / { ok, error }) and auth conventions as the
 * other page-level clients (rooms-api, use-apps): the key goes in a header, never in the URL.
 */
import { apiUrl, config } from "@/lib/config";

/** One exchange between two agents (mirrors AgentExchange in src/server/agent-talk.ts). */
export interface AgentExchange {
  id: string;
  from: string;
  to: string;
  kind: "question" | "handoff" | "escalation";
  message: string;
  status: "working" | "answered" | "failed";
  answer?: string;
  error?: string;
  /** The conversation the writer was in (the answer goes back there). */
  fromSessionId?: string;
  /** The task the writer was working, when it wrote from a task run. */
  fromTaskId?: string;
  /** The pair's conversation (a session of the receiving agent). */
  dmSessionId?: string;
  startedAt: string;
  answeredAt?: string;
}

/** A pair's conversation: one per direction. */
export interface AgentPair {
  from: string;
  to: string;
  sessionId: string;
}

export interface AgentTalkOverview {
  conversations: AgentPair[];
  /** Newest first. */
  recent: AgentExchange[];
}

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: string;
}

async function request<T>(path: string): Promise<T> {
  const headers = new Headers();
  if (config.apiKey) headers.set("authorization", `Bearer ${config.apiKey}`);
  let response: Response;
  try {
    response = await fetch(apiUrl(`/api/v1${path}`), { headers, credentials: "include" });
  } catch {
    throw new Error("Could not reach the Polpo server");
  }
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: unknown; error?: unknown } | null;
  if (!response.ok || !body?.ok) {
    const error = typeof body?.error === "string"
      ? body.error
      : (body?.error as { message?: string } | undefined)?.message;
    throw new Error(error || `Request failed (${response.status})`);
  }
  return body.data as T;
}

export const agentTalkApi = {
  overview: async (): Promise<AgentTalkOverview> => {
    const data = await request<Partial<AgentTalkOverview> | null>("/agent-talk");
    return {
      conversations: Array.isArray(data?.conversations) ? data.conversations : [],
      recent: Array.isArray(data?.recent) ? data.recent : [],
    };
  },
  transcript: async (sessionId: string): Promise<TranscriptMessage[]> => {
    const data = await request<{ messages?: TranscriptMessage[] } | null>(
      `/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
    );
    return Array.isArray(data?.messages) ? data.messages : [];
  },
};

export function isAgentExchange(value: unknown): value is AgentExchange {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.from === "string" && typeof v.to === "string"
    && typeof v.status === "string";
}

function time(value: string | undefined): number {
  const t = value ? Date.parse(value) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Merge exchanges by id (later copies win: a status update reuses the id) and keep them newest
 * first. Returns `current` itself when nothing changed, so callers can skip a re-render.
 */
export function mergeExchanges(current: AgentExchange[], incoming: AgentExchange[]): AgentExchange[] {
  if (incoming.length === 0) return current;
  const byId = new Map<string, AgentExchange>();
  for (const exchange of current) byId.set(exchange.id, exchange);
  let changed = false;
  for (const exchange of incoming) {
    const existing = byId.get(exchange.id);
    if (existing && JSON.stringify(existing) === JSON.stringify(exchange)) continue;
    // Events trim long texts: keep what the merged copy does not carry.
    byId.set(exchange.id, existing ? { ...existing, ...exchange } : exchange);
    changed = true;
  }
  if (!changed) return current;
  return [...byId.values()].sort((a, b) => time(b.startedAt) - time(a.startedAt));
}

/** Add the pair an exchange belongs to when it is not listed yet. */
export function mergePairs(current: AgentPair[], exchange: AgentExchange): AgentPair[] {
  if (!exchange.dmSessionId) return current;
  if (current.some((p) => p.sessionId === exchange.dmSessionId)) return current;
  return [{ from: exchange.from, to: exchange.to, sessionId: exchange.dmSessionId }, ...current];
}

/**
 * A message in a pair's conversation starts with a bracketed intro saying who wrote it
 * ("[health-coach asks you, …]\n<question>"): split it into the intro and the text.
 */
export function splitIntro(content: string): { intro: string | null; text: string } {
  const match = /^\[([^\]\n]+)\]\s*\n?/.exec(content);
  if (!match) return { intro: null, text: content };
  return { intro: match[1].trim(), text: content.slice(match[0].length) };
}
