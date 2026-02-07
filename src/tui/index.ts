#!/usr/bin/env node

import blessed from "blessed";
import { resolve } from "node:path";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { Orchestrator } from "../orchestrator.js";
import type { OrchestraState, TaskStatus, Team } from "../core/types.js";

// Register adapters
import "../adapters/claude-sdk.js";
import "../adapters/generic.js";

// ─── Constants ───────────────────────────────────────────

const NOTES = ["♩", "♪", "♫", "♬"];

const LOGO_LINES = [
  "    ♪  ╔═══════════════════════════════════╗  ♪",
  "   ♫  ║                                   ║  ♫",
  "       ║   ♩ O R C H E S T R A ♩          ║",
  "       ║                                   ║",
  "       ║   AI Agent Orchestration Framework ║",
  "   ♫  ║                                   ║  ♫",
  "    ♪  ╚═══════════════════════════════════╝  ♪",
];

interface ProviderOption {
  label: string;
  value: string;
  available: boolean;
}

const PROVIDERS: ProviderOption[] = [
  { label: "Claude Code", value: "claude-sdk", available: true },
  { label: "OpenCode", value: "opencode", available: false },
  { label: "OpenClaw", value: "openclaw", available: false },
  { label: "AI SDK Vercel", value: "ai-sdk-vercel", available: false },
];

interface ModelOption {
  label: string;
  value: string;
  adapter: string; // which adapter this model belongs to
}

const MODELS: ModelOption[] = [
  { label: "Claude Sonnet 4.5", value: "claude-sonnet-4-5-20250929", adapter: "claude-sdk" },
  { label: "Claude Opus 4.6", value: "claude-opus-4-6", adapter: "claude-sdk" },
  { label: "Claude Haiku 4.5", value: "claude-haiku-4-5-20251001", adapter: "claude-sdk" },
];

const SLASH_COMMANDS: Record<string, string> = {
  "/status": "Detailed task status",
  "/result": "Show last task result",
  "/inspect": "Browse tasks & plans",
  "/edit-plan": "Edit a running plan",
  "/reassess": "Re-run assessment on task",
  "/team": "Show / manage team",
  "/abort": "Abort running plan/task",
  "/clear-tasks": "Clear finished tasks",
  "/tasks": "Browse tasks & plans",
  "/clear": "Clear log",
  "/config": "Show configuration",
  "/help": "Commands & shortcuts",
  "/quit": "Exit Orchestra",
};

const SHORTCUTS: Record<string, string> = {
  "Alt+T": "Toggle Direct/Plan mode",
  "Ctrl+O": "Toggle task panel",
  "Ctrl+L": "Toggle verbose log",
  "Ctrl+C": "Quit",
  "Enter": "Submit",
  "Escape": "Clear input",
};

// ─── Skill Discovery ─────────────────────────────────────

interface SkillInfo {
  name: string;
  description: string;
  allowedTools?: string[];
}

/** Scan .claude/skills/ directories for available SKILL.md files */
function discoverSkills(cwd: string): SkillInfo[] {
  const skills: SkillInfo[] = [];
  const dirs = [
    resolve(cwd, ".claude", "skills"),
    resolve(process.env.HOME ?? "", ".claude", "skills"),
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillPath = resolve(dir, entry.name, "SKILL.md");
        if (!existsSync(skillPath)) continue;

        try {
          const content = readFileSync(skillPath, "utf-8");
          const info = parseSkillFrontmatter(content);
          if (info && !skills.find(s => s.name === info.name)) {
            skills.push(info);
          }
        } catch { /* skip unreadable */ }
      }
    } catch { /* skip unreadable dirs */ }
  }
  return skills;
}

/** Parse SKILL.md YAML frontmatter */
function parseSkillFrontmatter(content: string): SkillInfo | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  try {
    const fm = parseYaml(match[1]);
    if (!fm?.name) return null;
    return {
      name: fm.name,
      description: fm.description ?? "",
      allowedTools: fm["allowed-tools"],
    };
  } catch { return null; }
}

/** Format milliseconds as human-readable elapsed time */
function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

// ─── TUI Application ────────────────────────────────────

interface TUIConfig {
  judge: string;
  agent: string;
  model: string;
}

export class OrchestraTUI {
  private screen!: blessed.Widgets.Screen;
  private config: TUIConfig = { judge: "claude-sdk", agent: "claude-sdk", model: "claude-sonnet-4-5-20250929" };

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
  private workDir: string;
  private statePath: string;
  private inputMode: "task" | "plan" | "chat" = "task";
  private processing = false;
  private processingStart = 0;
  private processingLabel = "";
  private processingDetail = "";
  private planCounter = 0;
  private overlayActive = false;
  private menuType: "command" | "agent" | null = null;
  private menuJustClosed = false;
  private verboseLog = false;
  private fullLogLines: string[] = [];
  private eventLogLines: string[] = [];

  constructor(workDir: string = ".") {
    this.workDir = resolve(workDir);
    this.statePath = resolve(this.workDir, ".orchestra", "state.json");
  }

  private inputBuffer = "";

  async start(): Promise<void> {
    this.createScreen();
    await this.runWizard();
    this.initOrchestrator();
    this.buildMainUI();
    this.startPolling();
  }

  private initOrchestrator(): void {
    this.orchestrator = new Orchestrator(this.workDir);

    // Try to load team from orchestra.yml
    let team: Team;
    const ymlPath = resolve(this.workDir, "orchestra.yml");
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

    this.orchestrator.initInteractive("orchestra-interactive", team);

    // Intercept console.log to redirect to TUI
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => {
      const msg = args.map(a => String(a)).join(" ");
      const clean = this.stripAnsi(msg);
      this.log(clean);
      this.emitEvent(clean);
    };
    console.error = (...args: unknown[]) => {
      const msg = args.map(a => String(a)).join(" ");
      const clean = this.stripAnsi(msg);
      this.log(`{red-fg}${clean}{/red-fg}`);
      this.logEvent(`{red-fg}${clean}{/red-fg}`);
    };

    // Start the supervisor loop in background
    this.orchestrator.run().catch((err: Error) => {
      this.log(`{red-fg}Supervisor error: ${err.message}{/red-fg}`);
    }).finally(() => {
      console.log = originalLog;
      console.error = originalError;
    });
  }

  private createScreen(): void {
    this.screen = blessed.screen({
      smartCSR: true,
      title: "Orchestra",
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
      const wizardBox = blessed.box({
        parent: this.screen,
        top: "center",
        left: "center",
        width: 60,
        height: 24,
        tags: true,
        style: { bg: "black" },
      });

      // Logo
      const logoText = LOGO_LINES.map(l =>
        l.replace(/[♪♫♩♬]/g, m => `{yellow-fg}${m}{/yellow-fg}`)
          .replace(/[╔╗╚╝║═]/g, m => `{bold}${m}{/bold}`)
          .replace(/O R C H E S T R A/g, `{bold}{white-fg}O R C H E S T R A{/white-fg}{/bold}`)
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
      const selections = { judge: "claude-sdk", agent: "claude-sdk", model: "claude-sonnet-4-5-20250929" };

      const stepLabel = blessed.box({
        parent: wizardBox,
        top: 9,
        left: 2,
        width: 56,
        height: 1,
        content: "",
        tags: true,
        style: { bg: "black" },
      });

      const selectionList = blessed.list({
        parent: wizardBox,
        top: 11,
        left: 2,
        width: 54,
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
        keys: true,
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

      const showStep = (s: number) => {
        if (s === 0) {
          stepLabel.setContent(`{bold}Step 1/3 — Select Judge{/bold} {grey-fg}(who evaluates task results){/grey-fg}`);
          selectionList.setItems(providerItems);
          selectionList.height = PROVIDERS.length + 2;
        } else if (s === 1) {
          stepLabel.setContent(`{bold}Step 2/3 — Select Agent{/bold} {grey-fg}(who executes tasks){/grey-fg}`);
          selectionList.setItems(providerItems);
          selectionList.height = PROVIDERS.length + 2;
        } else if (s === 2) {
          const available = MODELS.filter(m => m.adapter === selections.agent);
          stepLabel.setContent(`{bold}Step 3/3 — Select Model{/bold} {grey-fg}(for ${this.getProviderLabel(selections.agent)}){/grey-fg}`);
          const modelItems = available.map(m => `  {green-fg}●{/green-fg} ${m.label} {grey-fg}${m.value}{/grey-fg}`);
          selectionList.setItems(modelItems);
          selectionList.height = available.length + 2;
        }
        selectionList.select(0);
        this.screen.render();
      };

      showStep(0);
      selectionList.focus();

      let initReady = false;
      setImmediate(() => { initReady = true; });
      selectionList.on("select", (_item: blessed.Widgets.BlessedElement, index: number) => {
        if (!initReady) return;
        if (step === 0 || step === 1) {
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
            step = 1;
            showStep(1);
          } else {
            selections.agent = provider.value;
            const available = MODELS.filter(m => m.adapter === selections.agent);
            if (available.length > 0) {
              step = 2;
              showStep(2);
            } else {
              // No model selection needed for this adapter
              selections.model = "";
              this.config = selections;
              wizardBox.destroy();
              this.screen.render();
              resolvePromise();
            }
          }
        } else if (step === 2) {
          // Model selection
          const available = MODELS.filter(m => m.adapter === selections.agent);
          const model = available[index];
          if (model) {
            selections.model = model.value;
          }
          this.config = selections;
          wizardBox.destroy();
          this.screen.render();
          resolvePromise();
        }
      });
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
      width: this.taskPanelVisible ? "75%" : "100%",
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
      width: "25%",
      height: "100%-4",
      border: { type: "line" },
      tags: true,
      label: " {yellow-fg}♩{/yellow-fg} {bold}Tasks{/bold} ",
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
      width: 42,
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
      keys: true,
      vi: false,
      mouse: true,
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

        // "@" at start → open agent menu
        if (this.inputBuffer === "@") {
          this.openMentionMenu();
        }
      }
    });

    // Welcome message
    const team = this.orchestrator.getTeam();
    const modelLabel = this.config.model
      ? MODELS.find(m => m.value === this.config.model)?.label ?? this.config.model
      : "";
    this.log("{yellow-fg}♩{/yellow-fg} Welcome to {bold}Orchestra{/bold}");
    this.log("");
    this.log(`  Judge:  {green-fg}${this.getProviderLabel(this.config.judge)}{/green-fg}`);
    this.log(`  Agent:  {green-fg}${this.getProviderLabel(this.config.agent)}{/green-fg}` + (modelLabel ? ` {grey-fg}(${modelLabel}){/grey-fg}` : ""));
    this.log(`  Team:   {green-fg}${team.name}{/green-fg} (${team.agents.map(a => a.name).join(", ")})`);
    this.log("");
    this.log("Type a task description and press Enter to run it.");
    this.log("{grey-fg}Use {bold}@agent{/bold} to assign, {bold}/team{/bold} to manage, {bold}/config{/bold} to configure, {bold}/help{/bold} for commands{/grey-fg}");
    this.log("");

    // Clean welcome event
    this.logEvent("{yellow-fg}♩{/yellow-fg} {bold}Orchestra{/bold}");
    this.logEvent("");
    this.logEvent(`  Team {green-fg}${team.name}{/green-fg} — ${team.agents.map(a => a.name).join(", ")}`);
    this.logEvent("");
    this.logEvent("{grey-fg}Ctrl+L for verbose log{/grey-fg}");
    this.logEvent("");

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
      this.handlePlanInput(trimmed);
    } else if (this.inputMode === "chat") {
      this.handleChatInput(trimmed);
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

    this.logAlways(`{cyan-fg}>{/cyan-fg} ${input}`);
    this.logAlways("");

    try {
      const task = this.orchestrator.addTask({
        title: description.length > 60 ? description.slice(0, 57) + "..." : description,
        description,
        assignTo,
        group,
      });
      const groupInfo = group ? ` {cyan-fg}[${group}]{/cyan-fg}` : "";
      this.logAlways(`{green-fg}Task created:{/green-fg} ${task.title} {grey-fg}[${task.id}] → ${assignTo}{/grey-fg}${groupInfo}`);
      this.logAlways("{grey-fg}Agent will pick it up shortly...{/grey-fg}");
      this.logAlways("");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logAlways(`{red-fg}Failed to create task: ${msg}{/red-fg}`);
    }
  }

  private handleSlashCommand(cmd: string): void {
    const parts = cmd.split(/\s+/);
    const command = parts[0].toLowerCase();

    switch (command) {
      case "/status":
        this.cmdStatus();
        break;
      case "/result":
        this.cmdResult();
        break;
      case "/team":
        this.cmdTeam(parts.slice(1));
        break;
      case "/inspect":
        this.cmdInspect();
        break;
      case "/edit-plan":
        this.cmdEditPlan();
        break;
      case "/reassess":
        this.cmdReassess();
        break;
      case "/abort":
        this.cmdAbort();
        break;
      case "/clear-tasks":
        this.cmdClearTasks();
        break;
      case "/tasks":
        this.cmdTaskBrowser();
        break;
      case "/clear":
        this.clearLog();
        break;
      case "/config":
        this.cmdConfig();
        break;
      case "/help":
        this.cmdHelp();
        break;
      case "/quit":
      case "/exit":
        this.quit();
        break;
      default:
        this.logAlways(`{red-fg}Unknown command: ${command}{/red-fg}`);
        this.logAlways("{grey-fg}Type / to see available commands{/grey-fg}");
    }
  }

  private cmdStatus(): void {
    this.loadState();
    if (!this.state || this.state.tasks.length === 0) {
      this.logAlways("{grey-fg}No tasks found{/grey-fg}");
      return;
    }

    this.logAlways("");
    this.logAlways("{bold}Task Status:{/bold}");
    for (const task of this.state.tasks) {
      const icon = this.getStatusIcon(task.status);
      const label = this.getStatusLabel(task.status);
      const dur = task.result ? ` (${(task.result.duration / 1000).toFixed(1)}s)` : "";
      const score = task.result?.assessment?.globalScore !== undefined
        ? ` [{bold}${task.result.assessment.globalScore.toFixed(1)}/5{/bold}]`
        : "";
      this.logAlways(`  ${icon} ${label} ${task.title}${dur}${score}`);

      // Show dimension scores
      if (task.result?.assessment?.scores) {
        for (const s of task.result.assessment.scores) {
          const stars = "★".repeat(s.score) + "☆".repeat(5 - s.score);
          const color = s.score >= 4 ? "green" : s.score >= 3 ? "yellow" : "red";
          this.logAlways(`    {${color}-fg}${stars}{/${color}-fg} ${s.dimension}`);
        }
      }
    }
    this.logAlways("");
  }

  private cmdResult(): void {
    this.loadState();
    if (!this.state || this.state.tasks.length === 0) {
      this.logAlways("{grey-fg}No tasks found{/grey-fg}");
      return;
    }

    // Find the last completed (or failed) task with a result
    const withResult = [...this.state.tasks]
      .filter(t => t.result)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    if (withResult.length === 0) {
      this.logAlways("{grey-fg}No task results yet{/grey-fg}");
      return;
    }

    const task = withResult[0];
    const r = task.result!;

    this.logAlways("");
    this.logAlways(`{bold}Result: ${task.title}{/bold} {grey-fg}[${task.id}]{/grey-fg}`);
    this.logAlways(`{grey-fg}Status: ${task.status} | Duration: ${(r.duration / 1000).toFixed(1)}s | Exit: ${r.exitCode}{/grey-fg}`);

    if (r.assessment?.globalScore !== undefined) {
      const color = r.assessment.globalScore >= 4 ? "green" : r.assessment.globalScore >= 3 ? "yellow" : "red";
      this.logAlways(`{${color}-fg}Score: ${r.assessment.globalScore.toFixed(1)}/5{/${color}-fg}`);
      if (r.assessment.scores) {
        for (const s of r.assessment.scores) {
          const sc = s.score >= 4 ? "green" : s.score >= 3 ? "yellow" : "red";
          const stars = "★".repeat(s.score) + "☆".repeat(5 - s.score);
          this.logAlways(`  {${sc}-fg}${stars}{/${sc}-fg} ${s.dimension}`);
        }
      }
    }

    this.logAlways("");
    if (r.stdout) {
      // Show full output, line by line
      const lines = r.stdout.split("\n");
      for (const line of lines) {
        this.logAlways(`  ${line}`);
      }
    }
    this.logAlways("");
  }

  private cmdConfig(): void {
    this.showConfigMenu();
  }

  private showConfigMenu(): void {
    this.overlayActive = true;
    const overlay = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      style: { bg: "black" },
    });

    const modelLabel = this.config.model
      ? MODELS.find(m => m.value === this.config.model)?.label ?? this.config.model
      : "default";

    const configItems = [
      `  {cyan-fg}Judge{/cyan-fg}      ${this.getProviderLabel(this.config.judge)}`,
      `  {cyan-fg}Agent{/cyan-fg}      ${this.getProviderLabel(this.config.agent)}`,
      `  {cyan-fg}Model{/cyan-fg}      ${modelLabel}`,
    ];

    const configBox = blessed.list({
      parent: overlay,
      top: "center",
      left: "center",
      width: 50,
      height: configItems.length + 2,
      items: configItems,
      tags: true,
      border: { type: "line" },
      label: " {yellow-fg}♩{/yellow-fg} {bold}Configuration{/bold} ",
      style: {
        bg: "black",
        border: { fg: "cyan" },
        selected: { bg: "blue", fg: "white", bold: true },
        item: { bg: "black" },
      },
      keys: true,
      vi: false,
      mouse: true,
    });

