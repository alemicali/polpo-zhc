import { PolpoApiError } from "./errors.js";
import type {
  Task,
  Plan,
  AgentConfig,
  AgentProcess,
  Team,
  PolpoState,
  PolpoConfig,
  ProjectInfo,
  HealthResponse,
  TaskFilters,
  CreateTaskRequest,
  UpdateTaskRequest,
  CreatePlanRequest,
  UpdatePlanRequest,
  AddAgentRequest,
  ExecutePlanResult,
  ResumePlanResult,
  ApiResult,
  LogSession,
  LogEntry,
  ChatSession,
  ChatMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  RunActivityEntry,
  SkillInfo,
  NotificationRecord,
  NotificationStats,
  SendNotificationRequest,
  SendNotificationResult,
  ApprovalRequest,
  ApprovalStatus,
  TemplateInfo,
  TemplateDefinition,
  TemplateRunResult,
} from "./types.js";

export interface PolpoClientConfig {
  baseUrl: string;
  projectId: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}

export class PolpoClient {
  private readonly baseUrl: string;
  private readonly projectId: string;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: typeof globalThis.fetch;
  /** In-flight GET deduplication */
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(config: PolpoClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.projectId = config.projectId;
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.headers = {};
    if (config.apiKey) {
      this.headers["x-api-key"] = config.apiKey;
    }
  }

  // ── Helpers ──────────────────────────────────────────────

  private projectUrl(path: string): string {
    return `${this.baseUrl}/api/v1/projects/${this.projectId}${path}`;
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(url, {
      method,
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as ApiResult<T>;
    if (!json.ok) {
      throw new PolpoApiError(json.error, json.code, res.status, json.details);
    }
    return json.data;
  }

  private get<T>(path: string): Promise<T> {
    const url = this.projectUrl(path);
    const existing = this.inflight.get(url);
    if (existing) return existing as Promise<T>;

    const promise = this.request<T>("GET", url);
    this.inflight.set(url, promise);
    promise.finally(() => this.inflight.delete(url));
    return promise;
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", this.projectUrl(path), body);
  }

  private patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", this.projectUrl(path), body);
  }

  private del<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", this.projectUrl(path));
  }

  // ── Tasks ────────────────────────────────────────────────

