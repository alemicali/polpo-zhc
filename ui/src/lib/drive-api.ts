/** An agent's drive: its purpose and goals, self-portrait, intentions and reflections. */
import { apiUrl, config } from "@/lib/config";

export type DriveAutonomy = "propose" | "balanced" | "act";

export interface DriveSettings {
  enabled?: boolean;
  purpose?: string;
  goals?: string[];
  autonomy?: DriveAutonomy;
  reflectEveryMinutes?: number;
  dayStartsAt?: string;
}

export type GoalHorizon = "long" | "quarter" | "month" | "week" | "day";

export interface PlanItem {
  id: string;
  title: string;
  horizon?: GoalHorizon;
  parentId?: string;
  measure?: string;
  progress?: number;
  owner?: string;
  why?: string;
  goal?: string;
  status: "todo" | "doing" | "done" | "dropped";
  due?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Intention {
  id: string;
  state: "active" | "proposed" | "ended" | "cancelled";
  prompt: string;
  message?: string;
  why?: string;
  everyMinutes: number;
  cron?: string;
  timezone?: string;
  nextRunAt: string;
  runs: number;
  target?: { chatId: string; name?: string; conversation?: string };
}

export interface ReflectionEntry {
  id: string;
  at: string;
  trigger: "first" | "activity" | "daily" | "manual";
  messages: number;
  summary: string;
  actions: string[];
  reviews?: ("day" | "week" | "month" | "quarter")[];
}

export interface DriveData {
  drive: DriveSettings;
  self: string;
  plan: PlanItem[];
  intentions: Intention[];
  journal: ReflectionEntry[];
  lastReflectionAt: string | null;
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
    throw new Error(error || `Drive request failed (${response.status})`);
  }
  return body.data as T;
}

const agentPath = (name: string) => `/drive/${encodeURIComponent(name)}`;

export const driveApi = {
  get: (agent: string) => request<DriveData>(agentPath(agent)),
  save: (agent: string, drive: DriveSettings) =>
    request<unknown>(`/agents/${encodeURIComponent(agent)}`, { method: "PATCH", body: JSON.stringify({ drive }) }),
  saveSelf: (agent: string, portrait: string) =>
    request<unknown>(`${agentPath(agent)}/self`, { method: "PUT", body: JSON.stringify({ portrait }) }),
  reflectNow: (agent: string) => request<{ entry: ReflectionEntry }>(`${agentPath(agent)}/reflect`, { method: "POST" }),
  updatePlanItem: (agent: string, id: string, patch: Partial<Pick<PlanItem, "status" | "progress" | "notes">>) =>
    request<unknown>(`${agentPath(agent)}/plan/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  confirm: (agent: string, id: string) =>
    request<unknown>(`${agentPath(agent)}/intentions/${encodeURIComponent(id)}/confirm`, { method: "POST" }),
  cancel: (agent: string, id: string) =>
    request<unknown>(`${agentPath(agent)}/intentions/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
};
