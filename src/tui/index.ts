#!/usr/bin/env node

import blessed from "blessed";
import { resolve, basename } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { Orchestrator } from "../core/orchestrator.js";
import type { OrchestraState, Team, Task } from "../core/types.js";
import { JsonConfigStore } from "../stores/json-config-store.js";
import type { TUIConfig, CommandContext } from "./context.js";
import {
  LOGO_LINES, PROVIDERS, MODELS,
  SLASH_COMMANDS,
} from "./constants.js";
import {
  formatElapsed, getStatusIcon,
  getProviderLabel, boxWidth, esc, fmtUserMsg,
} from "./formatters.js";
import { bridgeOrchestraEvents } from "./event-bridge.js";
import { dispatchCommand } from "./commands/router.js";
import { handlePlanInput as cmdHandlePlanInput } from "./commands/plan.js";
import { handleChatInput as cmdHandleChatInput } from "./commands/chat.js";
import { prepareTask, fallbackDirectCreate } from "./commands/task-prep.js";

// Register adapters
import "../adapters/claude-sdk.js";
import "../adapters/generic.js";

export class OrchestraTUI {
  private screen!: blessed.Widgets.Screen;
  private config: TUIConfig = { project: "", judge: "claude-sdk", judgeModel: "claude-sonnet-4-5-20250929", agent: "claude-sdk", model: "claude-sonnet-4-5-20250929" };

  // Main UI elements
  private header!: blessed.Widgets.BoxElement;
  private logBox!: blessed.Widgets.Log;
  private taskPanel!: blessed.Widgets.BoxElement;
  private taskListBox!: blessed.Widgets.BoxElement;
  private inputBox!: blessed.Widgets.BoxElement;
  private statusLine!: blessed.Widgets.BoxElement;
  private hintBar!: blessed.Widgets.BoxElement;
  private completionBox!: blessed.Widgets.ListElement;

  // State
  private taskPanelVisible = true;
  private state: OrchestraState | null = null;
  private frame = 0;
  private orchestrator!: Orchestrator;
  private defaultAgent = "dev";
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private animTimer: ReturnType<typeof setInterval> | null = null;
  private disposeBridge: (() => void) | null = null;
  private workDir: string;
  private inputMode: "task" | "plan" | "chat" = "task";
  private processing = false;
  private processingStart = 0;
  private processingLabel = "";
  private processingDetail = "";
  private overlayActive = false;
  private menuType: "command" | "agent" | null = null;
  private menuJustClosed = false;
  private verboseLog = false;
  private fullLogLines: string[] = [];
  private eventLogLines: string[] = [];

  constructor(workDir: string = ".") {
    this.workDir = resolve(workDir);
  }

  private inputBuffer = "";

  async start(): Promise<void> {
    this.createScreen();

    // Check for persisted config — skip wizard if setup was already completed
    const orchestraDir = resolve(this.workDir, ".polpo");
    const configStore = new JsonConfigStore(orchestraDir);
    const savedConfig = configStore.get();

    if (savedConfig) {
      // Backfill for old configs
      let needsSave = false;
      if (!savedConfig.project) {
        savedConfig.project = basename(this.workDir);
        needsSave = true;
      }
      if (!savedConfig.judgeModel) {
        savedConfig.judgeModel = savedConfig.model || "claude-sonnet-4-5-20250929";
        needsSave = true;
      }
      if (needsSave) configStore.save(savedConfig);
      this.config = savedConfig;
    } else {
      // Default project name from directory
      this.config.project = basename(this.workDir);
      await this.runWizard();
      configStore.save(this.config);
    }

    this.initOrchestrator();
    this.buildMainUI();
    this.startPolling();
  }

  private initOrchestrator(): void {
    this.orchestrator = new Orchestrator(this.workDir);

    // Try to load team from polpo.yml
    let team: Team;
    const ymlPath = resolve(this.workDir, "polpo.yml");
    if (existsSync(ymlPath)) {
      try {
        const raw = readFileSync(ymlPath, "utf-8");
        const doc = parseYaml(raw);
        team = doc.team;
        this.defaultAgent = team.agents[0]?.name ?? "dev";
      } catch {
        team = this.makeDefaultTeam();
      }
    } else {
      team = this.makeDefaultTeam();
    }

    this.orchestrator.initInteractive(this.config.project || basename(this.workDir), team);

    // Pass judge model to orchestrator settings
    const cfg = this.orchestrator.getConfig();
    if (cfg && this.config.judgeModel) {
      cfg.settings.orchestratorModel = this.config.judgeModel;
    }

    // Subscribe to typed orchestrator events (replaces console.log monkey-patch)
    this.disposeBridge = bridgeOrchestraEvents(this.orchestrator, {
      log: (msg) => this.log(msg),
      logAlways: (msg) => this.logAlways(msg),
      logEvent: (msg) => this.logEvent(msg),
    });

    // Start the supervisor loop in background
    this.orchestrator.run().catch((err: Error) => {
      this.log(`{red-fg}Supervisor error: ${err.message}{/red-fg}`);
    });
  }

  private createScreen(): void {
    this.screen = blessed.screen({
      smartCSR: true,
      title: "Polpo",
      fullUnicode: true,
    });

    this.screen.key(["C-c"], () => this.quit());

    // Handle OS signals for graceful shutdown
    process.on("SIGTERM", () => this.quit());
    process.on("SIGHUP", () => this.quit());
  }

  private quitting = false;

  private quit(): void {
    if (this.quitting) return; // prevent double-exit
    this.quitting = true;

    this.stopPolling();
    this.disposeBridge?.();

    if (this.orchestrator) {
      // Graceful: kill agents, mark orphaned tasks, persist state
      this.orchestrator.gracefulStop(3000).then(() => {
        this.screen.destroy();
        process.exit(0);
      }).catch(() => {
        this.screen.destroy();
        process.exit(1);
      });
    } else {
      this.screen.destroy();
      process.exit(0);
    }
  }

