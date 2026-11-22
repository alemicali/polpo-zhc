/**
 * Agent harnesses (Claude Code, Codex as an agent's engine) — thin client for /api/v1/harnesses,
 * the settings (PATCH /config/settings { harnesses }) and an agent's engine (PATCH /agents/:name).
 * Credentials are vault references only (owner + service); values never reach the dashboard.
 *
 * Mirrors packages/core/src/harnesses.ts.
 */
import { apiUrl, config } from "@/lib/config";
import type { VaultRef } from "@/lib/vault-ref";

export type HarnessId = "claude-code" | "codex";
export const HARNESS_NAMES: Record<HarnessId, string> = { "claude-code": "Claude Code", codex: "Codex" };
export type ClaudeCodeAuth = "api-key" | "bedrock" | "vertex";
export const CLAUDE_CODE_AUTH_LABELS: Record<ClaudeCodeAuth, string> = {
  "api-key": "Anthropic API key", bedrock: "Amazon Bedrock", vertex: "Google Vertex AI",
};
export type HarnessPermissionMode = "allow-all" | "allow-edits" | "allow-reads";
export type HarnessEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentHarnessEngine {
  harness: HarnessId;
  model?: string;
  permissionMode?: HarnessPermissionMode;
  effort?: HarnessEffort;
  maxBudgetUsd?: number;
}

export interface HarnessItem {
  id: HarnessId;
  name: string;
  enabled: boolean;
  auth?: string;
  credentialRef?: VaultRef;
  credentialFound?: boolean;
  model?: string;
  bedrock?: { region: string };
  vertex?: { region: string; projectId: string };
  agents: string[];
}

export interface HarnessesOverview {
  allowHost: boolean;
  harnesses: HarnessItem[];
  /** Computers that can run a harness. */
  computers: string[];
}

export interface HarnessSession {
  key: string;
  agent: string;
  harness: HarnessId;
  computerId: string;
  scope: "task" | "chat";
  taskId?: string;
  state: string;
  live: boolean;
  bootstrappedAt?: string;
  bootstrapMs?: number;
  lastDetachAt?: string;
  lastResumeAt?: string;
  resumable: boolean;
  turns: number;
  costUsd: number;
  lastError?: string;
  updatedAt: string;
}

/** settings.harnesses as saved. */
export interface HarnessesSettings {
  enabled: HarnessId[];
  allowHost?: boolean;
  "claude-code"?: { auth: ClaudeCodeAuth; credentialRef: VaultRef; bedrock?: { region: string }; vertex?: { region: string; projectId: string }; model?: string };
  codex?: { auth: "api-key"; credentialRef: VaultRef; model?: string };
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
    throw new Error(error || `Request failed (${response.status})`);
  }
  return body.data as T;
}

const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const harnessesApi = {
  overview: () => request<HarnessesOverview>("/harnesses"),
  sessions: (filter: { agent?: string; computer?: string } = {}) => {
    const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => !!v) as Array<[string, string]>);
    return request<{ sessions: HarnessSession[] }>(`/harnesses/sessions${q.size ? `?${q}` : ""}`).then((d) => d.sessions);
  },
  control: (key: string, action: "stop" | "reset") =>
    request<{ message: string }>(`/harnesses/sessions/${encodeURIComponent(key)}/${action}`, json("POST", action === "reset" ? { confirm: true } : undefined)),
  /** Replace settings.harnesses (null removes it). */
  save: (harnesses: HarnessesSettings | null) => request<unknown>("/config/settings", json("PATCH", { harnesses })),
  /** An agent's engine: "polpo" (Polpo's own) or a harness. */
  setEngine: (agent: string, engine: "polpo" | AgentHarnessEngine) => request<unknown>(`/agents/${encodeURIComponent(agent)}`, json("PATCH", { engine })),
};

/** The settings as saved, from the overview (what the form edits). */
export function settingsFromOverview(o: HarnessesOverview): HarnessesSettings {
  const cc = o.harnesses.find((h) => h.id === "claude-code");
  const cx = o.harnesses.find((h) => h.id === "codex");
  return {
    enabled: o.harnesses.filter((h) => h.enabled).map((h) => h.id),
    ...(o.allowHost ? { allowHost: true } : {}),
    ...(cc?.auth && cc.credentialRef ? { "claude-code": {
      auth: cc.auth as ClaudeCodeAuth, credentialRef: cc.credentialRef,
      ...(cc.bedrock ? { bedrock: cc.bedrock } : {}), ...(cc.vertex ? { vertex: cc.vertex } : {}), ...(cc.model ? { model: cc.model } : {}),
    } } : {}),
    ...(cx?.credentialRef ? { codex: { auth: "api-key" as const, credentialRef: cx.credentialRef, ...(cx.model ? { model: cx.model } : {}) } } : {}),
  };
}
