import { PolpoApiError } from "./errors.js";
import type {
  AuthStatusResponse,
  VaultEntryMeta,
  Task,
  Mission,
  AgentConfig,
  AgentProcess,
  Team,
  PolpoState,
  PolpoConfig,
  HealthResponse,
  TaskFilters,
  CreateTaskRequest,
  UpdateTaskRequest,
  CreateMissionRequest,
  UpdateMissionRequest,
  AddMissionTaskRequest,
  UpdateMissionTaskRequest,
  ReorderMissionTasksRequest,
  AddMissionCheckpointRequest,
  UpdateMissionCheckpointRequest,
  AddMissionDelayRequest,
  UpdateMissionDelayRequest,
  ActiveDelay,
  AddMissionQualityGateRequest,
  UpdateMissionQualityGateRequest,
  AddMissionTeamMemberRequest,
  UpdateMissionTeamMemberRequest,
  UpdateMissionNotificationsRequest,
  AddAgentRequest,
  UpdateAgentRequest,
  UpdateSettingsRequest,
  AddTeamRequest,
  ExecuteMissionResult,
  ResumeMissionResult,
  ApiResult,
  LogSession,
  LogEntry,
  ChatSession,
  ChatMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  AskUserPayload,
  MissionPreviewPayload,
  VaultPreviewPayload,
  OpenFilePayload,
  NavigateToPayload,
  OpenTabPayload,
  RunActivityEntry,
  SkillInfo,
  LoadedSkill,
  SkillWithAssignment,
  SkillIndexEntry,
  SkillIndex,
  NotificationChannelConfig,
  NotificationRecord,
  NotificationStats,
  SendNotificationRequest,
  SendNotificationResult,
  ApprovalRequest,
  ApprovalStatus,
  ScheduleEntry,
  PlaybookInfo,
  PlaybookDefinition,
  PlaybookRunResult,
} from "./types.js";

export interface PolpoClientConfig {
  baseUrl: string;
  /** @deprecated No longer used. Kept for backwards compatibility. */
  projectId?: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  /** API path prefix. Default: "/v1" for polpo.sh, "/api/v1" for self-hosted. */
  apiPrefix?: string;
}

/**
 * Async-iterable streaming response from chat completions.
 * Exposes `sessionId` from the server's `x-session-id` response header,
 * which lets callers learn which session was created/reused.
 */
export class ChatCompletionStream implements AsyncIterable<ChatCompletionChunk> {
  /** Session ID assigned by the server. Available after the first `next()` call. */
  sessionId: string | null = null;

  /** If the stream ended with finish_reason "ask_user", this contains the questions. */
  askUser: AskUserPayload | null = null;

  /** If the stream ended with finish_reason "mission_preview", this contains the proposed mission. */
  missionPreview: MissionPreviewPayload | null = null;

  /** If the stream ended with finish_reason "vault_preview", this contains the proposed vault entry. */
  vaultPreview: VaultPreviewPayload | null = null;

  /** If the stream ended with finish_reason "open_file", this contains the file path to open. */
  openFile: OpenFilePayload | null = null;

  /** If the stream ended with finish_reason "navigate_to", this contains navigation target info. */
  navigateTo: NavigateToPayload | null = null;

  /** If the stream ended with finish_reason "open_tab", this contains the URL to open. */
  openTab: OpenTabPayload | null = null;

  /** Whether abort() has been called. */
  aborted = false;

  private fetchFn: typeof globalThis.fetch;
  private url: string;
  private clientHeaders: Record<string, string>;
  private req: ChatCompletionRequest;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private decoder = new TextDecoder();
  private buffer = "";
  private started = false;
  private abortController = new AbortController();

  constructor(
    fetchFn: typeof globalThis.fetch,
    url: string,
    clientHeaders: Record<string, string>,
    req: ChatCompletionRequest,
  ) {
    this.fetchFn = fetchFn;
    this.url = url;
    this.clientHeaders = clientHeaders;
    this.req = req;
  }

  /**
   * Abort the in-flight stream. Cancels the fetch request and closes the reader.
   * The server will detect the disconnect and stop generating.
   */
  abort(): void {
    this.aborted = true;
    this.abortController.abort();
    this.reader?.cancel().catch(() => { /* best effort */ });
  }

