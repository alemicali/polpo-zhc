import { basename } from "node:path";
import {
  CombinedAutocompleteProvider,
  Container,
  Loader,
  ProcessTerminal,
  Text,
  TUI,
} from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";
import type { Team } from "../core/types.js";
import { Orchestrator } from "../core/orchestrator.js";
import type { InputMode, ApprovalMode, PendingApproval, Seg, TUIContext } from "./types.js";
import { theme, editorTheme } from "./theme.js";
import { formatTokenCount, kickRun } from "./format.js";
import { ChatLog } from "./components/chat-log.js";
import { CustomEditor } from "./components/custom-editor.js";
import { TaskPanel, TASK_PANEL_WIDTH } from "./components/task-panel.js";
import { RootLayout } from "./components/root-layout.js";
import { bridgeEvents } from "./bridge.js";
import { ApprovalOverlay } from "./overlays/approval.js";
import { dispatch, COMMANDS } from "./commands/router.js";
import { parseMentions } from "./mentions.js";
import { startChat } from "./actions/chat.js";
import { createTask } from "./actions/create-task.js";
import { createMission } from "./actions/create-mission.js";
import { startRecording, stopAndTranscribe } from "./voice.js";
import type { RecordingHandle } from "./voice.js";

/**
 * Launch the pi-tui based TUI.
 * This is the main entry point called from the CLI.
 */
