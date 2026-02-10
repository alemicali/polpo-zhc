import { OrchestraApiError } from "./errors.js";
import type {
  Task,
  Plan,
  AgentConfig,
  AgentProcess,
  Team,
  OrchestraState,
  OrchestraConfig,
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
} from "./types.js";

export interface OrchestraClientConfig {
  baseUrl: string;
  projectId: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}

export class OrchestraClient {
  private readonly baseUrl: string;
  private readonly projectId: string;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: typeof globalThis.fetch;
  /** In-flight GET deduplication */
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(config: OrchestraClientConfig) {
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
      throw new OrchestraApiError(json.error, json.code, res.status, json.details);
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

  getState(): Promise<OrchestraState> {
    return this.get<OrchestraState>("/state");
  }

  getConfig(): Promise<OrchestraConfig> {
    return this.get<OrchestraConfig>("/config");
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

  // ── Chat / LLM ────────────────────────────────────────────

  chat(message: string): Promise<{ response: string }> {
    return this.post<{ response: string }>("/chat", { message });
  }

  generatePlan(prompt: string): Promise<{ yaml: string; raw: string }> {
    return this.post<{ yaml: string; raw: string }>("/chat/generate-plan", { prompt });
  }

  prepareTask(description: string, assignTo: string): Promise<{ yaml: string; raw: string }> {
    return this.post<{ yaml: string; raw: string }>("/chat/prepare-task", { description, assignTo });
  }

  generateTeam(description: string): Promise<{ yaml: string; raw: string }> {
    return this.post<{ yaml: string; raw: string }>("/chat/generate-team", { description });
  }

  refineTeam(currentYaml: string, description: string, feedback: string): Promise<{ yaml: string; raw: string }> {
    return this.post<{ yaml: string; raw: string }>("/chat/refine-team", { currentYaml, description, feedback });
  }

  refinePlan(currentYaml: string, prompt: string, feedback: string): Promise<{ yaml: string; raw: string }> {
    return this.post<{ yaml: string; raw: string }>("/chat/refine-plan", { currentYaml, prompt, feedback });
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
    if (!json.ok) throw new OrchestraApiError(json.error, json.code, res.status);
    return json.data;
  }

  static async health(baseUrl: string): Promise<HealthResponse> {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v1/health`);
    const json = (await res.json()) as ApiResult<HealthResponse>;
    if (!json.ok) throw new OrchestraApiError(json.error, json.code, res.status);
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
