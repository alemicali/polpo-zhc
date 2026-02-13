import { useEffect, useState } from "react";
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { resolve, basename } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { Orchestrator } from "../core/orchestrator.js";
import { JsonConfigStore } from "../stores/json-config-store.js";
import type { Team, ProjectConfig } from "../core/types.js";
import { useTUIStore } from "../tui/store.js";
import { bridgeOrchestraEvents } from "../tui/event-bridge-ink.js";
import { MODELS } from "../tui/constants.js";
import { getProviderLabel } from "../tui/formatters.js";
import { Header } from "./components/Header.js";
import { LogPanel } from "./components/LogPanel.js";
import { TaskPanel } from "./components/TaskPanel.js";
import { InputBar } from "./components/InputBar.js";
import { HintBar } from "./components/HintBar.js";
import { StatusLine } from "./components/StatusLine.js";
import { CompletionMenu } from "./components/CompletionMenu.js";
import { OverlayHost } from "./overlays/OverlayHost.js";

// Register adapters
import "../adapters/claude-sdk.js";
import "../adapters/generic.js";

function App() {
  const store = useTUIStore();
  const [size, setSize] = useState({ width: process.stdout.columns || 80, height: process.stdout.rows || 24 });

  // Track terminal resize
  useEffect(() => {
    const onResize = () => {
      setSize({ width: process.stdout.columns || 80, height: process.stdout.rows || 24 });
    };
    process.stdout.on("resize", onResize);
    return () => { process.stdout.off("resize", onResize); };
  }, []);

  // Initialize orchestrator on mount
  useEffect(() => {
    const workDir = store.workDir;
    const orchestraDir = resolve(workDir, ".polpo");
    const configStore = new JsonConfigStore(orchestraDir);
    const savedConfig = configStore.get();

    let config: ProjectConfig;
    if (savedConfig) {
      let needsSave = false;
      if (!savedConfig.project) {
        savedConfig.project = basename(workDir);
        needsSave = true;
      }
      if (!savedConfig.judgeModel) {
        savedConfig.judgeModel = savedConfig.model || "claude-sonnet-4-5-20250929";
        needsSave = true;
      }
      if (needsSave) configStore.save(savedConfig);
      config = savedConfig;
    } else {
      config = {
        project: basename(workDir),
        judge: "claude-sdk",
        judgeModel: "claude-sonnet-4-5-20250929",
        agent: "claude-sdk",
        model: "claude-sonnet-4-5-20250929",
      };
      configStore.save(config);
    }

    store.setConfig(config);

    // Init orchestrator
    const orchestrator = new Orchestrator(workDir);
    let team: Team;
    const ymlPath = resolve(workDir, "polpo.yml");
    if (existsSync(ymlPath)) {
      try {
        const raw = readFileSync(ymlPath, "utf-8");
        const doc = parseYaml(raw);
        team = doc.team;
        store.setDefaultAgent(team.agents[0]?.name ?? "dev");
      } catch {
        team = makeDefaultTeam(config);
      }
    } else {
      team = makeDefaultTeam(config);
    }

    orchestrator.initInteractive(config.project || basename(workDir), team);

    const cfg = orchestrator.getConfig();
    if (cfg && config.judgeModel) {
      cfg.settings.orchestratorModel = config.judgeModel;
    }

    store.setOrchestrator(orchestrator);

    // Bridge events
    const dispose = bridgeOrchestraEvents(orchestrator, store);

    // Welcome message
    const modelLabel = config.model
      ? MODELS.find((m) => m.value === config.model)?.label ?? config.model
      : "";
    const judgeModelLabel = config.judgeModel
      ? MODELS.find((m) => m.value === config.judgeModel)?.label ?? config.judgeModel
      : "";
    const S = (text: string, color?: string, bold?: boolean, dim?: boolean) => ({ text, color, bold, dim });
    store.logAlways("Polpo", [S("🐙 Polpo", "cyan", true)]);
    store.logAlways("", []);
    store.logAlways(`  Judge:  ${getProviderLabel(config.judge)}` + (judgeModelLabel ? ` (${judgeModelLabel})` : ""), [
      S("  Judge:  ", "gray"),
      S(getProviderLabel(config.judge), "cyan"),
      ...(judgeModelLabel ? [S(` (${judgeModelLabel})`, "gray")] : []),
    ]);
    store.logAlways(`  Orchestrator: ${getProviderLabel(config.agent)}` + (modelLabel ? ` (${modelLabel})` : ""), [
      S("  Orchestrator: ", "gray"),
      S(getProviderLabel(config.agent), "cyan"),
      ...(modelLabel ? [S(` (${modelLabel})`, "gray")] : []),
    ]);
    store.logAlways(`  Team:   ${team.name} (${team.agents.map((a) => a.name).join(", ")})`, [
      S("  Team:   ", "gray"),
      S(team.name, "cyan"),
      S(` (${team.agents.map((a) => a.name).join(", ")})`, "gray"),
    ]);
    store.logAlways("", []);
    store.logAlways("Type a task description and press Enter to run it.", [
      S("Type a task description and press Enter to run it.", undefined, false, true),
    ]);
    store.logAlways("Use @agent to assign, ! prefix to skip prep, /config to configure, /help for commands", [
      S("Use @agent to assign, ! prefix to skip prep, /config to configure, /help for commands", undefined, false, true),
    ]);
    store.logAlways("");

    // Start supervisor loop
    orchestrator.run().catch((err: Error) => {
      store.log(`Supervisor error: ${err.message}`);
    });

    // Poll state + animate
    const pollInterval = setInterval(() => {
      store.loadState();
      store.tick();
    }, 700);

    return () => {
      clearInterval(pollInterval);
      dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Global key handler — use getState() to avoid stale closures
  useKeyboard((key) => {
    const s = useTUIStore.getState();
    if (s.activeOverlay) return;

    // Ctrl+C → quit
    if (key.name === "c" && key.ctrl) {
      handleQuit();
      return;
    }

    // Alt+T → toggle mode
    if (key.name === "t" && key.meta) {
      s.toggleMode();
      return;
    }

    // Ctrl+O → toggle task panel
    if (key.name === "o" && key.ctrl) {
      s.toggleTaskPanel();
      return;
    }

    // Ctrl+L → toggle verbose
    if (key.name === "l" && key.ctrl) {
      s.toggleVerbose();
      return;
    }
  });

  const handleQuit = () => {
    if (store.quitting) return;
    store.setQuitting(true);

    const orchestrator = store.orchestrator;
    if (orchestrator) {
      orchestrator
        .gracefulStop(3000)
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    } else {
      process.exit(0);
    }
  };

  const { width, height } = size;

  if (store.quitting) {
    return (
      <box style={{ flexDirection: "column", width, height, justifyContent: "center", alignItems: "center" }}>
        <text fg="#888888">Shutting down gracefully...</text>
      </box>
    );
  }

  // Overlay mode: full-screen overlay replaces normal UI
  if (store.activeOverlay) {
    return (
      <box style={{ flexDirection: "column", width, height }}>
        <OverlayHost width={width} height={height} />
      </box>
    );
  }

  // Layout calculations
  const headerH = 1;
  const inputH = 3;
  const hintH = 1;
  const statusH = store.processing ? 1 : 0;
  const bodyH = Math.max(3, height - headerH - inputH - hintH - statusH);

  // Task panel = 35% width (or 0 if hidden), min 20
  const taskW = store.taskPanelVisible
    ? Math.max(20, Math.min(45, Math.floor(width * 0.35)))
    : 0;
  const logW = width - taskW;

  return (
    <box style={{ flexDirection: "column", width, height }}>
      <Header width={width} />
      <box style={{ flexDirection: "row", height: bodyH }}>
        <LogPanel width={logW} height={bodyH} />
        {store.taskPanelVisible && <TaskPanel width={taskW} height={bodyH} />}
      </box>
      {store.processing && <StatusLine width={width} />}
      {store.menuType && <CompletionMenu />}
      <InputBar width={width} />
      <HintBar width={width} />
    </box>
  );
}

function makeDefaultTeam(config: ProjectConfig): Team {
  return {
    name: "default",
    agents: [
      {
        name: "dev",
        adapter: config.agent || "claude-sdk",
        model: config.model || "claude-sonnet-4-5-20250929",
      },
    ],
  };
}

// ─── Entry point ──────────────────────────────────────────

export async function startOpenTUI(workDir: string = "."): Promise<void> {
  const resolvedDir = resolve(workDir);
  useTUIStore.getState().setWorkDir(resolvedDir);

  const renderer = await createCliRenderer({ fullscreen: true });
  const root = createRoot(renderer);
  root.render(<App />);

  // Graceful shutdown on SIGINT/SIGTERM
  const cleanup = () => {
    renderer.destroy();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}