export async function startPiTUI(workDir: string): Promise<void> {
  // === State ===
  let inputMode: InputMode = "chat";
  let approvalMode: ApprovalMode = "approval";
  let pendingApproval: PendingApproval | null = null;
  let taskPanelVisible = true;
  let processing = false;
  let processingLabel = "";
  let streaming = false;
  let streamingTokens = 0;
  let activeSessionId: string | null = null;
  let defaultAgent: string | null = null;
  let lastCtrlCAt = 0;
  let recordingHandle: RecordingHandle | null = null;
  let syncTimer: ReturnType<typeof setInterval> | null = null;

  // === Initialize Orchestrator ===
  const polpo = new Orchestrator(workDir);
  const projectName = basename(workDir);
  const defaultTeam: Team = {
    name: "default",
    agents: [{ name: "dev-1", role: "developer" }],
  };
  await polpo.initInteractive(projectName, defaultTeam);

  // Set default agent from config
  const agents = polpo.getAgents();
  if (agents.length > 0) {
    defaultAgent = agents[0]!.name;
  }

  // === Create pi-tui components ===
  const tui = new TUI(new ProcessTerminal());
  const header = new Text("", 1, 0);
  const chatLog = new ChatLog();
  const statusContainer = new Container();
  const footer = new Text("", 1, 0);
  const editor = new CustomEditor(tui, editorTheme);
  const taskPanel = new TaskPanel(() => tui.requestRender());

  // === Layout ===
  // RootLayout is a single monolithic component that renders the entire TUI.
  // It composites left (header, chat, status, footer, editor) and right (panel)
  // side-by-side in a single render() call, always producing exactly termHeight
  // lines. This ensures zero terminal scrollback and a sticky panel.
  const rootLayout = new RootLayout(tui);
  rootLayout.header = header;
  rootLayout.chatLog = chatLog;
  rootLayout.status = statusContainer;
  rootLayout.footer = footer;
  rootLayout.editor = editor;
  rootLayout.panel = taskPanel;
  rootLayout.setPanelWidth(TASK_PANEL_WIDTH);

  tui.addChild(rootLayout);
  tui.setFocus(editor);

  // === TUI Context (implements TUIContext interface) ===
  const ctx: TUIContext = {
    polpo,
    get inputMode() { return inputMode; },
    get approvalMode() { return approvalMode; },
    get pendingApproval() { return pendingApproval; },
    get taskPanelVisible() { return taskPanelVisible; },
    get processing() { return processing; },
    get processingLabel() { return processingLabel; },
    get streaming() { return streaming; },
    get streamingTokens() { return streamingTokens; },
    get activeSessionId() { return activeSessionId; },
    set activeSessionId(v) { activeSessionId = v; },
    get defaultAgent() { return defaultAgent; },
    get tuiInstance() { return tui; },

    setInputMode(mode: InputMode) {
      inputMode = mode;
      updateFooter();
    },
    setProcessing(active: boolean, label?: string) {
      processing = active;
      processingLabel = label ?? "";
      updateStatus();
    },
    setStreaming(active: boolean) {
      streaming = active;
      if (!active) streamingTokens = 0;
      updateStatus();
    },
    updateStreamingTokens(tokens: number) {
      streamingTokens = tokens;
      updateFooter();
    },
    setPendingApproval(approval: PendingApproval | null) {
      pendingApproval = approval;
      tui.requestRender();
    },
    setApprovalMode(mode: ApprovalMode) {
      approvalMode = mode;
      updateFooter();
    },
    toggleTaskPanel() {
      taskPanelVisible = !taskPanelVisible;
      taskPanel.setVisible(taskPanelVisible);
      rootLayout.setPanelVisible(taskPanelVisible);
      tui.requestRender();
    },
    log(text: string) {
      chatLog.addEvent(text);
      rootLayout.scrollToBottom();
    },
    logUser(text: string) {
      chatLog.addUser(text);
      rootLayout.scrollToBottom();
    },
    logResponse(segs: Seg[]) {
      const text = segs.map(s => s.text).join("");
      chatLog.updateAssistant(text);
      rootLayout.scrollToBottom();
    },
    logSystem(text: string) {
      chatLog.addSystem(text);
      rootLayout.scrollToBottom();
    },
    clearLog() {
      chatLog.clearAll();
      rootLayout.scrollToBottom();
    },
    finalizeAssistant(text: string, runId?: string) {
      chatLog.finalizeAssistant(text, runId);
      rootLayout.scrollToBottom();
    },
    dropAssistant(runId?: string) {
      chatLog.dropAssistant(runId);
    },
    startTool(toolCallId: string, toolName: string, args: unknown) {
      chatLog.startTool(toolCallId, toolName, args);
      rootLayout.scrollToBottom();
    },
    updateToolResult(toolCallId: string, result: unknown, opts?: { isError?: boolean; partial?: boolean }) {
      chatLog.updateToolResult(toolCallId, result, opts);
    },
    requestRender() {
      tui.requestRender();
    },
    showApproval(opts) {
      return new Promise<boolean>((resolve) => {
        const overlay = new ApprovalOverlay({
          ...opts,
          onApprove: () => {
            ctx.hideOverlay();
            resolve(true);
          },
          onReject: () => {
            ctx.hideOverlay();
            resolve(false);
          },
        });
        ctx.showOverlay(overlay);
      });
    },
    showOverlay(component: Component) {
      tui.showOverlay(component);
    },
    hideOverlay() {
      tui.hideOverlay();
      tui.setFocus(editor);
    },
  };

  // === Autocomplete ===
  const slashCommands = COMMANDS.map(c => ({
    name: c.command.replace(/^\//, ""),
    description: c.description,
  }));
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(slashCommands, process.cwd()),
  );

  // === Header / Footer / Status ===
  function updateHeader(): void {
    const config = polpo.getConfig();
    const project = config?.project ?? projectName;
    const tasks = polpo.getStore().getAllTasks();
    const running = tasks.filter(t => t.status === "in_progress" || t.status === "review").length;
    const done = tasks.filter(t => t.status === "done").length;
    const agts = polpo.getAgents();

    header.setText(theme.header(
      `POLPO | ${project} | ${agts.length} agents | ${running} running \u00b7 ${done} done`
    ));
  }

  function updateFooter(): void {
    const modeColor = inputMode === "chat" ? theme.chatMode
      : inputMode === "plan" ? theme.planMode
      : theme.taskMode;
    const modeLabel = modeColor(inputMode);
    const approval = approvalMode === "approval" ? theme.info("approval") : theme.dim("accept-all");
    const tokens = streamingTokens > 0 ? ` | ${formatTokenCount(streamingTokens)} tokens` : "";
    const panel = taskPanelVisible ? "" : theme.dim(" | panel off");
    const scrollHint = !rootLayout.isAtBottom() ? theme.warning(" | SCROLLED (End to resume)") : "";

    footer.setText(theme.dim(
      ` ${modeLabel} | ${approval}${tokens}${panel}${scrollHint} | Tab: mode \u00b7 Ctrl+O: panel \u00b7 /help`
    ));
  }

  let statusText: Text | null = null;
  let statusLoader: Loader | null = null;

  function updateStatus(): void {
    if (processing || streaming) {
      if (!statusLoader) {
        statusContainer.clear();
        statusText = null;
        statusLoader = new Loader(
          tui,
          (spinner) => theme.accent(spinner),
          (text) => theme.bold(theme.accentSoft(text)),
          "",
        );
        statusContainer.addChild(statusLoader);
      }
      const label = processing ? processingLabel : "streaming";
      statusLoader.setMessage(label);
    } else {
      if (!statusText) {
        statusContainer.clear();
        statusLoader?.stop();
        statusLoader = null;
        statusText = new Text("", 1, 0);
        statusContainer.addChild(statusText);
      }
      statusText.setText(theme.dim("idle"));
    }
    tui.requestRender();
  }

  // === Event Bridge ===
  const unbridgeEvents = bridgeEvents(polpo, chatLog, () => {
    rootLayout.scrollToBottom();
    tui.requestRender();
  });

  // Track orchestrator start time for TaskPanel timer
  polpo.on("orchestrator:started", () => {
    taskPanel.setOrchestratorStartedAt(Date.now());
  });

  // === State Sync (tasks/missions -> TaskPanel) ===
  function syncState(): void {
    const tasks = polpo.getStore().getAllTasks();
    const state = polpo.getStore().getState();
    const processes = state.processes ?? [];
    const missions = polpo.getAllMissions();

    taskPanel.setTasks(tasks.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      assignedTo: t.assignTo,
      group: t.group,
      dependsOn: t.dependsOn,
      retries: t.retries,
      maxRetries: t.maxRetries,
      duration: t.result?.duration,
      score: t.result?.assessment?.globalScore ? Math.round(t.result.assessment.globalScore * 20) : undefined,
      description: t.description,
    })));

    taskPanel.setMissions(missions.map((p) => {
      let taskCount: number | undefined;
      try {
        const parsed = JSON.parse(p.data);
        taskCount = Array.isArray(parsed.tasks) ? parsed.tasks.length : undefined;
      } catch { /* invalid data */ }
      return {
        name: p.name,
        status: p.status,
        prompt: p.prompt,
        taskCount,
        completedCount: tasks.filter(t => t.group === p.name && t.status === "done").length,
        failedCount: tasks.filter(t => t.group === p.name && t.status === "failed").length,
      };
    }));

    taskPanel.setActivities(processes.filter((p) => p.alive).map((p) => {
      const task = polpo.getStore().getTask(p.taskId);
      const elapsed = p.startedAt ? Date.now() - new Date(p.startedAt).getTime() : undefined;
      return {
        agentName: p.agentName,
        taskId: p.taskId,
        taskTitle: task?.title,
        currentTool: p.activity?.lastTool,
        elapsed,
        tokens: p.activity?.totalTokens,
        toolCalls: p.activity?.toolCalls,
      };
    }));

    updateHeader();
    tui.requestRender();
  }

  // Sync every 1 second
  syncTimer = setInterval(syncState, 1000);

  // === Editor Keybindings ===
  editor.onSubmit = (text: string) => {
    const raw = text;
    const value = raw.trim();
    editor.setText("");

    if (!value) return;
    editor.addToHistory(value);

    // Slash commands
    if (value.startsWith("/")) {
      const handled = dispatch(value, { polpo, tui: ctx, args: [] });
      if (handled) return;
    }

    // Parse mentions
    const mentions = parseMentions(value);

    // Route by input mode
    chatLog.addUser(value);
    rootLayout.scrollToBottom();
    tui.requestRender();

    switch (inputMode) {
      case "chat":
        void startChat(mentions.text, polpo, ctx, mentions.agent);
        break;
      case "plan":
        void createMission(mentions.text, polpo, ctx);
        break;
      case "task":
        createTask(mentions.text, polpo, ctx, mentions.agent);
        break;
    }
  };

  editor.onEscape = () => {
    if (processing || streaming) {
      ctx.setProcessing(false);
      ctx.setStreaming(false);
      chatLog.addSystem("Cancelled");
      tui.requestRender();
    }
  };

  editor.onCtrlC = () => {
    const now = Date.now();
    if (editor.getText().trim().length > 0) {
      editor.setText("");
      chatLog.addSystem("Input cleared");
      tui.requestRender();
      return;
    }
    if (now - lastCtrlCAt < 1000) {
      void cleanup().then(() => process.exit(0));
      return;
    }
    lastCtrlCAt = now;
    chatLog.addSystem("Press Ctrl+C again to exit");
    tui.requestRender();
  };

  editor.onCtrlD = () => {
    void cleanup().then(() => process.exit(0));
  };

  editor.onCtrlO = () => {
    ctx.toggleTaskPanel();
    chatLog.addSystem(taskPanelVisible ? "Task panel shown" : "Task panel hidden");
    tui.requestRender();
  };

  editor.onCtrlA = () => {
    const newMode = approvalMode === "approval" ? "accept-all" : "approval";
    ctx.setApprovalMode(newMode as ApprovalMode);
    chatLog.addSystem(`Approval mode: ${newMode}`);
    tui.requestRender();
  };

  editor.onCtrlR = async () => {
    if (recordingHandle) {
      chatLog.addSystem("Transcribing\u2026");
      tui.requestRender();
      const text = await stopAndTranscribe(recordingHandle);
      recordingHandle = null;
      if (text) {
        editor.setText(text);
        chatLog.addSystem(`Transcribed: "${text}"`);
      } else {
        chatLog.addSystem("No speech detected");
      }
      tui.requestRender();
    } else {
      const handle = startRecording();
      if (handle) {
        recordingHandle = handle;
        chatLog.addSystem("Recording\u2026 (Ctrl+R to stop)");
      } else {
        chatLog.addSystem("Voice recording unavailable (sox not found)");
      }
      tui.requestRender();
    }
  };

  editor.onCtrlL = () => {
    chatLog.clearAll();
    chatLog.addSystem("Log cleared");
    rootLayout.scrollToBottom();
    tui.requestRender();
  };

  editor.onTab = () => {
    const modes: InputMode[] = ["chat", "plan", "task"];
    const idx = modes.indexOf(inputMode);
    const next = modes[(idx + 1) % modes.length]!;
    ctx.setInputMode(next);
    tui.requestRender();
  };

  // === Scroll keybindings ===
  tui.addInputListener((data: string) => {
    if (data === "\x1b[1;5A" || data === "\x1b[1;2A") {
      rootLayout.scrollUp(3);
      updateFooter();
      tui.requestRender();
      return { consume: true };
    }
    if (data === "\x1b[1;5B" || data === "\x1b[1;2B") {
      rootLayout.scrollDown(3);
      updateFooter();
      tui.requestRender();
      return { consume: true };
    }
    if (data === "\x1b[5~") {
      rootLayout.pageUp();
      updateFooter();
      tui.requestRender();
      return { consume: true };
    }
    if (data === "\x1b[6~") {
      rootLayout.pageDown();
      updateFooter();
      tui.requestRender();
      return { consume: true };
    }
    if (data === "\x1b[F" || data === "\x1b[4~") {
      rootLayout.scrollToBottom();
      updateFooter();
      tui.requestRender();
      return { consume: true };
    }
    return undefined;
  });

  // === Startup ===
  async function cleanup(): Promise<void> {
    unbridgeEvents();
    taskPanel.dispose();
    if (syncTimer) clearInterval(syncTimer);
    statusLoader?.stop();
    tui.stop();
    await polpo.gracefulStop().catch(() => {});
  }

  // Session restore — load recent messages (< 30 min old)
  const SESSION_RESTORE_TIMEOUT = 30 * 60 * 1000;
  const SESSION_RESTORE_LIMIT = 50;
  const sessionStore = polpo.getSessionStore();
  if (sessionStore) {
    const latest = sessionStore.getLatestSession();
    if (latest) {
      const age = Date.now() - new Date(latest.updatedAt).getTime();
      if (age < SESSION_RESTORE_TIMEOUT) {
        activeSessionId = latest.id;
        const messages = sessionStore.getRecentMessages(latest.id, SESSION_RESTORE_LIMIT);
        if (messages.length > 0) {
          chatLog.addSystem(`── Session restored (${messages.length} messages) ──`);
          for (const m of messages) {
            if (m.role === "user") {
              chatLog.addUser(m.content);
            } else {
              chatLog.updateAssistant(m.content);
            }
          }
        }
      }
    }
  }

  // Set session start time for TaskPanel timer
  taskPanel.setStartedAt(Date.now());

  // Welcome message
  chatLog.addSystem(`Welcome to Polpo TUI (pi-tui)`);
  chatLog.addSystem(`Project: ${projectName} | ${polpo.getAgents().length} agents`);
  chatLog.addSystem(`Type /help for commands`);

  updateHeader();
  updateFooter();
  updateStatus();

  // Start the orchestrator supervisor
  kickRun(polpo);

  // Start the TUI
  tui.start();

  // Keep alive until exit
  await new Promise<void>((resolve) => {
    const finish = () => {
      void cleanup().then(resolve);
    };
    process.once("exit", finish);
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}
