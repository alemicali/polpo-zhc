/**
 * Polpo Mobile - HTTP API Client
 * Provides methods to interact with Polpo's REST API
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
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
} from './types';

export class OrchestraApiError extends Error {
  constructor(
    message: string,
    public code?: string,
    public status?: number,
    public details?: unknown
  ) {
    super(message);
    this.name = 'OrchestraApiError';
  }
}

export interface OrchestraClientConfig {
  baseUrl: string;
  projectId: string;
  apiKey?: string;
}

export class OrchestraClient {
  private readonly axios: AxiosInstance;
  private readonly projectId: string;

  constructor(config: OrchestraClientConfig) {
    this.projectId = config.projectId;

    this.axios = axios.create({
      baseURL: config.baseUrl.replace(/\/$/, ''),
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
      },
    });

    // Response interceptor for error handling
    this.axios.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        if (error.response?.data) {
          const apiError = error.response.data as ApiResult<never>;
          throw new OrchestraApiError(
            apiError.error || error.message,
            apiError.code,
            error.response.status,
            apiError.details
          );
        }
        throw new OrchestraApiError(error.message);
      }
    );
  }

  // ── Helpers ──────────────────────────────────────────────

  private projectUrl(path: string): string {
    return `/api/v1/projects/${this.projectId}${path}`;
  }

  private async request<T>(
    method: string,
    url: string,
    data?: unknown
  ): Promise<T> {
    const response = await this.axios.request<ApiResult<T>>({
      method,
      url,
      data,
    });
    if (!response.data.ok) {
      throw new OrchestraApiError(
        response.data.error || 'Unknown error',
        response.data.code
      );
    }
    return response.data.data;
  }

  // ── Tasks ────────────────────────────────────────────────

  async getTasks(filters?: TaskFilters): Promise<Task[]> {
    const params = new URLSearchParams();
    if (filters?.status) params.set('status', filters.status);
    if (filters?.group) params.set('group', filters.group);
    if (filters?.assignTo) params.set('assignTo', filters.assignTo);
    const qs = params.toString();
    return this.request<Task[]>(
      'GET',
      this.projectUrl(`/tasks${qs ? `?${qs}` : ''}`)
    );
  }

  async getTask(taskId: string): Promise<Task> {
    return this.request<Task>('GET', this.projectUrl(`/tasks/${taskId}`));
  }

  async createTask(req: CreateTaskRequest): Promise<Task> {
    return this.request<Task>('POST', this.projectUrl('/tasks'), req);
  }

  async updateTask(taskId: string, req: UpdateTaskRequest): Promise<Task> {
    return this.request<Task>(
      'PATCH',
      this.projectUrl(`/tasks/${taskId}`),
      req
    );
  }

  async deleteTask(taskId: string): Promise<{ removed: boolean }> {
    return this.request<{ removed: boolean }>(
      'DELETE',
      this.projectUrl(`/tasks/${taskId}`)
    );
  }

  async retryTask(taskId: string): Promise<{ retried: boolean }> {
    return this.request<{ retried: boolean }>(
      'POST',
      this.projectUrl(`/tasks/${taskId}/retry`)
    );
  }

  async killTask(taskId: string): Promise<{ killed: boolean }> {
    return this.request<{ killed: boolean }>(
      'POST',
      this.projectUrl(`/tasks/${taskId}/kill`)
    );
  }

  // ── Plans ────────────────────────────────────────────────

  async getPlans(): Promise<Plan[]> {
    return this.request<Plan[]>('GET', this.projectUrl('/plans'));
  }

  async getPlan(planId: string): Promise<Plan> {
    return this.request<Plan>('GET', this.projectUrl(`/plans/${planId}`));
  }

  async createPlan(req: CreatePlanRequest): Promise<Plan> {
    return this.request<Plan>('POST', this.projectUrl('/plans'), req);
  }

  async updatePlan(planId: string, req: UpdatePlanRequest): Promise<Plan> {
    return this.request<Plan>(
      'PATCH',
      this.projectUrl(`/plans/${planId}`),
      req
    );
  }

  async deletePlan(planId: string): Promise<{ deleted: boolean }> {
    return this.request<{ deleted: boolean }>(
      'DELETE',
      this.projectUrl(`/plans/${planId}`)
    );
  }

  async executePlan(planId: string): Promise<ExecutePlanResult> {
    return this.request<ExecutePlanResult>(
      'POST',
      this.projectUrl(`/plans/${planId}/execute`)
    );
  }

  async resumePlan(
    planId: string,
    opts?: { retryFailed?: boolean }
  ): Promise<ResumePlanResult> {
    return this.request<ResumePlanResult>(
      'POST',
      this.projectUrl(`/plans/${planId}/resume`),
      opts
    );
  }

  async abortPlan(planId: string): Promise<{ aborted: number }> {
    return this.request<{ aborted: number }>(
      'POST',
      this.projectUrl(`/plans/${planId}/abort`)
    );
  }

  // ── Agents ───────────────────────────────────────────────

  async getAgents(): Promise<AgentConfig[]> {
    return this.request<AgentConfig[]>('GET', this.projectUrl('/agents'));
  }

  async addAgent(req: AddAgentRequest): Promise<{ added: boolean }> {
    return this.request<{ added: boolean }>(
      'POST',
      this.projectUrl('/agents'),
      req
    );
  }

  async removeAgent(name: string): Promise<{ removed: boolean }> {
    return this.request<{ removed: boolean }>(
      'DELETE',
      this.projectUrl(`/agents/${encodeURIComponent(name)}`)
    );
  }

  async getTeam(): Promise<Team> {
    return this.request<Team>('GET', this.projectUrl('/agents/team'));
  }

  async renameTeam(name: string): Promise<Team> {
    return this.request<Team>('PATCH', this.projectUrl('/agents/team'), {
      name,
    });
  }

  async getProcesses(): Promise<AgentProcess[]> {
    return this.request<AgentProcess[]>(
      'GET',
      this.projectUrl('/agents/processes')
    );
  }

  // ── Project ──────────────────────────────────────────────

  async getState(): Promise<OrchestraState> {
    return this.request<OrchestraState>('GET', this.projectUrl('/state'));
  }

  async getConfig(): Promise<OrchestraConfig> {
    return this.request<OrchestraConfig>('GET', this.projectUrl('/config'));
  }

  async getMemory(): Promise<{ exists: boolean; content: string }> {
    return this.request<{ exists: boolean; content: string }>(
      'GET',
      this.projectUrl('/memory')
    );
  }

  async saveMemory(content: string): Promise<{ saved: boolean }> {
    return this.request<{ saved: boolean }>(
      'PUT',
      this.projectUrl('/memory'),
      { content }
    );
  }

  async getLogs(): Promise<LogSession[]> {
    return this.request<LogSession[]>('GET', this.projectUrl('/logs'));
  }

  async getLogEntries(sessionId: string): Promise<LogEntry[]> {
    return this.request<LogEntry[]>(
      'GET',
      this.projectUrl(`/logs/${sessionId}`)
    );
  }

  // ── Static ───────────────────────────────────────────────

  static async listProjects(
    baseUrl: string,
    apiKey?: string
  ): Promise<ProjectInfo[]> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) headers['x-api-key'] = apiKey;

    const response = await axios.get<ApiResult<ProjectInfo[]>>(
      `${baseUrl.replace(/\/$/, '')}/api/v1/projects`,
      { headers }
    );

    if (!response.data.ok) {
      throw new OrchestraApiError(
        response.data.error || 'Failed to list projects',
        response.data.code
      );
    }
    return response.data.data;
  }

  static async health(baseUrl: string): Promise<HealthResponse> {
    const response = await axios.get<ApiResult<HealthResponse>>(
      `${baseUrl.replace(/\/$/, '')}/api/v1/health`
    );

    if (!response.data.ok) {
      throw new OrchestraApiError(
        response.data.error || 'Health check failed',
        response.data.code
      );
    }
    return response.data.data;
  }

  /** Build SSE URL for EventSource (with optional apiKey as query param) */
  getEventsUrl(filter?: string[]): string {
    const params = new URLSearchParams();
    if (filter?.length) params.set('filter', filter.join(','));
    // Note: apiKey will be added in event-source.ts if needed
    const qs = params.toString();
    return `${this.axios.defaults.baseURL}${this.projectUrl('/events')}${
      qs ? `?${qs}` : ''
    }`;
  }

  /** Get API key for SSE connection */
  getApiKey(): string | undefined {
    return this.axios.defaults.headers.common['x-api-key'] as
      | string
      | undefined;
  }
}