  private async ensureStarted(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.clientHeaders["Authorization"]) {
      headers["Authorization"] = this.clientHeaders["Authorization"];
    }
    if (this.req.sessionId) {
      headers["x-session-id"] = this.req.sessionId;
    }
    const { sessionId: _, ...body } = this.req;
    const res = await this.fetchFn(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, stream: true }),
      signal: this.abortController.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
      throw new PolpoApiError(
        (err as any).error?.message ?? "Chat completions failed",
        res.status === 401 ? "AUTH_REQUIRED" : "INTERNAL_ERROR",
        res.status,
      );
    }

    // Capture session ID from response header
    this.sessionId = res.headers.get("x-session-id");

    this.reader = res.body?.getReader() ?? null;
    if (!this.reader) throw new PolpoApiError("No response body", "INTERNAL_ERROR", 500);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    await this.ensureStarted();
    const reader = this.reader!;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.buffer += this.decoder.decode(value, { stream: true });
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") return;
          try {
            const chunk = JSON.parse(data) as ChatCompletionChunk;
            // Capture ask_user payload from the chunk
            const choice = chunk.choices[0];
            if (choice?.finish_reason === "ask_user" && choice.ask_user) {
              this.askUser = choice.ask_user;
            }
            // Capture mission_preview payload from the chunk
            if (choice?.finish_reason === "mission_preview" && choice.mission_preview) {
              this.missionPreview = choice.mission_preview;
            }
            // Capture vault_preview payload from the chunk
            if (choice?.finish_reason === "vault_preview" && choice.vault_preview) {
              this.vaultPreview = choice.vault_preview;
            }
            // Capture open_file payload from the chunk
            if (choice?.finish_reason === "open_file" && choice.open_file) {
              this.openFile = choice.open_file;
            }
            // Capture navigate_to payload from the chunk
            if (choice?.finish_reason === "navigate_to" && choice.navigate_to) {
              this.navigateTo = choice.navigate_to;
            }
            // Capture open_tab payload from the chunk
            if (choice?.finish_reason === "open_tab" && choice.open_tab) {
              this.openTab = choice.open_tab;
            }
            yield chunk;
          } catch {
            // skip malformed chunks
          }
        }
      }
    } catch (err) {
      // Suppress AbortError — this is expected when the user stops the stream
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (this.aborted) return;
      throw err;
    }
  }
}

export class PolpoClient {
  private readonly baseUrl: string;
  private readonly apiPrefix: string;
  private readonly apiKey: string | undefined;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: typeof globalThis.fetch;
  /** In-flight GET deduplication */
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(config: PolpoClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    // Detect cloud vs self-hosted prefix via proper hostname check
    if (config.apiPrefix) {
      this.apiPrefix = config.apiPrefix;
    } else {
      try {
        const hostname = new URL(this.baseUrl).hostname;
        this.apiPrefix = hostname.endsWith(".polpo.sh") || hostname === "polpo.sh" ? "/v1" : "/api/v1";
      } catch {
        this.apiPrefix = "/api/v1";
      }
    }
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.apiKey = config.apiKey;
    this.headers = {};
    if (config.apiKey) {
      this.headers["Authorization"] = `Bearer ${config.apiKey}`;
    }
  }

  // ── Helpers ──────────────────────────────────────────────

  private apiUrl(path: string): string {
    return `${this.baseUrl}${this.apiPrefix}${path}`;
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
    const url = this.apiUrl(path);
    const existing = this.inflight.get(url);
    if (existing) return existing as Promise<T>;

    const promise = this.request<T>("GET", url);
    this.inflight.set(url, promise);
    promise.finally(() => this.inflight.delete(url));
    return promise;
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", this.apiUrl(path), body);
  }