    blessed.box({
      parent: overlay,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      content: " {cyan-fg}Enter{/cyan-fg} {grey-fg}change{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}close{/grey-fg}",
      style: { bg: "black", fg: "grey" },
    });

    configBox.select(0);
    configBox.focus();
    this.scheduleRender();

    const cleanup = () => {
      this.overlayActive = false;
      overlay.destroy();
      this.scheduleRender();
    };

    let cfgReady = false;
    setImmediate(() => { cfgReady = true; });
    configBox.on("select", (_item: any, index: number) => {
      if (!cfgReady) return;
      if (index === 0) {
        // Change judge
        this.showConfigPicker(overlay, "Select Judge", PROVIDERS, (value) => {
          this.config.judge = value;
          cleanup();
          this.log(`{green-fg}Judge changed to ${this.getProviderLabel(value)}{/green-fg}`);
        }, cleanup);
      } else if (index === 1) {
        // Change agent
        this.showConfigPicker(overlay, "Select Agent", PROVIDERS, (value) => {
          this.config.agent = value;
          // Update all existing agents' adapter
          const team = this.orchestrator.getTeam();
          for (const a of team.agents) {
            a.adapter = value;
          }
          cleanup();
          this.log(`{green-fg}Agent changed to ${this.getProviderLabel(value)}{/green-fg}`);
          // Check if model is still valid
          const validModels = MODELS.filter(m => m.adapter === value);
          if (validModels.length > 0 && !validModels.find(m => m.value === this.config.model)) {
            this.config.model = validModels[0].value;
            this.log(`{yellow-fg}Model auto-set to ${validModels[0].label}{/yellow-fg}`);
          }
        }, cleanup);
      } else if (index === 2) {
        // Change model
        const available = MODELS.filter(m => m.adapter === this.config.agent);
        if (available.length === 0) {
          cleanup();
          this.log("{yellow-fg}No model selection for this adapter{/yellow-fg}");
          return;
        }
        const modelProviders = available.map(m => ({
          label: `${m.label} {grey-fg}${m.value}{/grey-fg}`,
          value: m.value,
          available: true,
        }));
        this.showConfigPicker(overlay, "Select Model", modelProviders, (value) => {
          this.config.model = value;
          // Update all agents' model
          const team = this.orchestrator.getTeam();
          for (const a of team.agents) {
            a.model = value;
          }
          const label = MODELS.find(m => m.value === value)?.label ?? value;
          cleanup();
          this.log(`{green-fg}Model changed to ${label}{/green-fg}`);
        }, cleanup);
      }
    });

