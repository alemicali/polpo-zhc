import { useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { withFullScreen, useScreenSize } from "fullscreen-ink";
import { resolve, basename } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { Orchestrator } from "../core/orchestrator.js";
import { JsonConfigStore } from "../stores/json-config-store.js";
import type { Team, ProjectConfig } from "../core/types.js";
import { useTUIStore } from "./store.js";
import { bridgeOrchestraEvents } from "./event-bridge-ink.js";
import { Header } from "./components/Header.js";
import { LogPanel } from "./components/LogPanel.js";
import { TaskPanel } from "./components/TaskPanel.js";
import { InputBar } from "./components/InputBar.js";
import { HintBar } from "./components/HintBar.js";
import { StatusLine } from "./components/Shimmer.js";
import { CompletionMenu } from "./components/CompletionMenu.js";
import { OverlayHost } from "./overlays/OverlayHost.js";
import { MODELS } from "./constants.js";
import { getProviderLabel } from "./formatters.js";

// Register adapters
import "../adapters/claude-sdk.js";
import "../adapters/generic.js";

function App() {
  const { exit } = useApp();
  const { height, width } = useScreenSize();
  const store = useTUIStore();

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

    // Welcome message (matches old TUI)
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

  // Global key handler
  useInput((input, key) => {
    if (store.activeOverlay) return; // overlay handles its own input

    // Ctrl+C → quit
    if (input === "c" && key.ctrl) {
      handleQuit();
      return;
    }

    // Alt+T → toggle mode
    if (input === "t" && key.meta) {
      store.toggleMode();
      return;
    }

    // Ctrl+O → toggle task panel
    if (input === "o" && key.ctrl) {
      store.toggleTaskPanel();
      return;
    }

    // Ctrl+L → toggle verbose
    if (input === "l" && key.ctrl) {
      store.toggleVerbose();
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
        .then(() => {
          exit();
        })
        .catch(() => {
          exit();
        });
    } else {
      exit();
    }
  };

  if (store.quitting) {
    return (
      <Box flexDirection="column" height={height} width={width}>
        <Box justifyContent="center" alignItems="center" flexGrow={1}>
          <Text dimColor>Shutting down gracefully...</Text>
        </Box>
      </Box>
    );
  }

  // ─── Overlay mode: full-screen overlay replaces normal UI ────
  if (store.activeOverlay) {
    return (
      <Box flexDirection="column" height={height} width={width}>
        <OverlayHost width={width} height={height} />
      </Box>
    );
  }

  // ─── Layout calculations matching old blessed TUI ─────────
  // Old blessed: header(1) + body(h-4) + input(3) + hint(1) = h+1 (overlapping)
  // Ink flex: header(1) + body + status?(1) + input(3) + hint(1) = h
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
    <Box flexDirection="column" height={height} width={width}>
      <Header width={width} />
      <Box flexDirection="row" height={bodyH}>
        <LogPanel width={logW} height={bodyH} />
        {store.taskPanelVisible && <TaskPanel width={taskW} height={bodyH} />}
      </Box>
      {store.processing && <StatusLine width={width} />}
      {/* Command/mention completion menu - positioned above input */}
      {store.menuType && <CompletionMenu />}
      <InputBar width={width} />
      <HintBar width={width} />
    </Box>
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

export async function startInkTUI(workDir: string = "."): Promise<void> {
  const resolvedDir = resolve(workDir);
  useTUIStore.getState().setWorkDir(resolvedDir);

  const ink = withFullScreen(<App />);
  await ink.start();
  await ink.waitUntilExit();
}