  // ─── Wizard ──────────────────────────────────────────

  private runWizard(): Promise<void> {
    return new Promise<void>((resolvePromise) => {
      const wizCols = Math.min(60, (this.screen.cols as number) - 4);
      const wizardBox = blessed.box({
        parent: this.screen,
        top: "center",
        left: "center",
        width: wizCols,
        height: 24,
        tags: true,
        style: { bg: "black" },
      });

      // Logo
      const logoText = LOGO_LINES.map(l =>
        l.replace(/[╔╗╚╝║═]/g, m => `{bold}${m}{/bold}`)
          .replace(/🐙 O P E N P O L P O/g, `{bold}{white-fg}🐙 O P E N P O L P O{/white-fg}{/bold}`)
          .replace(/AI Agent Orchestration Framework/g, `{grey-fg}AI Agent Orchestration Framework{/grey-fg}`)
      ).join("\n");

      blessed.box({
        parent: wizardBox,
        top: 0,
        left: "center",
        width: 52,
        height: 8,
        content: logoText,
        tags: true,
        style: { bg: "black" },
      });

      let step = 0;
      const selections: TUIConfig = {
        project: this.config.project,
        judge: "claude-sdk",
        judgeModel: "claude-sonnet-4-5-20250929",
        agent: "claude-sdk",
        model: "claude-sonnet-4-5-20250929",
      };

      const stepLabel = blessed.box({
        parent: wizardBox,
        top: 9,
        left: 2,
        width: wizCols - 4,
        height: 1,
        content: "",
        tags: true,
        style: { bg: "black" },
      });

      const selectionList = blessed.list({
        parent: wizardBox,
        top: 11,
        left: 2,
        width: wizCols - 6,
        height: PROVIDERS.length + 2,
        items: [],
        tags: true,
        border: { type: "line" },
        style: {
          bg: "black",
          border: { fg: "grey" },
          selected: { bg: "blue", fg: "white", bold: true },
          item: { bg: "black" },
        },
        keys: false,
        vi: false,
        mouse: true,
      });

      blessed.box({
        parent: wizardBox,
        bottom: 0,
        left: 2,
        width: 56,
        height: 1,
        content: "{grey-fg}↑↓ Navigate   Enter Select   Ctrl+C Quit{/grey-fg}",
        tags: true,
        style: { bg: "black" },
      });

      const providerItems = PROVIDERS.map(p => {
        if (p.available) return `  {green-fg}●{/green-fg} ${p.label}`;
        return `  {grey-fg}○ ${p.label}{/grey-fg}  {yellow-fg}coming soon{/yellow-fg}`;
      });

      const buildModelItems = (adapter: string) => {
        const available = MODELS.filter(m => m.adapter === adapter);
        return available.map(m => `  {green-fg}●{/green-fg} ${m.label} {grey-fg}${m.value}{/grey-fg}`);
      };

      // Steps: 0=Judge adapter, 1=Judge model, 2=Agent adapter, 3=Agent model
      const showStep = (s: number) => {
        if (s === 0) {
          stepLabel.setContent(`{bold}Step 1/4 — Select Judge{/bold} {grey-fg}(evaluates results, resolves deadlocks){/grey-fg}`);
          selectionList.setItems(providerItems);
          selectionList.height = PROVIDERS.length + 2;
        } else if (s === 1) {
          const available = MODELS.filter(m => m.adapter === selections.judge);
          stepLabel.setContent(`{bold}Step 2/4 — Judge Model{/bold} {grey-fg}(for ${getProviderLabel(selections.judge)}){/grey-fg}`);
          selectionList.setItems(buildModelItems(selections.judge));
          selectionList.height = available.length + 2;
        } else if (s === 2) {
          stepLabel.setContent(`{bold}Step 3/4 — Select Orchestrator{/bold} {grey-fg}(executes tasks){/grey-fg}`);
          selectionList.setItems(providerItems);
          selectionList.height = PROVIDERS.length + 2;
        } else if (s === 3) {
          const available = MODELS.filter(m => m.adapter === selections.agent);
          stepLabel.setContent(`{bold}Step 4/4 — Agent Model{/bold} {grey-fg}(for ${getProviderLabel(selections.agent)}){/grey-fg}`);
          selectionList.setItems(buildModelItems(selections.agent));
          selectionList.height = available.length + 2;
        }
        selectionList.select(0);
        this.screen.render();
      };

      const finishWizard = () => {
        this.config = selections;
        wizardBox.destroy();
        this.screen.removeListener("keypress", wizKh);
        this.screen.render();
        resolvePromise();
      };

      const handleSelect = (index: number) => {
        if (step === 0 || step === 2) {
          // Provider selection
          const provider = PROVIDERS[index];
          if (!provider.available) {
            const prev = stepLabel.getContent();
            stepLabel.setContent(`{yellow-fg}${provider.label} is not available yet — coming soon!{/yellow-fg}`);
            this.screen.render();
            setTimeout(() => { stepLabel.setContent(prev); this.screen.render(); }, 1500);
            return;
          }

          if (step === 0) {
            selections.judge = provider.value;
            const available = MODELS.filter(m => m.adapter === provider.value);
            if (available.length > 0) {
              step = 1;
              showStep(1);
            } else {
              selections.judgeModel = "";
              step = 2;
              showStep(2);
            }
          } else {
            selections.agent = provider.value;
            const available = MODELS.filter(m => m.adapter === provider.value);
            if (available.length > 0) {
              step = 3;
              showStep(3);
            } else {
              selections.model = "";
              finishWizard();
            }
          }
        } else if (step === 1) {
          // Judge model selection
          const available = MODELS.filter(m => m.adapter === selections.judge);
          const model = available[index];
          if (model) selections.judgeModel = model.value;
          step = 2;
          showStep(2);
        } else if (step === 3) {
          // Agent model selection
          const available = MODELS.filter(m => m.adapter === selections.agent);
          const model = available[index];
          if (model) selections.model = model.value;
          finishWizard();
        }
      };

      showStep(0);
      selectionList.focus();

      let initReady = false;
      setImmediate(() => { initReady = true; });
      selectionList.on("select", (_item: blessed.Widgets.BlessedElement, index: number) => {
        if (initReady) handleSelect(index);
      });

      const wizKh = (_ch: string, key: any) => {
        if (!key || !initReady) return;
        if (key.name === "up") { selectionList.up(1); this.screen.render(); return; }
        if (key.name === "down") { selectionList.down(1); this.screen.render(); return; }
        if (key.name === "return" || key.name === "enter") {
          handleSelect((selectionList as any).selected ?? 0);
        }
      };
      this.screen.on("keypress", wizKh);
    });
  }

