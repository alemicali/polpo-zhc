import type { ComputerControl, ComputerDesktopView, ComputerTakeoverRequest } from "./computer-types.js";
import { PolpoApiError } from "./errors.js";
import type { DataTransactionRequest, DataTransactionResult } from "./data-types.js";
import type {
  AgentDeployGate, AgentSuite, AgentSuiteInput, CaseGenerationRequest, GeneratedCaseProposal, SuiteBaselineComparison, SuiteCase, SuiteCassette, SuiteCassetteEdit,
  SuiteCassetteSummary, SuiteDataset, SuiteRole, SuiteRun, SuiteRunRequest, SuiteDatasetImport, SuiteTargetKind, SuiteTrend,
  BenchmarkCaseComparison, BenchmarkDefinition, BenchmarkEstimate, BenchmarkInput, BenchmarkLeaderboard, BenchmarkMatrix, BenchmarkReport, BenchmarkRun,
  BenchmarkVariantStats, BenchmarkWeights, PlaygroundExchange, PlaygroundPane, PlaygroundPaneInput, PlaygroundSession, PlaygroundStreamEvent, SuiteVariantOverrides,
} from "./agent-suite-types.js";
import type { DecideRequest, DecideResult, DecisionCallerKind, DecisionLogEntry, DecisionLogPage, DecisionNodeState, DecisionStatus } from "./decision-types.js";
import type { EditImageRequest, GenerateImageRequest, ImageNodeState, MediaCallerKind, MediaLogEntry, MediaLogPage, MediaResult, MediaStatus } from "./media-types.js";
import type { CodingChatAccountInfo, CodingChatApproval, CodingChatCreateRequest, CodingChatEvent, CodingChatKind, CodingChatSession, CodingChatSummary } from "./coding-types.js";
import type {
  Connector,
  ConnectorTool,
  McpServerSummary, McpServerTemplateInfo, McpServerInstallRequest, McpServerInstallResult, McpSecretRef, McpHostedServer, McpServerSpec, McpServerGenerateRequest, McpServerGenerateResult,
  McpServerTestCase, McpToolTestResult, McpServerVersionInfo, McpServerDeploy, McpServerDeployBlocked, McpServerDiff, McpServerCallLog, McpPendingCall,
  AuthStatusResponse,
  MemberPreferencesPatch,
  MemberPreferencesResponse,
  SearchOptions,
  SearchResponse,
  SearchAskEvent,
  SearchAskOptions,
  SearchAskResult,
  VaultEntryMeta,
  GenerateVaultLoginRequest,
  GenerateVaultLoginResult,
  Task,
  Mission,
  AgentConfig,
  AgentProcess,
  Team,
  PolpoState,
  PolpoConfig,
  HealthResponse,
  TaskFilters,
  TasksPageRequest,
  TasksPageResponse,
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
  AgentLinesChart,
  UpdateAgentRequest,
  UpdateSettingsRequest,
  AddTeamRequest,
  ExecuteMissionResult,
  ResumeMissionResult,
  ApiResult,
  TaskSlim,
  MissionSlim,
  LogSession,
  LogEntry,
  ChatSession,
  ChatQueueItem,
  ChatQueueState,
  ChatQueueSendResult,
  SteerResult,
  ForkSessionResult,
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
  SetDesignPayload,
  WidgetRenderPayload,
  WhatsAppPreviewPayload,
  EmailPreviewPayload,
  RunActivityEntry,
  SkillInfo,
  LoadedSkill,
  SkillWithAssignment,
  SkillIndexEntry,
  SkillIndex,
  SkillPool,
  SkillFileList,
  SkillBundlePreview,
  Artifact,
  ArtifactType,
  ArtifactVersionUsage,
  ArtifactVersionInfo,
  ArtifactSummary,
  ArtifactChange,
  ArtifactUpdateInput,
  ArtifactCreateInput,
  ArtifactReadOptions,
  ArtifactRead,
  ArtifactUploadOptions,
  ArtifactUploadPart,
  ArtifactStorageUsage,
  SkillBundleInstallOptions,
  SkillBundleInstallResult,
  SkillVersionList,
  SkillVersionFiles,
  SkillVersionDiff,
  AgentVersion,
  AgentVersionBump,
  AgentTestRun,
  AgentTestRunRequest,
  AgentTestFixAction,
  AgentVersionDiff,
  AgentVersionList,
  AgentDeployEntry,
  AgentDeployOutcome,
  AgentPublishResult,
  SkillRestoreResult,
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
  TaskDirection,
  SendTaskDirectionRequest,
  SendTaskDirectionResult,
  WaBizOutcome,
  WaBizSecretKind,
  TriggerContentType,
  TriggerDeliveryStatus,
  TriggerFilterOp,
  TriggerHmacConfig,
  TriggerContract,
  TriggerFilter,
  Trigger,
  TriggerInput,
  TriggerDeliverySummary,
  TriggerDelivery,
  TriggerDeliveryPage,
  TriggerSample,
  TriggerDraft,
  TriggerDryRun,
  TriggerContractRevision,
  TriggerActionsStatus,
  TriggerActionRun,
  TriggerActionInput,
  TriggerActionPreview,
  WaBusinessStatus,
  WaBusinessEventSummary,
  WaBusinessEvent,
  WaBusinessEventPage,
  WaBusinessContact,
  SlackStatus,
  SlackSecretKind,
  ChannelPeer,
  PeerPresence,
  WaBusinessMessage,
  WaBusinessConversation,
  WaBusinessTemplate,
  WaBusinessSendResult,
  WaBizOutbound,
  WaBizFileInput,
  WaBizTemplateInput,
  WaBusinessTemplateDefinition,
  WaBusinessProfile,
  WaBusinessBlockResult,
  WaBusinessAnalyticsQuery,
  WaBusinessPhoneAction,
  WaBusinessWebhookOverride,
  WaBusinessAccountEvent,
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
  userMessageId: string | null = null;

  /**
   * Turn ID assigned by the server (`x-turn-id` header). Identifies this
   * specific in-flight completion turn so a disconnected client can come
   * back and resume from where it left off via /chat/completions/resume/:turnId.
   * Available after the first `next()` call.
   */
  turnId: string | null = null;

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

  /** If the stream ended with finish_reason "set_design", this contains appearance overrides. */
  setDesign: SetDesignPayload | null = null;

  /** If the stream ended with finish_reason "widget_render", this contains the inline widget. */
  widgetRender: WidgetRenderPayload | null = null;

  /** If the stream ended with finish_reason "whatsapp_preview", this contains the proposed WhatsApp message. */
  whatsappPreview: WhatsAppPreviewPayload | null = null;

  /** If the stream ended with finish_reason "email_preview", this contains the proposed email. */
  emailPreview: EmailPreviewPayload | null = null;

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
      credentials: "include",
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
      throw new PolpoApiError(
        (err as any).error?.message ?? "Chat completions failed",
        res.status === 401 ? "AUTH_REQUIRED" : "INTERNAL_ERROR",
        res.status,
      );
    }

    // Capture session/turn IDs from response headers
    this.sessionId = res.headers.get("x-session-id");
    this.userMessageId = res.headers.get("x-user-message-id");
    this.turnId = res.headers.get("x-turn-id");

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
            if ((chunk as any).error) throw new Error((chunk as any).error.message || "Stream failed");
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
            // Capture set_design payload from the chunk
            if (choice?.finish_reason === "set_design" && choice.set_design) {
              this.setDesign = choice.set_design;
            }
            // Capture widget_render payload from the chunk
            if (choice?.finish_reason === "widget_render" && choice.widget_render) {
              this.widgetRender = choice.widget_render;
            }
            // Capture whatsapp_preview payload from the chunk
            if (choice?.finish_reason === "whatsapp_preview" && choice.whatsapp_preview) {
              this.whatsappPreview = choice.whatsapp_preview;
            }
            // Capture email_preview payload from the chunk
            if (choice?.finish_reason === "email_preview" && choice.email_preview) {
              this.emailPreview = choice.email_preview;
            }
            yield chunk;
          } catch (error) {
            // A server error is terminal; only malformed JSON is ignorable.
            if (!(error instanceof SyntaxError)) throw error;
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

  // ── Coding chats (Claude Code / Codex in a worktree, on your own CLI account) ──

  /** Coding chat sessions, newest first, without their transcripts. */
  getCodingChats(o: { cwd?: string; workspaceId?: string; kind?: CodingChatKind } = {}): Promise<CodingChatSummary[]> {
    const q = new URLSearchParams();
    if (o.cwd) q.set("cwd", o.cwd);
    if (o.workspaceId) q.set("workspaceId", o.workspaceId);
    if (o.kind) q.set("kind", o.kind);
    const qs = q.toString();
    return this.get(`/coding/chats${qs ? `?${qs}` : ""}`);
  }

  /** One coding chat with its transcript and approvals. */
  getCodingChat(id: string): Promise<CodingChatSession> {
    return this.get(`/coding/chats/${encodeURIComponent(id)}`);
  }

  /** A new coding chat in a worktree (with prompt, its first turn starts at once). */
  createCodingChat(req: CodingChatCreateRequest): Promise<CodingChatSession> {
    return this.post("/coding/chats", req);
  }

  /** A message: a new turn, or a steer while one runs. */
  sendCodingChatMessage(id: string, text: string): Promise<{ steered: boolean; session: CodingChatSession }> {
    return this.post(`/coding/chats/${encodeURIComponent(id)}/messages`, { text });
  }

  /** Stop the running turn (the conversation stays). */
  stopCodingChat(id: string): Promise<CodingChatSession> {
    return this.post(`/coding/chats/${encodeURIComponent(id)}/stop`);
  }

  /** Approve or deny a risky action waiting in a coding chat. */
  resolveCodingChatApproval(id: string, approvalId: string, decision: "approve" | "deny"): Promise<CodingChatApproval> {
    return this.post(`/coding/chats/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approvalId)}`, { decision });
  }

  deleteCodingChat(id: string): Promise<{ deleted: boolean }> {
    return this.request("DELETE", this.apiUrl(`/coding/chats/${encodeURIComponent(id)}`));
  }

  /** The CLI account a coding chat of yours would use, or why none (and where to sign in). */
  getCodingChatAccount(kind: CodingChatKind): Promise<CodingChatAccountInfo> {
    return this.get(`/coding/chats/account?kind=${kind}`);
  }

  /**
   * Follow a coding chat live (Server-Sent Events over fetch, so the API key header works too):
   * the session first, then messages as they are written, approvals, files-changed. Resolves when
   * the stream ends (aborted, or the session deleted).
   */
  async streamCodingChat(id: string, onEvent: (e: CodingChatEvent) => void, signal?: AbortSignal): Promise<void> {
    const res = await this.fetchFn(this.apiUrl(`/coding/chats/${encodeURIComponent(id)}/events`), {
      headers: { ...this.headers, accept: "text/event-stream" },
      credentials: "include",
      ...(signal ? { signal } : {}),
    });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const json = (await res.json().catch(() => null)) as ApiResult<unknown> | null;
      throw new PolpoApiError(json && !json.ok ? json.error : `Stream failed (${res.status})`, (json && !json.ok ? json.code : "INTERNAL_ERROR") as never, res.status);
    }
    const reader = res.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    const flush = (block: string) => {
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data) return;
      try { onEvent(JSON.parse(data) as CodingChatEvent); } catch { /* not an event */ }
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let i: number;
        while ((i = buffer.indexOf("\n\n")) >= 0) {
          flush(buffer.slice(0, i));
          buffer = buffer.slice(i + 2);
        }
      }
      if (buffer.trim()) flush(buffer);
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") throw err;
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
      credentials: "include",
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

  /**
   * Slim variant of {@link getTasks}. Same filters, but the server returns
   * only the fields the list rows render (~70-90% smaller payload). Use
   * this for the Tasks page, Dashboard, and any list view. Fall back to
   * `getTask(id)` for the full record on detail screens.
   */
  getTasksSlim(filters?: TaskFilters): Promise<TaskSlim[]> {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.group) params.set("group", filters.group);
    if (filters?.assignTo) params.set("assignTo", filters.assignTo);
    params.set("slim", "true");
    return this.get<TaskSlim[]>(`/tasks?${params.toString()}`);
  }

  getTask(taskId: string): Promise<Task> {
    return this.get<Task>(`/tasks/${taskId}`);
  }

  /**
   * Cursor-paginated task list with optional full-text search.
   *
   * Triggers the paginated response envelope (`{ tasks, nextCursor, hasMore }`)
   * on the server side. Pass `cursor` from a previous page's `nextCursor`
   * to fetch the next page. Pass `q` to switch the server into FTS5
   * ranked-search mode (cursor is ignored in that mode).
   *
   * Backed by the SQLite FTS5 virtual table when the server uses SQLite
   * (default). PostgreSQL / file-backed stores fall back to in-memory
   * filtering — same shape, slower under load.
   */
  getTasksPage(opts?: TasksPageRequest): Promise<TasksPageResponse> {
    const params = new URLSearchParams();
    params.set("limit", String(opts?.limit ?? 50));
    if (opts?.cursor) params.set("cursor", opts.cursor);
    if (opts?.q) params.set("q", opts.q);
    if (opts?.status) params.set("status", String(opts.status));
    if (opts?.group) params.set("group", opts.group);
    if (opts?.assignTo) params.set("assignTo", opts.assignTo);
    if (opts?.slim) params.set("slim", "true");
    return this.get<TasksPageResponse>(`/tasks?${params.toString()}`);
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

  sendTaskDirection(taskId: string, req: SendTaskDirectionRequest): Promise<SendTaskDirectionResult> {
    return this.post<SendTaskDirectionResult>(`/tasks/${taskId}/directions`, req);
  }

  getTaskDirections(taskId: string): Promise<TaskDirection[]> {
    return this.get<TaskDirection[]>(`/tasks/${taskId}/directions`);
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

  /**
   * Slim variant of {@link getMissions}. Drops the `data` blob and the
   * full `prompt` (often 2-10× smaller). Adds `taskCount`. Use for the
   * Missions list page, Dashboard, and any list view.
   */
  getMissionsSlim(): Promise<MissionSlim[]> {
    return this.get<MissionSlim[]>("/missions?slim=true");
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
    /** Logical mailbox account (groups SMTP+IMAP of the same mailbox). */
    account?: string;
    /** Other agent names allowed to use this credential (shared). */
    allowedAgents?: string[];
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
    patch: { type?: string; label?: string; account?: string; allowedAgents?: string[]; credentials?: Record<string, string> },
  ): Promise<{ agent: string; service: string; type: string; keys: string[] }> {
    return this.patch<{ agent: string; service: string; type: string; keys: string[] }>(
      `/vault/entries/${encodeURIComponent(agent)}/${encodeURIComponent(service)}`,
      patch,
    );
  }

  /**
   * Create a login in an agent's vault with a password Polpo generates. The password is never
   * returned: the agent fills it with browser_fill { from_vault: "<service>.password" }.
   */
  generateVaultLogin(agent: string, service: string, req: GenerateVaultLoginRequest = {}): Promise<GenerateVaultLoginResult> {
    return this.post<GenerateVaultLoginResult>(
      `/vault/entries/${encodeURIComponent(agent)}/${encodeURIComponent(service)}/generate`,
      req,
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

  // ── Member preferences ────────────────────────────────────

  /** The signed-in member's dashboard preferences (chat navigation: open chat, tabs, panels). */
  getPreferences(): Promise<MemberPreferencesResponse> {
    return this.get<MemberPreferencesResponse>("/preferences");
  }

  /** Merge fields into the signed-in member's preferences; returns the stored result. */
  updatePreferences(patch: MemberPreferencesPatch): Promise<MemberPreferencesResponse> {
    return this.patch<MemberPreferencesResponse>("/preferences", patch);
  }

  // ── Global search ─────────────────────────────────────────

  /**
   * Search everything (chats with their messages, agents, tasks, missions, artifacts, files, data…),
   * grouped by type, best first. Pass a signal to cancel a stale query.
   */
  async search(q: string, opts: SearchOptions = {}): Promise<SearchResponse> {
    const params = new URLSearchParams({ q });
    if (opts.types?.length) params.set("types", opts.types.join(","));
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.perType) params.set("perType", String(opts.perType));
    if (opts.cursor) params.set("cursor", opts.cursor);
    const res = await this.fetchFn(this.apiUrl(`/search?${params}`), {
      method: "GET",
      headers: { ...this.headers },
      credentials: "include",
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const json = (await res.json()) as ApiResult<SearchResponse>;
    if (!json.ok) throw new PolpoApiError(json.error, json.code, res.status, json.details);
    return json.data;
  }

  /**
   * Ask Polpo from the search (POST /search/ask): the orchestrator's model searches, answers in a
   * line or two, picks the results worth opening and returns intents (pages to open, commands,
   * suggested changes). Nothing is executed by the server. With onEvent the answer streams.
   */
  async searchAsk(q: string, opts: SearchAskOptions = {}): Promise<SearchAskResult> {
    const { onEvent, signal, ...context } = opts;
    const res = await this.fetchFn(this.apiUrl("/search/ask"), {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ q, ...context, ...(onEvent ? { stream: true } : {}) }),
      ...(signal ? { signal } : {}),
    });
    if (!onEvent || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const json = (await res.json()) as ApiResult<SearchAskResult>;
      if (!json.ok) throw new PolpoApiError(json.error, json.code, res.status, json.details);
      return json.data;
    }
    const reader = res.body?.getReader();
    if (!reader) throw new PolpoApiError("No response body", "INTERNAL_ERROR", 500);
    const decoder = new TextDecoder();
    let buffer = "";
    let result: SearchAskResult | undefined;
    let failure: { error: string; code?: string } | undefined;
    const handle = (line: string) => {
      if (!line.startsWith("data:")) return;
      let event: SearchAskEvent;
      try { event = JSON.parse(line.slice(5).trim()) as SearchAskEvent; } catch { return; }
      if (event.type === "done") result = event.result;
      if (event.type === "error") failure = event;
      onEvent(event);
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handle(line.trim());
    }
    if (buffer.trim()) handle(buffer.trim());
    if (failure) throw new PolpoApiError(failure.error, (failure.code ?? "INTERNAL_ERROR") as never, 502);
    if (!result) throw new PolpoApiError("The answer was cut short", "INTERNAL_ERROR", 502);
    return result;
  }

  // ── Schedules ─────────────────────────────────────────────

  getSchedules(): Promise<ScheduleEntry[]> {
    return this.get<ScheduleEntry[]>("/schedules");
  }

  // ── Connectors ───────────────────────────────────────────

  /** The connectors (external apps over MCP), with their status, account and who may use them. */
  getConnectors(): Promise<Connector[]> {
    return this.get<{ connectors: Connector[] }>("/connectors").then((d) => d.connectors);
  }

  // ── Computers: live view and take control ──

  /** A remote computer's live view and who holds its desktop; viewer: also this person's VNC password while it runs. Never starts it. */
  getComputerDesktop(id: string, o: { viewer?: boolean } = {}): Promise<ComputerDesktopView> {
    return this.get(`/computers/${encodeURIComponent(id)}/desktop${o.viewer ? "?viewer=1" : ""}`);
  }

  /** Start the live view (starts or wakes the computer); the answer carries this person's viewer access. */
  startComputerDesktop(id: string): Promise<ComputerDesktopView> {
    return this.post(`/computers/${encodeURIComponent(id)}/desktop/start`);
  }

  /** Stop the live view (the display and the browser windows stay). */
  stopComputerDesktop(id: string): Promise<ComputerDesktopView> {
    return this.post(`/computers/${encodeURIComponent(id)}/desktop/stop`);
  }

  /** Who holds the computer's desktop and its agents' takeover requests (open first). */
  getComputerControl(id: string): Promise<ComputerControl> {
    return this.get(`/computers/${encodeURIComponent(id)}/control`);
  }

  /** The signed-in person takes control (the agent's browser waits); force: take it from another person. */
  takeoverComputer(id: string, o: { force?: boolean } = {}): Promise<ComputerDesktopView> {
    return this.post(`/computers/${encodeURIComponent(id)}/takeover`, o.force ? { force: true } : {});
  }

  /** Give control back to the agent, with an optional note it reads (never a password). */
  releaseComputer(id: string, o: { note?: string; force?: boolean } = {}): Promise<ComputerDesktopView> {
    return this.post(`/computers/${encodeURIComponent(id)}/release`, { ...(o.note ? { note: o.note } : {}), ...(o.force ? { force: true } : {}) });
  }

  /** Every agent waiting for a person (open takeover requests of all computers), oldest first. */
  getComputerTakeovers(): Promise<ComputerTakeoverRequest[]> {
    return this.get<{ requests: ComputerTakeoverRequest[] }>("/computer-takeovers").then((d) => d.requests);
  }

  // ── Decisions (decide(): typed judgments with probabilities from the decision model) ──

  /** Ask the decision model typed questions about a state: predicate, choice, score, rank. Throws 409 when no decision model is configured. */
  decide(req: DecideRequest): Promise<DecideResult> {
    return this.post("/decide", req);
  }

  /** The decision log, newest first. */
  getDecisions(o: { limit?: number; cursor?: string; caller?: DecisionCallerKind; callerId?: string; uncertain?: boolean; status?: "ok" | "error" } = {}): Promise<DecisionLogPage> {
    const q = new URLSearchParams();
    if (o.limit) q.set("limit", String(o.limit));
    if (o.cursor) q.set("cursor", o.cursor);
    if (o.caller) q.set("caller", o.caller);
    if (o.callerId) q.set("callerId", o.callerId);
    if (o.uncertain !== undefined) q.set("uncertain", String(o.uncertain));
    if (o.status) q.set("status", o.status);
    const qs = q.toString();
    return this.get(`/decisions${qs ? `?${qs}` : ""}`);
  }

  /** One decision with its questions and (capped) state. */
  getDecision(id: string): Promise<DecisionLogEntry> {
    return this.get(`/decisions/${encodeURIComponent(id)}`);
  }

  /** The decision model, its gateway and where its key comes from (never the key). */
  getDecisionStatus(): Promise<DecisionStatus> {
    return this.get("/decisions/status");
  }

  /** Missions' decision nodes: deciding, decided, or waiting for a person. */
  getDecisionNodes(): Promise<DecisionNodeState[]> {
    return this.get("/decisions/nodes");
  }

  /** Choose the branch of a decision node waiting for a person (null: none of its tasks run); the mission resumes. */
  resolveDecisionNode(group: string, node: string, branch: string | null): Promise<DecisionNodeState> {
    return this.post("/decisions/nodes/resolve", { group, node, branch });
  }

  // ── Media (image generation and editing: the media primitive) ──

  /** Generate images with the image model (settings.imageModel). Throws 409 when no image model is configured. */
  generateImage(req: GenerateImageRequest): Promise<MediaResult> {
    return this.post("/media/images", req);
  }

  /** Change an image (or compose several) with a prompt, optionally inside a mask. */
  editImage(req: EditImageRequest): Promise<MediaResult> {
    return this.post("/media/images/edits", req);
  }

  /** The media log (every image request with its provenance and images), newest first. */
  getMediaLog(o: { limit?: number; cursor?: string; caller?: MediaCallerKind; callerId?: string; status?: "ok" | "error"; kind?: "generate" | "edit" } = {}): Promise<MediaLogPage> {
    const q = new URLSearchParams();
    if (o.limit) q.set("limit", String(o.limit));
    if (o.cursor) q.set("cursor", o.cursor);
    if (o.caller) q.set("caller", o.caller);
    if (o.callerId) q.set("callerId", o.callerId);
    if (o.status) q.set("status", o.status);
    if (o.kind) q.set("kind", o.kind);
    const qs = q.toString();
    return this.get(`/media/images${qs ? `?${qs}` : ""}`);
  }

  /** One image request with its provenance and images. */
  getMediaEntry(id: string): Promise<MediaLogEntry> {
    return this.get(`/media/images/${encodeURIComponent(id)}`);
  }

  /** The image model, its gateway, the fallback and where the key comes from (never the key). */
  getMediaStatus(): Promise<MediaStatus> {
    return this.get("/media/status");
  }

  /** Missions' image nodes: generating, done or failed. */
  getImageNodes(): Promise<ImageNodeState[]> {
    return this.get("/media/nodes");
  }

  /** The URL of an image of the media log (thumb: its 512 px preview; download: as an attachment). */
  mediaImageUrl(id: string, index: number, opts: { thumb?: boolean; download?: boolean } = {}): string {
    const q = new URLSearchParams();
    if (opts.thumb) q.set("thumb", "1");
    if (opts.download) q.set("download", "1");
    const qs = q.toString();
    return this.apiUrl(`/media/images/${encodeURIComponent(id)}/${index}${qs ? `?${qs}` : ""}`);
  }

  // ── Triggers (POST /hooks/{id}: forms and webhooks, with actions on accepted deliveries) ──

  getTriggers(): Promise<Trigger[]> {
    return this.get("/triggers");
  }

  getTrigger(id: string): Promise<Trigger> {
    return this.get(`/triggers/${encodeURIComponent(id)}`);
  }

  /** Create a trigger; `secret` (the generated one) is returned this once. */
  createTrigger(input: TriggerInput & { name: string }): Promise<{ trigger: Trigger; secret?: string }> {
    return this.post("/triggers", input);
  }

  /** Change a trigger; a contract change makes a new contract version. */
  updateTrigger(id: string, input: TriggerInput): Promise<{ trigger: Trigger; secret?: string }> {
    return this.patch(`/triggers/${encodeURIComponent(id)}`, input);
  }

  deleteTrigger(id: string): Promise<{ deleted: boolean }> {
    return this.del(`/triggers/${encodeURIComponent(id)}`);
  }

  /** A new generated secret (returned this once); the previous works for overlapSeconds (default a day). */
  rotateTriggerSecret(id: string, overlapSeconds?: number): Promise<{ secret: string; previousValidUntil?: string; trigger: Trigger }> {
    return this.post(`/triggers/${encodeURIComponent(id)}/rotate-secret`, overlapSeconds !== undefined ? { overlapSeconds } : {});
  }

  /** The HMAC signing secret into the vault (never echoed); `generate: true` makes one, returned this once. */
  setTriggerHmacSecret(id: string, o: { secret?: string; generate?: boolean; overlapSeconds?: number }): Promise<{ secret?: string; status: { secretSet: boolean; previousUntil?: string } }> {
    return this.put(`/triggers/${encodeURIComponent(id)}/hmac-secret`, o);
  }

  removeTriggerHmacSecret(id: string): Promise<{ secretSet: boolean }> {
    return this.del(`/triggers/${encodeURIComponent(id)}/hmac-secret`);
  }

  getTriggerContractVersions(id: string): Promise<TriggerContractRevision[]> {
    return this.get(`/triggers/${encodeURIComponent(id)}/contract-versions`);
  }

  diffTriggerContract(id: string, from: number, to: number): Promise<{ from: number; to: number; diff: string }> {
    return this.get(`/triggers/${encodeURIComponent(id)}/contract-versions/diff?from=${from}&to=${to}`);
  }

  getTriggerDeliveries(id: string, o: { limit?: number; cursor?: string; status?: TriggerDeliveryStatus[]; test?: boolean } = {}): Promise<TriggerDeliveryPage> {
    const q = new URLSearchParams();
    if (o.limit) q.set("limit", String(o.limit));
    if (o.cursor) q.set("cursor", o.cursor);
    if (o.status?.length) q.set("status", o.status.join(","));
    if (o.test !== undefined) q.set("test", String(o.test));
    const qs = q.toString();
    return this.get(`/triggers/${encodeURIComponent(id)}/deliveries${qs ? `?${qs}` : ""}`);
  }

  getTriggerDelivery(id: string, deliveryId: string): Promise<TriggerDelivery> {
    return this.get(`/triggers/${encodeURIComponent(id)}/deliveries/${encodeURIComponent(deliveryId)}`);
  }

  /** A test delivery (recorded with test: true) through the contract, filter, dedupe and mapping. */
  sendTriggerTest(id: string, sample: TriggerSample): Promise<TriggerDelivery> {
    return this.post(`/triggers/${encodeURIComponent(id)}/test`, sample);
  }

  /** A sample against the contract, filter, dedupe and mapping (saved, or a draft), without recording it. */
  validateTriggerSample(id: string, sample: TriggerSample, draft?: TriggerDraft): Promise<TriggerDryRun> {
    return this.post(`/triggers/${encodeURIComponent(id)}/validate`, { sample, ...(draft ? { draft } : {}) });
  }

  /** A stored delivery through the current (or a draft) contract, filter, dedupe and mapping: a dry run. */
  replayTriggerDelivery(id: string, deliveryId: string, draft?: TriggerDraft): Promise<TriggerDryRun> {
    return this.post(`/triggers/${encodeURIComponent(id)}/deliveries/${encodeURIComponent(deliveryId)}/replay`, draft ? { draft } : {});
  }

  /** Run the trigger's current actions again on a stored accepted delivery (they run after the answer). */
  rerunTriggerActions(id: string, deliveryId: string): Promise<{ deliveryId: string; actionsStatus?: TriggerActionsStatus; actions: TriggerActionRun[] }> {
    return this.post(`/triggers/${encodeURIComponent(id)}/deliveries/${encodeURIComponent(deliveryId)}/run-actions`, {});
  }

  /** The actions (saved, or a draft) rendered against a delivery (default: the newest accepted one); nothing runs. */
  previewTriggerActions(id: string, o: { deliveryId?: string; actions?: TriggerActionInput[] } = {}): Promise<TriggerActionPreview> {
    return this.post(`/triggers/${encodeURIComponent(id)}/actions/preview`, o);
  }

  /** Actions started today and what the agent actions spent (UTC day). */
  getTriggerActionUsage(id: string): Promise<{ day: string; actions: number; agentUsd: number }> {
    return this.get(`/triggers/${encodeURIComponent(id)}/action-usage`);
  }

  /** A JSON Schema from a sample (or, with a trigger, from one of its deliveries). */
  inferTriggerSchema(o: { sample?: unknown; triggerId?: string; deliveryId?: string }): Promise<{ schema: Record<string, unknown> }> {
    if (o.triggerId) return this.post(`/triggers/${encodeURIComponent(o.triggerId)}/infer-schema`, o.deliveryId ? { deliveryId: o.deliveryId } : { sample: o.sample });
    return this.post("/triggers/infer-schema", { sample: o.sample });
  }

  // ── WhatsApp Business (Meta Cloud API) ─────────────────────

  /** Every WhatsApp Business channel's status (never a secret's value). */
  getWaBusinessChannels(): Promise<WaBusinessStatus[]> {
    return this.get<{ channels: WaBusinessStatus[] }>("/whatsapp-business").then((d) => d.channels);
  }

  getWaBusinessStatus(channel: string): Promise<WaBusinessStatus> {
    return this.get<WaBusinessStatus>(`/whatsapp-business/${encodeURIComponent(channel)}/status`);
  }

  /** Store secrets in the vault (dashboard); only the ones given change. Returns which are set. */
  setWaBusinessSecrets(channel: string, secrets: Partial<Record<WaBizSecretKind, string>>): Promise<{ secrets: Record<WaBizSecretKind, boolean> }> {
    return this.put(`/whatsapp-business/${encodeURIComponent(channel)}/secrets`, secrets);
  }

  removeWaBusinessSecret(channel: string, kind: WaBizSecretKind): Promise<{ secrets: Record<WaBizSecretKind, boolean> }> {
    return this.del(`/whatsapp-business/${encodeURIComponent(channel)}/secrets/${kind}`);
  }

  /** A fresh verify token, returned this once (paste it in Meta's dashboard). */
  generateWaBusinessVerifyToken(channel: string): Promise<{ verifyToken: string }> {
    return this.post(`/whatsapp-business/${encodeURIComponent(channel)}/verify-token`);
  }

  getWaBusinessEvents(channel: string, o: { limit?: number; cursor?: string; outcome?: WaBizOutcome[] } = {}): Promise<WaBusinessEventPage> {
    const q = new URLSearchParams();
    if (o.limit) q.set("limit", String(o.limit));
    if (o.cursor) q.set("cursor", o.cursor);
    if (o.outcome?.length) q.set("outcome", o.outcome.join(","));
    const qs = q.toString();
    return this.get(`/whatsapp-business/${encodeURIComponent(channel)}/events${qs ? `?${qs}` : ""}`);
  }

  getWaBusinessEvent(channel: string, id: string): Promise<WaBusinessEvent> {
    return this.get(`/whatsapp-business/${encodeURIComponent(channel)}/events/${encodeURIComponent(id)}`);
  }

  getWaBusinessContacts(channel: string, limit?: number): Promise<WaBusinessContact[]> {
    return this.get<{ contacts: WaBusinessContact[] }>(`/whatsapp-business/${encodeURIComponent(channel)}/contacts${limit ? `?limit=${limit}` : ""}`).then((d) => d.contacts);
  }

  getWaBusinessConversation(channel: string, waId: string, limit?: number): Promise<WaBusinessConversation> {
    return this.get(`/whatsapp-business/${encodeURIComponent(channel)}/contacts/${encodeURIComponent(waId)}${limit ? `?limit=${limit}` : ""}`);
  }

  setWaBusinessOptIn(channel: string, waId: string, optIn: boolean, source?: string): Promise<WaBusinessContact> {
    return this.put(`/whatsapp-business/${encodeURIComponent(channel)}/contacts/${encodeURIComponent(waId)}/opt-in`, { optIn, ...(source ? { source } : {}) });
  }

  /** Erase a contact and its messages (GDPR). */
  deleteWaBusinessContact(channel: string, waId: string): Promise<{ deleted: boolean }> {
    return this.del(`/whatsapp-business/${encodeURIComponent(channel)}/contacts/${encodeURIComponent(waId)}`);
  }

  /** Free-form text, inside the 24-hour window only. replyTo quotes a message (its wamid). */
  sendWaBusinessText(channel: string, to: string, text: string, o: { replyTo?: string; by?: string } = {}): Promise<WaBusinessSendResult> {
    return this.post(`/whatsapp-business/${encodeURIComponent(channel)}/send`, { to, text, ...(o.replyTo ? { replyTo: o.replyTo } : {}), ...(o.by ? { by: o.by } : {}) });
  }

  /**
   * Any message type inside the 24-hour window: text, media (by Meta media id, public link, or a
   * base64 file uploaded first), location, contacts, reaction, buttons, list, CTA URL, location
   * request, flow, product / product list / catalog, call button, call permission request,
   * address (India), order details (India, Brazil) and order status. Checked against Meta's limits.
   */
  sendWaBusinessMessage(channel: string, input: { to: string; message: WaBizOutbound; file?: WaBizFileInput; by?: string }): Promise<{ status: "sent"; ids: string[] }> {
    return this.post(`/whatsapp-business/${encodeURIComponent(channel)}/messages`, input);
  }

  /** React to a message (an empty emoji removes the reaction). */
  reactWaBusiness(channel: string, input: { to: string; messageId: string; emoji: string; by?: string }): Promise<{ status: "sent"; ids: string[] }> {
    return this.post(`/whatsapp-business/${encodeURIComponent(channel)}/react`, input);
  }

  /** Mark a contact's message read (blue ticks), optionally showing the typing indicator. */
  markWaBusinessRead(channel: string, messageId: string, o: { typing?: boolean } = {}): Promise<{ read: string }> {
    return this.post(`/whatsapp-business/${encodeURIComponent(channel)}/read`, { messageId, ...(o.typing ? { typing: true } : {}) });
  }

  /** The URL of a message's file (inbound downloads, outbound sends): needs the dashboard's session or the API key in a header. */
  waBusinessMediaUrl(channel: string, messageId: string): string {
    return this.apiUrl(`/whatsapp-business/${encodeURIComponent(channel)}/media/${encodeURIComponent(messageId)}`);
  }

  /** A message's file: its bytes, content type and file name (image, audio, voice note, video, document, sticker). */
  async getWaBusinessMedia(channel: string, messageId: string): Promise<{ contentType: string; bytes: ArrayBuffer; filename?: string }> {
    const res = await this.fetchFn(this.waBusinessMediaUrl(channel, messageId), { headers: { ...this.headers }, credentials: "include" });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string; code?: string } | null;
      throw new PolpoApiError(body?.error ?? "Could not read the media", (body?.code ?? "NOT_FOUND") as never, res.status);
    }
    const disposition = res.headers.get("content-disposition") ?? "";
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1];
    return { contentType: res.headers.get("content-type") ?? "application/octet-stream", bytes: await res.arrayBuffer(), ...(filename ? { filename } : {}) };
  }

  /**
   * An approved template (business-initiated); queue: wait for an operator's approval. params are
   * the positional body variables; components fills every component (header, named body variables,
   * buttons, carousel cards, OTP).
   */
  sendWaBusinessTemplate(channel: string, input: { to: string; template: string; language?: string; params?: string[]; components?: WaBizTemplateInput; queue?: boolean; reason?: string; by?: string }): Promise<WaBusinessSendResult> {
    return this.post(`/whatsapp-business/${encodeURIComponent(channel)}/send-template`, input);
  }

  /** Create a template (it goes to Meta's review; its status comes back by webhook and sync). */
  createWaBusinessTemplate(channel: string, definition: WaBusinessTemplateDefinition): Promise<{ id: string; status: string; category: string }> {
    return this.post(`/whatsapp-business/${encodeURIComponent(channel)}/templates`, definition);
  }

  /** Edit a template by its id (it goes back to review). */
  editWaBusinessTemplate(channel: string, id: string, patch: { components?: Array<Record<string, unknown>>; category?: WaBusinessTemplateDefinition["category"] }): Promise<{ id: string; edited: true }> {
    return this.patch(`/whatsapp-business/${encodeURIComponent(channel)}/templates/${encodeURIComponent(id)}`, patch);
  }

  /** Delete a template: every language, or only the one with this id. */
  deleteWaBusinessTemplate(channel: string, template: string, id?: string): Promise<{ template: string; deleted: true }> {
    return this.del(`/whatsapp-business/${encodeURIComponent(channel)}/templates/${encodeURIComponent(template)}${id ? `?id=${encodeURIComponent(id)}` : ""}`);
  }

  getWaBusinessProfile(channel: string): Promise<WaBusinessProfile> {
    return this.get(`/whatsapp-business/${encodeURIComponent(channel)}/profile`);
  }

  /** Update the business profile; the photo (JPEG or PNG ≤ 5 MB, base64) needs business.appId. */
  updateWaBusinessProfile(channel: string, profile: Omit<WaBusinessProfile, "profilePictureUrl"> & { photo?: WaBizFileInput }): Promise<WaBusinessProfile> {
    return this.put(`/whatsapp-business/${encodeURIComponent(channel)}/profile`, profile);
  }

  /** Block (or unblock) contacts at Meta: only people who wrote in the last 24 hours can be blocked. */
  blockWaBusinessUsers(channel: string, users: string[], block: boolean, by?: string): Promise<WaBusinessBlockResult> {
    return this.post(`/whatsapp-business/${encodeURIComponent(channel)}/block`, { users, block, ...(by ? { by } : {}) });
  }

  /** The contacts blocked at Meta. */
  getWaBusinessBlocked(channel: string): Promise<string[]> {
    return this.get<{ blocked: string[] }>(`/whatsapp-business/${encodeURIComponent(channel)}/blocked`).then((d) => d.blocked);
  }

  /** Meta's analytics: messages sent / delivered, pricing (cost and volume), templates (sent, delivered, read, clicked). */
  getWaBusinessAnalytics(channel: string, q: WaBusinessAnalyticsQuery): Promise<unknown> {
    const p = new URLSearchParams({ kind: q.kind, start: String(q.start), end: String(q.end) });
    if (q.granularity) p.set("granularity", q.granularity);
    if (q.templateIds?.length) p.set("templateIds", q.templateIds.join(","));
    if (q.dimensions?.length) p.set("dimensions", q.dimensions.join(","));
    return this.get(`/whatsapp-business/${encodeURIComponent(channel)}/analytics?${p.toString()}`);
  }

  /** The phone number at Meta: register (PIN), deregister, set the two-step PIN, request / verify the code, subscribe the app. */
  waBusinessPhoneAction(channel: string, action: WaBusinessPhoneAction): Promise<{ action: WaBusinessPhoneAction["action"]; done: true }> {
    return this.post(`/whatsapp-business/${encodeURIComponent(channel)}/phone`, action);
  }

  /** This number's callback at Meta (one app shared by several instances). */
  getWaBusinessWebhookOverride(channel: string): Promise<WaBusinessWebhookOverride> {
    return this.get(`/whatsapp-business/${encodeURIComponent(channel)}/webhook-override`);
  }

  /** set: true points this number's deliveries at this instance; false goes back to the app's callback. */
  setWaBusinessWebhookOverride(channel: string, set: boolean): Promise<WaBusinessWebhookOverride> {
    return this.put(`/whatsapp-business/${encodeURIComponent(channel)}/webhook-override`, { set });
  }

  /** Account updates from Meta (quality, tier, name review, templates, capabilities, alerts), newest first. */
  getWaBusinessAccountEvents(channel: string, limit?: number): Promise<WaBusinessAccountEvent[]> {
    return this.get<{ events: WaBusinessAccountEvent[] }>(`/whatsapp-business/${encodeURIComponent(channel)}/account-events${limit ? `?limit=${limit}` : ""}`).then((d) => d.events);
  }

  getWaBusinessTemplates(channel: string, refresh = false): Promise<{ templates: WaBusinessTemplate[]; syncedAt?: string }> {
    return this.get(`/whatsapp-business/${encodeURIComponent(channel)}/templates${refresh ? "?refresh=true" : ""}`);
  }

  syncWaBusinessTemplates(channel: string): Promise<{ templates: WaBusinessTemplate[]; syncedAt?: string }> {
    return this.post(`/whatsapp-business/${encodeURIComponent(channel)}/templates/sync`);
  }

  getWaBusinessPending(channel: string): Promise<WaBusinessMessage[]> {
    return this.get<{ pending: WaBusinessMessage[] }>(`/whatsapp-business/${encodeURIComponent(channel)}/pending`).then((d) => d.pending);
  }

  approveWaBusinessSend(channel: string, id: string, by?: string): Promise<{ id: string; sentAs: string }> {
    return this.post(`/whatsapp-business/${encodeURIComponent(channel)}/pending/${encodeURIComponent(id)}/approve`, by ? { by } : {});
  }

  rejectWaBusinessSend(channel: string, id: string, reason?: string, by?: string): Promise<{ id: string; status: "rejected" }> {
    return this.post(`/whatsapp-business/${encodeURIComponent(channel)}/pending/${encodeURIComponent(id)}/reject`, { ...(reason ? { reason } : {}), ...(by ? { by } : {}) });
  }

  /** Check the token and the number at Meta: quality rating and messaging tier when Graph returns them. */
  testWaBusiness(channel: string): Promise<NonNullable<WaBusinessStatus["phone"]>> {
    return this.post(`/whatsapp-business/${encodeURIComponent(channel)}/test`);
  }

  // ── Slack (Socket Mode) ────────────────────────────────────

  /** Every Slack channel's inbound connection (never a token's value). */
  getSlackChannels(): Promise<SlackStatus[]> {
    return this.get<{ channels: SlackStatus[] }>("/slack").then((d) => d.channels);
  }

  getSlackStatus(channel: string): Promise<SlackStatus> {
    return this.get<SlackStatus>(`/slack/${encodeURIComponent(channel)}/status`);
  }

  /** Store the app's tokens in the vault (dashboard); only the ones given change. Returns which are set. */
  setSlackSecrets(channel: string, secrets: Partial<Record<SlackSecretKind, string>>): Promise<{ secrets: Record<SlackSecretKind, boolean> }> {
    return this.put(`/slack/${encodeURIComponent(channel)}/secrets`, secrets);
  }

  removeSlackSecret(channel: string, kind: SlackSecretKind): Promise<{ secrets: Record<SlackSecretKind, boolean> }> {
    return this.del(`/slack/${encodeURIComponent(channel)}/secrets/${kind}`);
  }

  /** auth.test with the bot token. */
  testSlack(channel: string): Promise<{ ok: boolean; status: SlackStatus }> {
    return this.post(`/slack/${encodeURIComponent(channel)}/test`);
  }

  // ── Peers: the people on the channels ──────────────────────

  getPeers(channel?: string): Promise<ChannelPeer[]> {
    return this.get<ChannelPeer[]>(`/peers${channel ? `?channel=${encodeURIComponent(channel)}` : ""}`);
  }

  /** Who is active on the channels right now. */
  getPeerPresence(): Promise<PeerPresence[]> {
    return this.get<PeerPresence[]>("/peers/presence");
  }

  /** Link a peer to another identity of the same person (shared sessions); null unlinks it. */
  linkPeers(peerId: string, linkedTo: string | null): Promise<{ peerId: string; linkedTo: string | null }> {
    return this.post("/peers/link", { peerId, linkedTo });
  }

  getConnector(id: string): Promise<Connector> {
    return this.get<Connector>(`/connectors/${encodeURIComponent(id)}`);
  }

  /** A connector's tools (names as agent.connectorTools lists them) and their policy. */
  getConnectorTools(id: string): Promise<ConnectorTool[]> {
    return this.get<{ tools: ConnectorTool[] }>(`/connectors/${encodeURIComponent(id)}/tools`).then((d) => d.tools);
  }

  // ── Agents ───────────────────────────────────────────────

  getAgents(): Promise<AgentConfig[]> {
    return this.get<AgentConfig[]>("/agents");
  }

  /** An agent as production runs it; view "draft": its draft (working copy), as the dashboard edits it. */
  getAgent(name: string, opts: { view?: "production" | "draft" } = {}): Promise<AgentConfig> {
    return this.get<AgentConfig>(`/agents/${encodeURIComponent(name)}${opts.view === "draft" ? "?view=draft" : ""}`);
  }

  /** The org chart and the communication lines between agents (who may talk to whom). */
  getAgentLines(): Promise<AgentLinesChart> {
    return this.get<AgentLinesChart>("/agents/lines");
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

  // ── Agent versions ──

  /** An agent's published versions (newest first), production pointer and draft state. */
  getAgentVersions(name: string): Promise<AgentVersionList> {
    return this.get<AgentVersionList>(`/agents/${encodeURIComponent(name)}/versions`);
  }

  /** One version with its config: a semver, "production" or "draft". */
  getAgentVersion(name: string, version: string): Promise<AgentVersion> {
    return this.get<AgentVersion>(`/agents/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`);
  }

  /** Diff two refs (a version, "production", "draft"); to defaults to the draft. */
  diffAgentVersions(name: string, opts: { from?: string; to?: string } = {}): Promise<AgentVersionDiff> {
    const q = new URLSearchParams();
    if (opts.from) q.set("from", opts.from);
    if (opts.to) q.set("to", opts.to);
    const qs = q.toString();
    return this.get<AgentVersionDiff>(`/agents/${encodeURIComponent(name)}/diff${qs ? `?${qs}` : ""}`);
  }

  /** Publish the draft as a new version (deploy: true also deploys it to production). */
  publishAgent(name: string, req: { bump?: AgentVersionBump; version?: string; note?: string; deploy?: boolean } = {}): Promise<AgentPublishResult> {
    return this.post<AgentPublishResult>(`/agents/${encodeURIComponent(name)}/publish`, req);
  }

  /** Move a stale draft onto what production runs now (after a rollback or deploy). */
  rebaseAgentDraft(name: string): Promise<{ from?: string; to?: string; dropped: boolean }> {
    return this.post<{ from?: string; to?: string; dropped: boolean }>(`/agents/${encodeURIComponent(name)}/draft/rebase`);
  }

  /** Throw away the draft's unpublished changes. */
  discardAgentDraft(name: string): Promise<{ discarded: boolean }> {
    return this.del<{ discarded: boolean }>(`/agents/${encodeURIComponent(name)}/draft`);
  }

  /**
   * Deploy a published version to production. With required suites (deploy gate) the outcome may be
   * `pending` (they are running; production moves when they pass); a blocked deploy throws a
   * PolpoApiError with code GATE_BLOCKED. `override` (admins only): deploy anyway, with a reason.
   */
  deployAgentVersion(name: string, version: string, note?: string, opts: { override?: { reason: string }; wait?: boolean } = {}): Promise<AgentDeployOutcome> {
    return this.post<AgentDeployOutcome>(`/agents/${encodeURIComponent(name)}/deploy`, { version, ...(note ? { note } : {}), ...(opts.override ? { override: opts.override } : {}), ...(opts.wait ? { wait: true } : {}) });
  }

  /** An agent's deploy gates, newest first (version: only that version's). */
  getAgentDeployGates(name: string, opts: { version?: string; limit?: number } = {}): Promise<AgentDeployGate[]> {
    const q = new URLSearchParams();
    if (opts.version) q.set("version", opts.version);
    if (opts.limit) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return this.get<AgentDeployGate[]>(`/agents/${encodeURIComponent(name)}/deploy-gates${qs ? `?${qs}` : ""}`);
  }

  /** One deploy gate (waitSeconds: wait up to that long, max 55, for it to finish). */
  getAgentDeployGate(name: string, id: string, opts: { waitSeconds?: number } = {}): Promise<AgentDeployGate> {
    return this.get<AgentDeployGate>(`/agents/${encodeURIComponent(name)}/deploy-gates/${encodeURIComponent(id)}${opts.waitSeconds ? `?wait=${opts.waitSeconds}` : ""}`);
  }

  /** Stop a verification: nothing is deployed. */
  cancelAgentDeployGate(name: string, id: string): Promise<AgentDeployGate> {
    return this.post<AgentDeployGate>(`/agents/${encodeURIComponent(name)}/deploy-gates/${encodeURIComponent(id)}/cancel`);
  }

  /** Deploy a gate's version anyway (admins only; the reason is recorded in the deploy history). */
  overrideAgentDeployGate(name: string, id: string, reason: string, note?: string): Promise<AgentDeployOutcome> {
    return this.post<AgentDeployOutcome>(`/agents/${encodeURIComponent(name)}/deploy-gates/${encodeURIComponent(id)}/override`, { reason, ...(note ? { note } : {}) });
  }

  /** Roll production back to the previous deploy (or to a version). */
  rollbackAgent(name: string, opts: { to?: string; note?: string } = {}): Promise<AgentDeployEntry> {
    return this.post<AgentDeployEntry>(`/agents/${encodeURIComponent(name)}/rollback`, opts);
  }

  /** The deploy history, newest first (withDiff: each with its diff). */
  getAgentDeploys(name: string, opts: { limit?: number; withDiff?: boolean } = {}): Promise<AgentDeployEntry[]> {
    const q = new URLSearchParams();
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.withDiff) q.set("diff", "true");
    const qs = q.toString();
    return this.get<AgentDeployEntry[]>(`/agents/${encodeURIComponent(name)}/deploys${qs ? `?${qs}` : ""}`);
  }

  /** One deploy with its diff. */
  getAgentDeploy(name: string, id: string): Promise<AgentDeployEntry & { diff: AgentVersionDiff }> {
    return this.get<AgentDeployEntry & { diff: AgentVersionDiff }>(`/agents/${encodeURIComponent(name)}/deploys/${encodeURIComponent(id)}`);
  }

  // ── Agent tests ──

  /** Test an agent: all checks but the smoke run by default, or `checks`; kept in its history. */
  runAgentTests(name: string, req: AgentTestRunRequest = {}): Promise<AgentTestRun> {
    return this.post<AgentTestRun>(`/agents/${encodeURIComponent(name)}/tests`, req);
  }

  /** The agent's test runs, newest first. */
  getAgentTests(name: string, opts: { limit?: number } = {}): Promise<AgentTestRun[]> {
    return this.get<AgentTestRun[]>(`/agents/${encodeURIComponent(name)}/tests${opts.limit ? `?limit=${opts.limit}` : ""}`);
  }

  getAgentTest(name: string, id: string): Promise<AgentTestRun> {
    return this.get<AgentTestRun>(`/agents/${encodeURIComponent(name)}/tests/${encodeURIComponent(id)}`);
  }

  /** Apply a one-click fix a check offered (e.g. grant a connector's access to the agent). */
  fixAgentTest(name: string, action: AgentTestFixAction): Promise<{ message: string }> {
    return this.post<{ message: string }>(`/agents/${encodeURIComponent(name)}/tests/fix`, action);
  }

  // ── Agent suites ──

  /** The agent's test and eval suites. */
  getAgentSuites(name: string): Promise<AgentSuite[]> {
    return this.get<AgentSuite[]>(`/agents/${encodeURIComponent(name)}/suites`);
  }

  getAgentSuite(name: string, id: string): Promise<AgentSuite> {
    return this.get<AgentSuite>(`/agents/${encodeURIComponent(name)}/suites/${encodeURIComponent(id)}`);
  }

  /** The suite as YAML (the YAML view) with its revision. */
  getAgentSuiteYaml(name: string, id: string): Promise<{ yaml: string; revision: number }> {
    return this.get<{ yaml: string; revision: number }>(`/agents/${encodeURIComponent(name)}/suites/${encodeURIComponent(id)}?format=yaml`);
  }

  /** Create a suite (409 when its id exists). */
  createAgentSuite(name: string, suite: AgentSuiteInput | { yaml: string }): Promise<AgentSuite> {
    return this.post<AgentSuite>(`/agents/${encodeURIComponent(name)}/suites`, suite);
  }

  /** Replace (or create) a suite; `revision` refuses the save when it changed meanwhile (409). */
  saveAgentSuite(name: string, id: string, suite: AgentSuiteInput | { yaml: string }, revision?: number): Promise<AgentSuite> {
    return this.put<AgentSuite>(`/agents/${encodeURIComponent(name)}/suites/${encodeURIComponent(id)}`, { ...suite, ...(revision !== undefined ? { revision } : {}) });
  }

  deleteAgentSuite(name: string, id: string): Promise<{ deleted: string }> {
    return this.del<{ deleted: string }>(`/agents/${encodeURIComponent(name)}/suites/${encodeURIComponent(id)}`);
  }

  /**
   * Run several SQL statements in one transaction on a data source (PostgreSQL or SQLite): all
   * commit, or a failing statement / expectRows mismatch rolls everything back
   * (status "rolled_back", failed says which statement and why).
   */
  runDataTransaction(sourceId: string, req: DataTransactionRequest): Promise<DataTransactionResult> {
    return this.post<DataTransactionResult>(`/data/${encodeURIComponent(sourceId)}/transaction`, req);
  }

  /** Import a dataset from CSV or JSON into a suite. */
  importAgentSuiteDataset(name: string, id: string, req: SuiteDatasetImport): Promise<AgentSuite> {
    return this.post<AgentSuite>(`/agents/${encodeURIComponent(name)}/suites/${encodeURIComponent(id)}/datasets/import`, req);
  }

  /** Run a suite (returns it running unless `wait`). */
  runAgentSuite(name: string, id: string, req: SuiteRunRequest = {}): Promise<SuiteRun> {
    return this.post<SuiteRun>(`/agents/${encodeURIComponent(name)}/suites/${encodeURIComponent(id)}/runs`, req);
  }

  /** The agent's suite runs, newest first, without traces. */
  getAgentSuiteRuns(name: string, opts: { suite?: string; benchmark?: string; limit?: number } = {}): Promise<SuiteRun[]> {
    const q = new URLSearchParams();
    if (opts.suite) q.set("suite", opts.suite);
    if (opts.benchmark) q.set("benchmark", opts.benchmark);
    if (opts.limit) q.set("limit", String(opts.limit));
    const s = q.toString();
    return this.get<SuiteRun[]>(`/agents/${encodeURIComponent(name)}/suite-runs${s ? `?${s}` : ""}`);
  }

  /** One run with every case's assertions and trace. */
  getAgentSuiteRun(name: string, runId: string): Promise<SuiteRun> {
    return this.get<SuiteRun>(`/agents/${encodeURIComponent(name)}/suite-runs/${encodeURIComponent(runId)}`);
  }

  cancelAgentSuiteRun(name: string, runId: string): Promise<SuiteRun> {
    return this.post<SuiteRun>(`/agents/${encodeURIComponent(name)}/suite-runs/${encodeURIComponent(runId)}/cancel`);
  }

  /** A suite's finished runs over time (pass rate, score, cost, latency) and by version. */
  getAgentSuiteTrend(name: string, id: string, opts: { limit?: number } = {}): Promise<SuiteTrend> {
    return this.get<SuiteTrend>(`/agents/${encodeURIComponent(name)}/suites/${encodeURIComponent(id)}/trend${opts.limit ? `?limit=${opts.limit}` : ""}`);
  }

  /** The suite's marked baseline run (without traces), or null. */
  getAgentSuiteBaseline(name: string, id: string): Promise<SuiteRun | null> {
    return this.get<SuiteRun | null>(`/agents/${encodeURIComponent(name)}/suites/${encodeURIComponent(id)}/baseline`);
  }

  /** Mark a finished run as the suite's baseline (`runId` null clears the mark). */
  setAgentSuiteBaseline(name: string, id: string, runId: string | null): Promise<SuiteRun | null> {
    const path = `/agents/${encodeURIComponent(name)}/suites/${encodeURIComponent(id)}/baseline`;
    return runId ? this.put<SuiteRun | null>(path, { runId }) : this.del<SuiteRun | null>(path);
  }

  /** Compare a run with another (`baseline`) or with its suite's baseline now; null when there is nothing to compare with. */
  compareAgentSuiteRun(name: string, runId: string, opts: { baseline?: string; tolerance?: number } = {}): Promise<SuiteBaselineComparison | null> {
    const q = new URLSearchParams();
    if (opts.baseline) q.set("baseline", opts.baseline);
    if (opts.tolerance !== undefined) q.set("tolerance", String(opts.tolerance));
    const s = q.toString();
    return this.get<SuiteBaselineComparison | null>(`/agents/${encodeURIComponent(name)}/suite-runs/${encodeURIComponent(runId)}/compare${s ? `?${s}` : ""}`);
  }

  /** "Explain this run": an AI review (the suite's reviewer, or `reviewer`; default Polpo) stored on the run. */
  reviewAgentSuiteRun(name: string, runId: string, opts: { language?: string; reviewer?: SuiteRole } = {}): Promise<SuiteRun> {
    return this.post<SuiteRun>(`/agents/${encodeURIComponent(name)}/suite-runs/${encodeURIComponent(runId)}/review`, opts);
  }

  // ── Agent suites, phase 4: cassettes (record / replay), recordings, generation ──

  /** The agent's cassettes (recorded exchanges its cases replay), without their calls. */
  getAgentCassettes(name: string): Promise<SuiteCassetteSummary[]> {
    return this.get<SuiteCassetteSummary[]>(`/agents/${encodeURIComponent(name)}/cassettes`);
  }

  /** One cassette with every recorded model turn and tool call (secrets redacted). */
  getAgentCassette(name: string, id: string): Promise<SuiteCassette> {
    return this.get<SuiteCassette>(`/agents/${encodeURIComponent(name)}/cassettes/${encodeURIComponent(id)}`);
  }

  /** The cassette a case replays, or null when it was never recorded. */
  getAgentSuiteCaseCassette(name: string, suiteId: string, caseId: string): Promise<SuiteCassette | null> {
    return this.get<SuiteCassette | null>(`/agents/${encodeURIComponent(name)}/suites/${encodeURIComponent(suiteId)}/cases/${encodeURIComponent(caseId)}/cassette`);
  }

  /** Edit recorded calls (response, delete, turn into a case mock); `revision` refuses an edit over a newer one. */
  editAgentCassette(name: string, id: string, edits: SuiteCassetteEdit[], revision?: number): Promise<SuiteCassette> {
    return this.patch<SuiteCassette>(`/agents/${encodeURIComponent(name)}/cassettes/${encodeURIComponent(id)}`, { edits, ...(revision !== undefined ? { revision } : {}) });
  }

  deleteAgentCassette(name: string, id: string): Promise<{ deleted: string }> {
    return this.del<{ deleted: string }>(`/agents/${encodeURIComponent(name)}/cassettes/${encodeURIComponent(id)}`);
  }

  /** Record (or re-record) a case live — real model and tools: admins, `allowRealTools: true` — into its cassette. */
  recordAgentSuiteCase(name: string, suiteId: string, caseId: string, req: { target?: string; allowRealTools: boolean; wait?: boolean }): Promise<SuiteRun> {
    return this.post<SuiteRun>(`/agents/${encodeURIComponent(name)}/suites/${encodeURIComponent(suiteId)}/cases/${encodeURIComponent(caseId)}/record`, req);
  }

  /** A case and its cassette from a real chat (`sessionId`) or task run (`taskId`), added to the suite. */
  agentSuiteCaseFromRecording(name: string, suiteId: string, req: { sessionId?: string; taskId?: string; messageIndex?: number; name?: string }): Promise<{ suite: AgentSuite; case: SuiteCase; cassette: SuiteCassette }> {
    return this.post(`/agents/${encodeURIComponent(name)}/suites/${encodeURIComponent(suiteId)}/cases/from-recording`, req);
  }

  /** AI-proposed cases (validated, NOT saved): accept the ones you keep with acceptAgentSuiteCases. */
  generateAgentSuiteCases(name: string, req: CaseGenerationRequest = {}): Promise<{ proposals: GeneratedCaseProposal[]; model?: string; costUsd?: number }> {
    return this.post(`/agents/${encodeURIComponent(name)}/suites/generate-cases`, req);
  }

  /** Add cases (e.g. accepted proposals) and their datasets to a suite. */
  acceptAgentSuiteCases(name: string, suiteId: string, req: { cases: Array<Partial<SuiteCase>>; datasets?: Array<Partial<SuiteDataset>>; revision?: number }): Promise<AgentSuite> {
    return this.post<AgentSuite>(`/agents/${encodeURIComponent(name)}/suites/${encodeURIComponent(suiteId)}/cases`, req);
  }

  /** AI-proposed dataset rows for a case (not saved). */
  generateAgentSuiteDatasetRows(name: string, suiteId: string, req: { caseId: string; count?: number; brief?: string; generator?: SuiteRole }): Promise<{ datasetId?: string; columns: string[]; rows: Array<Record<string, unknown>>; model?: string; costUsd?: number }> {
    return this.post(`/agents/${encodeURIComponent(name)}/suites/${encodeURIComponent(suiteId)}/datasets/generate`, req);
  }

  // ── Suites of other targets: a hosted MCP server (its saved tests), a mission ──

  private targetBase(kind: SuiteTargetKind, id: string): string {
    return `${kind === "mcp-server" ? "/mcp-servers" : "/missions"}/${encodeURIComponent(id)}`;
  }

  /** A hosted server's suite (one: its saved tests) or a mission's suites. */
  getTargetSuites(kind: SuiteTargetKind, id: string): Promise<AgentSuite[]> {
    return this.get<AgentSuite[]>(`${this.targetBase(kind, id)}/suites`);
  }

  /** Save a target's suite (a hosted server: id "saved-tests"); without an id, create one (missions). */
  saveTargetSuite(kind: SuiteTargetKind, id: string, suite: AgentSuiteInput, revision?: number): Promise<AgentSuite> {
    const body = { ...suite, ...(revision !== undefined ? { revision } : {}) };
    const sid = suite.id ?? (kind === "mcp-server" ? "saved-tests" : undefined);
    return sid ? this.put<AgentSuite>(`${this.targetBase(kind, id)}/suites/${encodeURIComponent(sid)}`, body) : this.post<AgentSuite>(`${this.targetBase(kind, id)}/suites`, body);
  }

  deleteTargetSuite(kind: SuiteTargetKind, id: string, suiteId: string): Promise<{ deleted: string }> {
    return this.del<{ deleted: string }>(`${this.targetBase(kind, id)}/suites/${encodeURIComponent(suiteId)}`);
  }

  /** Run a target's suite (a hosted server: draft by default). */
  runTargetSuite(kind: SuiteTargetKind, id: string, suiteId: string, req: SuiteRunRequest = {}): Promise<SuiteRun> {
    return this.post<SuiteRun>(`${this.targetBase(kind, id)}/suites/${encodeURIComponent(suiteId)}/runs`, req);
  }

  getTargetSuiteRuns(kind: SuiteTargetKind, id: string, opts: { suite?: string; limit?: number } = {}): Promise<SuiteRun[]> {
    const q = new URLSearchParams();
    if (opts.suite) q.set("suite", opts.suite);
    if (opts.limit) q.set("limit", String(opts.limit));
    const s = q.toString();
    return this.get<SuiteRun[]>(`${this.targetBase(kind, id)}/suite-runs${s ? `?${s}` : ""}`);
  }

  getTargetSuiteRun(kind: SuiteTargetKind, id: string, runId: string): Promise<SuiteRun> {
    return this.get<SuiteRun>(`${this.targetBase(kind, id)}/suite-runs/${encodeURIComponent(runId)}`);
  }

  // ── Benchmarks (agent suites phase 5): suites × variants × repetitions, compared ──

  /** The saved benchmarks. */
  getBenchmarks(): Promise<BenchmarkDefinition[]> {
    return this.get<BenchmarkDefinition[]>("/benchmarks");
  }

  getBenchmark(id: string): Promise<BenchmarkDefinition> {
    return this.get<BenchmarkDefinition>(`/benchmarks/${encodeURIComponent(id)}`);
  }

  /** Create (no id) or replace a benchmark; `revision` refuses a save over someone else's change. */
  saveBenchmark(benchmark: BenchmarkInput, opts: { id?: string; revision?: number } = {}): Promise<BenchmarkDefinition> {
    const id = opts.id ?? benchmark.id;
    const body = { ...benchmark, ...(opts.revision !== undefined ? { revision: opts.revision } : {}) };
    return id ? this.put<BenchmarkDefinition>(`/benchmarks/${encodeURIComponent(id)}`, body) : this.post<BenchmarkDefinition>("/benchmarks", body);
  }

  deleteBenchmark(id: string): Promise<{ deleted: string }> {
    return this.del<{ deleted: string }>(`/benchmarks/${encodeURIComponent(id)}`);
  }

  /** What a benchmark would cost (a saved one, or inline), and whether it is offline (free). */
  estimateBenchmark(ref: { benchmarkId?: string; benchmark?: BenchmarkInput }): Promise<BenchmarkEstimate> {
    return this.post<BenchmarkEstimate>("/benchmarks/estimate", ref);
  }

  /**
   * Start a benchmark. One that calls a real model needs `confirm: true` (else PolpoApiError code
   * CONFIRM_COST, the estimate in `details`); one whose estimate is above the budget cap is refused
   * (OVER_BUDGET); real tools need `allowRealTools` (admins).
   */
  runBenchmark(ref: { benchmarkId?: string; benchmark?: BenchmarkInput }, opts: { confirm?: boolean; allowRealTools?: boolean; budgetUsd?: number; wait?: boolean; source?: string } = {}): Promise<BenchmarkRun> {
    return this.post<BenchmarkRun>("/benchmarks/runs", { ...ref, ...opts });
  }

  getBenchmarkRuns(opts: { benchmark?: string; limit?: number } = {}): Promise<BenchmarkRun[]> {
    const q = new URLSearchParams();
    if (opts.benchmark) q.set("benchmark", opts.benchmark);
    if (opts.limit) q.set("limit", String(opts.limit));
    const s = q.toString();
    return this.get<BenchmarkRun[]>(`/benchmark-runs${s ? `?${s}` : ""}`);
  }

  /** A benchmark run's comparison: the run, per-variant stats, the leaderboard (with these weights), the matrix. */
  getBenchmarkRun(runId: string, weights?: Partial<BenchmarkWeights>): Promise<BenchmarkReport> {
    const q = new URLSearchParams();
    for (const k of ["quality", "cost", "latency"] as const) if (weights?.[k] !== undefined) q.set(k, String(weights[k]));
    const s = q.toString();
    return this.get<BenchmarkReport>(`/benchmark-runs/${encodeURIComponent(runId)}${s ? `?${s}` : ""}`);
  }

  getBenchmarkLeaderboard(runId: string, weights?: Partial<BenchmarkWeights>): Promise<BenchmarkLeaderboard & { stats: BenchmarkVariantStats[] }> {
    const q = new URLSearchParams();
    for (const k of ["quality", "cost", "latency"] as const) if (weights?.[k] !== undefined) q.set(k, String(weights[k]));
    const s = q.toString();
    return this.get<BenchmarkLeaderboard & { stats: BenchmarkVariantStats[] }>(`/benchmark-runs/${encodeURIComponent(runId)}/leaderboard${s ? `?${s}` : ""}`);
  }

  getBenchmarkMatrix(runId: string): Promise<BenchmarkMatrix> {
    return this.get<BenchmarkMatrix>(`/benchmark-runs/${encodeURIComponent(runId)}/matrix`);
  }

  /** One case side by side for 2–4 variants: traces, tool calls and answers diffed against the first. */
  compareBenchmarkCase(runId: string, caseKey: string, opts: { variants?: string[]; repetition?: number } = {}): Promise<BenchmarkCaseComparison> {
    const q = new URLSearchParams({ case: caseKey });
    if (opts.variants?.length) q.set("variants", opts.variants.join(","));
    if (opts.repetition) q.set("repetition", String(opts.repetition));
    return this.get<BenchmarkCaseComparison>(`/benchmark-runs/${encodeURIComponent(runId)}/compare?${q.toString()}`);
  }

  cancelBenchmarkRun(runId: string): Promise<BenchmarkRun> {
    return this.post<BenchmarkRun>(`/benchmark-runs/${encodeURIComponent(runId)}/cancel`);
  }

  // ── Playground: chat panes side by side, each bound to a variant ──

  getPlaygroundSessions(): Promise<PlaygroundSession[]> {
    return this.get<PlaygroundSession[]>("/playground/sessions");
  }

  createPlaygroundSession(panes: PlaygroundPaneInput[]): Promise<PlaygroundSession> {
    return this.post<PlaygroundSession>("/playground/sessions", { panes });
  }

  getPlaygroundSession(id: string): Promise<PlaygroundSession> {
    return this.get<PlaygroundSession>(`/playground/sessions/${encodeURIComponent(id)}`);
  }

  /** Replace the panes (a pane whose variant and toggles are unchanged keeps its conversation). */
  updatePlaygroundSession(id: string, panes: PlaygroundPaneInput[]): Promise<PlaygroundSession> {
    return this.put<PlaygroundSession>(`/playground/sessions/${encodeURIComponent(id)}`, { panes });
  }

  deletePlaygroundSession(id: string): Promise<{ deleted: string }> {
    return this.del<{ deleted: string }>(`/playground/sessions/${encodeURIComponent(id)}`);
  }

  resetPlaygroundSession(id: string, paneId?: string): Promise<PlaygroundSession> {
    return this.post<PlaygroundSession>(`/playground/sessions/${encodeURIComponent(id)}/reset`, paneId ? { paneId } : {});
  }

  /**
   * Send a message to the panes (or `paneIds`). With `onEvent` the answers stream (start, text,
   * turn, tool, done per pane) and the result arrives at the end.
   */
  async sendPlayground(id: string, req: { message: string; paneIds?: string[]; allowRealTools?: boolean }, opts: { onEvent?: (e: PlaygroundStreamEvent) => void; signal?: AbortSignal } = {}): Promise<{ session: PlaygroundSession; exchanges: Record<string, PlaygroundExchange> }> {
    const path = `/playground/sessions/${encodeURIComponent(id)}/send`;
    if (!opts.onEvent) return this.post(path, req);
    const res = await this.fetchFn(this.apiUrl(path), {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ ...req, stream: true }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const json = (await res.json()) as ApiResult<{ session: PlaygroundSession; exchanges: Record<string, PlaygroundExchange> }>;
      if (!json.ok) throw new PolpoApiError(json.error, json.code, res.status, json.details);
      return json.data;
    }
    const reader = res.body?.getReader();
    if (!reader) throw new PolpoApiError("No response body", "INTERNAL_ERROR", 500);
    const decoder = new TextDecoder();
    let buffer = "";
    let event = "message";
    let result: { session: PlaygroundSession; exchanges: Record<string, PlaygroundExchange> } | undefined;
    let failure: { error: string; code?: string } | undefined;
    const handle = (line: string) => {
      if (line.startsWith("event:")) { event = line.slice(6).trim(); return; }
      if (!line.startsWith("data:")) return;
      let data: unknown;
      try { data = JSON.parse(line.slice(5).trim()); } catch { return; }
      if (event === "end") result = data as typeof result;
      else if (event === "error") failure = data as typeof failure;
      else opts.onEvent!(data as PlaygroundStreamEvent);
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handle(line.trim());
    }
    if (buffer.trim()) handle(buffer.trim());
    if (failure) throw new PolpoApiError(failure.error, (failure.code ?? "INTERNAL_ERROR") as never, 400);
    if (!result) throw new PolpoApiError("The answer was cut short", "INTERNAL_ERROR", 502);
    return result;
  }

  /** One message to 1–4 panes without keeping a session (headless comparison). */
  playgroundCompare(panes: PlaygroundPaneInput[], message: string, opts: { allowRealTools?: boolean } = {}): Promise<{ panes: PlaygroundPane[]; exchanges: Record<string, PlaygroundExchange> }> {
    return this.post("/playground/send", { panes, message, ...opts });
  }

  /** "Save as test case": a pane's exchange as a case (returned for review, or saved with `save`). */
  playgroundCaseFromExchange(id: string, req: { paneId: string; exchange?: number; name?: string; mockModel?: boolean; save?: { agent: string; suite: string } }): Promise<{ case: SuiteCase; suite?: AgentSuite }> {
    return this.post(`/playground/sessions/${encodeURIComponent(id)}/case`, req);
  }

  /** "Promote variant": its overrides into the agent's draft (never deployed). Admins. */
  promotePlaygroundVariant(req: { agent: string; version?: string; overrides: SuiteVariantOverrides; note?: string }): Promise<{ agent: string; fields: Record<string, unknown>; draftChanged: boolean }> {
    return this.post("/playground/promote", req);
  }

  // ── Hosted MCP servers ──

  /** Custom MCP servers Polpo hosts (each becomes a connector on first publish). */
  getMcpServers(): Promise<McpServerSummary[]> {
    return this.get<{ servers: McpServerSummary[] }>("/mcp-servers").then((d) => d.servers);
  }

  getMcpServerTemplates(): Promise<McpServerTemplateInfo[]> {
    return this.get<{ templates: McpServerTemplateInfo[] }>("/mcp-servers/templates").then((d) => d.templates);
  }

  /** One ready-made connector with its install status. */
  getMcpServerTemplate(template: string): Promise<McpServerTemplateInfo> {
    return this.get<McpServerTemplateInfo>(`/mcp-servers/templates/${encodeURIComponent(template)}`);
  }

  /**
   * Install a ready-made connector: settings → secrets (saved to the vault, never returned) → agents →
   * read-only tests → publish + deploy. An older installed revision becomes a draft with the diff.
   */
  installMcpServerTemplate(template: string, req: McpServerInstallRequest = {}): Promise<McpServerInstallResult> {
    return this.post<McpServerInstallResult>(`/mcp-servers/templates/${encodeURIComponent(template)}/install`, req);
  }

  /** Save a hosted server's secret to the vault entry it names (write-only). */
  saveMcpServerSecret(id: string, name: string, value: string): Promise<{ name: string; set: true; vault: McpSecretRef }> {
    return this.put<{ name: string; set: true; vault: McpSecretRef }>(`/mcp-servers/${encodeURIComponent(id)}/secrets/${encodeURIComponent(name)}`, { value });
  }

  getMcpServer(id: string): Promise<McpHostedServer> {
    return this.get<McpHostedServer>(`/mcp-servers/${encodeURIComponent(id)}`);
  }

  /** Create a draft from a spec or a template ({ template: "printful" }). */
  createMcpServer(req: { id?: string; spec?: McpServerSpec; template?: string; visibility?: "private" | "public" }): Promise<{ id: string; problems: string[]; setup?: string }> {
    return this.post<{ id: string; problems: string[]; setup?: string }>("/mcp-servers", req);
  }

  /** Draft a spec with the orchestrator model, from an API or a description (create: true saves it). */
  generateMcpServer(req: McpServerGenerateRequest): Promise<McpServerGenerateResult> {
    return this.post<McpServerGenerateResult>("/mcp-servers/generate", req);
  }

  updateMcpServerSettings(id: string, req: { visibility?: "private" | "public"; disabled?: boolean; onTestFailure?: "warn" | "block"; rateLimits?: { perIpPerMinute: number; globalPerMinute: number }; settings?: Record<string, string | number | boolean | null> }): Promise<McpServerSummary> {
    return this.patch<McpServerSummary>(`/mcp-servers/${encodeURIComponent(id)}`, req);
  }

  saveMcpServerDraft(id: string, spec: McpServerSpec): Promise<{ problems: string[] }> {
    return this.put<{ problems: string[] }>(`/mcp-servers/${encodeURIComponent(id)}/draft`, { spec });
  }

  discardMcpServerDraft(id: string): Promise<{ discarded: boolean }> {
    return this.del<{ discarded: boolean }>(`/mcp-servers/${encodeURIComponent(id)}/draft`);
  }

  deleteMcpServer(id: string): Promise<{ removed: boolean }> {
    return this.del<{ removed: boolean }>(`/mcp-servers/${encodeURIComponent(id)}`);
  }

  saveMcpServerTests(id: string, tests: Array<Omit<McpServerTestCase, "id"> & { id?: string }>): Promise<{ tests: McpServerTestCase[] }> {
    return this.put<{ tests: McpServerTestCase[] }>(`/mcp-servers/${encodeURIComponent(id)}/tests`, { tests });
  }

  /** Run one tool (destructive / approval tools: a dry run unless confirm). */
  testMcpServerTool(id: string, req: { tool: string; input?: Record<string, unknown>; ref?: string; confirm?: boolean; dryRun?: boolean }): Promise<McpToolTestResult> {
    return this.post<McpToolTestResult>(`/mcp-servers/${encodeURIComponent(id)}/test`, req);
  }

  runMcpServerTests(id: string, ref?: string): Promise<{ results: McpToolTestResult[]; passed: number; failed: number; skipped: number }> {
    return this.post<{ results: McpToolTestResult[]; passed: number; failed: number; skipped: number }>(`/mcp-servers/${encodeURIComponent(id)}/tests/run`, ref ? { ref } : {});
  }

  /**
   * Publish the draft. With `deploy` and a required suite (the saved tests' gate) the deploy runs it
   * first: when it fails the version stays published and `deployBlocked` says why; `override` (admins)
   * deploys anyway with a reason.
   */
  publishMcpServer(id: string, req: { bump?: "major" | "minor" | "patch"; version?: string; note?: string; deploy?: boolean; force?: boolean; override?: { reason: string } } = {}): Promise<{ version: string; changes: McpServerVersionInfo["changes"]; deployed?: McpServerDeploy; deployBlocked?: McpServerDeployBlocked; tests?: { passed: number; failed: number; skipped: number; runId?: string } }> {
    return this.post(`/mcp-servers/${encodeURIComponent(id)}/publish`, req);
  }

  /**
   * Deploy a version. A required suite that fails blocks it (`PolpoApiError` code `GATE_BLOCKED`,
   * details `{ runId, failures }`); `opts.override` (admins) deploys anyway, recorded on the deploy.
   */
  deployMcpServer(id: string, version: string, note?: string, opts: { override?: { reason: string } } = {}): Promise<McpServerDeploy> {
    return this.post<McpServerDeploy>(`/mcp-servers/${encodeURIComponent(id)}/deploy`, { version, ...(note ? { note } : {}), ...(opts.override ? { override: opts.override } : {}) });
  }

  rollbackMcpServer(id: string, opts: { to?: string; note?: string } = {}): Promise<McpServerDeploy> {
    return this.post<McpServerDeploy>(`/mcp-servers/${encodeURIComponent(id)}/rollback`, opts);
  }

  getMcpServerVersions(id: string): Promise<McpServerVersionInfo[]> {
    return this.get<{ versions: McpServerVersionInfo[] }>(`/mcp-servers/${encodeURIComponent(id)}/versions`).then((d) => d.versions);
  }

  getMcpServerVersion(id: string, version: string): Promise<McpServerVersionInfo & { spec: McpServerSpec }> {
    return this.get<McpServerVersionInfo & { spec: McpServerSpec }>(`/mcp-servers/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`);
  }

  getMcpServerDeploys(id: string): Promise<McpServerDeploy[]> {
    return this.get<{ deploys: McpServerDeploy[] }>(`/mcp-servers/${encodeURIComponent(id)}/deploys`).then((d) => d.deploys);
  }

  diffMcpServer(id: string, opts: { from?: string; to?: string } = {}): Promise<McpServerDiff> {
    const q = new URLSearchParams();
    if (opts.from) q.set("from", opts.from);
    if (opts.to) q.set("to", opts.to);
    const qs = q.toString();
    return this.get<McpServerDiff>(`/mcp-servers/${encodeURIComponent(id)}/diff${qs ? `?${qs}` : ""}`);
  }

  getMcpServerLogs(id: string, limit?: number): Promise<McpServerCallLog[]> {
    return this.get<{ logs: McpServerCallLog[] }>(`/mcp-servers/${encodeURIComponent(id)}/logs${limit ? `?limit=${limit}` : ""}`).then((d) => d.logs);
  }

  getMcpServerPending(id: string): Promise<McpPendingCall[]> {
    return this.get<{ calls: McpPendingCall[] }>(`/mcp-servers/${encodeURIComponent(id)}/pending`).then((d) => d.calls);
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

  testChannel(name: string): Promise<{ success: boolean; error?: string }> {
    return this.post<{ success: boolean; error?: string }>(`/config/channels/${encodeURIComponent(name)}/test`);
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

  // ── Skill bundles and files ──

  private skillBase(pool?: SkillPool): string {
    return pool === "orchestrator" ? "/skills/orchestrator" : "/skills";
  }

  /** The files of an installed skill (SKILL.md, scripts/, references/, assets/…) with sizes. */
  getSkillFiles(name: string, pool?: SkillPool): Promise<SkillFileList> {
    return this.get<SkillFileList>(`${this.skillBase(pool)}/${encodeURIComponent(name)}/files`);
  }

  /** The URL of one file of a skill (raw, with its content type): for <img>, <iframe> or a download link. */
  skillFileUrl(name: string, path: string, opts: { pool?: SkillPool; download?: boolean } = {}): string {
    const rel = path.split("/").map(encodeURIComponent).join("/");
    return this.apiUrl(`${this.skillBase(opts.pool)}/${encodeURIComponent(name)}/files/${rel}${opts.download ? "?download=1" : ""}`);
  }

  /** The URL of the whole skill as an archive (.skill by default, or .zip). */
  skillDownloadUrl(name: string, opts: { pool?: SkillPool; format?: "skill" | "zip" } = {}): string {
    return this.apiUrl(`${this.skillBase(opts.pool)}/${encodeURIComponent(name)}/download${opts.format === "zip" ? "?format=zip" : ""}`);
  }

  /** Read one file of a skill: its bytes and content type (text: decode with TextDecoder or use getSkillFileText). */
  async getSkillFile(name: string, path: string, pool?: SkillPool): Promise<{ contentType: string; bytes: ArrayBuffer }> {
    const res = await this.fetchFn(this.skillFileUrl(name, path, { pool }), { headers: { ...this.headers }, credentials: "include" });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string; code?: string } | null;
      throw new PolpoApiError(body?.error ?? `Could not read ${path}`, (body?.code ?? "NOT_FOUND") as never, res.status);
    }
    return { contentType: res.headers.get("content-type") ?? "application/octet-stream", bytes: await res.arrayBuffer() };
  }

  /** Read one text file of a skill. */
  async getSkillFileText(name: string, path: string, pool?: SkillPool): Promise<string> {
    const { bytes } = await this.getSkillFile(name, path, pool);
    return new TextDecoder().decode(bytes);
  }

  // ── Skill versions ──

  /** A skill's history, newest first: every change recorded as a copy of the folder (also for a deleted skill, while kept). */
  getSkillVersions(name: string, pool?: SkillPool): Promise<SkillVersionList> {
    return this.get<SkillVersionList>(`${this.skillBase(pool)}/${encodeURIComponent(name)}/versions`);
  }

  /** The files of one version of a skill. */
  getSkillVersionFiles(name: string, version: number, pool?: SkillPool): Promise<SkillVersionFiles> {
    return this.get<SkillVersionFiles>(`${this.skillBase(pool)}/${encodeURIComponent(name)}/versions/${version}/files`);
  }

  /** The URL of one file of a version (raw, with its content type). */
  skillVersionFileUrl(name: string, version: number, path: string, opts: { pool?: SkillPool; download?: boolean } = {}): string {
    const rel = path.split("/").map(encodeURIComponent).join("/");
    return this.apiUrl(`${this.skillBase(opts.pool)}/${encodeURIComponent(name)}/versions/${version}/files/${rel}${opts.download ? "?download=1" : ""}`);
  }

  /** Read one text file of a version. */
  async getSkillVersionFileText(name: string, version: number, path: string, pool?: SkillPool): Promise<string> {
    const res = await this.fetchFn(this.skillVersionFileUrl(name, version, path, { pool }), { headers: { ...this.headers }, credentials: "include" });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string; code?: string } | null;
      throw new PolpoApiError(body?.error ?? `Could not read ${path}`, (body?.code ?? "NOT_FOUND") as never, res.status);
    }
    return new TextDecoder().decode(await res.arrayBuffer());
  }

  /** What changed from version a to version b: files added, removed, changed, with unified diffs of text files. */
  diffSkillVersions(name: string, a: number, b: number, pool?: SkillPool): Promise<SkillVersionDiff> {
    return this.get<SkillVersionDiff>(`${this.skillBase(pool)}/${encodeURIComponent(name)}/versions/${a}/diff/${b}`);
  }

  /** Put a version back (or bring back a deleted skill); the current state is recorded first, the restore is a new version. */
  restoreSkillVersion(name: string, version: number, pool?: SkillPool): Promise<SkillRestoreResult> {
    return this.post<SkillRestoreResult>(`${this.skillBase(pool)}/${encodeURIComponent(name)}/versions/${version}/restore`);
  }

  /** The URL of a version as an archive (.skill by default, or .zip). */
  skillVersionDownloadUrl(name: string, version: number, opts: { pool?: SkillPool; format?: "skill" | "zip" } = {}): string {
    return this.apiUrl(`${this.skillBase(opts.pool)}/${encodeURIComponent(name)}/versions/${version}/download${opts.format === "zip" ? "?format=zip" : ""}`);
  }

  // ── Artifacts ────────────────────────────────────────────

  private artifactPath(id: string): string {
    return `/artifacts/${encodeURIComponent(id)}`;
  }

  /** A request with a raw body (a file), answered with { ok, data }. */
  private async requestBody<T>(method: string, path: string, body: Blob | ArrayBuffer | Uint8Array, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.fetchFn(this.apiUrl(path), {
      method, headers: { ...this.headers, "Content-Type": "application/octet-stream", ...headers }, body: body as BodyInit, credentials: "include",
    });
    const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` })) as ApiResult<T>;
    if (!json.ok) throw new PolpoApiError(json.error, json.code, res.status, json.details);
    return json.data;
  }

  /** Artifacts, newest first (no contents). */
  listArtifacts(filter: { type?: ArtifactType; kind?: string; q?: string; sessionId?: string; createdBy?: string; mine?: boolean } = {}): Promise<ArtifactSummary[]> {
    const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => v !== undefined && v !== false && v !== "").map(([k, v]) => [k, String(v)]));
    return this.get<ArtifactSummary[]>(`/artifacts${q.size ? `?${q}` : ""}`);
  }

  /** One artifact with its versions; the content comes whole up to the viewer limit (content: false leaves it out). */
  getArtifact(id: string, opts: { content?: boolean } = {}): Promise<Artifact> {
    return this.get<Artifact>(`${this.artifactPath(id)}${opts.content === false ? "?content=none" : ""}`);
  }

  /** One version with its content (left out over the viewer limit: contentOmitted). */
  getArtifactVersion(id: string, version: number): Promise<ArtifactVersionInfo & { contentOmitted?: boolean }> {
    return this.get(`${this.artifactPath(id)}/versions/${version}`);
  }

  /** Read part of an artifact: a byte range, the outline, or a tab, slide(s), sheet range, board, page or scene. */
  readArtifact(id: string, opts: ArtifactReadOptions = {}): Promise<ArtifactRead> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v !== undefined && v !== false) q.set(k, v === true ? "1" : String(v));
    return this.get<ArtifactRead>(`${this.artifactPath(id)}/read${q.size ? `?${q}` : ""}`);
  }

  /** The URL of the content as a file (Range supported), of a version, or as a download. */
  artifactContentUrl(id: string, opts: { version?: number; download?: boolean } = {}): string {
    const q = new URLSearchParams();
    if (opts.version) q.set("version", String(opts.version));
    if (opts.download) q.set("download", "1");
    return this.apiUrl(`${this.artifactPath(id)}/content${q.size ? `?${q}` : ""}`);
  }

  createArtifact(input: ArtifactCreateInput): Promise<Artifact> {
    return this.post<Artifact>("/artifacts", input);
  }

  /**
   * Change an artifact: { command: "update", old_str, new_str } (or updates[]) for a targeted change,
   * { command: "rewrite", content } for a whole new content, append / prepend, patch (JSON Patch) or ops.
   * With expectedVersion, refused (409) if it changed since.
   */
  updateArtifact(id: string, input: ArtifactUpdateInput): Promise<Artifact> {
    return this.patch<Artifact>(this.artifactPath(id), input);
  }

  deleteArtifact(id: string): Promise<{ deleted: boolean }> {
    return this.del(this.artifactPath(id));
  }

  restoreArtifact(id: string, version: number): Promise<Artifact> {
    return this.post<Artifact>(`${this.artifactPath(id)}/restore/${version}`);
  }

  duplicateArtifact(id: string, version?: number): Promise<Artifact> {
    return this.post<Artifact>(`${this.artifactPath(id)}/duplicate`, version ? { version } : {});
  }

  /** Storage used by every artifact of the instance, with the limits in force. */
  getArtifactUsage(): Promise<ArtifactStorageUsage> {
    return this.get<ArtifactStorageUsage>("/artifacts/usage");
  }

  /** Create an artifact from a file (streamed; the type is detected from the name and content unless given). */
  uploadArtifact(file: Blob, opts: ArtifactUploadOptions = {}): Promise<Artifact> {
    const q = new URLSearchParams();
    const filename = opts.filename ?? (file as File).name;
    for (const [k, v] of Object.entries({ ...opts, filename })) if (v) q.set(k, String(v));
    return this.requestBody<Artifact>("POST", `/artifacts/upload${q.size ? `?${q}` : ""}`, file);
  }

  /** Replace an artifact's content with a file (the previous one becomes a version). */
  replaceArtifactContent(id: string, file: Blob, opts: { expectedVersion?: number; filename?: string; note?: string } = {}): Promise<Artifact> {
    const q = new URLSearchParams();
    if (opts.expectedVersion) q.set("expectedVersion", String(opts.expectedVersion));
    const filename = opts.filename ?? (file as File).name;
    if (filename) q.set("filename", filename);
    if (opts.note) q.set("note", opts.note);
    return this.requestBody<Artifact>("PUT", `${this.artifactPath(id)}/content${q.size ? `?${q}` : ""}`, file);
  }

  /** Send one part of an upload (the first without appendTo; more: true until the last). */
  uploadArtifactPart(part: Blob, opts: { appendTo?: string; more?: boolean; filename?: string } = {}): Promise<ArtifactUploadPart> {
    const q = new URLSearchParams();
    if (opts.appendTo) q.set("append_to", opts.appendTo);
    if (opts.more) q.set("more", "true");
    if (opts.filename) q.set("filename", opts.filename);
    return this.requestBody<ArtifactUploadPart>("POST", `/artifacts/uploads${q.size ? `?${q}` : ""}`, part);
  }

  /** Create an artifact from a complete upload, or replace one's content (id). */
  finalizeArtifactUpload(uploadId: string, opts: ArtifactUploadOptions & { id?: string; expectedVersion?: number } = {}): Promise<Artifact> {
    return this.post<Artifact>(`/artifacts/uploads/${encodeURIComponent(uploadId)}/finalize`, opts);
  }

  private async requestForm<T>(path: string, form: FormData): Promise<T> {
    const res = await this.fetchFn(this.apiUrl(path), { method: "POST", headers: { ...this.headers }, body: form, credentials: "include" });
    const json = await res.json() as ApiResult<T> & { details?: unknown };
    if (!json.ok) throw new PolpoApiError(json.error, json.code, res.status, json.details);
    return json.data;
  }

  /**
   * Upload a .skill / .zip archive and preview it without installing (each skill's name, description,
   * files, errors, warnings, and whether its name is taken). Install it with installSkillBundle(uploadId).
   */
  previewSkillBundle(file: Blob, filename = "bundle.skill"): Promise<SkillBundlePreview> {
    const form = new FormData();
    form.append("file", file, filename);
    return this.requestForm<SkillBundlePreview>("/skills/upload?dryRun=1", form);
  }

  /** Install an archive previewed with previewSkillBundle (kept 30 minutes on the server). */
  installSkillBundle(uploadId: string, opts: SkillBundleInstallOptions = {}): Promise<SkillBundleInstallResult> {
    return this.post<SkillBundleInstallResult>(`/skills/upload/${encodeURIComponent(uploadId)}/install`, opts);
  }

  /** Upload and install a .skill / .zip archive in one call. */
  uploadSkillBundle(file: Blob, filename: string, opts: SkillBundleInstallOptions = {}): Promise<SkillBundleInstallResult> {
    const form = new FormData();
    form.append("file", file, filename);
    if (opts.renames) form.append("renames", JSON.stringify(opts.renames));
    const q = new URLSearchParams();
    if (opts.pool) q.set("pool", opts.pool);
    if (opts.global) q.set("global", "1");
    if (opts.onConflict) q.set("onConflict", opts.onConflict);
    if (opts.skills?.length) q.set("skills", opts.skills.join(","));
    if (opts.assignTo?.length) q.set("assignTo", opts.assignTo.join(","));
    const qs = q.toString();
    return this.requestForm<SkillBundleInstallResult>(`/skills/upload${qs ? `?${qs}` : ""}`, form);
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
    const url = `${this.baseUrl}/v1/chat/completions`;
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
      credentials: "include",
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
    const url = `${this.baseUrl}/v1/chat/completions`;
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

  /** Star or unstar a session. Mirrors PATCH /chat/sessions/:id with { starred } payload. */
  setSessionStarred(sessionId: string, starred: boolean): Promise<{ starred: boolean }> {
    return this.patch<{ starred: boolean }>(`/chat/sessions/${sessionId}`, { starred });
  }

  deleteSession(sessionId: string): Promise<{ deleted: boolean }> {
    return this.del<{ deleted: boolean }>(`/chat/sessions/${sessionId}`);
  }

  // ── Branches ────────────────────────────────────────────

  /** Branch the conversation at a message: from a user message the assistant answers it again in the branch, from a reply the branch waits for the next message. */
  forkSession(sessionId: string, messageId: string): Promise<ForkSessionResult> {
    return this.post<ForkSessionResult>(`/chat/sessions/${sessionId}/fork`, { messageId });
  }

  /**
   * Undo a branch: delete it and get back the parent and fork point. Fails with code
   * FORK_HAS_MESSAGES when the user already wrote in the branch, unless `force`.
   */
  undoFork(sessionId: string, opts?: { force?: boolean }): Promise<{ deleted: boolean; parentSessionId: string; forkMessageId: string | null }> {
    return this.del(`/chat/sessions/${sessionId}/fork${opts?.force ? "?force=1" : ""}`);
  }

  // ── Prompt queue ────────────────────────────────────────

  getChatQueue(sessionId: string): Promise<ChatQueueState> {
    return this.request<ChatQueueState>("GET", this.apiUrl(`/chat/sessions/${sessionId}/queue`));
  }

  /** Queue a prompt; `next` sends it right after the running turn, whatever auto-send says. */
  addToChatQueue(sessionId: string, content: string, opts?: { front?: boolean; next?: boolean }): Promise<ChatQueueItem> {
    return this.post<ChatQueueItem>(`/chat/sessions/${sessionId}/queue`, {
      content, ...(opts?.front ? { front: true } : {}), ...(opts?.next ? { next: true } : {}),
    });
  }

  updateChatQueueItem(sessionId: string, itemId: string, content: string): Promise<ChatQueueItem> {
    return this.patch<ChatQueueItem>(`/chat/sessions/${sessionId}/queue/${itemId}`, { content });
  }

  removeChatQueueItem(sessionId: string, itemId: string): Promise<{ removed: boolean }> {
    return this.del<{ removed: boolean }>(`/chat/sessions/${sessionId}/queue/${itemId}`);
  }

  reorderChatQueue(sessionId: string, ids: string[]): Promise<{ items: ChatQueueItem[] }> {
    return this.put<{ items: ChatQueueItem[] }>(`/chat/sessions/${sessionId}/queue/order`, { ids });
  }

  clearChatQueue(sessionId: string): Promise<{ cleared: number }> {
    return this.del<{ cleared: number }>(`/chat/sessions/${sessionId}/queue`);
  }

  setChatQueueAutoSend(sessionId: string, autoSend: boolean): Promise<ChatQueueState> {
    return this.patch<ChatQueueState>(`/chat/sessions/${sessionId}/queue`, { autoSend });
  }

  /** Send a queued prompt now: it steers the running turn, or starts one when the session is idle. */
  sendChatQueueItem(sessionId: string, itemId: string): Promise<ChatQueueSendResult> {
    return this.post<ChatQueueSendResult>(`/chat/sessions/${sessionId}/queue/${itemId}/send`);
  }

  // ── Steering ────────────────────────────────────────────

  /** Add a message to a running turn (joins at its next safe point). */
  steerTurn(turnId: string, steer: { id?: string; content: string }): Promise<SteerResult> {
    return this.request<SteerResult>("POST", `${this.baseUrl}/v1/chat/completions/steer/${encodeURIComponent(turnId)}`, steer);
  }

  /** Withdraw a steer that was not delivered yet (fails with code already_delivered otherwise). */
  cancelSteer(turnId: string, steerId: string): Promise<{ cancelled: boolean }> {
    return this.request<{ cancelled: boolean }>("DELETE", `${this.baseUrl}/v1/chat/completions/steer/${encodeURIComponent(turnId)}/${encodeURIComponent(steerId)}`);
  }

  /** Stop a running turn. Steers it had not delivered come back, never sent. */
  async abortTurn(turnId: string): Promise<{ ok: boolean; returnedSteers: Array<{ id: string; content: string }> }> {
    const res = await this.fetchFn(`${this.baseUrl}/v1/chat/completions/abort/${encodeURIComponent(turnId)}`, {
      method: "POST",
      headers: { ...this.headers },
      credentials: "include",
    });
    const json = await res.json().catch(() => ({})) as { ok?: boolean; returnedSteers?: Array<{ id: string; content: string }> };
    return { ok: !!json.ok, returnedSteers: json.returnedSteers ?? [] };
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
    const res = await this.fetchFn(`${this.baseUrl}${this.apiPrefix}/health`);
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