    configBox.on("cancel", cleanup);
  }

  /** Show a picker sub-menu inside the config overlay */
  private showConfigPicker(
    parent: blessed.Widgets.BoxElement | blessed.Widgets.Screen,
    title: string,
    options: ProviderOption[],
    onSelect: (value: string) => void,
    onCancel: () => void,
  ): void {
    const items = options.map(p => {
      if (p.available) return `  {green-fg}●{/green-fg} ${p.label}`;
      return `  {grey-fg}○ ${p.label}{/grey-fg}  {yellow-fg}coming soon{/yellow-fg}`;
    });

    // Always create a full-screen overlay for clean rendering
    const isStandalone = parent === this.screen;
    const overlay = isStandalone
      ? blessed.box({ parent: this.screen, top: 0, left: 0, width: "100%", height: "100%", style: { bg: "black" } })
      : null;
    const renderParent = overlay ?? parent;

    const picker = blessed.list({
      parent: renderParent,
      top: "center",
      left: "center",
      width: 50,
      height: items.length + 2,
      items,
      tags: true,
      border: { type: "line" },
      label: ` {bold}${title}{/bold} `,
      style: {
        bg: "black",
        border: { fg: "yellow" },
        selected: { bg: "blue", fg: "white", bold: true },
        item: { bg: "black" },
      },
      keys: false,
      vi: false,
      mouse: true,
    });

    if (overlay) {
      blessed.box({
        parent: overlay, bottom: 0, left: 0, width: "100%", height: 1,
        tags: true, content: " {cyan-fg}Enter{/cyan-fg} {grey-fg}select{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}",
        style: { bg: "black", fg: "grey" },
      });
    }

    picker.select(0);
    picker.focus();
    this.scheduleRender();

    const cleanup = () => {
      this.screen.removeListener("keypress", kh);
      if (overlay) {
        overlay.destroy();
      } else {
        picker.destroy();
      }
      this.scheduleRender();
    };

    const doSelect = (index: number) => {
      const opt = options[index];
      if (!opt.available) {
        (picker as any).setLabel(` {yellow-fg}Not available yet{/yellow-fg} `);
        this.screen.render();
        setTimeout(() => { (picker as any).setLabel(` {bold}${title}{/bold} `); this.screen.render(); }, 1200);
        return;
      }
      cleanup();
      onSelect(opt.value);
    };

    let pickerReady = false;
    setImmediate(() => { pickerReady = true; });
    picker.on("select", (_item: any, index: number) => { if (pickerReady) doSelect(index); });

    const kh = (_ch: string, key: any) => {
      if (!key) return;
      if (key.name === "escape") { cleanup(); onCancel(); return; }
      if (key.name === "up") { picker.up(1); this.scheduleRender(); return; }
      if (key.name === "down") { picker.down(1); this.scheduleRender(); return; }
      if (key.name === "return" || key.name === "enter") { doSelect((picker as any).selected ?? 0); }
    };
    this.screen.on("keypress", kh);
  }

  // ─── Inspect Session ───────────────────────────────────

  private cmdReassess(): void {
    this.loadState();
    const tasks = (this.state?.tasks ?? []).filter(t => t.status === "done" || t.status === "failed");
    if (tasks.length === 0) {
      this.logAlways("{yellow-fg}No done/failed tasks to reassess{/yellow-fg}");
      return;
    }

    this.overlayActive = true;
    const overlay = blessed.box({
      parent: this.screen, top: 0, left: 0, width: "100%", height: "100%",
      style: { bg: "black" },
    });

    const items = tasks.map(t => {
      const icon = t.status === "done" ? "{green-fg}✓{/green-fg}" : "{red-fg}✗{/red-fg}";
      const score = t.result?.assessment?.globalScore !== undefined
        ? ` {grey-fg}(${t.result.assessment.globalScore.toFixed(1)}/5){/grey-fg}`
        : "";
      return `  ${icon} ${t.title}${score}`;
    });

    const taskList = blessed.list({
      parent: overlay, top: "center", left: "center", width: 60,
      height: Math.min(items.length + 2, 16), items, tags: true,
      border: { type: "line" },
      label: " {yellow-fg}↻{/yellow-fg} {bold}Reassess Task{/bold} ",
      style: { bg: "black", border: { fg: "yellow" }, selected: { bg: "blue", fg: "white", bold: true }, item: { bg: "black" } },
      keys: false, vi: false, mouse: true,
    });

    blessed.box({
      parent: overlay, bottom: 0, left: 0, width: "100%", height: 1, tags: true,
      content: " {cyan-fg}Enter{/cyan-fg} {grey-fg}reassess{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}",
      style: { bg: "black", fg: "grey" },
    });

    taskList.select(0);
    this.scheduleRender();

    const cleanup = () => {
      this.overlayActive = false;
      this.screen.removeListener("keypress", keyHandler);
      overlay.destroy();
      this.scheduleRender();
    };

    const doReassess = (idx: number) => {
      if (idx < 0 || idx >= tasks.length) return;
      const task = tasks[idx];
      cleanup();
      this.logAlways(`{yellow-fg}↻{/yellow-fg} Reassessing: ${task.title}`);
      this.processing = true;
      this.processingStart = Date.now();
      this.processingLabel = "Reassessing";
      this.updateInputDisplay();
      this.orchestrator.reassessTask(task.id).then(() => {
        this.processing = false;
        this.processingStart = 0;
        this.updateInputDisplay();
      }).catch((err: Error) => {
        this.processing = false;
        this.processingStart = 0;
        this.updateInputDisplay();
        this.logAlways(`{red-fg}Reassess error: ${err.message}{/red-fg}`);
      });
    };

    let reassessReady = false;
    setImmediate(() => { reassessReady = true; });
    taskList.on("select", (_item: any, index: number) => {
      if (!reassessReady) return;
      doReassess(index);
    });

    const keyHandler = (_ch: string, key: any) => {
      if (!key) return;
      if (key.name === "escape") { cleanup(); return; }
      if (key.name === "up") { taskList.up(1); this.scheduleRender(); return; }
      if (key.name === "down") { taskList.down(1); this.scheduleRender(); return; }
      if (key.name === "return" || key.name === "enter") {
        doReassess((taskList as any).selected ?? 0);
        return;
      }
    };

    this.screen.on("keypress", keyHandler);
  }

  // ─── Task Browser (unified /tasks + /inspect) ─────────

  private cmdTaskBrowser(): void {
    this.loadState();
    const tasks = this.state?.tasks ?? [];
    if (tasks.length === 0) {
      this.log("{yellow-fg}No tasks{/yellow-fg}");
      return;
    }

    // Separate into groups and ungrouped
    const ungrouped: typeof tasks = [];
    const groups = new Map<string, typeof tasks>();
    for (const t of tasks) {
      if (t.group) {
        if (!groups.has(t.group)) groups.set(t.group, []);
        groups.get(t.group)!.push(t);
      } else {
        ungrouped.push(t);
      }
    }

    // Build top-level items: plans first, then ungrouped tasks
    type BrowserEntry = { type: "plan"; name: string; tasks: typeof tasks } | { type: "task"; task: typeof tasks[0] };
    const entries: BrowserEntry[] = [];
    for (const [name, gTasks] of groups) {
      entries.push({ type: "plan", name, tasks: gTasks });
    }
    for (const t of ungrouped) {
      entries.push({ type: "task", task: t });
    }

    if (entries.length === 0) {
      this.log("{yellow-fg}No tasks{/yellow-fg}");
      return;
    }

    this.showBrowserLevel1(entries);
  }

  /** Level 1: Plans + ungrouped tasks list */
  private showBrowserLevel1(entries: Array<{ type: "plan"; name: string; tasks: any[] } | { type: "task"; task: any }>): void {
    const items = entries.map(e => {
      if (e.type === "plan") {
        const done = e.tasks.filter((t: any) => t.status === "done").length;
        const failed = e.tasks.filter((t: any) => t.status === "failed").length;
        const total = e.tasks.length;
        const allTerminal = done + failed === total;
        const earliest = e.tasks.reduce((min: string, t: any) => t.createdAt < min ? t.createdAt : min, e.tasks[0].createdAt);
        const endTime = allTerminal
          ? e.tasks.reduce((max: string, t: any) => t.updatedAt > max ? t.updatedAt : max, e.tasks[0].updatedAt)
          : new Date().toISOString();
        const elapsed = formatElapsed(new Date(endTime).getTime() - new Date(earliest).getTime());
        const statusIcon = allTerminal
          ? (failed > 0 ? "{red-fg}✗{/red-fg}" : "{green-fg}✓{/green-fg}")
          : "{yellow-fg}●{/yellow-fg}";
        return `  ${statusIcon} {bold}${e.name}{/bold} {grey-fg}(${done}/${total}){/grey-fg} {grey-fg}${elapsed}{/grey-fg}`;
      } else {
        const icon = this.getStatusIcon(e.task.status);
        const score = e.task.result?.assessment?.globalScore !== undefined
          ? ` {grey-fg}${e.task.result.assessment.globalScore.toFixed(1)}/5{/grey-fg}`
          : "";
        return `  ${icon} ${e.task.title}${score}`;
      }
    });

    this.overlayActive = true;
    const overlay = blessed.box({ parent: this.screen, top: 0, left: 0, width: "100%", height: "100%", style: { bg: "black" } });
    const list = blessed.list({
      parent: overlay, top: 0, left: 0, width: "100%", height: "100%-1",
      items, tags: true, border: { type: "line" },
      label: " {bold}Tasks{/bold} ",
      style: { bg: "black", border: { fg: "cyan" }, selected: { bg: "blue", fg: "white", bold: true }, item: { bg: "black" } },
      keys: false, mouse: true,
    });
    blessed.box({
      parent: overlay, bottom: 0, left: 0, width: "100%", height: 1,
      tags: true, content: " {cyan-fg}Enter{/cyan-fg} {grey-fg}open{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}close{/grey-fg}",
      style: { bg: "black", fg: "grey" },
    });
    list.select(0);
    this.scheduleRender();

    const cleanup = () => { this.overlayActive = false; this.screen.removeListener("keypress", kh); overlay.destroy(); this.scheduleRender(); };
    const openEntry = (idx: number) => {
      const entry = entries[idx];
      if (!entry) return;
      cleanup();
      if (entry.type === "plan") {
        this.showBrowserPlan(entry.name, entry.tasks, entries);
      } else {
        this.showBrowserTaskDetail(entry.task, () => this.showBrowserLevel1(entries));
      }
    };

    let browseReady = false;
    setImmediate(() => { browseReady = true; });
    list.on("select", (_: any, idx: number) => { if (browseReady) openEntry(idx); });
    const kh = (_ch: string, key: any) => {
      if (!key) return;
      if (key.name === "escape") { cleanup(); return; }
      if (key.name === "up") { list.up(1); this.scheduleRender(); return; }
      if (key.name === "down") { list.down(1); this.scheduleRender(); return; }
      if (key.name === "return" || key.name === "enter") { openEntry((list as any).selected ?? 0); }
    };
    this.screen.on("keypress", kh);
  }

  /** Level 2: Tasks within a plan group */
  private showBrowserPlan(planName: string, planTasks: any[], parentEntries: any[]): void {
    const items = planTasks.map((t: any) => {
      const icon = this.getStatusIcon(t.status);
      const score = t.result?.assessment?.globalScore !== undefined
        ? ` {grey-fg}${t.result.assessment.globalScore.toFixed(1)}/5{/grey-fg}`
        : "";
      const agent = t.assignTo ? ` {grey-fg}→ ${t.assignTo}{/grey-fg}` : "";
      return `  ${icon} ${t.title}${agent}${score}`;
    });

    this.overlayActive = true;
    const overlay = blessed.box({ parent: this.screen, top: 0, left: 0, width: "100%", height: "100%", style: { bg: "black" } });
    const list = blessed.list({
      parent: overlay, top: 0, left: 0, width: "100%", height: "100%-1",
      items, tags: true, border: { type: "line" },
      label: ` {bold}${planName}{/bold} `,
      style: { bg: "black", border: { fg: "cyan" }, selected: { bg: "blue", fg: "white", bold: true }, item: { bg: "black" } },
      keys: false, mouse: true,
    });
    blessed.box({
      parent: overlay, bottom: 0, left: 0, width: "100%", height: 1,
      tags: true, content: " {cyan-fg}Enter{/cyan-fg} {grey-fg}inspect{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}back{/grey-fg}",
      style: { bg: "black", fg: "grey" },
    });
    list.select(0);
    this.scheduleRender();

    const cleanup = () => { this.overlayActive = false; this.screen.removeListener("keypress", kh); overlay.destroy(); this.scheduleRender(); };
    const openTask = (idx: number) => {
      const task = planTasks[idx];
      if (!task) return;
      cleanup();
      this.showBrowserTaskDetail(task, () => this.showBrowserPlan(planName, planTasks, parentEntries));
    };

    let planReady = false;
    setImmediate(() => { planReady = true; });
    list.on("select", (_: any, idx: number) => { if (planReady) openTask(idx); });
    const kh = (_ch: string, key: any) => {
      if (!key) return;
      if (key.name === "escape") { cleanup(); this.showBrowserLevel1(parentEntries); return; }
      if (key.name === "up") { list.up(1); this.scheduleRender(); return; }
      if (key.name === "down") { list.down(1); this.scheduleRender(); return; }
      if (key.name === "return" || key.name === "enter") { openTask((list as any).selected ?? 0); }
    };
    this.screen.on("keypress", kh);
  }

  /** Level 3: Task detail (reuses showTaskInspector content inline) */
  private showBrowserTaskDetail(task: any, goBack: () => void): void {
    import("../session-reader.js").then(({ readSessionSummary }) => {
      const proc = (this.state?.processes || []).find((p: any) => p.taskId === task.id);
      const sessionId = proc?.activity?.sessionId;

      const lines: string[] = [];
      lines.push(`{bold}${task.title}{/bold} {grey-fg}[${task.id}]{/grey-fg}`);
      const statusLabel = this.getStatusLabel(task.status);
      lines.push(`Status: ${statusLabel}  Agent: {cyan-fg}${task.assignTo}{/cyan-fg}  Retries: ${task.retries}/${task.maxRetries}`);
      if (task.group) lines.push(`Plan: {cyan-fg}${task.group}{/cyan-fg}`);
      lines.push("");

      if (task.description && task.description !== task.title) {
        lines.push(`{cyan-fg}Description:{/cyan-fg}`);
        lines.push(`  ${task.description.slice(0, 500)}`);
        lines.push("");
      }

      // Activity info
      if (proc?.activity) {
        const act = proc.activity;
        lines.push(`{cyan-fg}Activity:{/cyan-fg}`);
        lines.push(`  Tool calls: ${act.toolCalls}`);
        if (act.filesCreated?.length > 0) lines.push(`  {green-fg}Created:{/green-fg} ${act.filesCreated.join(", ")}`);
        if (act.filesEdited?.length > 0) lines.push(`  {yellow-fg}Edited:{/yellow-fg} ${act.filesEdited.join(", ")}`);
        if (act.lastTool) lines.push(`  Last tool: ${act.lastTool}`);
        if (act.summary) lines.push(`  Summary: ${act.summary.slice(0, 200)}`);
        lines.push("");
      }

      // SDK session details
      if (sessionId) {
        const summary = readSessionSummary(sessionId, this.workDir);
        if (summary) {
          lines.push(`{cyan-fg}Session:{/cyan-fg} {grey-fg}${sessionId}{/grey-fg}`);
          lines.push(`  Messages: ${summary.messageCount}`);
          if (summary.filesCreated.length > 0) {
            lines.push(`  {green-fg}Files created:{/green-fg}`);
            for (const f of summary.filesCreated.slice(0, 10)) lines.push(`    ${f}`);
          }
          if (summary.filesEdited.length > 0) {
            lines.push(`  {yellow-fg}Files edited:{/yellow-fg}`);
            for (const f of summary.filesEdited.slice(0, 10)) lines.push(`    ${f}`);
          }
          if (summary.todos.length > 0) {
            lines.push(`  {magenta-fg}TODOs:{/magenta-fg}`);
            for (const t of summary.todos.slice(0, 5)) lines.push(`    ${t}`);
          }
          if (summary.errors.length > 0) {
            lines.push(`  {red-fg}Errors:{/red-fg}`);
            for (const e of summary.errors.slice(0, 3)) lines.push(`    ${e}`);
          }
          if (summary.lastMessage) {
            lines.push(`  {grey-fg}Last message:{/grey-fg}`);
            lines.push(`    ${summary.lastMessage.slice(0, 300)}`);
          }
          lines.push("");
        }
      }

      // Task result
      if (task.result) {
        lines.push(`{cyan-fg}Result:{/cyan-fg}`);
        lines.push(`  Exit: ${task.result.exitCode} | Duration: ${(task.result.duration / 1000).toFixed(1)}s`);
        if (task.result.assessment?.globalScore !== undefined) {
          const gs = task.result.assessment.globalScore;
          const color = gs >= 4 ? "green" : gs >= 3 ? "yellow" : "red";
          lines.push(`  {${color}-fg}Score: ${gs.toFixed(1)}/5{/${color}-fg}`);
          if (task.result.assessment.scores) {
            for (const s of task.result.assessment.scores) {
              const sc = s.score >= 4 ? "green" : s.score >= 3 ? "yellow" : "red";
              const stars = "★".repeat(s.score) + "☆".repeat(5 - s.score);
              lines.push(`    {${sc}-fg}${stars}{/${sc}-fg} ${s.dimension} — ${s.reasoning.slice(0, 100)}`);
            }
          }
        }
        if (task.result.stdout) {
          lines.push(`  {grey-fg}Output:{/grey-fg}`);
          lines.push(`    ${task.result.stdout.slice(0, 500)}`);
        }
        if (task.result.stderr) {
          lines.push(`  {red-fg}Stderr:{/red-fg}`);
          lines.push(`    ${task.result.stderr.slice(0, 300)}`);
        }
      }

      this.overlayActive = true;
      const overlay = blessed.box({ parent: this.screen, top: 0, left: 0, width: "100%", height: "100%", style: { bg: "black" } });
      const content = blessed.box({
        parent: overlay, top: 0, left: 0, width: "100%", height: "100%-1",
        content: lines.join("\n"), tags: true, border: { type: "line" },
        label: ` {bold}${task.title}{/bold} `,
        scrollable: true, keys: false, mouse: true,
        style: { bg: "black", border: { fg: "cyan" } },
      });
      blessed.box({
        parent: overlay, bottom: 0, left: 0, width: "100%", height: 1,
        tags: true, content: " {cyan-fg}↑↓{/cyan-fg} {grey-fg}scroll{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}back{/grey-fg}",
        style: { bg: "black", fg: "grey" },
      });
      content.focus();
      this.scheduleRender();

      const cleanup = () => { this.overlayActive = false; this.screen.removeListener("keypress", detailKh); overlay.destroy(); this.scheduleRender(); };
      const detailKh = (_ch: string, key: any) => {
        if (!key) return;
        if (key.name === "escape" || key.name === "q") { cleanup(); goBack(); return; }
        if (key.name === "up") { content.scroll(-1); this.scheduleRender(); return; }
        if (key.name === "down") { content.scroll(1); this.scheduleRender(); return; }
      };
      this.screen.on("keypress", detailKh);
    });
  }

  private cmdInspect(): void {
    this.cmdTaskBrowser();
  }

  // ─── Edit Plan ──────────────────────────────────────

  private cmdEditPlan(): void {
    this.loadState();
    const tasks = this.state?.tasks ?? [];
    const groups = new Map<string, typeof tasks>();
    for (const t of tasks) {
      if (t.group) {
        if (!groups.has(t.group)) groups.set(t.group, []);
        groups.get(t.group)!.push(t);
      }
    }

    // Only show groups that have non-terminal tasks
    const editableGroups = [...groups.entries()].filter(([, g]) =>
      g.some(t => t.status !== "done" && t.status !== "failed")
    );

    if (editableGroups.length === 0) {
      this.log("{yellow-fg}No active plans to edit{/yellow-fg}");
      return;
    }

    if (editableGroups.length === 1) {
      this.showPlanEditor(editableGroups[0][0], editableGroups[0][1]);
      return;
    }

    // Pick a group
    const items = editableGroups.map(([name, g]) => {
      const done = g.filter(t => t.status === "done").length;
      return `  {cyan-fg}${name}{/cyan-fg} {grey-fg}(${done}/${g.length} done){/grey-fg}`;
    });

    this.overlayActive = true;
    const overlay = blessed.box({ parent: this.screen, top: 0, left: 0, width: "100%", height: "100%", style: { bg: "black" } });
    const list = blessed.list({
      parent: overlay, top: "center", left: "center", width: "50%", height: Math.min(items.length + 2, 12),
      items, tags: true, border: { type: "line" },
      label: " {bold}Edit Plan{/bold} ",
      style: { bg: "black", border: { fg: "yellow" }, selected: { bg: "blue", fg: "white", bold: true }, item: { bg: "black" } },
      keys: false, mouse: true,
    });
    list.select(0);
    this.scheduleRender();

    const cleanup = () => { this.overlayActive = false; this.screen.removeListener("keypress", kh); overlay.destroy(); this.scheduleRender(); };
    const selectGroup = (idx: number) => {
      const [name, g] = editableGroups[idx];
      cleanup();
      this.showPlanEditor(name, g);
    };
    let editPlanReady = false;
    setImmediate(() => { editPlanReady = true; });
    list.on("select", (_: any, idx: number) => { if (editPlanReady) selectGroup(idx); });
    const kh = (_ch: string, key: any) => {
      if (!key) return;
      if (key.name === "escape") { cleanup(); return; }
      if (key.name === "up") { list.up(1); this.scheduleRender(); return; }
      if (key.name === "down") { list.down(1); this.scheduleRender(); return; }
      if (key.name === "return" || key.name === "enter") { selectGroup((list as any).selected ?? 0); }
    };
    this.screen.on("keypress", kh);
  }

  /**
   * Interactive plan editor for a running plan group.
   * Shows tasks with status, allows: remove pending tasks, add new tasks,
   * change assignment, change priority/order.
   */
  private showPlanEditor(groupName: string, groupTasks: any[]): void {
    this.overlayActive = true;
    const overlay = blessed.box({ parent: this.screen, top: 0, left: 0, width: "100%", height: "100%", style: { bg: "black" } });

    const buildItems = () => {
      const items: string[] = [];
      for (const t of groupTasks) {
        const icon = this.getStatusIcon(t.status);
        const agent = `{cyan-fg}→ ${t.assignTo}{/cyan-fg}`;
        const editable = t.status === "pending" || t.status === "failed";
        const editMark = editable ? "" : " {grey-fg}(locked){/grey-fg}";
        items.push(`  ${icon} ${t.title.slice(0, 30)} ${agent}${editMark}`);
      }
      items.push("  {green-fg}+{/green-fg} Add task to plan");
      return items;
    };

    const taskList = blessed.list({
      parent: overlay, top: 0, left: 0, width: "100%", height: "100%-5",
      items: buildItems(), tags: true, border: { type: "line" },
      label: ` {yellow-fg}✎{/yellow-fg} {bold}Edit: ${groupName}{/bold} `,
      style: { bg: "black", border: { fg: "yellow" }, selected: { bg: "blue", fg: "white", bold: true }, item: { bg: "black" } },
      keys: false, mouse: true, scrollable: true,
    });

    blessed.box({
      parent: overlay, bottom: 0, left: 0, width: "100%", height: 1,
      tags: true,
      content: " {cyan-fg}Enter{/cyan-fg} {grey-fg}edit{/grey-fg}  {cyan-fg}d{/cyan-fg} {grey-fg}remove{/grey-fg}  {cyan-fg}a{/cyan-fg} {grey-fg}reassign{/grey-fg}  {cyan-fg}r{/cyan-fg} {grey-fg}retry{/grey-fg}  {cyan-fg}Esc{/cyan-fg} {grey-fg}close{/grey-fg}",
      style: { bg: "black", fg: "grey" },
    });

    taskList.select(0);
    this.scheduleRender();

    const refreshList = () => { taskList.setItems(buildItems()); this.scheduleRender(); };
    const cleanup = () => { this.overlayActive = false; this.screen.removeListener("keypress", kh); overlay.destroy(); this.scheduleRender(); };

    const kh = (_ch: string, key: any) => {
      if (!key) return;
      const idx = (taskList as any).selected ?? 0;
      const isAddRow = idx >= groupTasks.length;
      const task = groupTasks[idx];
      const editable = task && (task.status === "pending" || task.status === "failed");

      if (key.name === "escape") { cleanup(); return; }
      if (key.name === "up") { taskList.up(1); this.scheduleRender(); return; }
      if (key.name === "down") { taskList.down(1); this.scheduleRender(); return; }

      if (key.name === "return" || key.name === "enter") {
        if (isAddRow) {
          // Add a new task to this plan group
          cleanup();
          this.showTextInput("New task title", "", (title) => {
            if (title?.trim()) {
              this.showTextInput("Task description", "", (desc) => {
                const agents = this.orchestrator.getAgents();
                const defaultAgent = agents[0]?.name ?? "dev";
                this.orchestrator.addTask({
                  title: title.trim(),
                  description: desc?.trim() || title.trim(),
                  assignTo: defaultAgent,
                  expectations: [],
                  group: groupName,
                });
                this.log(`{green-fg}Task added to ${groupName}: ${title.trim()}{/green-fg}`);
                // Refresh by reopening
                this.loadState();
                const updated = (this.state?.tasks ?? []).filter((t: any) => t.group === groupName);
                this.showPlanEditor(groupName, updated);
              }, () => {
                this.loadState();
                const updated = (this.state?.tasks ?? []).filter((t: any) => t.group === groupName);
                this.showPlanEditor(groupName, updated);
              });
            } else {
              this.loadState();
              const updated = (this.state?.tasks ?? []).filter((t: any) => t.group === groupName);
              this.showPlanEditor(groupName, updated);
            }
          }, () => {
            this.loadState();
            const updated = (this.state?.tasks ?? []).filter((t: any) => t.group === groupName);
            this.showPlanEditor(groupName, updated);
          });
        } else if (editable) {
          // Edit task description
          cleanup();
          this.showTextInput(`Edit: ${task.title}`, task.description, (desc) => {
            if (desc?.trim()) {
              this.orchestrator.updateTaskDescription(task.id, desc.trim());
              this.log(`{green-fg}Task updated: ${task.title}{/green-fg}`);
            }
            this.loadState();
            const updated = (this.state?.tasks ?? []).filter((t: any) => t.group === groupName);
            this.showPlanEditor(groupName, updated);
          }, () => {
            this.loadState();
            const updated = (this.state?.tasks ?? []).filter((t: any) => t.group === groupName);
            this.showPlanEditor(groupName, updated);
          });
        }
        return;
      }

      // d = delete (only pending/failed)
      if (key.name === "d" && !isAddRow && editable) {
        this.orchestrator.killTask(task.id);
        this.orchestrator.clearTasks((t: any) => t.id === task.id);
        groupTasks.splice(idx, 1);
        this.log(`{red-fg}Removed from plan: ${task.title}{/red-fg}`);
        refreshList();
        return;
      }

      // a = reassign (only pending/failed)
      if (key.name === "a" && !isAddRow && editable) {
        const agents = this.orchestrator.getAgents();
        const agentOpts = agents.map(a => ({
          label: `${a.name} ${a.role ? `{grey-fg}(${a.role}){/grey-fg}` : ""}`,
          value: a.name,
          available: true,
        }));
        cleanup();
        this.showConfigPicker(this.screen as any, "Reassign to", agentOpts, (value) => {
          this.orchestrator.updateTaskAssignment(task.id, value);
          this.log(`{green-fg}${task.title} → ${value}{/green-fg}`);
          this.loadState();
          const updated = (this.state?.tasks ?? []).filter((t: any) => t.group === groupName);
          this.showPlanEditor(groupName, updated);
        }, () => {
          this.loadState();
          const updated = (this.state?.tasks ?? []).filter((t: any) => t.group === groupName);
          this.showPlanEditor(groupName, updated);
        });
        return;
      }

      // r = retry (only failed)
      if (key.name === "r" && !isAddRow && task?.status === "failed") {
        try {
          this.orchestrator.retryTask(task.id);
          this.log(`{yellow-fg}Retrying: ${task.title}{/yellow-fg}`);
        } catch (e: any) {
          this.log(`{red-fg}Cannot retry: ${e.message}{/red-fg}`);
        }
        this.loadState();
        const updated = (this.state?.tasks ?? []).filter((t: any) => t.group === groupName);
        cleanup();
        this.showPlanEditor(groupName, updated);
        return;
      }
    };

    let planEdReady = false;
    setImmediate(() => { planEdReady = true; });
    taskList.on("select", () => {
      if (planEdReady) kh("", { name: "return" });
    });

    this.screen.on("keypress", kh);
  }

  private cmdAbort(): void {
    this.loadState();
    if (!this.state || this.state.tasks.length === 0) {
      this.log("{grey-fg}No tasks to abort{/grey-fg}");
      return;
    }

    // Find active groups and standalone running tasks
    const running = this.state.tasks.filter(t =>
      ["pending", "assigned", "in_progress", "review"].includes(t.status)
    );

    if (running.length === 0) {
      this.log("{grey-fg}No running tasks{/grey-fg}");
      return;
    }

    // Build abort options: groups + individual ungrouped tasks
    const groups = new Map<string, typeof running>();
    const ungrouped: typeof running = [];
    for (const t of running) {
      if (t.group) {
        if (!groups.has(t.group)) groups.set(t.group, []);
        groups.get(t.group)!.push(t);
      } else {
        ungrouped.push(t);
      }
    }

    const options: { label: string; action: () => void }[] = [];

    for (const [groupName, tasks] of groups) {
      options.push({
        label: `  {red-fg}✗{/red-fg} Abort {bold}${groupName}{/bold} {grey-fg}(${tasks.length} tasks){/grey-fg}`,
        action: () => {
          const count = this.orchestrator.abortGroup(groupName);
          this.log(`{red-fg}Aborted ${count} tasks in ${groupName}{/red-fg}`);
        },
      });
    }

    for (const t of ungrouped) {
      options.push({
        label: `  {red-fg}✗{/red-fg} ${t.title.slice(0, 30)}`,
        action: () => {
          this.orchestrator.killTask(t.id);
          this.log(`{red-fg}Aborted: ${t.title}{/red-fg}`);
        },
      });
    }

    if (options.length === 1) {
      // Only one option, execute directly
      options[0].action();
      return;
    }

    // Show picker
    this.showAbortPicker(options);
  }

  private showAbortPicker(options: { label: string; action: () => void }[]): void {
    this.overlayActive = true;
    const overlay = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      style: { bg: "black" },
    });

    const items = options.map(o => o.label);
    items.push("  {grey-fg}Cancel{/grey-fg}");

    const list = blessed.list({
      parent: overlay,
      top: "center",
      left: "center",
      width: 50,
      height: items.length + 2,
      items,
      tags: true,
      border: { type: "line" },
      label: " {red-fg}✗{/red-fg} {bold}Abort{/bold} ",
      style: {
        bg: "black",
        border: { fg: "red" },
        selected: { bg: "red", fg: "white", bold: true },
        item: { bg: "black" },
      },
      keys: true,
      vi: false,
      mouse: true,
    });

    blessed.box({
      parent: overlay,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      content: " {cyan-fg}Enter{/cyan-fg} {grey-fg}confirm{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}",
      style: { bg: "black", fg: "grey" },
    });

    list.select(0);
    list.focus();
    this.scheduleRender();

    const cleanup = () => {
      this.overlayActive = false;
      overlay.destroy();
      this.scheduleRender();
    };

    let abortReady = false;
    setImmediate(() => { abortReady = true; });
    list.on("select", (_item: any, index: number) => {
      if (!abortReady) return;
      cleanup();
      if (index < options.length) {
        options[index].action();
      }
    });

    list.on("cancel", cleanup);
  }

  private cmdClearTasks(): void {
    this.loadState();
    if (!this.state || this.state.tasks.length === 0) {
      this.log("{grey-fg}No tasks to clear{/grey-fg}");
      return;
    }

    const done = this.state.tasks.filter(t => t.status === "done" || t.status === "failed");
    if (done.length === 0) {
      this.log("{grey-fg}No finished tasks to clear{/grey-fg}");
      return;
    }

    // Show options
    this.overlayActive = true;
    const overlay = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      style: { bg: "black" },
    });

    const items = [
      `  {green-fg}✓{/green-fg} Clear completed {grey-fg}(done){/grey-fg}`,
      `  {red-fg}✗{/red-fg} Clear failed`,
      `  {yellow-fg}●{/yellow-fg} Clear all finished {grey-fg}(done + failed){/grey-fg}`,
      `  {red-fg}!!{/red-fg} Clear ALL tasks {grey-fg}(kills running agents){/grey-fg}`,
      `  {grey-fg}Cancel{/grey-fg}`,
    ];

    const list = blessed.list({
      parent: overlay,
      top: "center",
      left: "center",
      width: 50,
      height: items.length + 2,
      items,
      tags: true,
      border: { type: "line" },
      label: " {bold}Clear Tasks{/bold} ",
      style: {
        bg: "black",
        border: { fg: "yellow" },
        selected: { bg: "blue", fg: "white", bold: true },
        item: { bg: "black" },
      },
      keys: true,
      vi: false,
      mouse: true,
    });

    blessed.box({
      parent: overlay,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      content: " {cyan-fg}Enter{/cyan-fg} {grey-fg}select{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}",
      style: { bg: "black", fg: "grey" },
    });

    list.select(0);
    list.focus();
    this.scheduleRender();

    const cleanup = () => {
      this.overlayActive = false;
      overlay.destroy();
      this.scheduleRender();
    };

    let clearReady = false;
    setImmediate(() => { clearReady = true; });
    list.on("select", (_item: any, index: number) => {
      if (!clearReady) return;
      cleanup();
      let count = 0;
      switch (index) {
        case 0: // Done only
          count = this.orchestrator.clearTasks(t => t.status === "done");
          this.log(`{green-fg}Cleared ${count} completed tasks{/green-fg}`);
          break;
        case 1: // Failed only
          count = this.orchestrator.clearTasks(t => t.status === "failed");
          this.log(`{green-fg}Cleared ${count} failed tasks{/green-fg}`);
          break;
        case 2: // Done + failed
          count = this.orchestrator.clearTasks(t => t.status === "done" || t.status === "failed");
          this.log(`{green-fg}Cleared ${count} finished tasks{/green-fg}`);
          break;
        case 3: // ALL
          count = this.orchestrator.clearTasks(() => true);
          this.log(`{red-fg}Cleared all ${count} tasks{/red-fg}`);
          break;
      }
    });

    list.on("cancel", cleanup);
  }

  private cmdHelp(): void {
    this.logAlways("");
    this.logAlways("{bold}Commands:{/bold}");
    for (const [cmd, desc] of Object.entries(SLASH_COMMANDS)) {
      this.logAlways(`  {cyan-fg}${cmd.padEnd(12)}{/cyan-fg} ${desc}`);
    }
    this.logAlways("");
    this.logAlways("{bold}Shortcuts:{/bold}");
    for (const [key, desc] of Object.entries(SHORTCUTS)) {
      this.logAlways(`  {cyan-fg}${key.padEnd(12)}{/cyan-fg} ${desc}`);
    }
    this.logAlways("");
  }

  // ─── Team Management ─────────────────────────────────

  private cmdTeam(_args: string[]): void {
    this.showTeamMenu();
  }

  private showTeamMenu(): void {
    this.overlayActive = true;
    const overlay = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      style: { bg: "black" },
    });

    const team = this.orchestrator.getTeam();

    const buildItems = () => {
      const items: string[] = [];
      const agents = this.orchestrator.getAgents();
      for (const a of agents) {
        const def = a.name === this.defaultAgent ? " {green-fg}★{/green-fg}" : "";
        const model = a.model ? ` {grey-fg}(${MODELS.find(m => m.value === a.model)?.label ?? a.model}){/grey-fg}` : "";
        const skillsBadge = a.skills?.length ? ` {yellow-fg}⚡${a.skills.length}{/yellow-fg}` : "";
        const sysPrompt = a.systemPrompt ? " {blue-fg}✎{/blue-fg}" : "";
        items.push(`  {cyan-fg}${a.name}{/cyan-fg}  ${a.adapter}  ${a.role || "-"}${model}${skillsBadge}${sysPrompt}${def}`);
      }
      items.push("  {green-fg}+{/green-fg} Add agent");
      items.push("  {magenta-fg}✦{/magenta-fg} Generate team with AI");
      return items;
    };

    const teamList = blessed.list({
      parent: overlay,
      top: "center",
      left: "center",
      width: "70%",
      height: 14,
      items: buildItems(),
      tags: true,
      border: { type: "line" },
      label: ` {yellow-fg}♩{/yellow-fg} {bold}Team: ${team.name}{/bold} `,
      style: {
        bg: "black",
        border: { fg: "cyan" },
        selected: { bg: "blue", fg: "white", bold: true },
        item: { bg: "black" },
      },
      keys: false, // manual key handling
      vi: false,
      mouse: true,
    });

    blessed.box({
      parent: overlay,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      content: " {cyan-fg}Enter{/cyan-fg} {grey-fg}edit{/grey-fg}  {cyan-fg}d{/cyan-fg} {grey-fg}delete{/grey-fg}  {cyan-fg}r{/cyan-fg} {grey-fg}rename{/grey-fg}  {cyan-fg}*{/cyan-fg} {grey-fg}default{/grey-fg}  {cyan-fg}a{/cyan-fg} {grey-fg}AI generate{/grey-fg}  {cyan-fg}Esc{/cyan-fg} {grey-fg}close{/grey-fg}",
      style: { bg: "black", fg: "grey" },
    });

    teamList.select(0);
    this.scheduleRender();

    const refreshList = () => {
      teamList.setItems(buildItems());
      this.scheduleRender();
    };

    const cleanup = () => {
      this.overlayActive = false;
      this.screen.removeListener("keypress", keyHandler);
      overlay.destroy();
      this.scheduleRender();
    };

    const handleSelect = (idx: number) => {
      const agents = this.orchestrator.getAgents();
      const isAIRow = idx === agents.length + 1;
      const isAddRow = idx >= agents.length;
      if (isAIRow) {
        cleanup();
        this.showAITeamGenerate();
      } else if (isAddRow) {
        cleanup();
        this.showAddAgentWizard();
      } else if (agents[idx]) {
        cleanup();
        this.showEditAgentMenu(agents[idx]);
      }
    };

    // Mouse click support (guarded — blessed fires "select" on .select(0))
    let ready = false;
    setImmediate(() => { ready = true; });
    teamList.on("select", (_item: any, index: number) => {
      if (!ready) return;
      handleSelect(index);
    });

    const keyHandler = (_ch: string, key: any) => {
      if (!key) return;
      if (!ready) return; // guard against Enter leak from /team command
      const agents = this.orchestrator.getAgents();
      const idx = (teamList as any).selected ?? 0;
      const isAddRow = idx >= agents.length;

      if (key.name === "escape") {
        cleanup();
        return;
      }

      if (key.name === "up") {
        teamList.up(1);
        this.scheduleRender();
        return;
      }
      if (key.name === "down") {
        teamList.down(1);
        this.scheduleRender();
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        handleSelect(idx);
        return;
      }

      // d = delete
      if (key.name === "d" && !isAddRow) {
        if (agents.length <= 1) {
          this.log("{yellow-fg}Cannot remove the last agent{/yellow-fg}");
          return;
        }
        const agent = agents[idx];
        this.orchestrator.removeAgent(agent.name);
        if (agent.name === this.defaultAgent) {
          const remaining = this.orchestrator.getAgents();
          this.defaultAgent = remaining[0]?.name ?? "dev";
        }
        this.log(`{red-fg}Agent "${agent.name}" removed{/red-fg}`);
        refreshList();
        return;
      }

      // r = rename
      if (key.name === "r" && !isAddRow) {
        const agent = agents[idx];
        cleanup();
        this.showTextInput(`Rename "${agent.name}"`, agent.name, (newName) => {
          if (newName && newName !== agent.name) {
            // Check no duplicate
            if (agents.find(a => a.name === newName && a !== agent)) {
              this.log(`{red-fg}Agent "${newName}" already exists{/red-fg}`);
            } else {
              const oldName = agent.name;
              agent.name = newName;
              if (this.defaultAgent === oldName) this.defaultAgent = newName;
              this.log(`{green-fg}Renamed: ${oldName} → ${newName}{/green-fg}`);
            }
          }
          this.showTeamMenu();
        }, () => this.showTeamMenu());
        return;
      }

      // * = set default
      if (_ch === "*" && !isAddRow) {
        this.defaultAgent = agents[idx].name;
        this.log(`{green-fg}Default agent: ${agents[idx].name}{/green-fg}`);
        refreshList();
        return;
      }

      // a = AI generate team
      if (key.name === "a") {
        cleanup();
        this.showAITeamGenerate();
        return;
      }
    };

    this.screen.on("keypress", keyHandler);
  }

  // ─── AI Team Generation ────────────────────────────────

  /** Show text input for describing the team, then generate with AI and preview */
  private showAITeamGenerate(): void {
    this.overlayActive = true;
    const overlay = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      style: { bg: "black" },
    });

    const promptBox = blessed.box({
      parent: overlay,
      top: "center",
      left: "center",
      width: "70%",
      height: 7,
      border: { type: "line" },
      tags: true,
      label: " {magenta-fg}✦{/magenta-fg} {bold}AI Team Generator{/bold} ",
      style: { bg: "black", fg: "white", border: { fg: "magenta" } },
    });

    const hintBox = blessed.box({
      parent: promptBox,
      top: 0,
      left: 1,
      width: "100%-4",
      height: 1,
      tags: true,
      content: "{grey-fg}Describe the team you need (e.g. \"a fullstack team for a React + Node project\"){/grey-fg}",
      style: { bg: "black" },
    });

    let inputBuffer = "";
    const cursor = "{white-fg}█{/white-fg}";

    const inputLine = blessed.box({
      parent: promptBox,
      top: 2,
      left: 1,
      width: "100%-4",
      height: 1,
      tags: true,
      content: ` ${cursor}`,
      style: { bg: "black" },
    });

    blessed.box({
      parent: overlay,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      content: " {cyan-fg}Enter{/cyan-fg} {grey-fg}generate{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}",
      style: { bg: "black", fg: "grey" },
    });

    this.scheduleRender();

    const cleanup = () => {
      this.overlayActive = false;
      this.screen.removeListener("keypress", keyHandler);
      overlay.destroy();
      this.scheduleRender();
    };

    const keyHandler = (ch: string, key: any) => {
      if (!key) return;

      if (key.name === "escape") {
        cleanup();
        this.showTeamMenu();
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        const description = inputBuffer.trim();
        if (!description) return;
        cleanup();
        this.generateAITeam(description);
        return;
      }

      if (key.name === "backspace") {
        inputBuffer = inputBuffer.slice(0, -1);
      } else if (ch && ch.length === 1 && !key.ctrl && !key.meta) {
        inputBuffer += ch;
      }

      if (inputBuffer.length > 0) {
        hintBox.hide();
      } else {
        hintBox.show();
      }
      inputLine.setContent(` ${inputBuffer}${cursor}`);
      this.scheduleRender();
    };

    this.screen.on("keypress", keyHandler);
  }

  /** Generate a team proposal via AI and show the preview */
  private async generateAITeam(description: string): Promise<void> {
    this.logAlways(`{magenta-fg}✦{/magenta-fg} ${description}`);
    this.logAlways("");
    this.processing = true;
    this.processingStart = Date.now();
    this.processingLabel = "Generating team";
    this.updateInputDisplay();

    try {
      const prompt = this.buildTeamGenPrompt(description);
      const resultText = await this.querySDK(prompt, ["Skill", "Bash"], (event) => {
        this.processingDetail = event.replace(/\{[^}]*\}/g, "").slice(0, 80);
        this.updateInputDisplay();
        this.logAlways(`  {grey-fg}${event}{/grey-fg}`);
      });
      this.processing = false;
      this.processingStart = 0;
      this.updateInputDisplay();

      const yaml = this.extractTeamYaml(resultText);
      if (!yaml?.trim()) {
        this.log("{red-fg}AI returned empty result{/red-fg}");
        return;
      }

      try {
        const doc = parseYaml(yaml);
        if (!doc?.team || !Array.isArray(doc.team) || doc.team.length === 0) {
          this.log("{red-fg}Invalid team: no agents found{/red-fg}");
          return;
        }
      } catch (parseErr: unknown) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        this.log(`{red-fg}Invalid YAML: ${msg}{/red-fg}`);
        return;
      }

      this.showTeamPreview(yaml, description);
    } catch (err: unknown) {
      this.processing = false;
      this.processingStart = 0;
      this.updateInputDisplay();
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`{red-fg}Team generation failed: ${msg}{/red-fg}`);
    }
  }

  /** Build the system prompt for AI team generation */
  private buildTeamGenPrompt(description: string): string {
    const currentTeam = this.orchestrator.getTeam();
    const alreadyInstalled = discoverSkills(this.workDir);
    const installedSection = alreadyInstalled.length > 0
      ? `Already installed skills: ${alreadyInstalled.map(s => s.name).join(", ")}`
      : `No skills currently installed.`;

    return [
      `You are Orchestra's team designer. Orchestra is an agent-agnostic framework for orchestrating teams of AI coding agents.`,
      ``,
      `## Your Role`,
      ``,
      `Design a team of specialized AI agents based on the user's description.`,
      `Each agent should have a clear role, the right model, a focused system prompt, and relevant skills.`,
      ``,
      `## IMPORTANT: Skill Discovery & Installation`,
      ``,
      `You have access to the Skill tool and Bash. Before generating the team YAML, you MUST:`,
      ``,
      `1. Use the Skill tool to invoke "find-skills" — search for skills relevant to the user's request.`,
      `   For example, if the user wants an Expo team, search for "expo", "react native", etc.`,
      `2. Review the search results and identify useful skills for the agents.`,
      `3. Install the relevant skills using Bash: \`npx skills add <source> --skill <name> -y\``,
      `   The find-skills skill will tell you the install commands.`,
      `4. After installing, include the installed skill names in the team YAML under each agent's \`skills:\` field.`,
      ``,
      `${installedSection}`,
      `Only search and install skills that are genuinely useful for the team's roles. Don't install irrelevant skills.`,
      ``,
      `## Available Adapters`,
      ``,
      `- claude-sdk: Uses Claude Code SDK. Fast, autonomous, can read/write files, run commands, etc.`,
      `- generic: Spawns any CLI command. For non-Claude tools.`,
      ``,
      `## Available Models (for claude-sdk adapter)`,
      ``,
      `- claude-haiku-4-5-20251001: Fast and cheap. Good for simple tasks, formatting, quick edits.`,
      `- claude-sonnet-4-5-20250929: Balanced. Good for most coding tasks.`,
      `- claude-opus-4-6: Most capable. Best for complex reasoning, architecture decisions, code review.`,
      ``,
      `## Current Team`,
      ``,
      `Team name: ${currentTeam.name}`,
      `Agents: ${currentTeam.agents.length > 0 ? currentTeam.agents.map(a => `${a.name} (${a.role || "general"})`).join(", ") : "none"}`,
      ``,
      `## Final Output`,
      ``,
      `After skill discovery and installation, output ONLY valid YAML (no markdown fences, no explanation):`,
      ``,
      `team:`,
      `  - name: "agent-name"            # kebab-case, descriptive`,
      `    adapter: "claude-sdk"          # or "generic"`,
      `    model: "claude-sonnet-4-5-20250929"  # pick the right model for the role`,
      `    role: "Clear description of what this agent does"`,
      `    systemPrompt: |               # instructions appended to the agent's base prompt`,
      `      You are a specialized frontend developer.`,
      `      Focus on React components, CSS, and accessibility.`,
      `    skills:                        # skill names (already installed + newly installed)`,
      `      - "frontend-design"`,
      ``,
      `## Rules`,
      ``,
      `- Each agent should have a distinct, non-overlapping role`,
      `- Use kebab-case for agent names (e.g. "frontend-dev", "test-writer", "api-designer")`,
      `- Choose models strategically: Haiku for simple tasks, Sonnet for standard, Opus for complex`,
      `- Include 2-6 agents typically — match the complexity of the user's needs`,
      `- Consider including a "reviewer" agent for quality assurance if appropriate`,
      `- Write a concise, focused systemPrompt for each agent that defines its specialization and constraints`,
      `- Only assign skills that are actually installed (either pre-existing or just installed by you)`,
      `- If no skills are relevant, omit the skills field`,
      `- The FINAL output must be ONLY the YAML team definition`,
      ``,
      `---`,
      ``,
      `User request: "${description}"`,
    ].join("\n");
  }

  /** Extract YAML — also handle team: prefix */
  private extractTeamYaml(text: string): string {
    let yaml = text.trim();
    const fenceMatch = yaml.match(/```(?:ya?ml)?\n([\s\S]*?)\n```/i);
    if (fenceMatch) yaml = fenceMatch[1].trim();
    if (!yaml.startsWith("team:")) {
      const idx = yaml.indexOf("team:");
      if (idx >= 0) yaml = yaml.slice(idx);
    }
    return yaml;
  }

  /** Show team preview with Execute/Edit/Refine (like plan preview) */
  private showTeamPreview(yaml: string, originalDescription: string): void {
    this.overlayActive = true;
    let doc: any;
    try {
      doc = parseYaml(yaml);
      if (!doc?.team?.length) {
        this.log("{red-fg}Invalid team: no agents found{/red-fg}");
        return;
      }
    } catch {
      this.log("{red-fg}Invalid YAML in team{/red-fg}");
      return;
    }

    let viewMode: "readable" | "yaml" = "readable";

    const overlay = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      style: { bg: "black" },
    });

    const contentBox = blessed.box({
      parent: overlay,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%-8",
      border: { type: "line" },
      tags: true,
      label: " {magenta-fg}✦{/magenta-fg} {bold}Team Preview{/bold} ",
      scrollable: true,
      keys: true,
      vi: true,
      mouse: true,
      style: { bg: "black", border: { fg: "magenta" } },
    });

    const actionItems = [
      "  {green-fg}✓{/green-fg} Apply team",
      "  {yellow-fg}✎{/yellow-fg} Edit YAML",
      "  {cyan-fg}↻{/cyan-fg} Refine with feedback",
    ];
    const actionList = blessed.list({
      parent: overlay,
      bottom: 1,
      left: "center",
      width: 32,
      height: actionItems.length + 2,
      items: actionItems,
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
      parent: overlay,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      content: " {cyan-fg}Tab{/cyan-fg} {grey-fg}toggle view{/grey-fg}  {cyan-fg}↑↓{/cyan-fg} {grey-fg}actions{/grey-fg}  {cyan-fg}Enter{/cyan-fg} {grey-fg}select{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}",
      style: { bg: "black", fg: "grey" },
    });

    const formatTeamReadable = (d: any): string => {
      const agents = d.team || [];
      const lines: string[] = [];
      lines.push(`  {bold}${agents.length} agent${agents.length !== 1 ? "s" : ""}{/bold} in team`);
      lines.push("");
      for (const a of agents) {
        const modelLabel = MODELS.find(m => m.value === a.model)?.label ?? a.model ?? "";
        lines.push(`  {cyan-fg}${a.name}{/cyan-fg}  {grey-fg}${a.adapter || "claude-sdk"}{/grey-fg}`);
        if (modelLabel) lines.push(`    {grey-fg}Model: ${modelLabel}{/grey-fg}`);
        if (a.role) lines.push(`    ${a.role}`);
        if (a.systemPrompt) {
          const truncated = String(a.systemPrompt).replace(/\n/g, " ").slice(0, 60);
          lines.push(`    {blue-fg}✎{/blue-fg} ${truncated}${String(a.systemPrompt).length > 60 ? "…" : ""}`);
        }
        if (a.skills?.length) {
          lines.push(`    {yellow-fg}⚡{/yellow-fg} ${a.skills.join(", ")}`);
        }
        lines.push("");
      }
      return lines.join("\n");
    };

    const renderContent = () => {
      if (viewMode === "readable") {
        contentBox.setContent(formatTeamReadable(doc));
        (contentBox as any).setLabel(" {magenta-fg}✦{/magenta-fg} {bold}Team Preview{/bold} ");
      } else {
        contentBox.setContent(this.formatYamlColored(yaml));
        (contentBox as any).setLabel(" {magenta-fg}✦{/magenta-fg} {bold}Team (YAML){/bold} ");
      }
    };

    renderContent();
    actionList.select(0);
    this.scheduleRender();

    const cleanup = () => {
      this.overlayActive = false;
      this.screen.removeListener("keypress", keyHandler);
      overlay.destroy();
      this.scheduleRender();
    };

    const keyHandler = (_ch: string, key: any) => {
      if (!key) return;

      if (key.name === "escape") {
        cleanup();
        this.log("{yellow-fg}Team generation cancelled{/yellow-fg}");
        return;
      }

      if (key.name === "tab") {
        viewMode = viewMode === "readable" ? "yaml" : "readable";
        renderContent();
        this.scheduleRender();
        return;
      }

      if (key.name === "up") {
        actionList.up(1);
        this.scheduleRender();
        return;
      }
      if (key.name === "down") {
        actionList.down(1);
        this.scheduleRender();
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        const selectedIdx = (actionList as any).selected ?? 0;
        cleanup();
        switch (selectedIdx) {
          case 0:
            this.applyTeam(yaml);
            break;
          case 1:
            this.showTeamYamlEditor(yaml, originalDescription);
            break;
          case 2:
            this.showTeamRefineInput(yaml, originalDescription);
            break;
        }
        return;
      }
    };

    this.screen.on("keypress", keyHandler);
  }

  /** Apply the AI-generated team: replace or merge agents */
  private applyTeam(yaml: string): void {
    try {
      const doc = parseYaml(yaml);
      if (!doc?.team || !Array.isArray(doc.team)) {
        this.log("{red-fg}Invalid team YAML{/red-fg}");
        return;
      }

      let added = 0;
      let updated = 0;
      for (const agentDef of doc.team) {
        if (!agentDef.name || !agentDef.adapter) continue;
        const existing = this.orchestrator.getAgents().find(a => a.name === agentDef.name);
        if (existing) {
          // Update existing agent
          existing.adapter = agentDef.adapter;
          existing.model = agentDef.model;
          existing.role = agentDef.role;
          existing.systemPrompt = agentDef.systemPrompt;
          existing.skills = agentDef.skills;
          updated++;
        } else {
          // Add new agent
          try {
            this.orchestrator.addAgent({
              name: agentDef.name,
              adapter: agentDef.adapter,
              model: agentDef.model,
              role: agentDef.role,
              systemPrompt: agentDef.systemPrompt,
              skills: agentDef.skills,
            });
            added++;
          } catch { /* skip duplicates */ }
        }
      }

      // Set first agent as default if we don't have one
      if (!this.defaultAgent || !this.orchestrator.getAgents().find(a => a.name === this.defaultAgent)) {
        this.defaultAgent = this.orchestrator.getAgents()[0]?.name ?? "dev";
      }

      this.log(`{green-fg}Team applied: ${added} added, ${updated} updated{/green-fg}`);
      this.logEvent(`  {magenta-fg}✦{/magenta-fg} Team updated — ${added} added, ${updated} updated`);
      this.log("");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`{red-fg}Failed to apply team: ${msg}{/red-fg}`);
    }
  }

  /** YAML editor for team (like plan YAML editor) */
  private showTeamYamlEditor(yaml: string, originalDescription: string): void {
    this.overlayActive = true;
    const editor = blessed.textarea({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%-1",
      value: yaml,
      inputOnFocus: false,
      border: { type: "line" },
      tags: true,
      label: " {yellow-fg}✎{/yellow-fg} {bold}Edit Team{/bold}  {grey-fg}Ctrl+S save  Escape cancel{/grey-fg} ",
      style: { bg: "black", fg: "white", border: { fg: "yellow" } },
      keys: true,
      mouse: true,
      scrollable: true,
    });

    editor.focus();
    editor.readInput(() => {});
    this.scheduleRender();

    editor.key(["C-s"], () => {
      const editedYaml = editor.getValue();
      this.overlayActive = false;
      editor.destroy();
      this.showTeamPreview(editedYaml, originalDescription);
    });

    editor.key(["escape"], () => {
      this.overlayActive = false;
      editor.destroy();
      this.showTeamPreview(yaml, originalDescription);
    });
  }

  /** Refine input for team (like plan refine) */
  private showTeamRefineInput(yaml: string, originalDescription: string): void {
    this.overlayActive = true;
    const refineBox = blessed.box({
      parent: this.screen,
      top: "center",
      left: "center",
      width: "70%",
      height: 5,
      border: { type: "line" },
      tags: true,
      label: " {cyan-fg}↻{/cyan-fg} {bold}Refine{/bold}  {grey-fg}What should be changed?{/grey-fg} ",
      style: { bg: "black", fg: "white", border: { fg: "cyan" } },
    });

    let refineBuffer = "";
    const cursor = "{white-fg}█{/white-fg}";
    refineBox.setContent(` ${cursor}`);
    this.scheduleRender();

    const cleanup = () => {
      this.overlayActive = false;
      this.screen.removeListener("keypress", keyHandler);
      refineBox.destroy();
      this.scheduleRender();
    };

    const keyHandler = (ch: string, key: any) => {
      if (!key) return;
      if (key.name === "return" || key.name === "enter") {
        if (refineBuffer.trim()) {
          cleanup();
          this.refineAITeam(yaml, originalDescription, refineBuffer.trim());
        }
        return;
      }
      if (key.name === "escape") {
        cleanup();
        this.showTeamPreview(yaml, originalDescription);
        return;
      }
      if (key.name === "backspace") {
        refineBuffer = refineBuffer.slice(0, -1);
      } else if (ch && ch.length === 1 && !key.ctrl && !key.meta) {
        refineBuffer += ch;
      }
      refineBox.setContent(` ${refineBuffer}${cursor}`);
      this.scheduleRender();
    };

    this.screen.on("keypress", keyHandler);
  }

  /** Re-generate team with feedback */
  private async refineAITeam(currentYaml: string, originalDescription: string, feedback: string): Promise<void> {
    this.logAlways(`{cyan-fg}↻{/cyan-fg} Refining: ${feedback}`);
    this.logAlways("");
    this.processing = true;
    this.processingStart = Date.now();
    this.processingLabel = "Refining team";
    this.updateInputDisplay();

    try {
      const prompt = [
        this.buildTeamGenPrompt(originalDescription),
        ``,
        `---`,
        ``,
        `Current team YAML:`,
        currentYaml,
        ``,
        `User feedback: "${feedback}"`,
        ``,
        `Revise the team based on the feedback. Output ONLY valid YAML.`,
      ].join("\n");

      const resultText = await this.querySDK(prompt, ["Skill", "Bash"], (event) => {
        this.processingDetail = event.replace(/\{[^}]*\}/g, "").slice(0, 80);
        this.updateInputDisplay();
        this.logAlways(`  {grey-fg}${event}{/grey-fg}`);
      });
      this.processing = false;
      this.processingStart = 0;
      this.updateInputDisplay();

      const newYaml = this.extractTeamYaml(resultText);
      if (!newYaml?.trim()) {
        this.log("{red-fg}Refine returned empty result{/red-fg}");
        this.showTeamPreview(currentYaml, originalDescription);
        return;
      }

      try {
        const doc = parseYaml(newYaml);
        if (!doc?.team?.length) {
          this.log("{red-fg}Refined team has no agents{/red-fg}");
          this.showTeamPreview(currentYaml, originalDescription);
          return;
        }
      } catch {
        this.log("{red-fg}Refined team has invalid YAML{/red-fg}");
        this.showTeamPreview(currentYaml, originalDescription);
        return;
      }

      this.showTeamPreview(newYaml, originalDescription);
    } catch (err: unknown) {
      this.processing = false;
      this.processingStart = 0;
      this.updateInputDisplay();
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`{red-fg}Refine failed: ${msg}{/red-fg}`);
    }
  }

  /** Wizard for adding a new agent */
  private showAddAgentWizard(): void {
    this.overlayActive = true;
    const overlay = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      style: { bg: "black" },
    });

    let step = 0; // 0=name(text), 1=adapter(list), 2=model(list), 3=role(text)
    let agentName = "";
    let agentAdapter = this.config.agent;
    let agentModel = this.config.model;
    let agentRole = "";

    const stepLabel = blessed.box({
      parent: overlay,
      top: 3,
      left: "center",
      width: 50,
      height: 1,
      content: "",
      tags: true,
      style: { bg: "black" },
    });

    // Input box for name/role (text steps)
    const inputBox = blessed.box({
      parent: overlay,
      top: 5,
      left: "center",
      width: 50,
      height: 3,
      border: { type: "line" },
      tags: true,
      style: { bg: "black", fg: "white", border: { fg: "cyan" } },
      hidden: true,
    });

    // List for adapter/model selection
    const selList = blessed.list({
      parent: overlay,
      top: 5,
      left: "center",
      width: 50,
      height: 8,
      items: [],
      tags: true,
      border: { type: "line" },
      style: {
        bg: "black",
        border: { fg: "cyan" },
        selected: { bg: "blue", fg: "white", bold: true },
        item: { bg: "black" },
      },
      keys: false, // We handle keys ourselves
      vi: false,
      mouse: true,
      hidden: true,
    });

    blessed.box({
      parent: overlay,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      content: " {cyan-fg}Enter{/cyan-fg} {grey-fg}confirm{/grey-fg}  {cyan-fg}↑↓{/cyan-fg} {grey-fg}navigate{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}",
      style: { bg: "black", fg: "grey" },
    });

    let inputBuf = "";
    const cursor = "{white-fg}█{/white-fg}";
    let listData: string[] = []; // values for current list step
    let stepReady = false; // guard against Enter leak between steps
    setImmediate(() => { stepReady = true; }); // also guards initial Enter from team menu

    const cleanup = () => {
      this.screen.removeListener("keypress", keyHandler);
      overlay.destroy();
      this.showTeamMenu();
    };

    const showTextStep = (label: string) => {
      stepLabel.setContent(label);
      selList.hide();
      inputBox.show();
      inputBuf = "";
      inputBox.setContent(` ${cursor}`);
      stepReady = false;
      setImmediate(() => { stepReady = true; });
      this.scheduleRender();
    };

    const showListStep = (label: string, items: string[], values: string[]) => {
      stepLabel.setContent(label);
      inputBox.hide();
      listData = values;
      selList.setItems(items);
      selList.height = items.length + 2;
      selList.show();
      selList.select(0);
      stepReady = false;
      setImmediate(() => { stepReady = true; });
      this.scheduleRender();
    };

    const finishAdd = () => {
      if (!agentName.trim()) {
        this.log("{red-fg}Agent name required{/red-fg}");
        cleanup();
        return;
      }
      try {
        this.orchestrator.addAgent({
          name: agentName.trim(),
          adapter: agentAdapter,
          model: agentModel || undefined,
          role: agentRole || undefined,
        });
        this.log(`{green-fg}Agent "${agentName.trim()}" added (${agentAdapter}){/green-fg}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`{red-fg}${msg}{/red-fg}`);
      }
      cleanup();
    };

    const goToAdapterStep = () => {
      const available = PROVIDERS.filter(p => p.available);
      step = 1;
      showListStep(
        "{bold}Step 2/4 — Adapter{/bold}",
        available.map(p => `  {green-fg}●{/green-fg} ${p.label}`),
        available.map(p => p.value),
      );
    };

    const goToModelStep = () => {
      const models = MODELS.filter(m => m.adapter === agentAdapter);
      if (models.length > 0) {
        step = 2;
        showListStep(
          "{bold}Step 3/4 — Model{/bold}",
          models.map(m => `  {green-fg}●{/green-fg} ${m.label} {grey-fg}${m.value}{/grey-fg}`),
          models.map(m => m.value),
        );
      } else {
        agentModel = "";
        goToRoleStep();
      }
    };

    const goToRoleStep = () => {
      step = 3;
      showTextStep("{bold}Step 4/4 — Role{/bold} {grey-fg}(optional, Enter to skip){/grey-fg}");
    };

    // Start with name input
    showTextStep("{bold}Step 1/4 — Agent name{/bold}");

    // ALL input handled here — no blessed events
    const keyHandler = (ch: string, key: any) => {
      if (!key) return;
      if (key.name === "escape") { cleanup(); return; }

      const isTextStep = step === 0 || step === 3;
      const isListStep = step === 1 || step === 2;

      if (isTextStep) {
        if (key.name === "return" || key.name === "enter") {
          if (!stepReady) return; // guard against Enter leak between steps
          if (step === 0) {
            agentName = inputBuf;
            if (!agentName.trim()) return;
            goToAdapterStep();
          } else {
            agentRole = inputBuf;
            finishAdd();
          }
          return;
        }
        if (key.name === "backspace") {
          inputBuf = inputBuf.slice(0, -1);
        } else if (ch && ch.length === 1 && !key.ctrl && !key.meta) {
          inputBuf += ch;
        }
        inputBox.setContent(` ${inputBuf}${cursor}`);
        this.scheduleRender();
        return;
      }

      if (isListStep) {
        if (key.name === "up") {
          selList.up(1);
          this.scheduleRender();
          return;
        }
        if (key.name === "down") {
          selList.down(1);
          this.scheduleRender();
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          if (!stepReady) return; // guard against Enter leak between steps
          const index = (selList as any).selected ?? 0;
          const value = listData[index];
          if (step === 1) {
            agentAdapter = value ?? this.config.agent;
            goToModelStep();
          } else if (step === 2) {
            agentModel = value ?? "";
            goToRoleStep();
          }
          return;
        }
      }
    };

    this.screen.on("keypress", keyHandler);
  }

  /** Menu for editing an existing agent */
  private showEditAgentMenu(agent: { name: string; adapter: string; model?: string; role?: string; systemPrompt?: string; skills?: string[] }): void {
    this.overlayActive = true;
    const overlay = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      style: { bg: "black" },
    });

    const modelLabel = agent.model
      ? MODELS.find(m => m.value === agent.model)?.label ?? agent.model
      : "default";

    const truncPrompt = agent.systemPrompt
      ? agent.systemPrompt.replace(/\n/g, " ").slice(0, 40) + (agent.systemPrompt.length > 40 ? "…" : "")
      : "-";

    const skillsLabel = agent.skills?.length ? agent.skills.join(", ") : "-";

    const items = [
      `  {cyan-fg}Adapter{/cyan-fg}       ${this.getProviderLabel(agent.adapter)}`,
      `  {cyan-fg}Model{/cyan-fg}         ${modelLabel}`,
      `  {cyan-fg}Role{/cyan-fg}          ${agent.role || "-"}`,
      `  {cyan-fg}System Prompt{/cyan-fg} ${truncPrompt}`,
      `  {cyan-fg}Skills{/cyan-fg}        ${skillsLabel}`,
    ];

    const editList = blessed.list({
      parent: overlay,
      top: "center",
      left: "center",
      width: "60%",
      height: items.length + 2,
      items,
      tags: true,
      border: { type: "line" },
      label: ` {bold}Edit: ${agent.name}{/bold} `,
      style: {
        bg: "black",
        border: { fg: "cyan" },
        selected: { bg: "blue", fg: "white", bold: true },
        item: { bg: "black" },
      },
      keys: false,
      vi: false,
      mouse: true,
    });

    blessed.box({
      parent: overlay,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      content: " {cyan-fg}Enter{/cyan-fg} {grey-fg}change{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}back{/grey-fg}",
      style: { bg: "black", fg: "grey" },
    });

    editList.select(0);
    this.scheduleRender();

    const cleanup = () => {
      this.overlayActive = false;
      this.screen.removeListener("keypress", keyHandler);
      overlay.destroy();
      this.scheduleRender();
    };

    const handleEditSelect = (index: number) => {
      if (index === 0) {
        // Change adapter
        const pickerOpts = PROVIDERS;
        cleanup();
        this.showConfigPicker(this.screen as any, "Select Adapter", pickerOpts, (value) => {
          const agents = this.orchestrator.getAgents();
          const found = agents.find(a => a.name === agent.name);
          if (found) {
            found.adapter = value;
            const validModels = MODELS.filter(m => m.adapter === value);
            if (validModels.length > 0 && !validModels.find(m => m.value === found.model)) {
              found.model = validModels[0].value;
            }
          }
          this.log(`{green-fg}${agent.name}: adapter → ${this.getProviderLabel(value)}{/green-fg}`);
          this.showTeamMenu();
        }, () => this.showTeamMenu());
      } else if (index === 1) {
        // Change model
        const available = MODELS.filter(m => m.adapter === agent.adapter);
        if (available.length === 0) {
          this.log("{yellow-fg}No models for this adapter{/yellow-fg}");
          return;
        }
        const modelOpts = available.map(m => ({
          label: `${m.label} {grey-fg}${m.value}{/grey-fg}`,
          value: m.value,
          available: true,
        }));
        cleanup();
        this.showConfigPicker(this.screen as any, "Select Model", modelOpts, (value) => {
          const agents = this.orchestrator.getAgents();
          const found = agents.find(a => a.name === agent.name);
          if (found) found.model = value;
          const label = MODELS.find(m => m.value === value)?.label ?? value;
          this.log(`{green-fg}${agent.name}: model → ${label}{/green-fg}`);
          this.showTeamMenu();
        }, () => this.showTeamMenu());
      } else if (index === 2) {
        // Change role — text input
        cleanup();
        this.showTextInput("Enter role", agent.role || "", (value) => {
          const agents = this.orchestrator.getAgents();
          const found = agents.find(a => a.name === agent.name);
          if (found) found.role = value || undefined;
          this.log(`{green-fg}${agent.name}: role → ${value || "-"}{/green-fg}`);
          this.showTeamMenu();
        }, () => this.showTeamMenu());
      } else if (index === 3) {
        // Edit system prompt — multiline textarea
        cleanup();
        this.showSystemPromptEditor(agent);
      } else if (index === 4) {
        // Edit skills — show skill picker
        cleanup();
        this.showSkillPicker(agent);
      }
    };

    // Mouse click support (guarded)
    let ready = false;
    setImmediate(() => { ready = true; });
    editList.on("select", (_item: any, index: number) => {
      if (!ready) return;
      handleEditSelect(index);
    });

    const keyHandler = (_ch: string, key: any) => {
      if (!key) return;
      if (!ready) return; // guard against Enter leak from parent overlay
      if (key.name === "escape") {
        cleanup();
        this.showTeamMenu();
        return;
      }
      if (key.name === "up") { editList.up(1); this.scheduleRender(); return; }
      if (key.name === "down") { editList.down(1); this.scheduleRender(); return; }
      if (key.name === "return" || key.name === "enter") {
        const idx = (editList as any).selected ?? 0;
        handleEditSelect(idx);
        return;
      }
    };

    this.screen.on("keypress", keyHandler);
  }

  /** System prompt editor — multiline textarea */
  private showSystemPromptEditor(agent: { name: string; systemPrompt?: string }): void {
    this.overlayActive = true;
    const overlay = blessed.box({
      parent: this.screen, top: 0, left: 0, width: "100%", height: "100%",
      style: { bg: "black" },
    });
    const editor = blessed.textarea({
      parent: overlay,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%-1",
      value: agent.systemPrompt || "",
      inputOnFocus: false,
      border: { type: "line" },
      tags: true,
      label: ` {blue-fg}✎{/blue-fg} {bold}System Prompt: ${agent.name}{/bold} `,
      style: { bg: "black", fg: "white", border: { fg: "blue" } },
      keys: true,
      mouse: true,
      scrollable: true,
    });
    blessed.box({
      parent: overlay, bottom: 0, left: 0, width: "100%", height: 1,
      tags: true, content: " {cyan-fg}Ctrl+S{/cyan-fg} {grey-fg}save{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}",
      style: { bg: "black", fg: "grey" },
    });

    editor.focus();
    editor.readInput(() => {});
    this.scheduleRender();

    const cleanup = () => {
      this.overlayActive = false;
      overlay.destroy();
      this.scheduleRender();
    };

    editor.key(["C-s"], () => {
      const value = editor.getValue().trim();
      cleanup();
      const agents = this.orchestrator.getAgents();
      const found = agents.find(a => a.name === agent.name);
      if (found) found.systemPrompt = value || undefined;
      this.logAlways(`{green-fg}${agent.name}: system prompt ${value ? "updated" : "cleared"}{/green-fg}`);
      this.showTeamMenu();
    });

    editor.key(["escape"], () => {
      cleanup();
      this.showTeamMenu();
    });
  }

  /** Skill picker — multi-select from discovered skills */
  private showSkillPicker(agent: { name: string; skills?: string[] }): void {
    this.overlayActive = true;
    const available = discoverSkills(this.workDir);
    const currentSkills = new Set(agent.skills ?? []);

    const overlay = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      style: { bg: "black" },
    });

    const buildSkillItems = () =>
      available.map(s => {
        const check = currentSkills.has(s.name) ? "{green-fg}✓{/green-fg}" : " ";
        return `  [${check}] {cyan-fg}${s.name}{/cyan-fg}  {grey-fg}${s.description.slice(0, 40)}{/grey-fg}`;
      });

    const items = available.length > 0
      ? buildSkillItems()
      : ["  {grey-fg}No skills found in .claude/skills/{/grey-fg}"];

    const skillList = blessed.list({
      parent: overlay,
      top: "center",
      left: "center",
      width: 60,
      height: Math.min(available.length + 4, 16),
      items,
      tags: true,
      border: { type: "line" },
      label: ` {yellow-fg}⚡{/yellow-fg} {bold}Skills: ${agent.name}{/bold} `,
      style: {
        bg: "black",
        border: { fg: "yellow" },
        selected: { bg: "blue", fg: "white", bold: true },
        item: { bg: "black" },
      },
      keys: false,
      vi: false,
      mouse: true,
    });

    blessed.box({
      parent: overlay,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      content: " {cyan-fg}Space{/cyan-fg} {grey-fg}toggle{/grey-fg}  {cyan-fg}Enter{/cyan-fg} {grey-fg}save{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}",
      style: { bg: "black", fg: "grey" },
    });

    skillList.select(0);
    this.scheduleRender();

    const refreshItems = () => {
      skillList.setItems(buildSkillItems());
      this.scheduleRender();
    };

    const cleanup = () => {
      this.overlayActive = false;
      this.screen.removeListener("keypress", keyHandler);
      overlay.destroy();
      this.scheduleRender();
    };

    const toggleSkill = (idx: number) => {
      if (idx < 0 || idx >= available.length) return;
      const name = available[idx].name;
      if (currentSkills.has(name)) {
        currentSkills.delete(name);
      } else {
        currentSkills.add(name);
      }
      refreshItems();
    };

    // Mouse click toggles skill (guarded)
    let skillReady = false;
    setImmediate(() => { skillReady = true; });
    skillList.on("select", (_item: any, index: number) => {
      if (!skillReady) return;
      toggleSkill(index);
    });

    const keyHandler = (_ch: string, key: any) => {
      if (!key) return;
      if (key.name === "escape") {
        cleanup();
        this.showTeamMenu();
        return;
      }
      if (key.name === "up") { skillList.up(1); this.scheduleRender(); return; }
      if (key.name === "down") { skillList.down(1); this.scheduleRender(); return; }
      if (key.name === "space") {
        const idx = (skillList as any).selected ?? 0;
        toggleSkill(idx);
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        const agents = this.orchestrator.getAgents();
        const found = agents.find(a => a.name === agent.name);
        if (found) {
          found.skills = currentSkills.size > 0 ? [...currentSkills] : undefined;
        }
        this.log(`{green-fg}${agent.name}: skills → ${currentSkills.size > 0 ? [...currentSkills].join(", ") : "none"}{/green-fg}`);
        this.showTeamMenu();
        return;
      }
    };

    this.screen.on("keypress", keyHandler);
  }

  /** Simple text input overlay */
  private showTextInput(title: string, initial: string, onSubmit: (value: string) => void, onCancel: () => void): void {
    this.overlayActive = true;
    const overlay = blessed.box({
      parent: this.screen, top: 0, left: 0, width: "100%", height: "100%",
      style: { bg: "black" },
    });
    const box = blessed.box({
      parent: overlay,
      top: "center",
      left: "center",
      width: "60%",
      height: 5,
      border: { type: "line" },
      tags: true,
      label: ` {bold}${title}{/bold} `,
      style: { bg: "black", fg: "white", border: { fg: "cyan" } },
    });
    blessed.box({
      parent: overlay, bottom: 0, left: 0, width: "100%", height: 1,
      tags: true, content: " {cyan-fg}Enter{/cyan-fg} {grey-fg}confirm{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}",
      style: { bg: "black", fg: "grey" },
    });

    let buf = initial;
    const cursor = "{white-fg}_{/white-fg}";
    box.setContent(` ${buf}${cursor}`);
    this.scheduleRender();

    const cleanup = () => {
      this.overlayActive = false;
      this.screen.removeListener("keypress", keyHandler);
      overlay.destroy();
      this.scheduleRender();
    };

    const keyHandler = (ch: string, key: any) => {
      if (!key) return;
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        onSubmit(buf.trim());
        return;
      }
      if (key.name === "escape") {
        cleanup();
        onCancel();
        return;
      }
      if (key.name === "backspace") {
        buf = buf.slice(0, -1);
      } else if (ch && ch.length === 1 && !key.ctrl && !key.meta) {
        buf += ch;
      }
      box.setContent(` ${buf}${cursor}`);
      this.scheduleRender();
    };

    this.screen.on("keypress", keyHandler);
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

  // ─── Plan Mode ──────────────────────────────────────

  private async handlePlanInput(input: string): Promise<void> {
    this.logAlways(`{yellow-fg}♩{/yellow-fg} ${input}`);
    this.logAlways("");
    this.processing = true;
    this.processingStart = Date.now();
    this.processingLabel = "Generating plan";
    this.updateInputDisplay();

    try {
      const yaml = await this.generatePlan(input);
      this.processing = false;
      this.processingStart = 0;
      this.updateInputDisplay();

      if (!yaml || !yaml.trim()) {
        this.log("{red-fg}Plan generation returned empty result{/red-fg}");
        return;
      }

      // Validate YAML
      try {
        const doc = parseYaml(yaml);
        if (!doc?.tasks || !Array.isArray(doc.tasks) || doc.tasks.length === 0) {
          this.log("{red-fg}Plan has no tasks. Try a more specific prompt.{/red-fg}");
          return;
        }
      } catch (parseErr: unknown) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        this.log(`{red-fg}Invalid YAML in plan: ${msg}{/red-fg}`);
        this.log("{grey-fg}Raw output:{/grey-fg}");
        for (const line of yaml.split("\n").slice(0, 10)) {
          this.log(`  ${line}`);
        }
        return;
      }

      this.showPlanPreview(yaml, input);
    } catch (err: unknown) {
      this.processing = false;
      this.processingStart = 0;
      this.updateInputDisplay();
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`{red-fg}Plan generation failed: ${msg}{/red-fg}`);
    }
  }

  // ─── Chat Mode ───────────────────────────────────────

  private async handleChatInput(input: string): Promise<void> {
    this.logAlways(`{magenta-fg}?{/magenta-fg} ${input}`);
    this.logAlways("");
    this.processing = true;
    this.processingStart = Date.now();
    this.processingLabel = "Thinking";
    this.updateInputDisplay();

    try {
      const response = await this.queryChatResponse(input);
      this.processing = false;
      this.processingStart = 0;
      this.updateInputDisplay();

      if (response) {
        // Render response line by line
        for (const line of response.split("\n")) {
          this.logAlways(`  ${line}`);
        }
      } else {
        this.logAlways("{grey-fg}No response{/grey-fg}");
      }
      this.logAlways("");
    } catch (err: unknown) {
      this.processing = false;
      this.processingStart = 0;
      this.updateInputDisplay();
      const msg = err instanceof Error ? err.message : String(err);
      this.logAlways(`{red-fg}Chat error: ${msg}{/red-fg}`);
    }
  }

  private async queryChatResponse(input: string): Promise<string> {
    const prompt = [
      this.buildChatSystemPrompt(),
      ``,
      `---`,
      ``,
      `User question: ${input}`,
      ``,
      `Answer concisely based on the current Orchestra state. Use plain text, no markdown.`,
    ].join("\n");

    return this.querySDKText(prompt);
  }

  private buildChatSystemPrompt(): string {
    this.loadState();
    const state = this.state;
    const team = this.orchestrator.getTeam();

    const parts: string[] = [
      `You are the Orchestra assistant. Orchestra is an agent-agnostic framework for orchestrating teams of AI coding agents.`,
      ``,
      `## How Orchestra Works`,
      ``,
      `Orchestra manages teams of AI agents that execute coding tasks autonomously.`,
      `The supervisor loop runs every 2 seconds and:`,
      `1. Checks for completed agents and collects their results`,
      `2. Spawns ALL agents for tasks whose dependencies are satisfied — multiple agents run in parallel`,
      `3. Runs assessment (tests, file checks, LLM review with G-Eval scoring) on completed tasks`,
      `4. Retries failed tasks up to maxRetries times, including per-dimension feedback`,
      ``,
      `IMPORTANT: The supervisor maximizes parallelism. Every tick, ALL tasks with satisfied dependencies`,
      `are spawned simultaneously. There is no concurrency limit. Tasks without dependencies between them`,
      `WILL run in parallel. Plans should exploit this by only adding dependencies where strictly needed.`,
      ``,
      `## Task State Machine`,
      ``,
      `pending → assigned → in_progress → review → done`,
      `                                          → failed → pending (retry)`,
      ``,
      `- pending: waiting for dependencies or to be picked up`,
      `- assigned: agent selected, about to start`,
      `- in_progress: agent is working on it`,
      `- review: agent finished, running assessment (expectations/metrics)`,
      `- done: all checks passed`,
      `- failed: checks failed or agent errored; may be retried`,
      ``,
      `## Adapters`,
      ``,
      `Agents are spawned via adapters:`,
      `- claude-sdk: Uses @anthropic-ai/claude-agent-sdk. Fast, no process spawning. Full streaming + tool tracking.`,
      `- generic: Spawns any CLI command as a child process. For Aider, OpenCode, custom scripts, etc.`,
      ``,
      `## Assessment System`,
      ``,
      `After an agent finishes a task, expectations are checked:`,
      `- test: Runs a command (e.g. "npm test"), passes if exit code 0`,
      `- file_exists: Checks that specified file paths exist`,
      `- script: Runs a script, passes if exit code 0`,
      `- llm_review: G-Eval LLM-as-Judge with multi-dimensional rubric scoring (1-5)`,
      `  - Default dimensions: correctness (0.35), completeness (0.30), code_quality (0.20), edge_cases (0.15)`,
      `  - Weighted global score compared to threshold (default 3.0)`,
      `  - On retry, per-dimension scores and reasoning are included for targeted improvement`,
      ``,
      `## TUI Modes`,
      ``,
      `- Task mode: User types a task description → immediately created and assigned to an agent`,
      `- Plan mode: User types a request → AI generates a multi-task YAML plan → preview with Execute/Edit/Refine → creates tasks with dependencies and grouping`,
      `- Chat mode (current): User asks questions → you answer based on current state`,
      ``,
      `## Current State`,
      ``,
      `Project: ${state?.project || "orchestra-interactive"}`,
      `Team: ${team.name}`,
      `Agents:`,
    ];

    for (const a of team.agents) {
      let line = `  - ${a.name} (adapter: ${a.adapter}): ${a.role || "general"}`;
      if (a.skills?.length) line += ` [skills: ${a.skills.join(", ")}]`;
      if (a.systemPrompt) line += ` [has system prompt]`;
      parts.push(line);
    }

    if (state?.tasks && state.tasks.length > 0) {
      parts.push(``, `Tasks (${state.tasks.length}):`);
      for (const t of state.tasks) {
        let line = `  - [${t.status.toUpperCase()}] "${t.title}" → ${t.assignTo}`;
        if (t.group) line += ` [${t.group}]`;
        if (t.retries > 0) line += ` (retry ${t.retries}/${t.maxRetries})`;
        parts.push(line);

        if (t.description !== t.title) {
          parts.push(`    Description: ${t.description.slice(0, 300)}`);
        }
        if (t.dependsOn.length > 0) {
          const depTitles = t.dependsOn.map(id => {
            const dep = state.tasks.find(tt => tt.id === id);
            return dep ? `"${dep.title}" [${dep.status}]` : id;
          });
          parts.push(`    Depends on: ${depTitles.join(", ")}`);
        }
        if (t.result) {
          parts.push(`    Result: exit ${t.result.exitCode}, duration ${(t.result.duration / 1000).toFixed(1)}s`);
          if (t.result.assessment?.globalScore !== undefined) {
            parts.push(`    Score: ${t.result.assessment.globalScore.toFixed(1)}/5`);
            if (t.result.assessment.scores) {
              for (const s of t.result.assessment.scores) {
                parts.push(`      ${s.dimension}: ${s.score}/5 — ${s.reasoning.slice(0, 100)}`);
              }
            }
          }
          if (t.result.stderr) {
            parts.push(`    Stderr: ${t.result.stderr.slice(0, 200)}`);
          }
          if (t.result.stdout) {
            parts.push(`    Output (first 200 chars): ${t.result.stdout.slice(0, 200)}`);
          }
        }
      }

      // Summary counts
      const counts: Record<string, number> = {};
      for (const t of state.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
      const summary = Object.entries(counts).map(([s, n]) => `${s}: ${n}`).join(", ");
      parts.push(``, `Summary: ${summary}`);
    } else {
      parts.push(``, `Tasks: none yet`);
    }

    const activeProcs = (state?.processes || []).filter(p => p.alive);
    if (activeProcs.length > 0) {
      parts.push(``, `Active agents (${activeProcs.length}):`);
      for (const p of activeProcs) {
        let line = `  - ${p.agentName} working on task ${p.taskId}`;
        if (p.activity?.lastTool) line += `, last tool: ${p.activity.lastTool}`;
        if (p.activity?.toolCalls) line += `, ${p.activity.toolCalls} tool calls`;
        if (p.activity?.filesCreated.length) line += `, created ${p.activity.filesCreated.length} files`;
        if (p.activity?.filesEdited.length) line += `, edited ${p.activity.filesEdited.length} files`;
        parts.push(line);
      }
    } else {
      parts.push(``, `Active agents: none`);
    }

    return parts.join("\n");
  }

  /** Build the system context for plan generation (Orchestra knowledge + output format) */
  private buildPlanSystemPrompt(): string {
    const orchestraKnowledge = this.buildChatSystemPrompt();
    const team = this.orchestrator.getTeam();
    const availableSkills = discoverSkills(this.workDir);

    return [
      orchestraKnowledge,
      ``,
      `---`,
      ``,
      `## Your Role: Plan Generator`,
      ``,
      `You are Orchestra's plan generator. Your job is to decompose a user request into`,
      `a set of atomic tasks that Orchestra's supervisor will execute via AI agents.`,
      `The agents are autonomous coding agents — they can read/write files, run commands,`,
      `install packages, write tests, etc. Each task gets its own independent agent session.`,
      ``,
      `## Output Format`,
      ``,
      `Output ONLY valid YAML (no markdown fences, no explanation, no preamble):`,
      ``,
      `# Optional: define volatile agents specific to this plan`,
      `# These agents are temporary — they exist only for this plan's execution`,
      `# Only include this section if the task benefits from specialized agents`,
      `# that differ from the existing team.`,
      `team:`,
      `  - name: "specialist-name"`,
      `    adapter: "claude-sdk"           # or "generic"`,
      `    model: "claude-sonnet-4-5-20250929"  # claude-sonnet-4-5-20250929, claude-opus-4-6, claude-haiku-4-5-20251001`,
      `    role: "What this agent specializes in"`,
      `    systemPrompt: |               # optional: instructions appended to agent's base prompt`,
      `      You are a specialist in X. Focus on Y.`,
      `    skills:                        # optional: skill names from available skills`,
      `      - "skill-name"`,
      ``,
      `tasks:`,
      `  - title: "Short descriptive title"`,
      `    description: "Detailed description — be specific about what files to create/modify, what logic to implement, etc."`,
      `    assignTo: "agent-name"          # can reference existing team agents OR volatile agents defined above`,
      `    dependsOn: []                   # list of task TITLES (not IDs) of prerequisites`,
      `    expectations:`,
      `      - type: test                  # run a command, pass if exit 0`,
      `        command: "npm test"`,
      `      - type: file_exists           # check files exist`,
      `        paths: ["src/foo.ts"]`,
      `      - type: llm_review            # G-Eval LLM scoring`,
      `        criteria: "Code is clean and well-structured"`,
      ``,
      `## Rules`,
      ``,
      `- List tasks in dependency order (a task's dependencies MUST appear BEFORE it)`,
      `- Each task should be atomic — one clear objective per task`,
      `- Descriptions should be specific enough for an autonomous agent with no context of other tasks`,
      `- Available agents: ${team.agents.filter(a => !a.volatile).map(a => `${a.name} (${a.adapter}, ${a.role || "general"})`).join(", ")}`,
      `- You can use existing agents OR define new volatile agents in the team: section`,
      `- Volatile agents are useful when the task needs specialized roles (e.g. "test-writer", "api-designer", "reviewer")`,
      `- For volatile agents, write a focused systemPrompt and assign relevant skills if available`,
      ...(availableSkills.length > 0 ? [
        `- Available skills: ${availableSkills.map(s => `${s.name} (${s.description})`).join(", ")}`,
        `- Only assign skills that are relevant to the volatile agent's role`,
      ] : []),
      `- Use different models strategically: Haiku for simple tasks, Sonnet for standard work, Opus for complex reasoning`,
      `- Add expectations where appropriate — tests for code, file_exists for creation, llm_review for quality`,
      `- Consider existing tasks/state to avoid duplication or conflicts`,
      `- MAXIMIZE PARALLELISM: Orchestra spawns ALL tasks with satisfied deps simultaneously.`,
      `  Only add a dependency if task B truly CANNOT start before task A finishes.`,
      `  Independent tasks (different files, different modules) MUST NOT have deps between them.`,
      `  Example: creating tests and creating docs for different features can run in parallel.`,
      `- Output ONLY the YAML, nothing else`,
    ].join("\n");
  }

  /** Shared helper: query Claude SDK for text-only response (no tools) */
  private async querySDKText(prompt: string): Promise<string> {
    return this.querySDK(prompt, []);
  }

  /** Query SDK with optional tool access */
  private async querySDK(
    prompt: string,
    allowedTools: string[],
    onProgress?: (event: string) => void,
  ): Promise<string> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    let resultText = "";
    const q = query({
      prompt,
      options: {
        cwd: this.workDir,
        permissionMode: "bypassPermissions" as any,
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        allowedTools,
      },
    });

    for await (const message of q) {
      if (message.type === "assistant" && (message as any).message) {
        const content = (message as any).message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text") {
              resultText = block.text;
              // Report text progress — first line as summary
              if (onProgress) {
                const firstLine = block.text.split("\n").find((l: string) => l.trim()) ?? "";
                if (firstLine.trim()) onProgress(firstLine.trim().slice(0, 120));
              }
            }
            if (block.type === "tool_use" && onProgress) {
              const toolName = block.name;
              const toolInput = block.input as Record<string, unknown> | undefined;
              // Report tool usage
              if (toolName === "Bash") {
                const cmd = (toolInput?.command as string)?.slice(0, 80) ?? "";
                onProgress(`{cyan-fg}${toolName}{/cyan-fg} ${cmd}`);
              } else if (toolName === "Skill") {
                const skill = (toolInput?.skill as string) ?? "";
                onProgress(`{cyan-fg}Skill{/cyan-fg} ${skill}`);
              } else {
                onProgress(`{cyan-fg}${toolName}{/cyan-fg}`);
              }
            }
          }
        }
      }
      if (message.type === "result") {
        const result = message as any;
        if (result.subtype === "success" && result.result) {
          resultText = result.result;
        }
      }
    }

    return resultText.trim();
  }

  private async generatePlan(input: string): Promise<string> {
    const prompt = [
      this.buildPlanSystemPrompt(),
      ``,
      `---`,
      ``,
      `Generate a task plan for:`,
      `"${input}"`,
    ].join("\n");

    const resultText = await this.querySDKText(prompt);
    return this.extractYaml(resultText);
  }

  private extractYaml(text: string): string {
    let yaml = text.trim();
    // Remove markdown fences
    const fenceMatch = yaml.match(/```(?:ya?ml)?\n([\s\S]*?)\n```/i);
    if (fenceMatch) {
      yaml = fenceMatch[1].trim();
    }
    // Find team: or tasks: block if not at start
    if (!yaml.startsWith("tasks:") && !yaml.startsWith("team:")) {
      // Prefer team: if it comes before tasks: (plan with volatile team)
      const teamIdx = yaml.indexOf("team:");
      const tasksIdx = yaml.indexOf("tasks:");
      if (teamIdx >= 0 && (tasksIdx < 0 || teamIdx < tasksIdx)) {
        yaml = yaml.slice(teamIdx);
      } else if (tasksIdx >= 0) {
        yaml = yaml.slice(tasksIdx);
      }
    }
    return yaml;
  }

  private showPlanPreview(yaml: string, originalInput: string): void {
    this.overlayActive = true;
    let doc: any;
    try {
      doc = parseYaml(yaml);
      if (!doc?.tasks?.length) {
        this.log("{red-fg}Invalid plan: no tasks found{/red-fg}");
        return;
      }
    } catch {
      this.log("{red-fg}Invalid YAML in plan{/red-fg}");
      return;
    }

    let viewMode: "readable" | "yaml" = "readable";

    // Full-screen overlay
    const overlay = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      style: { bg: "black" },
    });

    // Content area (scrollable)
    const contentBox = blessed.box({
      parent: overlay,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%-8",
      border: { type: "line" },
      tags: true,
      label: " {yellow-fg}♩{/yellow-fg} {bold}Plan Preview{/bold} ",
      scrollable: true,
      keys: true,
      vi: true,
      mouse: true,
      style: { bg: "black", border: { fg: "cyan" } },
    });

    // Action list
    const actionItems = [
      "  {green-fg}✓{/green-fg} Execute plan",
      "  {yellow-fg}✎{/yellow-fg} Edit YAML",
      "  {cyan-fg}↻{/cyan-fg} Refine with feedback",
    ];
    const actionList = blessed.list({
      parent: overlay,
      bottom: 1,
      left: "center",
      width: 32,
      height: actionItems.length + 2,
      items: actionItems,
      tags: true,
      border: { type: "line" },
      style: {
        bg: "black",
        border: { fg: "grey" },
        selected: { bg: "blue", fg: "white", bold: true },
        item: { bg: "black" },
      },
      keys: true,
      vi: false,
      mouse: true,
    });

    // Hint bar
    blessed.box({
      parent: overlay,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      content: " {cyan-fg}Tab{/cyan-fg} {grey-fg}toggle view{/grey-fg}  {cyan-fg}↑↓{/cyan-fg} {grey-fg}actions{/grey-fg}  {cyan-fg}Enter{/cyan-fg} {grey-fg}select{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}",
      style: { bg: "black", fg: "grey" },
    });

    const renderContent = () => {
      if (viewMode === "readable") {
        contentBox.setContent(this.formatPlanReadable(doc));
        (contentBox as any).setLabel(" {yellow-fg}♩{/yellow-fg} {bold}Plan Preview{/bold} ");
      } else {
        contentBox.setContent(this.formatYamlColored(yaml));
        (contentBox as any).setLabel(" {yellow-fg}♩{/yellow-fg} {bold}Plan (YAML){/bold} ");
      }
    };

    renderContent();
    actionList.select(0);
    actionList.focus();
    this.scheduleRender();

    const cleanup = () => {
      this.overlayActive = false;
      overlay.destroy();
      this.scheduleRender();
    };

    // Tab toggles view
    actionList.key(["tab"], () => {
      viewMode = viewMode === "readable" ? "yaml" : "readable";
      renderContent();
      this.scheduleRender();
    });

    // Enter selects action
    let previewReady = false;
    setImmediate(() => { previewReady = true; });
    actionList.on("select", (_item: any, index: number) => {
      if (!previewReady) return;
      cleanup();
      switch (index) {
        case 0:
          this.executePlan(yaml);
          break;
        case 1:
          this.showYamlEditor(yaml, originalInput);
          break;
        case 2:
          this.showRefineInput(yaml, originalInput);
          break;
      }
    });

    // Escape cancels
    actionList.on("cancel", () => {
      cleanup();
      this.log("{yellow-fg}Plan cancelled{/yellow-fg}");
    });
  }

  /** Human-readable plan formatting */
  private formatPlanReadable(doc: any): string {
    const tasks = doc.tasks || [];
    const volatileTeam = doc.team as any[] | undefined;
    const lines: string[] = [];
    const circled = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];

    // Show volatile team if present
    if (volatileTeam && volatileTeam.length > 0) {
      lines.push(`  {bold}{yellow-fg}Volatile team{/yellow-fg}{/bold}  {grey-fg}(agents created for this plan only){/grey-fg}`);
      lines.push("");
      for (const a of volatileTeam) {
        const model = a.model ? `{grey-fg}${a.model}{/grey-fg}` : "";
        lines.push(`    {cyan-fg}${a.name}{/cyan-fg}  ${a.adapter || "claude-sdk"}  ${model}`);
        if (a.role) lines.push(`      {grey-fg}${a.role}{/grey-fg}`);
        if (a.skills?.length) lines.push(`      {yellow-fg}⚡{/yellow-fg} ${a.skills.join(", ")}`);
      }
      lines.push("");
      lines.push("  ───────────────────────────────");
      lines.push("");
    }

    lines.push(`  {bold}${tasks.length} task${tasks.length !== 1 ? "s" : ""}{/bold} in plan`);
    lines.push("");

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      const num = circled[i] ?? `(${i + 1})`;

      lines.push(`  {bold}${num} ${t.title}{/bold}`);

      // Agent + dependencies
      const depParts: string[] = [];
      if (t.dependsOn?.length > 0) {
        const depNums = t.dependsOn.map((dep: string) => {
          const idx = tasks.findIndex((tt: any) => tt.title === dep);
          return idx >= 0 ? (circled[idx] ?? `#${idx + 1}`) : dep;
        });
        depParts.push(`⟵ ${depNums.join(", ")}`);
      }
      const depStr = depParts.length > 0 ? `  {grey-fg}${depParts.join("  ")}{/grey-fg}` : "";
      lines.push(`    {cyan-fg}→ ${t.assignTo || "default"}{/cyan-fg}${depStr}`);

      // Description (truncated)
      if (t.description && t.description !== t.title) {
        const desc = t.description.length > 120
          ? t.description.slice(0, 117) + "..."
          : t.description;
        lines.push(`    {grey-fg}${desc}{/grey-fg}`);
      }

      // Expectations
      if (t.expectations?.length > 0) {
        const exps = t.expectations.map((e: any) => {
          switch (e.type) {
            case "test": return `{green-fg}☐{/green-fg} test: ${e.command || ""}`;
            case "file_exists": return `{green-fg}☐{/green-fg} files: ${(e.paths || []).join(", ")}`;
            case "script": return `{green-fg}☐{/green-fg} script: ${e.command || ""}`;
            case "llm_review": return `{green-fg}☐{/green-fg} review: ${e.criteria || ""}`;
            default: return `{green-fg}☐{/green-fg} ${e.type}`;
          }
        });
        lines.push(`    ${exps.join("  ")}`);
      }

      lines.push("");
    }

    return lines.join("\n");
  }

  /** YAML with basic syntax coloring */
  private formatYamlColored(yaml: string): string {
    return yaml.split("\n").map(line => {
      if (line.match(/^\s*#/)) return `{grey-fg}${line}{/grey-fg}`;
      if (line.match(/^\s*-\s/)) {
        return line.replace(/^(\s*-\s)(.*)$/, "{cyan-fg}$1{/cyan-fg}$2");
      }
      const kv = line.match(/^(\s*)(\w[\w\s]*?)(:)(.*)/);
      if (kv) {
        return `${kv[1]}{green-fg}${kv[2]}{/green-fg}{white-fg}${kv[3]}{/white-fg}${kv[4]}`;
      }
      return line;
    }).join("\n");
  }

  /** Open YAML editor overlay */
  private showYamlEditor(yaml: string, originalInput: string): void {
    this.overlayActive = true;
    const editor = blessed.textarea({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%-1",
      value: yaml,
      inputOnFocus: false,
      border: { type: "line" },
      tags: true,
      label: " {yellow-fg}✎{/yellow-fg} {bold}Edit Plan{/bold}  {grey-fg}Ctrl+S save  Escape cancel{/grey-fg} ",
      style: { bg: "black", fg: "white", border: { fg: "yellow" } },
      keys: true,
      mouse: true,
      scrollable: true,
    });

    editor.focus();
    editor.readInput(() => {});
    this.scheduleRender();

    editor.key(["C-s"], () => {
      const editedYaml = editor.getValue();
      editor.destroy();
      this.showPlanPreview(editedYaml, originalInput);
    });

    editor.key(["escape"], () => {
      editor.destroy();
      this.showPlanPreview(yaml, originalInput);
    });
  }

  /** Show refine input prompt */
  private showRefineInput(yaml: string, originalInput: string): void {
    this.overlayActive = true;
    const refineBox = blessed.box({
      parent: this.screen,
      top: "center",
      left: "center",
      width: "70%",
      height: 5,
      border: { type: "line" },
      tags: true,
      label: " {cyan-fg}↻{/cyan-fg} {bold}Refine{/bold}  {grey-fg}What should be changed?{/grey-fg} ",
      style: { bg: "black", fg: "white", border: { fg: "cyan" } },
    });

    let refineBuffer = "";
    const cursor = "{white-fg}█{/white-fg}";
    refineBox.setContent(` ${cursor}`);
    this.scheduleRender();

    const keyHandler = (ch: string, key: any) => {
      if (!key) return;
      if (key.name === "return" || key.name === "enter") {
        if (refineBuffer.trim()) {
          cleanup();
          this.handleRefine(yaml, originalInput, refineBuffer.trim());
        }
        return;
      }
      if (key.name === "escape") {
        cleanup();
        this.showPlanPreview(yaml, originalInput);
        return;
      }
      if (key.name === "backspace") {
        refineBuffer = refineBuffer.slice(0, -1);
      } else if (ch && ch.length === 1 && !key.ctrl && !key.meta) {
        refineBuffer += ch;
      }
      refineBox.setContent(` ${refineBuffer}${cursor}`);
      this.scheduleRender();
    };

    const cleanup = () => {
      this.overlayActive = false;
      this.screen.removeListener("keypress", keyHandler);
      refineBox.destroy();
      this.scheduleRender();
    };

    this.screen.on("keypress", keyHandler);
  }

  /** Re-generate plan with feedback */
  private async handleRefine(currentYaml: string, originalInput: string, feedback: string): Promise<void> {
    this.logAlways(`{cyan-fg}↻{/cyan-fg} Refining: ${feedback}`);
    this.logAlways("");
    this.processing = true;
    this.processingStart = Date.now();
    this.processingLabel = "Refining plan";
    this.updateInputDisplay();

    try {
      const newYaml = await this.generatePlanWithFeedback(originalInput, currentYaml, feedback);
      this.processing = false;
      this.processingStart = 0;
      this.updateInputDisplay();

      if (!newYaml?.trim()) {
        this.log("{red-fg}Refine returned empty result{/red-fg}");
        this.showPlanPreview(currentYaml, originalInput); // fall back
        return;
      }

      try {
        const doc = parseYaml(newYaml);
        if (!doc?.tasks?.length) {
          this.log("{red-fg}Refined plan has no tasks{/red-fg}");
          this.showPlanPreview(currentYaml, originalInput);
          return;
        }
      } catch {
        this.log("{red-fg}Refined plan has invalid YAML{/red-fg}");
        this.showPlanPreview(currentYaml, originalInput);
        return;
      }

      this.showPlanPreview(newYaml, originalInput);
    } catch (err: unknown) {
      this.processing = false;
      this.processingStart = 0;
      this.updateInputDisplay();
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`{red-fg}Refine failed: ${msg}{/red-fg}`);
    }
  }

  /** Generate plan with refinement context */
  private async generatePlanWithFeedback(originalInput: string, currentYaml: string, feedback: string): Promise<string> {
    const prompt = [
      this.buildPlanSystemPrompt(),
      ``,
      `---`,
      ``,
      `Original request: "${originalInput}"`,
      ``,
      `Current plan:`,
      currentYaml,
      ``,
      `User feedback: "${feedback}"`,
      ``,
      `Revise the plan based on the feedback. Output ONLY valid YAML.`,
    ].join("\n");

    const resultText = await this.querySDKText(prompt);
    return this.extractYaml(resultText);
  }

  /** Execute plan: create all tasks with group */
  private executePlan(yaml: string): void {
    try {
      const doc = parseYaml(yaml);
      if (!doc?.tasks || !Array.isArray(doc.tasks)) {
        this.log("{red-fg}Invalid plan: no tasks array{/red-fg}");
        return;
      }

      this.planCounter++;
      const group = `plan-${this.planCounter}`;

      // Register volatile agents from the plan's team: section
      if (doc.team && Array.isArray(doc.team)) {
        for (const agentDef of doc.team) {
          if (!agentDef.name || !agentDef.adapter) continue;
          this.orchestrator.addVolatileAgent({
            name: agentDef.name,
            adapter: agentDef.adapter,
            model: agentDef.model,
            role: agentDef.role,
            systemPrompt: agentDef.systemPrompt,
            skills: agentDef.skills,
          }, group);
        }
        this.log(`{cyan-fg}${doc.team.length} volatile agent(s) registered for ${group}{/cyan-fg}`);
      }

      const titleToId = new Map<string, string>();

      for (const t of doc.tasks) {
        const deps = (t.dependsOn || [])
          .map((title: string) => titleToId.get(title))
          .filter((id: string | undefined): id is string => !!id);

        const task = this.orchestrator.addTask({
          title: t.title,
          description: t.description || t.title,
          assignTo: t.assignTo || this.defaultAgent,
          dependsOn: deps,
          expectations: t.expectations || [],
          group,
        });

        titleToId.set(t.title, task.id);
      }

      this.log(`{green-fg}Plan executed: ${doc.tasks.length} task${doc.tasks.length !== 1 ? "s" : ""} created (${group}){/green-fg}`);
      this.logEvent(`  {green-fg}▸{/green-fg} {bold}Plan started{/bold} — ${doc.tasks.length} tasks {grey-fg}(${group}){/grey-fg}`);
      this.log("{grey-fg}Supervisor will start picking them up...{/grey-fg}");
      this.log("");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`{red-fg}Failed to execute plan: ${msg}{/red-fg}`);
    }
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

    const wasOpen = this.menuType === "command";
    this.menuType = "command";

    this.completionBox.setItems(items);
    this.completionBox.height = items.length + 2;
    (this.completionBox as any).setLabel(" {cyan-fg}Commands{/cyan-fg} ");
    this.completionBox.show();
    this.completionBox.select(0);
    if (!wasOpen) this.completionBox.focus();

    if (!wasOpen) {
      // Mouse click handler — only bind once
      this.completionBox.on("select", (_item: any, index: number) => {
        const cmd = this.commandKeys[index];
        this.closeMenu();
        if (cmd) {
          this.inputBuffer = "";
          this.updateInputDisplay();
          this.handleSlashCommand(cmd);
        }
      });
    }

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

    // Mouse click → append tag to buffer (don't submit)
    this.completionBox.on("select", (_item: any, index: number) => {
      this.resolveMention(index);
    });

    this.scheduleRender();
  }

  /** Resolve a mention selection by index → append tag to inputBuffer */
  private resolveMention(index: number): void {
    const entry = this.mentionEntries[index];
    if (!entry || !entry.tag) return; // skip separators
    this.closeMenu();
    // Replace the "@" trigger with the selected tag
    if (this.inputBuffer.endsWith("@")) {
      this.inputBuffer = this.inputBuffer.slice(0, -1);
    }
    this.inputBuffer += entry.tag + " ";
    this.updateInputDisplay();
  }

  /** Close popup menu without clearing buffer */
  private closeMenu(): void {
    this.menuType = null;
    this.menuJustClosed = true;
    this.completionBox.hide();
    this.completionBox.removeAllListeners("select");
    this.completionBox.removeAllListeners("cancel");
    this.scheduleRender();
  }

  // ─── Task Panel ──────────────────────────────────────

  private toggleTaskPanel(): void {
    this.taskPanelVisible = !this.taskPanelVisible;

    if (this.taskPanelVisible) {
      this.taskPanel.show();
      this.logBox.width = "75%";
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
    const barLen = 18;
    const greenFill = Math.round((doneN / total) * barLen);
    const redFill = Math.round((failN / total) * barLen);
    const grayFill = Math.max(0, barLen - greenFill - redFill);
    lines.push(`{green-fg}${"█".repeat(greenFill)}{/green-fg}{red-fg}${"█".repeat(redFill)}{/red-fg}{grey-fg}${"░".repeat(grayFill)}{/grey-fg} ${pct}%`);
    lines.push("");

    // Separate ungrouped vs grouped tasks
    const ungrouped: typeof this.state.tasks = [];
    const groups = new Map<string, typeof this.state.tasks>();
    for (const t of this.state.tasks) {
      if (t.group) {
        if (!groups.has(t.group)) groups.set(t.group, []);
        groups.get(t.group)!.push(t);
      } else {
        ungrouped.push(t);
      }
    }

    const blinkPhase = this.frame % 3; // 0, 1, 2 — faster cycle

    const renderTask = (task: typeof this.state.tasks[0], indent: string) => {
      const isRunning = ["in_progress", "assigned", "review"].includes(task.status);
      const hasDeps = task.dependsOn && task.dependsOn.length > 0;
      const depPrefix = hasDeps ? "↳ " : "";

      // Blink icon for running tasks — orange (#208) pulsing
      let icon: string;
      if (isRunning) {
        icon = blinkPhase === 0
          ? "{bold}{#ff8800-fg}●{/#ff8800-fg}{/bold}"
          : blinkPhase === 1
            ? "{#cc6600-fg}●{/#cc6600-fg}"
            : "{#884400-fg}○{/#884400-fg}";
      } else {
        icon = this.getStatusIcon(task.status);
      }

      const maxLen = hasDeps ? 16 : 18;
      const title = task.title.length > maxLen
        ? task.title.slice(0, maxLen - 1) + "…"
        : task.title;
      lines.push(`${indent}${depPrefix}${icon} ${title}`);

      if (task.result?.assessment?.globalScore !== undefined) {
        const gs = task.result.assessment.globalScore;
        const color = gs >= 4 ? "green" : gs >= 3 ? "yellow" : "red";
        lines.push(`${indent}  {${color}-fg}${gs.toFixed(1)}/5{/${color}-fg}`);
      }

      const proc = (this.state!.processes || []).find(p => p.taskId === task.id);
      if (proc?.alive && proc.activity) {
        const act = proc.activity;
        if (act.lastTool) {
          const fileInfo = act.lastFile ? ` → ${act.lastFile.split("/").pop()}` : "";
          lines.push(`${indent}  {cyan-fg}${s} ${act.lastTool}${fileInfo}{/cyan-fg}`);
        }
        if (act.toolCalls > 0) {
          const fCount = (act.filesCreated?.length || 0) + (act.filesEdited?.length || 0);
          const info = [`${act.toolCalls} calls`];
          if (fCount > 0) info.push(`${fCount} files`);
          lines.push(`${indent}  {grey-fg}${info.join(", ")}{/grey-fg}`);
        }
        if (act.summary) {
          const summary = act.summary.replace(/\{[^}]+\}/g, "").slice(0, 30);
          if (summary.trim()) lines.push(`${indent}  {grey-fg}${summary}{/grey-fg}`);
        }
      }
    };

    // Ungrouped tasks first
    for (const task of ungrouped) {
      renderTask(task, "");
    }

    // Grouped tasks with visual box
    for (const [groupName, groupTasks] of groups) {
      if (ungrouped.length > 0 || lines.length > 4) lines.push("");
      const gDone = groupTasks.filter(t => t.status === "done").length;
      const gFailed = groupTasks.filter(t => t.status === "failed").length;
      const gTotal = groupTasks.length;
      const allTerminal = gDone + gFailed === gTotal;

      // Elapsed time — from earliest createdAt to now (or last updatedAt if all terminal)
      const earliest = groupTasks.reduce((min, t) => t.createdAt < min ? t.createdAt : min, groupTasks[0].createdAt);
      const endTime = allTerminal
        ? groupTasks.reduce((max, t) => t.updatedAt > max ? t.updatedAt : max, groupTasks[0].updatedAt)
        : new Date().toISOString();
      const elapsedMs = new Date(endTime).getTime() - new Date(earliest).getTime();
      const elapsedStr = formatElapsed(elapsedMs);

      lines.push(`{cyan-fg}┌ {bold}${groupName}{/bold} {grey-fg}(${gDone}/${gTotal}){/grey-fg} {grey-fg}${elapsedStr}{/grey-fg}{/cyan-fg}`);
      for (const task of groupTasks) {
        renderTask(task, "{cyan-fg}│{/cyan-fg} ");
      }
      lines.push(`{cyan-fg}└${"─".repeat(16)}{/cyan-fg}`);
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
      if (existsSync(this.statePath)) {
        const raw = readFileSync(this.statePath, "utf-8");
        if (raw.trim()) {
          this.state = JSON.parse(raw);
        }
      }
    } catch {
      // File being written — skip
    }
  }

  // ─── UI Updates ──────────────────────────────────────

  private updateHeader(): void {
    this.loadState();
    const note = `{yellow-fg}${NOTES[this.frame % NOTES.length]}{/yellow-fg}`;

    const parts = [`${note} {bold}ORCHESTRA{/bold}`];

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

    // Truncate workDir for display
    const maxCwd = 30;
    const cwd = this.workDir.length > maxCwd
      ? "…" + this.workDir.slice(-(maxCwd - 1))
      : this.workDir;

    const left = ` ${modeLabels[this.inputMode]}  {grey-fg}│{/grey-fg}  ` +
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

  /** Translate orchestrator log messages into clean events */
  private emitEvent(msg: string): void {
    // Spawning agent
    let m = msg.match(/\[(\w+)\] Spawning "([^"]+)" .* for: (.+)/);
    if (m) { this.logEvent(`  {blue-fg}▶{/blue-fg} {bold}${m[3]}{/bold} {grey-fg}→ ${m[2]}{/grey-fg}`); return; }

    // Task passed
    m = msg.match(/\[(\w+)\] PASSED(.*?) — (.+)/);
    if (m) {
      const score = m[2].trim();
      this.logEvent(`  {green-fg}✓{/green-fg} {bold}${m[3]}{/bold} ${score ? `{green-fg}${score}{/green-fg}` : ""}`);
      return;
    }

    // Task done (no assessment)
    m = msg.match(/\[(\w+)\] DONE — (.+)/);
    if (m) { this.logEvent(`  {green-fg}✓{/green-fg} {bold}${m[2]}{/bold}`); return; }

    // Task failed
    m = msg.match(/\[(\w+)\] FAILED(.*?) — (.+)/);
    if (m) {
      const reason = m[2].trim();
      this.logEvent(`  {red-fg}✗{/red-fg} {bold}${m[3]}{/bold} ${reason ? `{grey-fg}${reason}{/grey-fg}` : ""}`);
      return;
    }

    // Retrying
    m = msg.match(/\[(\w+)\] Retrying \((\d+)\/(\d+)\)/);
    if (m) { this.logEvent(`  {yellow-fg}↻{/yellow-fg} Retry ${m[2]}/${m[3]} {grey-fg}[${m[1]}]{/grey-fg}`); return; }

    // Max retries
    m = msg.match(/\[(\w+)\] Max retries reached/);
    if (m) { this.logEvent(`  {red-fg}✗{/red-fg} {grey-fg}Max retries reached [${m[1]}]{/grey-fg}`); return; }

    // Task added
    m = msg.match(/\[(\w+)\] Task added: (.+)/);
    if (m) { this.logEvent(`  {cyan-fg}+{/cyan-fg} ${m[2]} {grey-fg}[${m[1]}]{/grey-fg}`); return; }

    // Reassessment
    m = msg.match(/\[(\w+)\] Reassessment (PASSED|FAILED)(.*)/);
    if (m) {
      const icon = m[2] === "PASSED" ? "{green-fg}✓{/green-fg}" : "{red-fg}✗{/red-fg}";
      this.logEvent(`  ${icon} Reassessment ${m[3].trim()} {grey-fg}[${m[1]}]{/grey-fg}`);
      return;
    }

    // Orphan recovery
    m = msg.match(/Recovered (\d+) orphaned/);
    if (m) { this.logEvent(`  {yellow-fg}↻{/yellow-fg} Recovered ${m[1]} orphaned task(s)`); return; }

    // Deadlock
    if (msg.includes("Deadlock detected")) {
      this.logEvent(`  {red-fg}⚠{/red-fg} {bold}Deadlock detected{/bold}`);
      return;
    }

    // Shutdown
    if (msg.includes("shut down cleanly")) {
      this.logEvent(`  {grey-fg}Orchestra stopped{/grey-fg}`);
      return;
    }

    // Skip dim/verbose lines in clean mode (agent started, assessment running, etc.)
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

  private getProviderLabel(value: string): string {
    return PROVIDERS.find(p => p.value === value)?.label ?? value;
  }

  private getStatusIcon(status: TaskStatus): string {
    switch (status) {
      case "pending": return "{grey-fg}○{/grey-fg}";
      case "assigned": return "{cyan-fg}◉{/cyan-fg}";
      case "in_progress": return "{yellow-fg}●{/yellow-fg}";
      case "review": return "{magenta-fg}●{/magenta-fg}";
      case "done": return "{green-fg}●{/green-fg}";
      case "failed": return "{red-fg}✗{/red-fg}";
    }
  }

  private getStatusLabel(status: TaskStatus): string {
    switch (status) {
      case "pending": return "{grey-fg}PENDING{/grey-fg}  ";
      case "assigned": return "{cyan-fg}ASSIGNED{/cyan-fg} ";
      case "in_progress": return "{yellow-fg}{bold}RUNNING{/bold}{/yellow-fg}  ";
      case "review": return "{magenta-fg}{bold}REVIEW{/bold}{/magenta-fg}   ";
      case "done": return "{green-fg}DONE{/green-fg}     ";
      case "failed": return "{red-fg}{bold}FAILED{/bold}{/red-fg}   ";
    }
  }

  private stripAnsi(str: string): string {
    // eslint-disable-next-line no-control-regex
    return str.replace(/[\x1B\x9B][[\]()#;?]*(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\x07|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])/g, "");
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