  private put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", this.apiUrl(path), body);
  }

  private patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", this.apiUrl(path), body);
  }

  private del<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", this.apiUrl(path));
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

  queueTask(taskId: string): Promise<{ queued: boolean }> {
    return this.post<{ queued: boolean }>(`/tasks/${taskId}/queue`);
  }

  // ── Missions ─────────────────────────────────────────────

  getMissions(): Promise<Mission[]> {
    return this.get<Mission[]>("/missions");
  }

  getResumableMissions(): Promise<Mission[]> {
    return this.get<Mission[]>("/missions/resumable");
  }

  getMission(missionId: string): Promise<Mission> {
    return this.get<Mission>(`/missions/${missionId}`);
  }

  createMission(req: CreateMissionRequest): Promise<Mission> {
    return this.post<Mission>("/missions", req);
  }

  updateMission(missionId: string, req: UpdateMissionRequest): Promise<Mission> {
    return this.patch<Mission>(`/missions/${missionId}`, req);
  }

  deleteMission(missionId: string): Promise<{ deleted: boolean }> {
    return this.del<{ deleted: boolean }>(`/missions/${missionId}`);
  }

  executeMission(missionId: string): Promise<ExecuteMissionResult> {
    return this.post<ExecuteMissionResult>(`/missions/${missionId}/execute`);
  }

  resumeMission(missionId: string, opts?: { retryFailed?: boolean }): Promise<ResumeMissionResult> {
    return this.post<ResumeMissionResult>(`/missions/${missionId}/resume`, opts);
  }

  abortMission(missionId: string): Promise<{ aborted: number }> {
    return this.post<{ aborted: number }>(`/missions/${missionId}/abort`);
  }

  // ── Atomic Mission Data ───────────────────────────────────

  addMissionTask(missionId: string, req: AddMissionTaskRequest): Promise<Mission> {
    return this.post<Mission>(`/missions/${missionId}/tasks`, req);
  }

  updateMissionTask(missionId: string, taskTitle: string, req: UpdateMissionTaskRequest): Promise<Mission> {
    return this.patch<Mission>(`/missions/${missionId}/tasks/${encodeURIComponent(taskTitle)}`, req);
  }

  removeMissionTask(missionId: string, taskTitle: string): Promise<Mission> {
    return this.del<Mission>(`/missions/${missionId}/tasks/${encodeURIComponent(taskTitle)}`);
  }

  reorderMissionTasks(missionId: string, req: ReorderMissionTasksRequest): Promise<Mission> {
    return this.put<Mission>(`/missions/${missionId}/tasks/reorder`, req);
  }

  addMissionCheckpoint(missionId: string, req: AddMissionCheckpointRequest): Promise<Mission> {
    return this.post<Mission>(`/missions/${missionId}/checkpoints`, req);
  }

  updateMissionCheckpoint(missionId: string, checkpointName: string, req: UpdateMissionCheckpointRequest): Promise<Mission> {
    return this.patch<Mission>(`/missions/${missionId}/checkpoints/${encodeURIComponent(checkpointName)}`, req);
  }

  removeMissionCheckpoint(missionId: string, checkpointName: string): Promise<Mission> {
    return this.del<Mission>(`/missions/${missionId}/checkpoints/${encodeURIComponent(checkpointName)}`);
  }

  // ── Delays ──

  listDelays(): Promise<ActiveDelay[]> {
    return this.get<ActiveDelay[]>("/missions/delays");
  }

  addMissionDelay(missionId: string, req: AddMissionDelayRequest): Promise<Mission> {
    return this.post<Mission>(`/missions/${missionId}/delays`, req);
  }

  updateMissionDelay(missionId: string, delayName: string, req: UpdateMissionDelayRequest): Promise<Mission> {
    return this.patch<Mission>(`/missions/${missionId}/delays/${encodeURIComponent(delayName)}`, req);
  }

  removeMissionDelay(missionId: string, delayName: string): Promise<Mission> {
    return this.del<Mission>(`/missions/${missionId}/delays/${encodeURIComponent(delayName)}`);
  }

  addMissionQualityGate(missionId: string, req: AddMissionQualityGateRequest): Promise<Mission> {
    return this.post<Mission>(`/missions/${missionId}/quality-gates`, req);
  }

  updateMissionQualityGate(missionId: string, gateName: string, req: UpdateMissionQualityGateRequest): Promise<Mission> {
    return this.patch<Mission>(`/missions/${missionId}/quality-gates/${encodeURIComponent(gateName)}`, req);
  }

  removeMissionQualityGate(missionId: string, gateName: string): Promise<Mission> {
    return this.del<Mission>(`/missions/${missionId}/quality-gates/${encodeURIComponent(gateName)}`);
  }

  addMissionTeamMember(missionId: string, req: AddMissionTeamMemberRequest): Promise<Mission> {
    return this.post<Mission>(`/missions/${missionId}/team`, req);
  }

  updateMissionTeamMember(missionId: string, memberName: string, req: UpdateMissionTeamMemberRequest): Promise<Mission> {
    return this.patch<Mission>(`/missions/${missionId}/team/${encodeURIComponent(memberName)}`, req);
  }

  removeMissionTeamMember(missionId: string, memberName: string): Promise<Mission> {
    return this.del<Mission>(`/missions/${missionId}/team/${encodeURIComponent(memberName)}`);
  }

  updateMissionNotifications(missionId: string, req: UpdateMissionNotificationsRequest): Promise<Mission> {
    return this.put<Mission>(`/missions/${missionId}/notifications`, req);
  }

  // ── Vault ─────────────────────────────────────────────────

  /**
   * Save a vault entry directly to the encrypted store.
   * Bypasses the LLM entirely — credentials go straight to AES-256-GCM encrypted storage.
   * Returns metadata only (never credential values).
   */
  saveVaultEntry(req: {
    agent: string;
    service: string;
    type: "smtp" | "imap" | "oauth" | "api_key" | "login" | "custom";
    label?: string;
    credentials: Record<string, string>;
  }): Promise<{ agent: string; service: string; type: string; keys: string[] }> {
    return this.post<{ agent: string; service: string; type: string; keys: string[] }>("/vault/entries", req);
  }

  /**
   * Partially update credential fields in an existing vault entry.
   * Only the provided fields are merged — existing fields are preserved.
   */
  patchVaultEntry(
    agent: string,
    service: string,
    patch: { type?: string; label?: string; credentials?: Record<string, string> },
  ): Promise<{ agent: string; service: string; type: string; keys: string[] }> {
    return this.patch<{ agent: string; service: string; type: string; keys: string[] }>(
      `/vault/entries/${encodeURIComponent(agent)}/${encodeURIComponent(service)}`,
      patch,
    );
  }

  /**
   * Remove a vault entry from the encrypted store.
   */
  removeVaultEntry(agent: string, service: string): Promise<{ removed: boolean }> {
    return this.del<{ removed: boolean }>(`/vault/entries/${encodeURIComponent(agent)}/${encodeURIComponent(service)}`);
  }

  /**
   * List vault entries for an agent (metadata only — no secret values).
   * Returns service names, types, labels, and credential field names.
   */
  listVaultEntries(agent: string): Promise<VaultEntryMeta[]> {
    return this.get<VaultEntryMeta[]>(`/vault/entries/${encodeURIComponent(agent)}`);
  }

  // ── Auth ───────────────────────────────────────────────────

  /**
   * Get per-provider auth status: config keys, env vars, OAuth profiles (metadata only).
   * Tokens are NEVER exposed.
   */
  getAuthStatus(): Promise<AuthStatusResponse> {
    return this.get<AuthStatusResponse>("/auth/status");
  }

  // ── Schedules ─────────────────────────────────────────────

  getSchedules(): Promise<ScheduleEntry[]> {
    return this.get<ScheduleEntry[]>("/schedules");
  }

  // ── Agents ───────────────────────────────────────────────

  getAgents(): Promise<AgentConfig[]> {
    return this.get<AgentConfig[]>("/agents");
  }

  getAgent(name: string): Promise<AgentConfig> {
    return this.get<AgentConfig>(`/agents/${encodeURIComponent(name)}`);
  }

  addAgent(req: AddAgentRequest, teamName?: string): Promise<{ added: boolean }> {
    const qs = teamName ? `?team=${encodeURIComponent(teamName)}` : "";
    return this.post<{ added: boolean }>(`/agents${qs}`, req);
  }

  removeAgent(name: string): Promise<{ removed: boolean }> {
    return this.del<{ removed: boolean }>(`/agents/${encodeURIComponent(name)}`);
  }

  updateAgent(name: string, req: UpdateAgentRequest): Promise<AgentConfig> {
    return this.patch<AgentConfig>(`/agents/${encodeURIComponent(name)}`, req);
  }

  getTeams(): Promise<Team[]> {
    return this.get<Team[]>("/agents/teams");
  }

  getTeam(name?: string): Promise<Team | undefined> {
    const qs = name ? `?name=${encodeURIComponent(name)}` : "";
    return this.get<Team | undefined>(`/agents/team${qs}`);
  }

  addTeam(req: AddTeamRequest): Promise<{ added: boolean }> {
    return this.post<{ added: boolean }>("/agents/teams", req);
  }

  removeTeam(name: string): Promise<{ removed: boolean }> {
    return this.del<{ removed: boolean }>(`/agents/teams/${encodeURIComponent(name)}`);
  }

  renameTeam(oldName: string, newName: string): Promise<Team> {
    return this.patch<Team>("/agents/team", { oldName, name: newName });
  }

  getProcesses(): Promise<AgentProcess[]> {
    return this.get<AgentProcess[]>("/agents/processes");
  }

  // ── State ────────────────────────────────────────────────

  getState(): Promise<PolpoState> {
    return this.get<PolpoState>("/state");
  }

  getConfig(): Promise<PolpoConfig> {
    return this.get<PolpoConfig>("/orchestrator-config");
  }

  updateSettings(req: UpdateSettingsRequest): Promise<PolpoConfig> {
    return this.patch<PolpoConfig>("/config/settings", req);
  }

  // ── Notification Channels ────────────────────────────────

  listChannels(): Promise<Record<string, NotificationChannelConfig>> {
    return this.get<Record<string, NotificationChannelConfig>>("/config/channels");
  }

  upsertChannel(name: string, config: NotificationChannelConfig): Promise<PolpoConfig> {
    return this.request<PolpoConfig>("PUT", this.apiUrl(`/config/channels/${encodeURIComponent(name)}`), config);
  }

  deleteChannel(name: string): Promise<PolpoConfig> {
    return this.del<PolpoConfig>(`/config/channels/${encodeURIComponent(name)}`);
  }

  testChannel(name: string): Promise<{ success: boolean }> {
    return this.post<{ success: boolean }>(`/config/channels/${encodeURIComponent(name)}/test`);
  }

  getMemory(): Promise<{ exists: boolean; content: string }> {
    return this.get<{ exists: boolean; content: string }>("/memory");
  }

  saveMemory(content: string): Promise<{ saved: boolean }> {
    return this.request<{ saved: boolean }>("PUT", this.apiUrl("/memory"), { content });
  }

  getAgentMemory(agentName: string): Promise<{ exists: boolean; content: string; agent: string }> {
    return this.get<{ exists: boolean; content: string; agent: string }>(`/memory/agent/${encodeURIComponent(agentName)}`);
  }

  saveAgentMemory(agentName: string, content: string): Promise<{ saved: boolean; agent: string }> {
    return this.request<{ saved: boolean; agent: string }>("PUT", this.apiUrl(`/memory/agent/${encodeURIComponent(agentName)}`), { content });
  }

  getLogs(): Promise<LogSession[]> {
    return this.get<LogSession[]>("/logs");
  }

  getLogEntries(sessionId: string): Promise<LogEntry[]> {
    return this.get<LogEntry[]>(`/logs/${sessionId}`);
  }

  // ── Skills ───────────────────────────────────────────────

  /** Discover available skills in the agent skill pool with assignment info. */
  getSkills(): Promise<SkillWithAssignment[]> {
    return this.get<SkillWithAssignment[]>("/skills");
  }

  /** Assign a skill to an agent. */
  assignSkill(skillName: string, agent: string): Promise<{ skill: string; agent: string }> {
    return this.post<{ skill: string; agent: string }>(`/skills/${encodeURIComponent(skillName)}/assign`, { agent });
  }

  /** Unassign a skill from an agent. */
  unassignSkill(skillName: string, agent: string): Promise<{ skill: string; agent: string }> {
    return this.post<{ skill: string; agent: string }>(`/skills/${encodeURIComponent(skillName)}/unassign`, { agent });
  }

  /** Discover orchestrator skills (.polpo/.agent/skills/). */
  getOrchestratorSkills(): Promise<SkillInfo[]> {
    return this.get<SkillInfo[]>("/skills/orchestrator");
  }

  /** Get the full content of an agent skill by name. */
  getSkillContent(name: string): Promise<LoadedSkill> {
    return this.get<LoadedSkill>(`/skills/${encodeURIComponent(name)}/content`);
  }

  /** Get the full content of an orchestrator skill by name. */
  getOrchestratorSkillContent(name: string): Promise<LoadedSkill> {
    return this.get<LoadedSkill>(`/skills/orchestrator/${encodeURIComponent(name)}/content`);
  }

  /** Get the full skills index (tags and categories for all skills). */
  getSkillsIndex(): Promise<SkillIndex> {
    return this.get<SkillIndex>("/skills/index");
  }

  /** Update a skill's tags and/or category in the skills index. */
  updateSkillIndex(name: string, entry: SkillIndexEntry): Promise<{ skill: string; tags?: string[]; category?: string }> {
    return this.put<{ skill: string; tags?: string[]; category?: string }>(`/skills/${encodeURIComponent(name)}/index`, entry);
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
    const url = `${this.baseUrl}${this.apiPrefix}/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.headers["Authorization"]) {
      headers["Authorization"] = this.headers["Authorization"];
    }
    if (req.sessionId) {
      headers["x-session-id"] = req.sessionId;
    }
    const { sessionId: _, ...body } = req;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, stream: false }),
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
   * Streaming mode — returns a ChatCompletionStream (async-iterable + metadata).
   */
  chatCompletionsStream(req: ChatCompletionRequest): ChatCompletionStream {
    const url = `${this.baseUrl}${this.apiPrefix}/chat/completions`;
    return new ChatCompletionStream(this.fetchFn, url, this.headers, req);
  }

  // ── Sessions ────────────────────────────────────────────

  getSessions(): Promise<{ sessions: ChatSession[] }> {
    return this.get<{ sessions: ChatSession[] }>("/chat/sessions");
  }

  getSessionMessages(sessionId: string): Promise<{ session: ChatSession; messages: ChatMessage[] }> {
    return this.get<{ session: ChatSession; messages: ChatMessage[] }>(`/chat/sessions/${sessionId}/messages`);
  }

  renameSession(sessionId: string, title: string): Promise<{ renamed: boolean }> {
    return this.patch<{ renamed: boolean }>(`/chat/sessions/${sessionId}`, { title });
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

  // ── Playbooks ────────────────────────────────────────────

  /** List available playbooks discovered from disk. */
  getPlaybooks(): Promise<PlaybookInfo[]> {
    return this.get<PlaybookInfo[]>("/playbooks");
  }

  /** Get full playbook definition including the mission body. */
  getPlaybook(name: string): Promise<PlaybookDefinition> {
    return this.get<PlaybookDefinition>(`/playbooks/${encodeURIComponent(name)}`);
  }

  /** Run a playbook with parameters. Returns the created mission + task count. */
  runPlaybook(name: string, params?: Record<string, string | number | boolean>): Promise<PlaybookRunResult> {
    return this.post<PlaybookRunResult>(`/playbooks/${encodeURIComponent(name)}/run`, { params });
  }

  // Backward-compat aliases
  /** @deprecated Use getPlaybooks instead. */
  getTemplates(): Promise<PlaybookInfo[]> { return this.getPlaybooks(); }
  /** @deprecated Use getPlaybook instead. */
  getTemplate(name: string): Promise<PlaybookDefinition> { return this.getPlaybook(name); }
  /** @deprecated Use runPlaybook instead. */
  runTemplate(name: string, params?: Record<string, string | number | boolean>): Promise<PlaybookRunResult> { return this.runPlaybook(name, params); }

  /** Health check (instance method — uses configured base URL, no auth). */
  async getHealth(): Promise<HealthResponse> {
    const res = await this.fetchFn(`${this.baseUrl}/health`);
    return res.json();
  }

  // ── Static ───────────────────────────────────────────────

  static async health(baseUrl: string): Promise<HealthResponse> {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v1/health`);
    const json = (await res.json()) as ApiResult<HealthResponse>;
    if (!json.ok) throw new PolpoApiError(json.error, json.code, res.status);
    return json.data;
  }

  /** Build SSE URL for EventSource (with optional apiKey as query param — EventSource can't send headers) */
  getEventsUrl(filter?: string[]): string {
    const params = new URLSearchParams();
    if (filter?.length) params.set("filter", filter.join(","));
    if (this.apiKey) params.set("apiKey", this.apiKey);
    const qs = params.toString();
    return `${this.apiUrl("/events")}${qs ? `?${qs}` : ""}`;
  }
}
