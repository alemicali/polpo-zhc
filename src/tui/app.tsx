/**
 * TUI entry point — Ink 5 + React + Zustand.
 * Orchestrator in React Context, NOT in Zustand store.
 */

import { createContext, useContext, useState, useEffect } from "react";
import { render } from "ink";
import { FullScreenBox } from "fullscreen-ink";
import { resolve, basename } from "node:path";
import { existsSync } from "node:fs";
import { Orchestrator } from "../core/orchestrator.js";
import { useStore } from "./store.js";
import { bridgeEvents } from "./bridge.js";
import { seg } from "./format.js";
import { Shell } from "./components/Shell.js";

// ─── Orchestrator Context ───────────────────────────────

const PolpoContext = createContext<Orchestrator | null>(null);

export function usePolpo(): Orchestrator {
  const ctx = useContext(PolpoContext);
  if (!ctx) throw new Error("usePolpo() must be used within PolpoContext");
  return ctx;
}

// ─── Init Hook ──────────────────────────────────────────

function useOrchestratorInit(workDir: string) {
  const [polpo, setPolpo] = useState<Orchestrator | null>(null);

  useEffect(() => {
    const absDir = resolve(workDir);
    const store = useStore.getState();

    // Create orchestrator — it loads config from polpo.yml in init()
    const orc = new Orchestrator(absDir);

    // Bridge events → store
    const unbridge = bridgeEvents(orc, store);

    const configPath = resolve(absDir, "polpo.yml");
    const hasConfig = existsSync(configPath);

    const boot = hasConfig
      ? orc.init()
      : Promise.resolve(
          orc.initInteractive(basename(absDir), { name: "default", agents: [] }),
        );

    boot.then(() => {
      const config = orc.getConfig();
      if (config?.team.agents[0]) {
        store.setDefaultAgent(config.team.agents[0].name);
      }

      // Welcome
      const project = config?.project ?? basename(absDir);
      store.log("Welcome to Polpo", [
        seg("Welcome to ", "gray"),
        seg("Polpo", "cyan", true),
      ]);
      store.log(`Project: ${project}`, [
        seg("Project: ", "gray"),
        seg(project, undefined, true),
      ]);

      const agents = config?.team.agents.length ?? 0;
      if (agents > 0) {
        store.log(`Team: ${config!.team.name} (${agents} agents)`, [
          seg("Team: ", "gray"),
          seg(config!.team.name, undefined, true),
          seg(` (${agents} agents)`, "gray"),
        ]);
      }

      if (!hasConfig) {
        store.log("No polpo.yml found — interactive mode", [
          seg("No polpo.yml found — ", "yellow"),
          seg("interactive mode", "yellow", true),
        ]);
        store.log("Use /team add to add agents, then type a task", [
          seg("Use ", "gray"),
          seg("/team add", "cyan"),
          seg(" to add agents, then type a task", "gray"),
        ]);
      }

      store.log("Type /help for commands", [
        seg("Type ", "gray"),
        seg("/help", "cyan"),
        seg(" for commands", "gray"),
      ]);

      setPolpo(orc);
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      store.log(`Init error: ${msg}`, [seg(`Init error: ${msg}`, "red")]);
      // Fallback to interactive mode
      orc.initInteractive(basename(absDir), { name: "default", agents: [] });
      setPolpo(orc);
    });

    // State sync interval
    const syncInterval = setInterval(() => {
      try {
        const state = orc.getStore()?.getState();
        if (state) store.syncState(state);
      } catch { /* store not ready yet */ }
    }, 1000);

    return () => {
      unbridge();
      clearInterval(syncInterval);
      orc.stop();
    };
  }, [workDir]);

  return polpo;
}

// ─── App ────────────────────────────────────────────────

function App({ workDir }: { workDir: string }) {
  const polpo = useOrchestratorInit(workDir);

  if (!polpo) return null;

  return (
    <PolpoContext.Provider value={polpo}>
      <FullScreenBox>
        <Shell />
      </FullScreenBox>
    </PolpoContext.Provider>
  );
}

// ─── Entry Point ────────────────────────────────────────

export async function startInkTUI(workDir: string = "."): Promise<void> {
  const { waitUntilExit } = render(<App workDir={workDir} />);
  await waitUntilExit();
}