  getTasks(filters?: TaskFilters): Promise<Task[]> {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.group) params.set("group", filters.group);
    if (filters?.assignTo) params.set("assignTo", filters.assignTo);
    const qs = params.toString();
    return this.get<Task[]>(`/tasks${qs ? `?${qs}` : ""}`);
  }

  getTask(taskId: string): Promise<Task> {
    return this.get<Task>(`/tasks/${taskId}`);
  }

  createTask(req: CreateTaskRequest): Promise<Task> {
    return this.post<Task>("/tasks", req);
  }

  updateTask(taskId: string, req: UpdateTaskRequest): Promise<Task> {
    return this.patch<Task>(`/tasks/${taskId}`, req);
  }

  deleteTask(taskId: string): Promise<{ removed: boolean }> {
    return this.del<{ removed: boolean }>(`/tasks/${taskId}`);
  }

  retryTask(taskId: string): Promise<{ retried: boolean }> {
    return this.post<{ retried: boolean }>(`/tasks/${taskId}/retry`);
  }

  killTask(taskId: string): Promise<{ killed: boolean }> {
    return this.post<{ killed: boolean }>(`/tasks/${taskId}/kill`);
  }

  reassessTask(taskId: string): Promise<{ reassessed: boolean }> {
    return this.post<{ reassessed: boolean }>(`/tasks/${taskId}/reassess`);
  }

  // ── Plans ────────────────────────────────────────────────

  getPlans(): Promise<Plan[]> {
    return this.get<Plan[]>("/plans");
  }

  getResumablePlans(): Promise<Plan[]> {
    return this.get<Plan[]>("/plans/resumable");
  }

  getPlan(planId: string): Promise<Plan> {
    return this.get<Plan>(`/plans/${planId}`);
  }

  createPlan(req: CreatePlanRequest): Promise<Plan> {
    return this.post<Plan>("/plans", req);
  }

  updatePlan(planId: string, req: UpdatePlanRequest): Promise<Plan> {
    return this.patch<Plan>(`/plans/${planId}`, req);
  }

  deletePlan(planId: string): Promise<{ deleted: boolean }> {
    return this.del<{ deleted: boolean }>(`/plans/${planId}`);
  }

  executePlan(planId: string): Promise<ExecutePlanResult> {
    return this.post<ExecutePlanResult>(`/plans/${planId}/execute`);
  }

  resumePlan(planId: string, opts?: { retryFailed?: boolean }): Promise<ResumePlanResult> {
    return this.post<ResumePlanResult>(`/plans/${planId}/resume`, opts);
  }

  abortPlan(planId: string): Promise<{ aborted: number }> {
    return this.post<{ aborted: number }>(`/plans/${planId}/abort`);
  }

  // ── Agents ───────────────────────────────────────────────

  getAgents(): Promise<AgentConfig[]> {
    return this.get<AgentConfig[]>("/agents");
  }

  getAgent(name: string): Promise<AgentConfig> {
    return this.get<AgentConfig>(`/agents/${encodeURIComponent(name)}`);
  }

  addAgent(req: AddAgentRequest): Promise<{ added: boolean }> {
    return this.post<{ added: boolean }>("/agents", req);
  }

  removeAgent(name: string): Promise<{ removed: boolean }> {
    return this.del<{ removed: boolean }>(`/agents/${encodeURIComponent(name)}`);
  }

  getTeam(): Promise<Team> {
    return this.get<Team>("/agents/team");
  }

  renameTeam(name: string): Promise<Team> {
    return this.patch<Team>("/agents/team", { name });
  }

  getProcesses(): Promise<AgentProcess[]> {
    return this.get<AgentProcess[]>("/agents/processes");
  }

  // ── Project ──────────────────────────────────────────────

  getState(): Promise<PolpoState> {
    return this.get<PolpoState>("/state");
  }

  getConfig(): Promise<PolpoConfig> {
    return this.get<PolpoConfig>("/config");
  }

  getMemory(): Promise<{ exists: boolean; content: string }> {
    return this.get<{ exists: boolean; content: string }>("/memory");
  }

  saveMemory(content: string): Promise<{ saved: boolean }> {
    return this.request<{ saved: boolean }>("PUT", this.projectUrl("/memory"), { content });
  }

  getLogs(): Promise<LogSession[]> {
    return this.get<LogSession[]>("/logs");
  }

  getLogEntries(sessionId: string): Promise<LogEntry[]> {
    return this.get<LogEntry[]>(`/logs/${sessionId}`);
  }

  // ── Skills ───────────────────────────────────────────────

  /** Discover available skills in the project (.claude/skills/). */
  getSkills(): Promise<SkillInfo[]> {
    return this.get<SkillInfo[]>("/skills");
  }

  // ── Run Activity ────────────────────────────────────────────

  /** Get the full activity history for a task from its run JSONL log. */
  getTaskActivity(taskId: string): Promise<RunActivityEntry[]> {
    return this.get<RunActivityEntry[]>(`/agents/processes/${taskId}/activity`);
  }

  // ── Chat Completions (OpenAI-compatible) ─────────────────

  /**
   * Talk to Polpo via the OpenAI-compatible chat completions endpoint.
   * Non-streaming mode — returns the full response.
   */
  async chatCompletions(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const url = `${this.baseUrl}/v1/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.headers["x-api-key"]) {
      headers["Authorization"] = `Bearer ${this.headers["x-api-key"]}`;
    }
    const res = await this.fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...req, stream: false, project: req.project ?? this.projectId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
      throw new PolpoApiError(
        (err as any).error?.message ?? "Chat completions failed",
        res.status === 401 ? "AUTH_REQUIRED" : "INTERNAL_ERROR",
        res.status,
      );
    }
    return (await res.json()) as ChatCompletionResponse;
  }

  /**
   * Talk to Polpo via the OpenAI-compatible chat completions endpoint.
   * Streaming mode — returns an async generator of chunks.
   */
  async *chatCompletionsStream(req: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    const url = `${this.baseUrl}/v1/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.headers["x-api-key"]) {
      headers["Authorization"] = `Bearer ${this.headers["x-api-key"]}`;
    }
    const res = await this.fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...req, stream: true, project: req.project ?? this.projectId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
      throw new PolpoApiError(
        (err as any).error?.message ?? "Chat completions failed",
        res.status === 401 ? "AUTH_REQUIRED" : "INTERNAL_ERROR",
        res.status,
      );
    }
    const reader = res.body?.getReader();
    if (!reader) throw new PolpoApiError("No response body", "INTERNAL_ERROR", 500);

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data) as ChatCompletionChunk;
        } catch {
          // skip malformed chunks
        }
      }
    }
  }

  // ── Sessions ────────────────────────────────────────────

  getSessions(): Promise<{ sessions: ChatSession[] }> {
    return this.get<{ sessions: ChatSession[] }>("/chat/sessions");
  }

  getSessionMessages(sessionId: string): Promise<{ session: ChatSession; messages: ChatMessage[] }> {
    return this.get<{ session: ChatSession; messages: ChatMessage[] }>(`/chat/sessions/${sessionId}/messages`);
  }

  deleteSession(sessionId: string): Promise<{ deleted: boolean }> {
    return this.del<{ deleted: boolean }>(`/chat/sessions/${sessionId}`);
  }

  // ── Notifications ────────────────────────────────────────

  /** List notification history. */
  getNotifications(opts?: { limit?: number; status?: string; channel?: string; rule?: string }): Promise<NotificationRecord[]> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.status) params.set("status", opts.status);
    if (opts?.channel) params.set("channel", opts.channel);
    if (opts?.rule) params.set("rule", opts.rule);
    const qs = params.toString();
    return this.get<NotificationRecord[]>(`/notifications${qs ? `?${qs}` : ""}`);
  }

  /** Get notification stats (total, sent, failed). */
  getNotificationStats(): Promise<NotificationStats> {
    return this.get<NotificationStats>("/notifications/stats");
  }

  /** Send a notification directly to a channel (with optional delay). */
  sendNotification(req: SendNotificationRequest): Promise<SendNotificationResult> {
    return this.post<SendNotificationResult>("/notifications/send", req);
  }

  // ── Approvals ───────────────────────────────────────────

  /** List approval requests. */
  getApprovals(status?: ApprovalStatus): Promise<ApprovalRequest[]> {
    const qs = status ? `?status=${status}` : "";
    return this.get<ApprovalRequest[]>(`/approvals${qs}`);
  }

  /** Get pending approval requests. */
  getPendingApprovals(): Promise<ApprovalRequest[]> {
    return this.get<ApprovalRequest[]>("/approvals/pending");
  }

  /** Approve a request. */
  approveRequest(requestId: string, opts?: { resolvedBy?: string; note?: string }): Promise<ApprovalRequest> {
    return this.post<ApprovalRequest>(`/approvals/${requestId}/approve`, opts);
  }

  /** Reject a request with feedback. */
  rejectRequest(requestId: string, feedback: string, resolvedBy?: string): Promise<ApprovalRequest> {
    return this.post<ApprovalRequest>(`/approvals/${requestId}/reject`, { feedback, resolvedBy });
  }

  // ── Templates ────────────────────────────────────────────

  /** List available templates discovered from disk. */
  getTemplates(): Promise<TemplateInfo[]> {
    return this.get<TemplateInfo[]>("/templates");
  }

  /** Get full template definition including the plan template. */
  getTemplate(name: string): Promise<TemplateDefinition> {
    return this.get<TemplateDefinition>(`/templates/${encodeURIComponent(name)}`);
  }

  /** Run a template with parameters. Returns the created plan + task count. */
  runTemplate(name: string, params?: Record<string, string | number | boolean>): Promise<TemplateRunResult> {
    return this.post<TemplateRunResult>(`/templates/${encodeURIComponent(name)}/run`, { params });
  }

  // ── Static ───────────────────────────────────────────────

  static async listProjects(
    baseUrl: string,
    apiKey?: string,
  ): Promise<ProjectInfo[]> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["x-api-key"] = apiKey;
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v1/projects`, { headers });
    const json = (await res.json()) as ApiResult<ProjectInfo[]>;
    if (!json.ok) throw new PolpoApiError(json.error, json.code, res.status);
    return json.data;
  }

  static async health(baseUrl: string): Promise<HealthResponse> {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v1/health`);
    const json = (await res.json()) as ApiResult<HealthResponse>;
    if (!json.ok) throw new PolpoApiError(json.error, json.code, res.status);
    return json.data;
  }

  /** Build SSE URL for EventSource (with optional apiKey as query param) */
  getEventsUrl(filter?: string[]): string {
    const params = new URLSearchParams();
    if (filter?.length) params.set("filter", filter.join(","));
    if (this.headers["x-api-key"]) params.set("apiKey", this.headers["x-api-key"]);
    const qs = params.toString();
    return `${this.projectUrl("/events")}${qs ? `?${qs}` : ""}`;
  }
}
