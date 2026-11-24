/** Learning from conversations: an agent's settings, what it changed, review now, undo. */
import { apiUrl, config } from "@/lib/config";

export interface LearningSettings {
  enabled?: boolean;
  everyMessages?: number;
  idleMinutes?: number;
  skills?: boolean;
}

export interface LearningChange {
  id: string;
  agent: string;
  at: string;
  kind: "memory" | "skill-created" | "skill-updated";
  target: string;
  before: string;
  after: string;
  source: "review" | "chat";
  revertedAt?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  if (config.apiKey) headers.set("authorization", `Bearer ${config.apiKey}`);
  let response: Response;
  try {
    response = await fetch(apiUrl(`/api/v1${path}`), { ...init, headers, credentials: "include" });
  } catch {
    throw new Error("Could not reach the Polpo server");
  }
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: unknown; error?: unknown } | null;
  if (!response.ok || !body?.ok) {
    const error = typeof body?.error === "string" ? body.error : (body?.error as { message?: string } | undefined)?.message;
    throw new Error(error || `Learning request failed (${response.status})`);
  }
  return body.data as T;
}

const agentPath = (name: string) => `/learning/${encodeURIComponent(name)}`;

export const learningApi = {
  get: (agent: string) => request<{ learning: LearningSettings; changes: LearningChange[] }>(agentPath(agent)),
  save: (agent: string, learning: LearningSettings) =>
    request<unknown>(`/agents/${encodeURIComponent(agent)}`, { method: "PATCH", body: JSON.stringify({ learning, publish: false }) }),
  reviewNow: (agent: string) => request<{ changes: LearningChange[] }>(`${agentPath(agent)}/review`, { method: "POST" }),
  revert: (agent: string, id: string) =>
    request<{ change: LearningChange }>(`${agentPath(agent)}/changes/${encodeURIComponent(id)}/revert`, { method: "POST" }),
};