  // ─── Main UI ─────────────────────────────────────────

  private buildMainUI(): void {
    // Header bar
    this.header = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      style: { bg: "black", fg: "white" },
    });
    this.updateHeader();

    // Log area
    this.logBox = blessed.log({
      parent: this.screen,
      top: 1,
      left: 0,
      width: this.taskPanelVisible ? "65%" : "100%",
      height: "100%-4",
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: "│", style: { fg: "grey" } },
      border: { type: "line" },
      style: {
        bg: "black",
        border: { fg: "grey" },
        scrollbar: { fg: "grey" },
      },
      label: " {grey-fg}Log{/grey-fg} ",
      keys: true,
      vi: true,
      mouse: true,
    }) as blessed.Widgets.Log;

    // Task panel (right side)
    this.taskPanel = blessed.box({
      parent: this.screen,
      top: 1,
      right: 0,
      width: "35%",
      height: "100%-4",
      border: { type: "line" },
      tags: true,
      label: " {bold}Tasks{/bold} ",
      style: {
        bg: "black",
        border: { fg: "grey" },
      },
      hidden: !this.taskPanelVisible,
    });

    this.taskListBox = blessed.box({
      parent: this.taskPanel,
      top: 0,
      left: 0,
      width: "100%-2",
      height: "100%-2",
      tags: true,
      scrollable: true,
      style: { bg: "black" },
    });

    // Status line (above input, for processing indicator)
    this.statusLine = blessed.box({
      parent: this.screen,
      bottom: 4,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      style: { bg: "black" },
      hidden: true,
    });

    // Input line — plain box, we handle keypress manually
    this.inputBox = blessed.box({
      parent: this.screen,
      bottom: 1,
      left: 0,
      width: "100%",
      height: 3,
      border: { type: "line" },
      tags: true,
      style: {
        bg: "black",
        fg: "white",
        border: { fg: "cyan" },
      },
      label: "",
    });

    // Hint bar
    this.hintBar = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      style: { bg: "black", fg: "grey" },
    });
    this.updateHints();

    // Command menu popup (hidden by default)
    this.completionBox = blessed.list({
      parent: this.screen,
      bottom: 4,
      left: 1,
      width: Math.min(50, Math.max(30, Math.floor((this.screen.cols as number) * 0.4))),
      height: Object.keys(SLASH_COMMANDS).length + 2,
      items: [],
      tags: true,
      border: { type: "line" },
      label: " {cyan-fg}Commands{/cyan-fg} ",
      style: {
        bg: "black",
        border: { fg: "cyan" },
        selected: { bg: "blue", fg: "white", bold: true },
        item: { bg: "black", fg: "white" },
      },
      hidden: true,
      keys: false,
      vi: false,
      mouse: true,
    });

    // Persistent mouse click handler for command menu (bound once, checks menuType)
    this.completionBox.on("select", (_item: any, index: number) => {
      if (this.menuType === "command") {
        const cmd = this.commandKeys[index];
        this.closeMenu();
        if (cmd) {
          this.inputBuffer = "";
          this.updateInputDisplay();
          this.handleSlashCommand(cmd);
        }
      } else if (this.menuType === "agent") {
        this.resolveMention(index);
      }
    });

    // Manual input handling — all keypress goes through screen
    this.screen.on("keypress", (ch: string, key: { full: string; name: string; ctrl: boolean; meta: boolean; shift: boolean }) => {
      if (!key) return;
      // Block input while overlay/wizard is open or processing
      if (this.overlayActive) return;
      if (this.processing) return;

      // Reset menuJustClosed on any key that isn't Enter (safety net)
      if (this.menuJustClosed && key.name !== "return" && key.name !== "enter") {
        this.menuJustClosed = false;
      }

      // Popup menu open: handle all keys ourselves
      if (this.completionBox.visible && this.menuType) {
        if (key.name === "return" || key.name === "enter") {
          const index = (this.completionBox as any).selected ?? 0;
          if (this.menuType === "command") {
            const cmd = this.commandKeys[index];
            this.closeMenu();
            if (cmd) {
              this.inputBuffer = "";
              this.updateInputDisplay();
              this.handleSlashCommand(cmd);
            }
          } else if (this.menuType === "agent") {
            this.resolveMention(index);
          }
          return;
        }
        if (key.name === "escape") {
          this.closeMenu();
          this.updateInputDisplay();
          return;
        }
        if (key.name === "up") {
          this.completionBox.up(1);
          this.scheduleRender();
          return;
        }
        if (key.name === "down") {
          this.completionBox.down(1);
          this.scheduleRender();
          return;
        }
        // Backspace: close menu and delete from buffer
        if (key.name === "backspace") {
          this.closeMenu();
          this.inputBuffer = this.inputBuffer.slice(0, -1);
          this.updateInputDisplay();
          return;
        }
        // Any other character: close menu, fall through to input
        if (ch && ch.length === 1 && !key.ctrl && !key.meta) {
          this.closeMenu();
          // Fall through to regular character handling below
        } else {
          return;
        }
      }

      // Alt+T → toggle Direct/Plan mode
      if (key.full === "M-t" || (key.meta && key.name === "t")) {
        this.toggleMode();
        return;
      }

      // Ctrl shortcuts
      if (key.ctrl) {
        switch (key.name) {
          case "o": this.toggleTaskPanel(); return;
          case "l": this.toggleLogMode(); return;
          case "c": this.quit(); return;
        }
        return;
      }

      // Enter → submit (but skip if menu was just closed by this same Enter)
      if (key.name === "return" || key.name === "enter") {
        if (this.menuJustClosed) {
          this.menuJustClosed = false;
          return;
        }
        const val = this.inputBuffer.trim();
        if (val) {
          this.handleInput(val);
        }
        this.inputBuffer = "";
        this.updateInputDisplay();
        return;
      }

      // Escape → clear
      if (key.name === "escape") {
        if (this.menuType === "command") this.closeMenu();
        this.inputBuffer = "";
        this.updateInputDisplay();
        return;
      }

      // Backspace
      if (key.name === "backspace") {
        this.inputBuffer = this.inputBuffer.slice(0, -1);
        this.updateInputDisplay();
        // Update command menu filtering
        if (this.inputBuffer.startsWith("/")) {
          this.openCommandMenu(this.inputBuffer);
        } else if (this.menuType === "command") {
          this.closeMenu();
        }
        return;
      }

      // Tab → open command menu if starts with /
      if (key.name === "tab") {
        if (this.inputBuffer.startsWith("/")) {
          this.openCommandMenu(this.inputBuffer);
        }
        return;
      }

      // Regular character
      if (ch && ch.length === 1 && !key.ctrl && !key.meta) {
        this.inputBuffer += ch;
        this.updateInputDisplay();

        // "/" at start → open/update command menu with filtering
        if (this.inputBuffer.startsWith("/")) {
          this.openCommandMenu(this.inputBuffer);
        }

        // "@" anywhere → open mention menu
        if (ch === "@") {
          this.openMentionMenu();
        }
      }
    });

    // Welcome message (always visible)
    const team = this.orchestrator.getTeam();
    const modelLabel = this.config.model
      ? MODELS.find(m => m.value === this.config.model)?.label ?? this.config.model
      : "";
    this.logAlways("{bold}🐙 Polpo{/bold}");
    this.logAlways("");
    const judgeModelLabel = this.config.judgeModel
      ? MODELS.find(m => m.value === this.config.judgeModel)?.label ?? this.config.judgeModel
      : "";
    this.logAlways(`  Judge:  {green-fg}${getProviderLabel(this.config.judge)}{/green-fg}` + (judgeModelLabel ? ` {grey-fg}(${judgeModelLabel}){/grey-fg}` : ""));
    this.logAlways(`  Orchestrator: {green-fg}${getProviderLabel(this.config.agent)}{/green-fg}` + (modelLabel ? ` {grey-fg}(${modelLabel}){/grey-fg}` : ""));
    this.logAlways(`  Team:   {green-fg}${team.name}{/green-fg} (${team.agents.map(a => a.name).join(", ")})`);
    this.logAlways("");
    this.logAlways("Type a task description and press Enter to run it.");
    this.logAlways("{grey-fg}Use {bold}@agent{/bold} to assign, {bold}!{/bold} prefix to skip prep, {bold}/config{/bold} to configure, {bold}/help{/bold} for commands{/grey-fg}");
    this.logAlways("");

    this.updateInputDisplay();
  }

  // ─── Input Handling ──────────────────────────────────

  private handleInput(value: string): void {
    const trimmed = value.trim();
    if (!trimmed) return;

    this.completionBox.hide();

    if (trimmed.startsWith("/")) {
      this.handleSlashCommand(trimmed);
    } else if (this.inputMode === "plan") {
      cmdHandlePlanInput(this.getCommandContext(), trimmed);
    } else if (this.inputMode === "chat") {
      cmdHandleChatInput(this.getCommandContext(), trimmed);
    } else {
      this.createTaskFromInput(trimmed);
    }
  }

  private createTaskFromInput(input: string): void {
    // Parse mentions: @agent, %plan-group
    let assignTo = this.defaultAgent;
    let group: string | undefined;
    let description = input;

    // Extract %group reference (anywhere in input)
    const groupMatch = description.match(/%([a-zA-Z0-9_-]+)/);
    if (groupMatch) {
      group = groupMatch[1];
      description = description.replace(groupMatch[0], "").trim();
    }

    // Extract @agent (at the start)
    const atMatch = description.match(/^@(\w+)\s+(.+)$/s);
    if (atMatch) {
      const agents = this.orchestrator.getAgents();
      const found = agents.find(a => a.name === atMatch[1]);
      if (found) {
        assignTo = found.name;
        description = atMatch[2];
      } else {
        this.logAlways(`{yellow-fg}Agent "${atMatch[1]}" not found, using ${this.defaultAgent}{/yellow-fg}`);
        description = atMatch[2];
      }
    }

    // Quick-task bypass: "!" prefix skips LLM preparation
    if (description.startsWith("!")) {
      description = description.slice(1).trim();
      this.logAlways(fmtUserMsg(input));
      this.logAlways("");
      fallbackDirectCreate(this.getCommandContext(), description, assignTo, group);
      return;
    }

    // LLM-powered task preparation (can be disabled via /config)
    const taskPrepEnabled = this.config.taskPrep !== false; // default: true
    if (taskPrepEnabled) {
      prepareTask(this.getCommandContext(), description, assignTo, group);
    } else {
      this.logAlways(fmtUserMsg(input));
      this.logAlways("");
      fallbackDirectCreate(this.getCommandContext(), description, assignTo, group);
    }
  }

  private handleSlashCommand(cmd: string): void {
    const command = cmd.split(/\s+/)[0].toLowerCase();

    // Handle built-in commands that need direct TUI access
    if (command === "/clear") { this.clearLog(); return; }
    if (command === "/quit" || command === "/exit") { this.quit(); return; }

    // Dispatch to command modules
    const handled = dispatchCommand(this.getCommandContext(), cmd);
    if (!handled) {
      this.logAlways(`{red-fg}Unknown command: ${command}{/red-fg}`);
      this.logAlways("{grey-fg}Type / to see available commands{/grey-fg}");
    }
  }


  // ─── Mode Toggle ────────────────────────────────────

  private toggleMode(): void {
    const modes: Array<typeof this.inputMode> = ["task", "plan", "chat"];
    const idx = modes.indexOf(this.inputMode);
    this.inputMode = modes[(idx + 1) % modes.length];
    this.updateModeIndicator();
    this.updateHints();
    this.scheduleRender();
  }

  private updateModeIndicator(): void {
    (this.inputBox as any).setLabel("");
  }

  private makeDefaultTeam(): Team {
    this.defaultAgent = "dev";
    return {
      name: "interactive-team",
      agents: [{
        name: "dev",
        adapter: this.config.agent,
        role: "developer",
        model: this.config.model || undefined,
      }],
    };
  }

  // ─── Command Menu ────────────────────────────────────

  private commandKeys: string[] = [];

  private openCommandMenu(filter = "/"): void {
    // Filter commands by what the user typed
    const allEntries = Object.entries(SLASH_COMMANDS);
    const filtered = filter === "/"
      ? allEntries
      : allEntries.filter(([cmd]) => cmd.startsWith(filter));

    if (filtered.length === 0) {
      // No matches — close menu if open
      if (this.menuType === "command") this.closeMenu();
      return;
    }

    this.commandKeys = filtered.map(([cmd]) => cmd);
    const items = filtered.map(([cmd, desc]) => `  ${cmd.padEnd(12)}  ${desc}`);

    this.menuType = "command";

    this.completionBox.setItems(items);
    this.completionBox.height = items.length + 2;
    (this.completionBox as any).setLabel(" {cyan-fg}Commands{/cyan-fg} ");
    this.completionBox.show();
    this.completionBox.select(0);

    this.scheduleRender();
  }

  /**
   * Mention entries built by openMentionMenu.
   * Stored so both keyboard Enter and mouse click resolve to the same data.
   */
  private mentionEntries: { tag: string; kind: "agent" | "task" | "group" }[] = [];

  private openMentionMenu(): void {
    this.menuType = "agent"; // reuses "agent" menuType for input routing
    const agents = this.orchestrator.getAgents();
    this.loadState();
    const tasks = this.state?.tasks ?? [];
    const groups = new Set<string>();
    for (const t of tasks) { if (t.group) groups.add(t.group); }

    const items: string[] = [];
    this.mentionEntries = [];

    // Agents section
    if (agents.length > 0) {
      items.push("{grey-fg} ── Agents ──{/grey-fg}");
      this.mentionEntries.push({ tag: "", kind: "agent" }); // separator
      for (const a of agents) {
        const def = a.name === this.defaultAgent ? " {green-fg}★{/green-fg}" : "";
        const role = a.role ? ` {grey-fg}${a.role}{/grey-fg}` : "";
        items.push(`  {cyan-fg}@${a.name}{/cyan-fg}${role}${def}`);
        this.mentionEntries.push({ tag: `@${a.name}`, kind: "agent" });
      }
    }

    // Tasks section (active — not done/failed)
    const activeTasks = tasks.filter(t => t.status !== "done" && t.status !== "failed");
    if (activeTasks.length > 0) {
      items.push("{grey-fg} ── Tasks ──{/grey-fg}");
      this.mentionEntries.push({ tag: "", kind: "task" }); // separator
      for (const t of activeTasks) {
        const statusIcon = t.status === "in_progress" ? "{yellow-fg}●{/yellow-fg}"
          : t.status === "pending" ? "{grey-fg}○{/grey-fg}"
          : "{blue-fg}◎{/blue-fg}";
        items.push(`  ${statusIcon} {white-fg}#${t.title}{/white-fg}`);
        this.mentionEntries.push({ tag: `#${t.title}`, kind: "task" });
      }
    }

    // Groups section
    if (groups.size > 0) {
      items.push("{grey-fg} ── Plans ──{/grey-fg}");
      this.mentionEntries.push({ tag: "", kind: "group" }); // separator
      for (const g of groups) {
        const count = tasks.filter(t => t.group === g).length;
        items.push(`  {magenta-fg}%${g}{/magenta-fg} {grey-fg}(${count} tasks){/grey-fg}`);
        this.mentionEntries.push({ tag: `%${g}`, kind: "group" });
      }
    }

    if (items.length === 0) return;

    const maxH = Math.min(items.length + 2, 16);
    this.completionBox.setItems(items);
    this.completionBox.height = maxH;
    (this.completionBox as any).setLabel(" {cyan-fg}@{/cyan-fg} {grey-fg}Mention{/grey-fg} ");
    this.completionBox.show();
    // Select first non-separator
    const firstReal = this.mentionEntries.findIndex(e => e.tag !== "");
    this.completionBox.select(firstReal >= 0 ? firstReal : 0);

    this.scheduleRender();
  }

  /** Resolve a mention selection by index → insert tag at the trigger position */
  private resolveMention(index: number): void {
    const entry = this.mentionEntries[index];
    if (!entry || !entry.tag) return; // skip separators
    this.closeMenu();
    // Find the last "@" in the buffer (the trigger point)
    const atPos = this.inputBuffer.lastIndexOf("@");
    if (atPos >= 0) {
      // Replace from "@" to end of partial typing (everything after @)
      this.inputBuffer = this.inputBuffer.slice(0, atPos) + entry.tag + " ";
    } else {
      this.inputBuffer += entry.tag + " ";
    }
    this.updateInputDisplay();
  }

  /** Close popup menu without clearing buffer */
  private closeMenu(): void {
    this.menuType = null;
    this.menuJustClosed = true;
    this.completionBox.hide();
    this.scheduleRender();
  }

  // ─── Task Panel ──────────────────────────────────────

  private toggleTaskPanel(): void {
    this.taskPanelVisible = !this.taskPanelVisible;

    if (this.taskPanelVisible) {
      this.taskPanel.show();
      this.logBox.width = "65%";
    } else {
      this.taskPanel.hide();
      this.logBox.width = "100%";
    }

    this.updateTaskPanel();
    this.screen.render();
    this.log(`{grey-fg}Task panel ${this.taskPanelVisible ? "shown" : "hidden"}{/grey-fg}`);
  }

  private updateTaskPanel(): void {
    if (!this.taskPanelVisible) return;

    this.loadState();
    if (!this.state || this.state.tasks.length === 0) {
      this.taskListBox.setContent("{grey-fg}No tasks{/grey-fg}");
      return;
    }

    const spin = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const s = spin[this.frame % spin.length];

    const lines: string[] = [];
    const counts: Record<string, number> = {};
    for (const t of this.state.tasks) {
      counts[t.status] = (counts[t.status] || 0) + 1;
    }

    // Summary line
    const parts: string[] = [];
    if (counts["done"]) parts.push(`{green-fg}${counts["done"]} done{/green-fg}`);
    if (counts["in_progress"] || counts["assigned"] || counts["review"]) {
      const running = (counts["in_progress"] || 0) + (counts["assigned"] || 0) + (counts["review"] || 0);
      parts.push(`{yellow-fg}${running} running{/yellow-fg}`);
    }
    if (counts["pending"]) parts.push(`{grey-fg}${counts["pending"]} pending{/grey-fg}`);
    if (counts["failed"]) parts.push(`{red-fg}${counts["failed"]} failed{/red-fg}`);
    lines.push(parts.join(" {grey-fg}|{/grey-fg} "));
    lines.push("");

    // Progress bar
    const total = this.state.tasks.length;
    const doneN = counts["done"] || 0;
    const failN = counts["failed"] || 0;
    const pct = Math.round(((doneN + failN) / total) * 100);
    const panelW = boxWidth(this.taskPanel);
    const barLen = Math.max(8, panelW - 5);
    const greenFill = Math.round((doneN / total) * barLen);
    const redFill = Math.round((failN / total) * barLen);
    const grayFill = Math.max(0, barLen - greenFill - redFill);
    lines.push(`{green-fg}${"█".repeat(greenFill)}{/green-fg}{red-fg}${"█".repeat(redFill)}{/red-fg}{grey-fg}${"░".repeat(grayFill)}{/grey-fg} ${pct}%`);
    lines.push("");

    // Build chronological entries: standalone tasks + plan groups interleaved by creation time
    type Entry = { type: "task"; task: Task; ts: string }
               | { type: "group"; name: string; tasks: Task[]; ts: string };
    const entries: Entry[] = [];
    const groups = new Map<string, Task[]>();
    for (const t of this.state.tasks) {
      if (t.group) {
        if (!groups.has(t.group)) groups.set(t.group, []);
        groups.get(t.group)!.push(t);
      } else {
        entries.push({ type: "task", task: t, ts: t.createdAt });
      }
    }
    for (const [name, tasks] of groups) {
      const earliest = tasks.reduce((min, t) => t.createdAt < min ? t.createdAt : min, tasks[0].createdAt);
      entries.push({ type: "group", name, tasks, ts: earliest });
    }
    entries.sort((a, b) => a.ts.localeCompare(b.ts));

    const blinkPhase = this.frame % 3; // 0, 1, 2 — faster cycle

    // Build task list for dependency rendering
    const allTasks = this.state.tasks;

    const taskIcon = (task: typeof allTasks[0]) => {
      const isRunning = ["in_progress", "assigned", "review"].includes(task.status);
      if (isRunning) {
        return blinkPhase === 0
          ? "{bold}{#ff8800-fg}●{/#ff8800-fg}{/bold}"
          : blinkPhase === 1
            ? "{#cc6600-fg}●{/#cc6600-fg}"
            : "{#884400-fg}○{/#884400-fg}";
      }
      return getStatusIcon(task.status);
    };

    const taskScore = (task: typeof allTasks[0]) => {
      if (task.result?.assessment?.globalScore !== undefined) {
        const gs = task.result.assessment.globalScore;
        const color = gs >= 4 ? "green" : gs >= 3 ? "yellow" : "red";
        return ` {${color}-fg}${gs.toFixed(1)}{/${color}-fg}`;
      }
      return "";
    };

    const truncTitle = (title: string, avail: number) => {
      const max = Math.max(6, avail);
      return title.length > max ? title.slice(0, max - 1) + "…" : title;
    };

    const renderTaskLine = (task: typeof allTasks[0], indent: string) => {
      const icon = taskIcon(task);
      const score = taskScore(task);
      let phaseTag = "";
      if (task.phase === "fix") {
        phaseTag = ` {magenta-fg}fix ${task.fixAttempts ?? 1}{/magenta-fg}`;
      } else if (task.phase === "review") {
        phaseTag = ` {yellow-fg}review{/yellow-fg}`;
      }
      const overhead = 4 + (score ? 5 : 0) + (phaseTag ? 6 : 0);
      const plainIndent = indent.replace(/\{[^}]*\}/g, "");
      const title = truncTitle(esc(task.title), panelW - plainIndent.length - overhead);
      lines.push(`${indent}${icon} ${title}${phaseTag}${score}`);

      // Activity line for running tasks
      const proc = (this.state!.processes || []).find(p => p.taskId === task.id);
      if (proc?.alive && proc.activity) {
        const act = proc.activity;
        const parts: string[] = [];
        if (act.lastTool) {
          const file = act.lastFile ? ` ${esc(act.lastFile.split("/").pop() ?? "")}` : "";
          parts.push(`${esc(act.lastTool)}${file}`);
        }
        if (act.toolCalls > 0) parts.push(`${act.toolCalls} calls`);
        const fCount = (act.filesCreated?.length || 0) + (act.filesEdited?.length || 0);
        if (fCount > 0) parts.push(`${fCount} files`);
        if (parts.length > 0) {
          lines.push(`${indent}  {cyan-fg}${s}{/cyan-fg} {grey-fg}${parts.join(" · ")}{/grey-fg}`);
        }
      }
    };

    /** Render tasks as a flat ordered list, showing deps inline */
    const renderTaskList = (tasks: typeof allTasks, baseIndent: string) => {
      // Sort: running first, then pending, then done, then failed
      const order: Record<string, number> = {
        in_progress: 0, assigned: 0, review: 0,
        pending: 1, done: 2, failed: 3,
      };
      const sorted = [...tasks].sort((a, b) =>
        (order[a.status] ?? 9) - (order[b.status] ?? 9)
      );

      for (const task of sorted) {
        // Show dependency info for blocked tasks
        const localDeps = (task.dependsOn || []).filter(d =>
          tasks.some(t => t.id === d && t.status !== "done")
        );
        if (localDeps.length > 0 && task.status === "pending") {
          const depNames = localDeps.map(d => {
            const dep = tasks.find(t => t.id === d);
            return dep ? esc(dep.title.slice(0, 15)) : d.slice(0, 6);
          });
          renderTaskLine(task, baseIndent);
          lines.push(`${baseIndent}  {grey-fg}⏳ after: ${depNames.join(", ")}{/grey-fg}`);
        } else {
          renderTaskLine(task, baseIndent);
        }
      }
    };

    // Render entries in chronological order (tasks + plan groups interleaved)
    for (const entry of entries) {
      if (entry.type === "task") {
        renderTaskLine(entry.task, "");
      } else {
        const groupTasks = entry.tasks;
        if (lines.length > 4) lines.push("");
        const gDone = groupTasks.filter(t => t.status === "done").length;
        const gFailed = groupTasks.filter(t => t.status === "failed").length;
        const gTotal = groupTasks.length;
        const allTerminal = gDone + gFailed === gTotal;

        const endTime = allTerminal
          ? groupTasks.reduce((max, t) => t.updatedAt > max ? t.updatedAt : max, groupTasks[0].updatedAt)
          : new Date().toISOString();
        const elapsedMs = new Date(endTime).getTime() - new Date(entry.ts).getTime();
        const elapsedStr = formatElapsed(elapsedMs);

        const groupStatus = allTerminal
          ? (gFailed > 0 ? "{red-fg}FAILED{/red-fg}" : "{green-fg}DONE{/green-fg}")
          : "{yellow-fg}RUNNING{/yellow-fg}";
        lines.push(`{cyan-fg}┌{/cyan-fg} {bold}${esc(entry.name)}{/bold} {grey-fg}${gDone}/${gTotal}{/grey-fg} ${groupStatus} {grey-fg}${elapsedStr}{/grey-fg}`);

        renderTaskList(groupTasks, "{cyan-fg}│{/cyan-fg} ");
        lines.push(`{cyan-fg}└${"─".repeat(Math.max(1, panelW - 2))}{/cyan-fg}`);
      }
    }

    lines.push("");
    lines.push("{grey-fg}Ctrl+O to hide{/grey-fg}");

    this.taskListBox.setContent(lines.join("\n"));
  }

  // ─── Polling & State ─────────────────────────────────

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      this.frame++;
      if (this.overlayActive) return; // skip main UI updates while overlay is open
      this.updateTaskPanel();
      this.updateHeader();
      if (this.processing) this.updateInputDisplay();
      this.screen.render();
    }, 700);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.animTimer) clearInterval(this.animTimer);
  }

  private loadState(): void {
    try {
      this.state = this.orchestrator.getStore().getState();
    } catch {
      // Store not ready — skip
    }
  }

  // ─── UI Updates ──────────────────────────────────────

  private updateHeader(): void {
    this.loadState();
    const parts = ["{bold}POLPO{/bold}"];

    if (this.state?.project) {
      parts.push(`{grey-fg}${this.state.project}{/grey-fg}`);
    }

    if (this.state && this.state.tasks.length > 0) {
      const counts: Record<string, number> = {};
      for (const t of this.state.tasks) counts[t.status] = (counts[t.status] || 0) + 1;

      if (counts["in_progress"] || counts["assigned"] || counts["review"]) {
        const running = (counts["in_progress"] || 0) + (counts["assigned"] || 0) + (counts["review"] || 0);
        parts.push(`{yellow-fg}● ${running} running{/yellow-fg}`);
      }
      if (counts["done"]) parts.push(`{green-fg}✓ ${counts["done"]} done{/green-fg}`);
      if (counts["failed"]) parts.push(`{red-fg}✗ ${counts["failed"]} failed{/red-fg}`);
    }

    // Show spinner if agents are active
    const hasActive = this.state && this.state.processes?.some(p => p.alive);
    if (hasActive) {
      const spin = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
      parts.push(`{cyan-fg}${spin[this.frame % spin.length]} orchestrating{/cyan-fg}`);
    }

    this.header.setContent(` ${parts.join("  {grey-fg}|{/grey-fg}  ")}`);
  }

  private updateHints(): void {
    const modeLabels: Record<string, string> = {
      task: "{cyan-fg}Task{/cyan-fg}",
      plan: "{yellow-fg}Plan{/yellow-fg}",
      chat: "{magenta-fg}Chat{/magenta-fg}",
    };

    // Show active plan name when in plan mode
    let planTag = "";
    if (this.inputMode === "plan") {
      const active = this.orchestrator.getResumablePlans().find(p => p.status === "active");
      if (active) {
        planTag = ` {yellow-fg}[${active.name}]{/yellow-fg}`;
      } else {
        planTag = " {grey-fg}[no active plan]{/grey-fg}";
      }
    }

    // Truncate workDir for display
    const maxCwd = 30;
    const cwd = this.workDir.length > maxCwd
      ? "…" + this.workDir.slice(-(maxCwd - 1))
      : this.workDir;

    const left = ` ${modeLabels[this.inputMode]}${planTag}  {grey-fg}│{/grey-fg}  ` +
      "{cyan-fg}Alt+T{/cyan-fg} {grey-fg}mode{/grey-fg}  " +
      "{cyan-fg}/{/cyan-fg} {grey-fg}cmds{/grey-fg}  " +
      "{cyan-fg}Ctrl+O{/cyan-fg} {grey-fg}tasks{/grey-fg}  " +
      "{cyan-fg}Ctrl+C{/cyan-fg} {grey-fg}quit{/grey-fg}";

    const right = `{grey-fg}${cwd}{/grey-fg} `;

    this.hintBar.setContent(`${left}{|}${right}`);
  }

  // ─── Helpers ─────────────────────────────────────────

  private updateInputDisplay(): void {
    if (this.processing) {
      // Animated spinner
      const dots = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
      const dot = dots[this.frame % dots.length];

      const label = this.processingLabel
        || (this.inputMode === "chat" ? "Thinking" : "Generating plan");

      // Elapsed time
      const elapsed = this.processingStart
        ? ((Date.now() - this.processingStart) / 1000).toFixed(0) + "s"
        : "";

      // Shimmer wave: a bright "highlight" sweeps across the text
      const wave = [
        "grey", "grey", "white", "bold", "white", "grey", "grey",
      ];
      const waveLen = wave.length;
      const offset = this.frame % (label.length + waveLen);
      let shimmerText = "";
      for (let i = 0; i < label.length; i++) {
        const wavePos = offset - i;
        let color = "grey";
        if (wavePos >= 0 && wavePos < waveLen) {
          color = wave[wavePos];
        }
        if (color === "bold") {
          shimmerText += `{bold}{yellow-fg}${label[i]}{/yellow-fg}{/bold}`;
        } else if (color === "white") {
          shimmerText += `{white-fg}${label[i]}{/white-fg}`;
        } else {
          shimmerText += `{grey-fg}${label[i]}{/grey-fg}`;
        }
      }

      // Detail line (truncated to fit)
      const detail = this.processingDetail
        ? `  {grey-fg}${this.processingDetail.replace(/\{[^}]*\}/g, "").slice(0, 60)}{/grey-fg}`
        : "";

      this.statusLine.setContent(
        ` {yellow-fg}${dot}{/yellow-fg} ${shimmerText}{grey-fg}...{/grey-fg}  {grey-fg}${elapsed}{/grey-fg}${detail}`
      );
      this.statusLine.show();
      (this.inputBox as any).setContent("");
    } else {
      this.processingLabel = "";
      this.processingDetail = "";
      this.statusLine.hide();
      const cursor = "{white-fg}█{/white-fg}";
      (this.inputBox as any).setContent(` ${this.inputBuffer}${cursor}`);
    }
    this.scheduleRender();
  }

  private renderPending = false;

  private log(msg: string): void {
    this.fullLogLines.push(msg);
    if (this.logBox) {
      if (this.verboseLog) {
        this.logBox.log(msg);
        this.scheduleRender();
      }
    }
  }

  /** Log a message that appears in both verbose and event modes */
  private logAlways(msg: string): void {
    this.fullLogLines.push(msg);
    this.eventLogLines.push(msg);
    if (this.logBox) {
      this.logBox.log(msg);
      this.scheduleRender();
    }
  }

  /** Log a human-readable event (shown in clean mode) */
  private logEvent(msg: string): void {
    this.eventLogLines.push(msg);
    if (this.logBox && !this.verboseLog) {
      this.logBox.log(msg);
      this.scheduleRender();
    }
  }

  /** Switch between clean events and full verbose log */
  private toggleLogMode(): void {
    this.verboseLog = !this.verboseLog;
    if (!this.logBox) return;
    this.logBox.setContent("");
    (this.logBox as any).setLabel(this.verboseLog
      ? " {yellow-fg}Log{/yellow-fg} {grey-fg}(verbose){/grey-fg} "
      : " {grey-fg}Log{/grey-fg} ");
    const lines = this.verboseLog ? this.fullLogLines : this.eventLogLines;
    for (const line of lines) {
      this.logBox.log(line);
    }
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.renderPending) return;
    this.renderPending = true;
    setImmediate(() => {
      this.renderPending = false;
      this.screen.render();
    });
  }

  private clearLog(): void {
    this.fullLogLines = [];
    this.eventLogLines = [];
    this.logBox.setContent("");
    this.logBox.log("{grey-fg}Log cleared{/grey-fg}");
    this.scheduleRender();
  }

  /** Build a CommandContext that delegates to TUI fields and methods */
  private getCommandContext(): CommandContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const tui = this;
    return {
      screen: tui.screen,
      get overlayActive() { return tui.overlayActive; },
      set overlayActive(v: boolean) { tui.overlayActive = v; },
      scheduleRender: () => tui.scheduleRender(),
      orchestrator: tui.orchestrator,
      config: tui.config,
      workDir: tui.workDir,
      log: (msg: string) => tui.log(msg),
      logAlways: (msg: string) => tui.logAlways(msg),
      logEvent: (msg: string) => tui.logEvent(msg),
      getState: () => tui.state,
      loadState: () => tui.loadState(),
      getDefaultAgent: () => tui.defaultAgent,
      setDefaultAgent: (name: string) => { tui.defaultAgent = name; },
      setProcessing: (active: boolean, label?: string) => {
        tui.processing = active;
        if (active) {
          tui.processingStart = Date.now();
          tui.processingLabel = label ?? "";
        } else {
          tui.processingStart = 0;
          tui.processingLabel = "";
          tui.processingDetail = "";
        }
        tui.updateInputDisplay();
      },
      setProcessingDetail: (detail: string) => {
        tui.processingDetail = detail;
        tui.updateInputDisplay();
      },
      getInputMode: () => tui.inputMode,
      setInputMode: (mode) => { tui.inputMode = mode; },
    };
  }
}

// ─── Entry Point ─────────────────────────────────────────

async function main() {
  const workDir = process.argv[2] || ".";
  const tui = new OrchestraTUI(workDir);
  await tui.start();
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
